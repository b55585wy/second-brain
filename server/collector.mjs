import { CodexRpc, RpcError } from './codex-rpc.mjs';
import { choice, integer, onlyFields, strings, text, digest, now, object, truncate } from './validation.mjs';
import { ApiError, fail, requireValue } from './errors.mjs';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

const DEFAULT_SCOPE = { enabled: false, allowedThreadIds: [], allowedProjectPaths: [], excludedThreadIds: [], excludedProjectPaths: [], includeArchived: false, allowManualImports: true };
const DEFAULT_OPTIONS = { days: 7, maxThreads: 20, pageSize: 100, maxPages: 20, cliPath: null };
function projectPath(value) {
  requireValue(typeof value === 'string' && isAbsolute(value), '项目路径必须是已存在的本地绝对路径。');
  let actual;
  try { actual = realpathSync(value); } catch { fail(422, 'VALIDATION_ERROR', '项目路径无法解析。'); }
  return process.platform === 'win32' ? actual.toLowerCase() : actual;
}
function inside(parent, child) {
  const part = relative(parent, child);
  return !part || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}
const unsupported = error => error instanceof RpcError && [-32601, -32602].includes(error.rpcCode);
const iso = value => {
  if (value === null || value === undefined) return null;
  const timestamp = typeof value === 'number' ? value < 1e12 ? value * 1000 : value : value;
  const date = new Date(timestamp);
  return Number.isFinite(+date) ? date.toISOString() : null;
};
const milliseconds = value => {
  const date = typeof value === 'number' ? new Date(value) : null;
  return date && Number.isFinite(+date) ? date.toISOString() : null;
};

function pageItems(page) {
  const items = page?.data ?? page?.items;
  if (!Array.isArray(items)) fail(502, 'UPSTREAM_ERROR', 'Codex 分页响应无效。');
  return items;
}

function historyCursor(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) fail(502, 'UPSTREAM_ERROR', 'Codex 对话分页游标无效。');
  return value;
}

function advanceCursorCheck(check, cursor) {
  const hash = digest(cursor);
  if (hash === check.anchorDigest) fail(502, 'UPSTREAM_ERROR', 'Codex 对话分页游标出现循环。');
  const steps = check.steps + 1;
  // Doubling the comparison window detects resumed cycles with constant checkpoint size.
  return steps === check.span ? { anchorDigest: hash, span: Math.min(check.span * 2, Number.MAX_SAFE_INTEGER), steps: 0 } : { ...check, steps };
}

function messageIdentity(threadId, messageId) {
  const combined = `${threadId}:${messageId}`;
  return [...combined].length > 512 ? `event_${digest([threadId, messageId])}` : combined;
}

export function visibleMessage(entry, index) {
  const item = entry.item ?? entry;
  let role;
  let content;
  if (item.type === 'userMessage') {
    role = 'user';
    content = typeof item.content === 'string' ? item.content : (item.content ?? [])
      .filter(part => ['inputText', 'text'].includes(part.type)).map(part => part.text ?? '').join('\n');
  } else if (['agentMessage', 'assistantMessage'].includes(item.type)) {
    role = 'assistant';
    content = item.text ?? (Array.isArray(item.content) ? item.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '');
  } else return null;
  if (typeof content !== 'string' || !content.trim()) return null;
  return { id: String(item.id ?? entry.id ?? `visible-${index}-${digest([role, content]).slice(0, 24)}`),
    role, text: content, occurredAt: milliseconds(item.startedAtMs ?? entry.startedAtMs)
      ?? milliseconds(item.completedAtMs ?? entry.completedAtMs) ?? iso(item.createdAt ?? entry.createdAt) };
}

export class Collector {
  constructor(store, secrets, sources, domain, { root, rpcFactory } = {}) {
    this.store = store; this.secrets = secrets; this.sources = sources; this.domain = domain;
    this.root = root;
    this.rpcFactory = rpcFactory ?? (scope => new CodexRpc({ cliPath: scope.cliPath, root }));
    this.clients = new Set();
    if (!store.get('config', 'codex-scope')) store.put('config', DEFAULT_SCOPE, 'codex-scope');
  }

