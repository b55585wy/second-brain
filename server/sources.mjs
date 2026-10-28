import { digest, id, now, choice, onlyFields, object, text, truncate } from './validation.mjs';
import { fail, requireValue } from './errors.mjs';

export const UNVERIFIED = { status: 'unverified', method: 'none', notes: '', evidenceRefs: [], checkedAt: null, checkedBy: null };
export const NOT_SYNCED = { status: 'not_synced', lastSyncedRevision: null, lastSyncedAt: null, jobId: null, lastError: null };

export function referenceUrl(value) {
  if (value === null || value === undefined) return null;
  text(value, 'url', 2000);
  let url;
  try { url = new URL(value); } catch { fail(422, 'VALIDATION_ERROR', '引用 URL 无效。'); }
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash, '引用 URL 只允许无凭据的 http/https。');
  for (const key of url.searchParams.keys()) requireValue(!/token|key|secret|password|auth/i.test(key), '引用 URL 不得包含凭据。');
  return url.href;
}

export class Sources {
  constructor(store, secrets) { this.store = store; this.secrets = secrets; }

  ref(source) {
    const result = {};
    for (const key of ['kind', 'externalId', 'title', 'url', 'threadId', 'messageId', 'documentId', 'blockId', 'excerpt', 'contentDigest', 'role', 'occurredAt', 'capturedAt', 'redacted']) result[key] = source[key] ?? null;
    return { sourceId: source.id, ...result };
  }

  inputs(value) {
    requireValue(Array.isArray(value) && value.length <= 50, 'sourceRefs 最多 50 项。');
    return value.map(input => {
      object(input, 'sourceRefs');
      if ('sourceId' in input) {
        onlyFields(input, ['sourceId']);
        const source = this.store.get('source', text(input.sourceId, 'sourceId', 128));
        requireValue(source, '引用的来源不存在。');
        return this.ref(source);
      }
      onlyFields(input, ['kind', 'title', 'url', 'excerpt']);
      choice(input.kind, ['manual'], 'kind');
      const title = text(input.title, 'title', 200);
      const url = referenceUrl(input.url);
      const excerpt = input.excerpt === null ? null : text(input.excerpt, 'excerpt', 2000, true);
      requireValue(url || excerpt?.trim(), '手工来源至少需要 URL 或摘录。');
      return this.ref(this.capture({ kind: 'manual', externalId: id(), title, url, content: excerpt ?? '', excerpt }));
    });
  }

  capture(fields) {
    const rawContent = text(fields.content, 'source content', 1024 * 1024, true);
    if (Buffer.byteLength(rawContent) > 1024 * 1024) fail(413, 'PAYLOAD_TOO_LARGE', '来源文本超过 1 MiB。');
    const content = this.secrets.redact(rawContent).replace(/\r\n/g, '\n');
    const contentDigest = digest(content);
    const sourceId = `src_${digest([fields.kind, fields.externalId]).slice(0, 48)}`;
    const existing = this.store.get('source', sourceId);
    if (existing?.contentDigest === contentDigest) return existing;
    if (existing) this.store.put('source-version', { sourceId, sourceRevision: existing.revision, snapshot: existing }, `${sourceId}-${existing.revision}`);
    const source = this.store.put('source', this.secrets.clean({
      kind: fields.kind, externalId: fields.externalId, title: truncate(text(fields.title, 'source title', 10000), 200), projectId: fields.projectId ?? null,
      url: fields.url ?? null, threadId: fields.threadId ?? null, messageId: fields.messageId ?? null,
      documentId: fields.documentId ?? null, blockId: fields.blockId ?? null,
      excerpt: fields.excerpt === null ? null : fields.excerpt ?? truncate(content, 2000),
      content, contentDigest, role: fields.role ?? null, occurredAt: fields.occurredAt ?? null,
      capturedAt: now(), redacted: content !== rawContent, origin: fields.origin ?? fields.kind,
    }), sourceId);
    if (existing) this.invalidate(source);
    return source;
  }

  invalidate(source) {
    for (const record of this.store.all('knowledge')) {
      if (!record.sourceRefs.some(ref => ref.sourceId === source.id)) continue;
      this.store.put('knowledge-audit', { knowledgeId: record.id, kind: 'source_changed', previousValidation: record.validation, sourceId: source.id, at: now() });
      this.store.put('knowledge', { ...record,
        status: record.status === 'accepted' ? 'needs_recheck' : record.status,
        validation: { ...UNVERIFIED }, sourceChangedAt: now(),
        sync: { ...record.sync, status: record.siyuanBlockId ? 'stale' : record.sync.status },
      });
    }
  }

  evidence(value) {
    requireValue(Array.isArray(value) && value.length <= 50, 'evidenceRefs 最多 50 项。');
    return value.map(input => {
      onlyFields(input, ['kind', 'id', 'url', 'label']);
      const kind = choice(input.kind, ['source', 'output', 'url'], 'kind');
      const label = text(input.label, 'label', 200);
      if (kind === 'url') {
        requireValue(input.id === null, 'URL 证据 id 必须为 null。');
        const url = referenceUrl(input.url);
        requireValue(url, 'URL 证据必须填写 url。');
        return { kind, id: null, url, label };
      }
      requireValue(input.url === null, '本地证据 url 必须为 null。');
      const recordId = text(input.id, 'id', 128);
      requireValue(this.store.get(kind, recordId), '引用的本地证据不存在。');
      return { kind, id: recordId, url: null, label };
    });
  }

  validation(input) {
    onlyFields(input, ['status', 'method', 'notes', 'evidenceRefs']);
    const status = choice(input.status, ['unverified', 'supported', 'contradicted', 'mixed'], 'validation.status');
    const method = choice(input.method, ['none', 'user_review', 'source_check', 'executable_evidence'], 'validation.method');
    const evidenceRefs = this.evidence(input.evidenceRefs);
    const notes = text(input.notes, 'notes', 10000, true);
    requireValue(status === 'unverified' || method !== 'none' && evidenceRefs.length, '校验结论必须有证据和校验方法。');
    return { status, method, notes, evidenceRefs, checkedAt: status === 'unverified' ? null : now(), checkedBy: status === 'unverified' ? null : 'user' };
  }

  candidate({ source, question, answer, projectId = null, refs = [this.ref(source)] }) {
    const candidateId = `kn_${digest([source.kind, source.externalId]).slice(0, 48)}`;
    const existing = this.store.get('knowledge', candidateId);
    if (existing) return existing;
    return this.store.put('knowledge', this.secrets.clean({
      projectId, question: truncate(question, 2000), answer: truncate(answer, 20000), sourceRefs: refs,
      status: 'draft', origin: source.kind, siyuanBlockId: null, validation: { ...UNVERIFIED },
      lastDecision: null, sync: { ...NOT_SYNCED },
    }), candidateId);
  }
}