  scope() {
    const saved = this.store.get('config', 'codex-scope');
    return { ...saved, ...(this.store.get('config', 'codex-options') ?? DEFAULT_OPTIONS), revision: saved.revision,
      selectedThreadIds: saved.allowedThreadIds };
  }

  publicScope() {
    const saved = this.store.get('config', 'codex-scope');
    return Object.fromEntries([...Object.keys(DEFAULT_SCOPE), 'revision', 'createdAt', 'updatedAt'].map(key => [key, saved[key]]));
  }

  authorized(thread, scope) {
    if (!scope.enabled || scope.excludedThreadIds.includes(thread.id) || !scope.includeArchived && thread.archived) return false;
    let path = null;
    try { if (thread.cwd) path = projectPath(thread.cwd); } catch {}
    if (scope.excludedProjectPaths.length && !path) return false;
    if (path && scope.excludedProjectPaths.some(parent => inside(parent, path))) return false;
    return scope.allowedThreadIds.includes(thread.id) || path && scope.allowedProjectPaths.some(parent => inside(parent, path));
  }

  setScope(body) {
    onlyFields(body, Object.keys(DEFAULT_SCOPE));
    requireValue(Object.keys(DEFAULT_SCOPE).every(key => Object.hasOwn(body, key)), '七个范围字段均为必填。');
    const next = { ...body };
    requireValue(typeof next.enabled === 'boolean', 'enabled 必须为布尔值。');
    next.allowedThreadIds = strings(next.allowedThreadIds, 'allowedThreadIds', 1000, 512);
    next.excludedThreadIds = strings(next.excludedThreadIds, 'excludedThreadIds', 1000, 512);
    next.allowedProjectPaths = strings(next.allowedProjectPaths, 'allowedProjectPaths', 100, 2000).map(projectPath);
    next.excludedProjectPaths = strings(next.excludedProjectPaths, 'excludedProjectPaths', 100, 2000).map(projectPath);
    requireValue(typeof next.includeArchived === 'boolean' && typeof next.allowManualImports === 'boolean', '范围标记必须为布尔值。');
    const previous = this.scope();
    const saved = this.store.put('config', next, 'codex-scope');
    if (saved.revision !== previous.revision) this.discardPending(saved.revision);
    for (const job of this.store.all('job')) {
      if (job.status !== 'queued') continue;
      if (job.kind === 'codex_sync' || job.kind === 'manual_dialogue_import' && !next.allowManualImports) {
        this.store.put('job', { ...job, status: 'cancelled', finishedAt: now(), error: { code: 'SCOPE_FORBIDDEN', message: '采集范围已变更，尚未开始的作业已取消。', retryable: false } });
      }
    }
    return this.publicScope();
  }

  async withClient(work, scope = this.scope()) {
    const client = this.rpcFactory(scope);
    this.clients.add(client);
    try {
      await client.start();
      const prior = this.store.get('config', 'codex-check') ?? {};
      const agent = client.negotiated?.server?.userAgent ?? client.negotiated?.server?.serverInfo?.version ?? null;
      this.store.put('config', { ...prior, status: 'connected', cliVersion: typeof agent === 'string' ? agent : null, protocolVersion: 'jsonrpc-stdio', lastCheckedAt: now(),
        capabilities: prior.capabilities ?? { threadList: false, threadRead: false, visibleMessages: false, forkAncestry: false } }, 'codex-check');
      return await work(client);
    }
    catch (error) {
      const prior = this.store.get('config', 'codex-check') ?? {};
      const failure = error instanceof RpcError ? new ApiError(503, 'CAPABILITY_UNSUPPORTED', 'Codex 未提供已验证的只读能力。') : error;
      this.store.put('config', { ...prior, status: failure.code === 'CAPABILITY_UNSUPPORTED' ? 'incompatible' : 'unavailable', lastCheckedAt: now(),
        lastError: { code: failure.code ?? 'UPSTREAM_ERROR', message: 'Codex 只读连接不可用，可手工导入。', retryable: !!failure.retryable } }, 'codex-check');
      if (error instanceof RpcError) fail(503, 'CAPABILITY_UNSUPPORTED', '当前 Codex 不支持安全只读采集；可手工导入对话。');
      throw error;
    } finally { await client.close(); this.clients.delete(client); }
  }

  async listPage(client, cursor, scope) {
    if (client.verifiedStateDbOnly === false) fail(503, 'CAPABILITY_UNSUPPORTED', '尚未验证该 Codex 版本的 useStateDbOnly 行为，已在列表读取前停止。');
    const params = { cursor: cursor ?? null, limit: scope.pageSize, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true, excludedThreadIds: scope.excludedThreadIds.slice(0, 100), archived: !!scope._archived };
    try { return await this.read(client, 'thread/list', params, scope); }
    catch (error) {
      if (!unsupported(error)) throw error;
      // Older versions may reject exclusions, but must still support the non-repairing list flag.
      const { excludedThreadIds, ...legacy } = params;
      try { return await this.read(client, 'thread/list', legacy, scope); }
      catch (legacyError) {
        if (unsupported(legacyError)) fail(503, 'CAPABILITY_UNSUPPORTED', 'Codex 不支持 useStateDbOnly，已停止采集以避免修复源元数据。');
        throw legacyError;
      }
    }
  }

  discardPending(revision) {
    for (const record of this.store.all('collector-cursor')) {
      if (record.scopeRevision !== revision) this.store.remove('collector-cursor', record.id);
    }
    for (const record of this.store.all('collector-thread')) {
      if (record.scopeRevision !== undefined && record.scopeRevision !== revision) this.store.remove('collector-thread', record.id);
    }
  }

  assertScope(scope, thread = null) {
    const current = this.scope();
    if (!current.enabled || current.revision !== scope.revision || thread && !this.authorized(thread, current)) {
      this.discardPending(current.revision);
      fail(403, 'SCOPE_FORBIDDEN', '采集授权已变化，本次作业已停止。');
    }
  }

  async read(client, method, params, scope) {
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      this.assertScope(scope);
      if (client.verifiedStateDbOnly === false) fail(503, 'CAPABILITY_UNSUPPORTED', '尚未验证 Codex 只读能力，已停止采集。');
      try { result = await client.request(method, params); break; }
      catch (error) { if (attempt || !error.retryable || error instanceof RpcError) throw error; }
    }
    this.assertScope(scope);
    const previous = this.store.get('config', 'codex-check') ?? {};
    const capabilities = { ...previous.capabilities, ...(method === 'thread/list' ? { threadList: true } : { threadRead: true, visibleMessages: true }) };
    this.store.put('config', { ...previous, capabilities }, 'codex-check');
    return result;
  }

  publicThread(thread, allowed = true) {
    return this.secrets.clean({ id: String(thread.id), title: truncate(String(thread.name ?? thread.title ?? thread.preview ?? '未命名对话'), 200),
      updatedAt: iso(thread.updatedAt) ?? now(), createdAt: iso(thread.createdAt),
      projectPath: thread.cwd ?? null, archived: !!thread.archived, allowed,
      lastSyncedAt: this.store.get('collector-thread', thread.id)?.lastSyncedAt ?? null,
      parentThreadId: thread.parentThreadId ?? thread.forkedFromId ?? null, ancestryVerified: false });
  }

  queuedThread(thread) {
    // IDs and canonical paths are authorization inputs, not display strings.
    return { id: String(thread.id), title: truncate(this.secrets.redact(thread.name ?? thread.title ?? thread.preview ?? '未命名对话'), 200),
      cwd: typeof thread.cwd === 'string' ? thread.cwd : null, updatedAt: iso(thread.updatedAt), archived: !!thread.archived };
  }

  assertDiscoveryRevision(scope) {
    if (this.scope().revision !== scope.revision) fail(403, 'SCOPE_FORBIDDEN', '采集范围已变化，请重新浏览标题。');
  }

  assertDiscovery(scope, client) {
    this.assertDiscoveryRevision(scope);
    if (client.verifiedStateDbOnly !== true || client.negotiated?.readOnly === false) fail(503, 'CAPABILITY_UNSUPPORTED', 'Codex 尚未提供已验证的安全标题列表能力。');
  }

  async metadataPage(client, cursor, scope, budget) {
    const params = { cursor, limit: scope.pageSize, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true,
      excludedThreadIds: scope.excludedThreadIds.slice(0, 100), archived: !!scope._archived };
    for (let attempt = 0; attempt < 2; attempt++) {
      this.assertDiscovery(scope, client);
      budget.remaining--;
      try {
        const page = await client.request('thread/list', params);
        this.assertDiscovery(scope, client);
        return page;
      } catch (error) {
        this.assertDiscovery(scope, client);
        if (attempt || !budget.remaining || !error.retryable || error instanceof RpcError) throw error;
      }
    }
  }

  discoverable(thread, scope) {
    if (scope.excludedThreadIds.includes(thread.id) || !scope.includeArchived && thread.archived) return false;
    let path = null;
    try { if (thread.cwd) path = projectPath(thread.cwd); } catch {}
    if (scope.excludedProjectPaths.length && !path) return false;
    return !path || !scope.excludedProjectPaths.some(parent => inside(parent, path));
  }

  discoveryThread(thread, scope) {
    const display = [thread.name, thread.title, thread.preview].find(value => typeof value === 'string' && value.trim()) ?? '未命名对话';
    const parent = thread.parentThreadId ?? thread.forkedFromId;
    return this.publicThread({ id: thread.id, name: truncate(this.secrets.redact(display), 200),
      cwd: typeof thread.cwd === 'string' ? truncate(thread.cwd, 2000) : null,
      createdAt: iso(thread.createdAt), updatedAt: iso(thread.updatedAt), archived: thread.archived,
      parentThreadId: typeof parent === 'string' ? truncate(parent, 512) : null }, !!this.authorized(thread, scope));
  }

  async discovery(options = {}) {
    onlyFields(options, ['days', 'limit']);
    const days = integer(options.days ?? 7, 'days', 1, 30);
    const limit = integer(options.limit ?? 20, 'limit', 1, 50);
    const scope = { ...this.scope(), pageSize: limit };
    const cutoff = Date.now() - days * 86400000;
    const budget = { remaining: 5 };
    const client = this.rpcFactory(scope);
    this.clients.add(client);
    try {
      await client.start();
      this.assertDiscovery(scope, client);
      const result = []; const ids = new Set(); const cursors = new Set();
      let cursor = null; let archived = false;
      while (budget.remaining && result.length < limit) {
        cursors.add(JSON.stringify([archived, cursor]));
        const page = await this.metadataPage(client, cursor, { ...scope, _archived: archived }, budget);
        const entries = pageItems(page);
        if (entries.length > limit) fail(502, 'UPSTREAM_ERROR', 'Codex 标题分页超过请求上限。');
        let cutoffReached = false;
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || !entry.id.trim() || [...entry.id].length > 512 || /[\x00-\x1f\x7f]/.test(entry.id)) fail(502, 'UPSTREAM_ERROR', 'Codex 标题身份无效。');
          const updatedAt = iso(entry.updatedAt);
          if (updatedAt && +new Date(updatedAt) < cutoff) { cutoffReached = true; continue; }
          const thread = { ...entry, archived: archived || !!entry.archived };
          if (!updatedAt || ids.has(thread.id) || !this.discoverable(thread, scope)) continue;
          ids.add(thread.id); result.push(this.discoveryThread(thread, scope));
          if (result.length === limit) break;
        }
        const nextCursor = page.nextCursor ?? null;
        if (nextCursor !== null && (typeof nextCursor !== 'string' || !nextCursor.trim() || nextCursor.length > 4096 || cursors.has(JSON.stringify([archived, nextCursor])))) fail(502, 'UPSTREAM_ERROR', 'Codex 标题分页游标无效或循环。');
        if (nextCursor === null || cutoffReached) {
          if (scope.includeArchived && !archived) { archived = true; cursor = null; continue; }
          break;
        }
        cursor = nextCursor;
      }
      this.assertDiscovery(scope, client);
      return result;
    } catch (error) {
      if (error instanceof RpcError) fail(503, 'CAPABILITY_UNSUPPORTED', 'Codex 不支持安全标题浏览；未读取对话正文。');
      throw error;
    } finally { try { await client.close(); } finally { this.clients.delete(client); this.assertDiscoveryRevision(scope); } }
  }

  async threads() {
    const scope = this.scope();
    if (!scope.enabled || !scope.allowedThreadIds.length && !scope.allowedProjectPaths.length) return [];
    return this.withClient(async client => {
      const result = [];
      let cursor = null;
      let archived = false;
      for (let count = 0; count < scope.maxPages && result.length < scope.maxThreads; count++) {
        const page = await this.listPage(client, cursor, { ...scope, _archived: archived });
        const cutoff = Date.now() - scope.days * 86400000;
        const candidates = pageItems(page).map(thread => ({ ...thread, archived: archived || !!thread.archived }))
          .filter(thread => this.authorized(thread, scope) && (!iso(thread.updatedAt) || +new Date(iso(thread.updatedAt)) >= cutoff));
        result.push(...candidates.filter(thread => !result.some(item => item.id === thread.id)).map(thread => this.publicThread(thread)));
        if (!page.nextCursor) {
          if (scope.includeArchived && !archived) { archived = true; cursor = null; continue; }
          break;
        }
        if (page.nextCursor === cursor) fail(502, 'UPSTREAM_ERROR', 'Codex 重复返回同一游标。');
        cursor = page.nextCursor;
      }
      return result.slice(0, scope.maxThreads);
    }, scope);
  }

  async messageChunk(client, threadId, scope, mode, startCursor, savedCheck, startEntryOffset = 0) {
    if (mode === 'legacy' && startCursor !== null) fail(503, 'CAPABILITY_UNSUPPORTED', '旧版对话协议无法使用分页续传游标。');
    const messages = []; const seen = new Set([startCursor]);
    let cursor = startCursor; let index = startEntryOffset;
    let cursorCheck = savedCheck ?? { anchorDigest: digest(startCursor), span: 1, steps: 0 };
    for (let count = 0; count < (mode === 'legacy' ? 1 : scope.maxPages); count++) {
      const method = { items: 'thread/items/list', turns: 'thread/turns/list', legacy: 'thread/read' }[mode];
      const params = mode === 'legacy' ? { threadId, includeTurns: true }
        : { threadId, cursor, limit: scope.pageSize, sortDirection: 'asc', ...(mode === 'turns' ? { itemsView: 'full' } : {}) };
      let page;
      try { page = await this.read(client, method, params, scope); }
      catch (error) {
        this.assertScope(scope);
        if (count && unsupported(error)) fail(503, 'CAPABILITY_UNSUPPORTED', 'Codex 续传协议不可用，已保留上次检查点。');
        throw error;
      }
      let entries = mode === 'legacy' ? page?.thread?.turns ?? page?.turns : pageItems(page);
      if (mode !== 'items') {
        if (!Array.isArray(entries) || entries.some(turn => !turn || ['notLoaded', 'summary'].includes(turn.itemsView) || !Array.isArray(turn.items ?? []))) fail(503, 'CAPABILITY_UNSUPPORTED', 'Codex 未提供完整可见对话，可使用手工导入。');
        entries = entries.flatMap(turn => turn.items ?? []);
      }
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(502, 'UPSTREAM_ERROR', 'Codex 对话分页条目无效。');
        const message = visibleMessage(entry, index++);
        if (message) messages.push(message);
      }
      const nextCursor = mode === 'legacy' ? null : historyCursor(page.nextCursor);
      if (nextCursor === null) return { messages, nextCursor: null, mode, cursorCheck: null, entryOffset: index };
      if (seen.has(nextCursor)) fail(502, 'UPSTREAM_ERROR', 'Codex 重复返回对话分页游标。');
      seen.add(nextCursor); cursorCheck = advanceCursorCheck(cursorCheck, nextCursor); cursor = nextCursor;
    }
    return { messages, nextCursor: cursor, mode, cursorCheck, entryOffset: index };
  }

  async messages(client, threadId, scope, state = {}) {
    const cursor = historyCursor(state.nativeCursor);
    const entryOffset = integer(state.nativeEntryOffset ?? 0, 'nativeEntryOffset', 0, Number.MAX_SAFE_INTEGER);
    if (state.nativeMode) {
      if (!['items', 'turns', 'legacy'].includes(state.nativeMode)) fail(503, 'CAPABILITY_UNSUPPORTED', '保存的 Codex 续传协议无效。');
      return this.messageChunk(client, threadId, scope, state.nativeMode, cursor, state.nativeCursorCheck, entryOffset);
    }
    if (cursor !== null) fail(503, 'CAPABILITY_UNSUPPORTED', 'Codex 续传游标缺少绑定协议。');
    for (const mode of ['items', 'turns', 'legacy']) {
      try { return await this.messageChunk(client, threadId, scope, mode, null, null, entryOffset); }
      catch (error) { this.assertScope(scope); if (!unsupported(error)) throw error; }
    }
    fail(503, 'CAPABILITY_UNSUPPORTED', 'Codex 未提供完整可见对话，可使用手工导入。');
  }

  ingest(thread, messages, projectId = null, origin = 'codex', questionSourceId, extractCandidates = true) {
    this.domain.project(projectId, true);
    let questionSource = questionSourceId === undefined
      ? this.store.all('source').filter(item => item.kind === origin && item.threadId === thread.id && item.role === 'user').sort((a,b) => b.capturedAt.localeCompare(a.capturedAt))[0] ?? null
      : questionSourceId === null ? null : this.store.get('source', questionSourceId);
    if (questionSourceId !== undefined && questionSourceId !== null && (!questionSource || questionSource.kind !== origin || questionSource.threadId !== thread.id || questionSource.role !== 'user')) fail(409, 'INVALID_STATE', '续采的提问来源已失效，请重新选择采集范围。');
    let question = questionSource?.content ?? null;
    const results = { sources: 0, candidates: 0, updated: 0, knowledgeIds: [], capturedSourceIds: [] };
    this.store.transaction(() => {
      for (const message of messages) {
        const identity = messageIdentity(thread.id, message.id);
        const sourceId = `src_${digest([origin, identity]).slice(0, 48)}`;
        const previous = this.store.get('source', sourceId);
        const source = this.sources.capture({ kind: origin, origin: origin === 'codex' ? 'codex-app-server' : 'manual-import',
          externalId: identity, threadId: thread.id, messageId: message.id, title: thread.title ?? '导入对话',
          role: message.role, occurredAt: message.occurredAt ?? null, content: message.text });
        if (!results.capturedSourceIds.includes(source.id)) results.capturedSourceIds.push(source.id);
        if (!previous) results.sources++;
        else if (previous.contentDigest !== source.contentDigest) results.updated++;
        if (message.role === 'user') { question = source.content; questionSource = source; continue; }
        const candidateId = `kn_${digest([source.kind, source.externalId]).slice(0, 48)}`;
        if (extractCandidates && !this.store.get('knowledge', candidateId)) {
          this.sources.candidate({ source, projectId, question: question ?? `请核验：${thread.title ?? '对话摘录'}`,
            answer: source.content, refs: [...(questionSource ? [this.sources.ref(questionSource)] : []), this.sources.ref(source)] });
          results.candidates++;
          results.knowledgeIds.push(candidateId);
        }
      }
    });
    if (questionSourceId !== undefined) results.lastUserSourceId = questionSource?.id ?? null;
    return results;
  }

  async sync(scopeSnapshot = this.scope(), request = {}) {
    const scope = scopeSnapshot;
    if (!scope.enabled || !scope.allowedThreadIds.length && !scope.allowedProjectPaths.length) fail(403, 'SCOPE_FORBIDDEN', '请先启用明确选择的线程采集范围。');
    this.assertScope(scope);
    const scopeKey = digest([scope.revision, Object.fromEntries(Object.keys(DEFAULT_SCOPE).map(key => [key, scope[key]])),
      request.threadIds ? [...new Set(request.threadIds)].sort() : null, request.projectId ?? null, ...(request.captureOnly ? ['capture-only'] : [])]);
    const savedCheckpoint = this.store.get('collector-cursor', scopeKey);
    const checkpoint = savedCheckpoint?.scopeRevision === scope.revision ? savedCheckpoint : null;
    const counts = { threads: 0, sources: 0, candidates: 0, updated: 0, truncated: false, knowledgeIds: [], capturedSourceIds: [] };
    const maximumThreads = request.maxThreads ?? 20;
    const maximumMessages = request.maxMessages ?? 500;
    let captured = 0;
    return this.withClient(async client => {
      let progress = checkpoint ?? { cursor: null, archived: false, pendingThreads: null, nextCursor: null, scopeRevision: scope.revision };
      const save = () => {
        progress = { ...progress, pendingThreads: progress.pendingThreads?.map(thread => this.queuedThread(thread)) ?? null };
        return this.store.put('collector-cursor', { ...progress, lastSuccessfulPageAt: now() }, scopeKey);
      };
      const continuing = checkpoint && (checkpoint.pendingThreads !== null || checkpoint.cursor || checkpoint.archived);
      if (!continuing && request.threadIds?.length && scope.allowedProjectPaths.length) {
        const authorizedIds = new Set();
        for (const archivedState of scope.includeArchived ? [false, true] : [false]) {
          let checkCursor = null;
          for (let pageNumber = 0; pageNumber < scope.maxPages; pageNumber++) {
            const page = await this.listPage(client, checkCursor, { ...scope, _archived: archivedState });
            for (const thread of pageItems(page)) if (this.authorized(thread, scope)) authorizedIds.add(thread.id);
            if (!page.nextCursor || page.nextCursor === checkCursor) break;
            checkCursor = page.nextCursor;
          }
        }
        if (request.threadIds.some(threadId => !authorizedIds.has(threadId))) fail(403, 'SCOPE_FORBIDDEN', '请求包含未授权或不可见线程，尚未采集任何消息。');
      }
      for (let pageNumber = 0; pageNumber < scope.maxPages; pageNumber++) {
        this.assertScope(scope);
        if (counts.threads >= maximumThreads || captured >= maximumMessages) { counts.truncated = true; return counts; }
        if (progress.pendingThreads === null) {
          const page = await this.listPage(client, progress.cursor, { ...scope, _archived: progress.archived });
          const threads = pageItems(page);
          requireValue(threads.length <= scope.pageSize, 'Codex 返回的线程页超过请求上限。');
          const nextCursor = page.nextCursor ?? null;
          if (nextCursor && nextCursor === progress.cursor) fail(502, 'UPSTREAM_ERROR', 'Codex 重复返回同一游标。');
          const unique = new Map();
          for (const entry of threads) {
            const thread = this.queuedThread({ ...entry, archived: progress.archived || !!entry.archived });
            const updated = iso(thread.updatedAt);
            if (this.authorized(thread, scope) && (!request.threadIds || request.threadIds.includes(thread.id))
              && (!updated || +new Date(updated) >= Date.now() - scope.days * 86400000)) unique.set(thread.id, thread);
          }
          progress = { ...progress, pendingThreads: [...unique.values()], nextCursor };
          save();
        }
        while (progress.pendingThreads.length) {
          if (counts.threads >= maximumThreads || captured >= maximumMessages) { counts.truncated = true; return counts; }
          const thread = progress.pendingThreads[0];
          this.assertScope(scope, thread);
          const stateKey = `${scopeKey}:${thread.id}`;
          const state = this.store.get('collector-thread', stateKey);
          const chunk = await this.messages(client, thread.id, scope, state ?? {});
          const messages = chunk.messages;
          this.assertScope(scope, thread);
          let startOffset = state?.offset ?? 0;
          if (startOffset && state.lastMessageId) {
            const index = messages.findIndex(message => message.id === state.lastMessageId);
            startOffset = index < 0 ? 0 : index + 1;
            if (state.prefixDigest && digest(messages.slice(0, startOffset)) !== state.prefixDigest) startOffset = 0;
          }
          const batch = messages.slice(startOffset, startOffset + maximumMessages - captured);
          const prefixUser = messages.slice(0, startOffset).findLast(message => message.role === 'user');
          const userSourceId = prefixUser ? `src_${digest(['codex', messageIdentity(thread.id, prefixUser.id)]).slice(0, 48)}` : state?.nativeUserSourceId ?? null;
          let result;
          const hasVisibleTail = startOffset + batch.length < messages.length;
          const hasMore = hasVisibleTail || chunk.nextCursor !== null;
          this.store.transaction(() => {
            this.assertScope(scope, thread);
            result = this.ingest(this.publicThread(thread), batch, request.projectId ?? null, 'codex', userSourceId, !request.captureOnly);
            if (typeof request.onCaptured === 'function') request.onCaptured(result.capturedSourceIds);
            this.store.put('collector-thread', { offset: hasVisibleTail ? startOffset + batch.length : 0, lastSyncedAt: now(), scopeRevision: scope.revision,
              nativeCursor: hasVisibleTail ? state?.nativeCursor ?? null : chunk.nextCursor,
              nativeMode: hasMore ? chunk.mode : null, nativeCursorCheck: hasVisibleTail ? state?.nativeCursorCheck ?? null : chunk.cursorCheck,
              // These values describe the chunk start, so quota rereads keep them unchanged.
              nativeEntryOffset: hasVisibleTail ? state?.nativeEntryOffset ?? 0 : hasMore ? chunk.entryOffset : 0,
              nativeUserSourceId: hasVisibleTail ? state?.nativeUserSourceId ?? null : hasMore ? result.lastUserSourceId : null,
              lastMessageId: batch.at(-1)?.id ?? null, digest: digest(batch), prefixDigest: digest(messages.slice(0, startOffset + batch.length)) }, stateKey);
            this.store.put('collector-thread', { lastSyncedAt: now() }, thread.id);
            if (!hasMore) progress = { ...progress, pendingThreads: progress.pendingThreads.slice(1) };
            save();
          });
          captured += batch.length;
          counts.threads++;
          for (const key of ['sources', 'candidates', 'updated']) counts[key] += result[key];
          counts.knowledgeIds.push(...result.knowledgeIds);
          counts.capturedSourceIds.push(...result.capturedSourceIds.filter(sourceId => !counts.capturedSourceIds.includes(sourceId)));
          if (hasMore) { counts.truncated = true; return counts; }
        }
        const finished = !progress.nextCursor && (!scope.includeArchived || progress.archived);
        progress = { cursor: progress.nextCursor, archived: progress.nextCursor ? progress.archived : !finished,
          pendingThreads: null, nextCursor: null, scopeRevision: scope.revision };
        save();
        if (finished) return counts;
      }
      counts.truncated = true;
      return counts;
    }, scope);
  }

  validateTranscript(body) {
    onlyFields(body, ['externalSourceId', 'title', 'messages', 'projectId']);
    if (!this.scope().allowManualImports) fail(403, 'SCOPE_FORBIDDEN', '手工对话导入未获授权。');
    const threadId = text(body.externalSourceId, 'externalSourceId', 512);
    const title = text(body.title, 'title', 200);
    requireValue(Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= 500, 'messages 必须包含 1–500 条可见消息。');
    const ids = new Set();
    const messages = body.messages.map(message => {
      onlyFields(message, ['sourceMessageId', 'role', 'content', 'occurredAt']);
      const messageId = text(message.sourceMessageId, 'sourceMessageId', 512);
      requireValue(!ids.has(messageId), '同一导入内消息 ID 不能重复。');
      ids.add(messageId);
      const occurredAt = message.occurredAt === undefined || message.occurredAt === null ? null : iso(message.occurredAt);
      requireValue(message.occurredAt === undefined || message.occurredAt === null || occurredAt, 'occurredAt 无效。');
      return { id: messageId, role: choice(message.role, ['user', 'assistant'], 'role'), text: text(message.content, 'content', 20000), occurredAt };
    });
    this.domain.project(body.projectId ?? null, true);
    return { threadId, title, messages, projectId: body.projectId ?? null };
  }

  importTranscript(body) {
    const { threadId, title, messages, projectId } = this.validateTranscript(body);
    const result = this.ingest({ id: threadId, title }, messages, projectId, 'manual_dialogue');
    return { ...result, origin: 'manual-import', threadId };
  }

  async close() { await Promise.all([...this.clients].map(client => client.close())); }
}
