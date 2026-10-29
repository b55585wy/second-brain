import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { Store } from './store.mjs';
import { Secrets } from './secrets.mjs';
import { Settings } from './settings.mjs';
import { Sources } from './sources.mjs';
import { Domain, PROJECT_STATUSES, KNOWLEDGE_STATUSES } from './domain.mjs';
import { Transport } from './transport.mjs';
import { Siyuan } from './siyuan.mjs';
import { Feishu } from './feishu.mjs';
import { Model } from './model.mjs';
import { Collector } from './collector.mjs';
import { Learning } from './learning.mjs';
import { Jobs } from './jobs.mjs';
import { Reviews } from './reviews.mjs';
import { Backup } from './backup.mjs';
import { Scheduler } from './scheduler.mjs';
import { Automation } from './automation.mjs';
import { Http, response } from './http.mjs';
import { FIELDS, dto, select } from './dto.mjs';
import { list, onlyFields, expectedRevision, choice, integer, text, strings, dateInZone, now, digest } from './validation.mjs';
import { fail, requireValue, publicError } from './errors.mjs';
import { assessRelevance, rankMaterials, relevanceDto } from './relevance.mjs';

const PAGE = ['limit', 'offset'];

function input(body, fields, record = null) {
  onlyFields(body, [...fields, 'operationId', ...(record ? ['expectedRevision'] : [])]);
  if (record) expectedRevision(body.expectedRevision, record);
  return Object.fromEntries(Object.entries(body).filter(([key]) => !['operationId', 'expectedRevision'].includes(key)));
}

function filter(items, query, searchFields = []) {
  const q = query.get('q')?.trim().toLocaleLowerCase() ?? '';
  requireValue([...q].length <= 200, '搜索文本最多 200 字符。');
  let result = q ? items.filter(item => searchFields.some(key => typeof item[key] === 'string' && item[key].toLocaleLowerCase().includes(q))) : items;
  for (const key of ['projectId', 'practiceId', 'status', 'kind', 'type', 'projectPath']) if (query.has(key)) result = result.filter(item => item[key] === query.get(key));
  return list(result, query);
}

export function createApp(options = {}) {
  const root = options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = options.dataDir ?? resolve(root, 'data');
  let version = '0.0.0';
  try { version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version ?? version; } catch {}
  const store = new Store(options.dbPath ?? resolve(dataDir, 'second-brain.sqlite'));
  const secrets = new Secrets(options.secretsPath ?? resolve(dataDir, 'secrets/credentials.json'));
  const settings = new Settings(store, secrets, root);
  const sources = new Sources(store, secrets);
  const domain = new Domain(store, secrets, sources);
  const transport = new Transport(options.transport ?? {});
  const siyuan = new Siyuan(store, settings, secrets, transport);
  const feishu = new Feishu(settings, secrets, transport);
  const model = new Model(settings, secrets, transport);
  const collector = new Collector(store, secrets, sources, domain, { root, rpcFactory: options.rpcFactory });
  if (options.collectorOptions) store.put('config', options.collectorOptions, 'codex-options');
  const learning = new Learning(store, domain, sources, siyuan, model, settings);
  const jobs = new Jobs(store, settings);
  const reviews = new Reviews(store, domain, siyuan, jobs, learning);
  const backup = new Backup(store, domain, sources, secrets, jobs, version);
  const automation = new Automation(store, settings, domain, sources, collector, learning, model, jobs, { clock: options.automationClock });
  const scheduler = new Scheduler(store, settings, domain, learning, collector, jobs, automation);
  const http = new Http(store, secrets, { root, frontendDir: options.frontendDir ?? resolve(root, 'frontend/dist'), port: options.port ?? 18997, origin: options.origin });
  const route = (method, path, handler, config) => http.route(method, path.startsWith('/api/') ? path : `/api/v1${path}`, handler, config);
  const sourceDto = record => ({ ...sources.ref(record), projectId: record.projectId ?? null, text: record.content ?? '', revision: record.revision, updatedAt: record.updatedAt });

  const collectionResult = result => ({ sourcesCreated: result.sources, sourcesUpdated: result.updated, inheritedAliasesCreated: 0,
    candidatesCreated: result.candidates, knowledgeIds: result.knowledgeIds ?? [], hasMore: !!result.truncated,
    checkpoints: store.all('collector-thread').filter(item => item.lastMessageId).map(item => ({ sourceKey: item.id, lastMessageId: item.lastMessageId, digest: item.digest, updatedAt: item.updatedAt })),
    notices: [{ code: 'MANUAL_REVIEW_REQUIRED', message: '来源和摘录草稿均未经事实核验，请明确审核。' }, { code: 'ANCESTRY_UNAVAILABLE', message: '未使用未经证明的跨线程继承去重。' }] });

  jobs.register('manual_dialogue_import', payload => collectionResult(collector.importTranscript(payload)));
  jobs.register('learning_automation', (payload, job) => automation.run(payload, job));
  jobs.register('codex_sync', async (payload, job) => {
    if (automation.config().enabled && (job?.trigger === 'scheduler' || payload.trigger === 'scheduler')) return {
      ...collectionResult({ sources: 0, updated: 0, candidates: 0, truncated: false, knowledgeIds: [] }),
      notices: [{ code: 'SUPERSEDED_BY_AUTOMATION', message: '自动整理已开启，本次旧定时采集已跳过。' }],
    };
    const result = collectionResult(await collector.sync(payload.scope, payload.request));
    const state = store.get('config', 'codex-check') ?? {};
    store.put('config', { ...state, lastSyncAt: now() }, 'codex-check');
    return result;
  });
  jobs.register('source_import', async payload => {
    domain.project(payload.projectId, true);
    const fields = payload.kind === 'feishu_document' ? await feishu.source(payload.url) : await siyuan.source(payload.blockId ?? payload.documentId, payload.connectionEpoch);
    return store.transaction(() => {
      if (payload.kind !== 'feishu_document') siyuan.assertEpoch(payload.connectionEpoch);
      const source = sources.capture({ ...fields, projectId: payload.projectId });
      let knowledge = null;
      const existingCandidate = store.get('knowledge', `kn_${digest([source.kind, source.externalId]).slice(0, 48)}`);
      if (payload.extractCandidates !== false && source.content.trim()) knowledge = sources.candidate({ source, projectId: payload.projectId,
        question: `请核验来源“${source.title}”中的以下摘录。`, answer: source.content.slice(0, 20000) });
      return { sourceIds: [source.id], knowledgeIds: knowledge ? [knowledge.id] : [], candidatesCreated: knowledge && !existingCandidate ? 1 : 0,
        notices: [{ code: 'MANUAL_REVIEW_REQUIRED', message: knowledge ? '本地摘录模板形成了草稿；没有验证、接受或修改来源。' : '已保存来源，请手工选择材料并审核。' }] };
    });
  });
  jobs.register('knowledge_sync', (payload, job) => siyuan.sync(payload.knowledgeId, payload.knowledgeRevision, job.id, payload.connectionEpoch));
  jobs.register('daily_plan_generate', async (payload, job) => ({ plan: dto('plans', await learning.generate(payload, job)) }));
  jobs.register('practice_feedback', async payload => ({ feedback: dto('feedback', (await learning.feedback(payload.attemptId, payload.request)).feedback) }));
  jobs.register('review_response', async (payload, job) => {
    const result = await reviews.grade(payload, job);
    return { response: dto('reviewResponses', result.response) };
  });
  jobs.register('reconcile', async payload => {
    const original = store.require('job', payload.originalJobId);
    siyuan.assertEpoch(original.payload.connectionEpoch);
    if (original.status !== 'uncertain') fail(409, 'INVALID_STATE', '原作业不再处于待确认状态。');
    if (original.kind === 'review_response') await reviews.reconcile(original.id);
    else if (original.kind === 'knowledge_sync') {
      const target = store.get('sync-target', original.payload.knowledgeId);
      if (target?.docId) await siyuan.call('/api/attr/getBlockAttrs', { id: target.docId }, true, original.payload.connectionEpoch);
    }
    return { originalJobId: original.id, resolution: 'still_uncertain', checkedAt: now(), reason: '现有原生读取证据尚不能证明全部写入步骤；保持阻塞，不重放远端操作。' };
  });

  route('GET', '/api/health', () => ({ status: 'ok', version, apiVersion: 'v1', stage: existsSync(resolve(root, 'frontend/dist/index.html')) ? 'ready' : 'development', time: now(), dependencies: { database: 'ok', siyuan: settings.connectionStatus().siyuan.status } }));
  route('GET', '/learning-profile', () => dto('profile', domain.profile()));
  route('PUT', '/learning-profile', ({ body }) => dto('profile', domain.updateProfile(input(body, FIELDS.profile.filter(key => !['revision', 'createdAt', 'updatedAt'].includes(key)), domain.profile()))));
  route('GET', '/learning-profile/revisions', ({ query }) => list(store.all('profile-revision').sort((a, b) => b.profileRevision - a.profileRevision).map(record => dto('profileRevisions', record)), query), { query: PAGE });

  route('GET', '/projects', ({ query }) => {
    if (query.has('status')) choice(query.get('status'), PROJECT_STATUSES, 'status');
    return list(domain.search('project', query).map(record => dto('projects', record)), query);
  }, { query: [...PAGE, 'q', 'status'] });
  route('GET', '/projects/:id', ({ params }) => dto('projects', domain.project(params.id)));
  route('POST', '/projects', ({ body }) => dto('projects', domain.createProject(input(body, ['title', 'goal', 'status']))), { status: 201 });
  route('PATCH', '/projects/:id', ({ params, body }) => dto('projects', domain.updateProject(params.id, input(body, ['title', 'goal', 'status'], domain.project(params.id)))));
  route('DELETE', '/projects/:id', ({ params, body }) => { input(body, [], domain.project(params.id)); return domain.deleteProject(params.id); });
  route('GET', '/projects/:id/checkpoints', ({ params, query }) => { domain.project(params.id); return list(store.all('checkpoint').filter(record => record.projectId === params.id).map(record => dto('checkpoints', record)), query); }, { query: PAGE });
  route('POST', '/projects/:id/checkpoints', ({ params, body }) => dto('checkpoints', domain.checkpoint(params.id, input(body, ['progress', 'nextAction', 'openQuestion']))), { status: 201 });

  route('GET', '/knowledge', ({ query }) => {
    if (query.has('status')) choice(query.get('status'), KNOWLEDGE_STATUSES, 'status');
    if (query.has('projectId')) domain.project(query.get('projectId'));
    if (query.has('sourceKind')) choice(query.get('sourceKind'), ['codex', 'manual_dialogue', 'siyuan', 'feishu', 'manual'], 'sourceKind');
    if (query.has('validationStatus')) choice(query.get('validationStatus'), ['unverified', 'supported', 'contradicted', 'mixed'], 'validationStatus');
    return list(rankMaterials(domain.search('knowledge', query), domain.profile())
      .map(({ fact, relevance }) => ({ ...dto('knowledge', fact), relevance: relevanceDto(relevance) })), query);
  }, { query: [...PAGE, 'q', 'projectId', 'status', 'sourceKind', 'validationStatus'] });
  route('GET', '/knowledge/:id', ({ params }) => {
    const record = store.require('knowledge', params.id);
    return { ...dto('knowledge', record), relevance: relevanceDto(assessRelevance(record, domain.profile())) };
  });
  route('POST', '/knowledge', ({ body }) => dto('knowledge', domain.createKnowledge(input(body, ['projectId', 'question', 'answer', 'sourceRefs']))), { status: 201 });
  route('PATCH', '/knowledge/:id', ({ params, body }) => dto('knowledge', domain.updateKnowledge(params.id, input(body, ['projectId', 'question', 'answer', 'sourceRefs', 'status', 'validation'], store.require('knowledge', params.id)))));
  route('POST', '/knowledge/:id/decision', ({ params, body }) => {
    const data = input(body, ['decision'], store.require('knowledge', params.id));
    return dto('knowledge', domain.decide(params.id, { ...data, operationId: body.operationId }));
  });
  route('POST', '/knowledge/:id/sync', ({ params, body }) => {
    const record = store.require('knowledge', params.id); input(body, [], record);
    domain.project(record.projectId, true);
    if (record.status !== 'accepted') fail(409, 'INVALID_STATE', '只有已接受的知识可以同步。');
    if (!settings.siyuan().baseUrl) fail(503, 'CONNECTION_UNAVAILABLE', '尚未配置 SiYuan。');
    return jobs.enqueue('knowledge_sync', { knowledgeId: record.id, knowledgeRevision: record.revision }, body.operationId, `knowledge:${record.id}`);
  }, { status: 202 });

  route('GET', '/connections', ({ query }) => list(settings.connections(), query), { query: PAGE });
  route('PUT', '/connections/siyuan', ({ body }) => settings.configureSiyuan(input(body, ['useRuntimeConnection', 'baseUrl', 'notebookTitle', 'token'], settings.siyuan())));
  route('POST', '/connections/siyuan/check', async ({ body }) => {
    input(body, []);
    const epoch = siyuan.epoch();
    const checks = { version: 'not_checked', auth: 'not_checked', notebooks: 'not_checked', riff: 'not_checked' };
    const notices = [];
    try {
      const result = await siyuan.check(epoch); checks.version = result.riffCompatible ? 'passed' : 'failed';
      await siyuan.notebooks(epoch); checks.auth = 'passed'; checks.notebooks = 'passed';
      if (result.riffCompatible) { await siyuan.call('/api/riff/getRiffDecks', {}, true, epoch); checks.riff = 'passed'; }
      else notices.push({ code: 'RIFF_INCOMPATIBLE', message: '当前 SiYuan 版本不支持固定的复习契约。' });
    } catch (error) {
      const current = settings.siyuan();
      if (current.connectionEpoch !== epoch) throw error;
      if (checks.version === 'not_checked') checks.version = 'failed';
      if (checks.auth === 'not_checked') checks.auth = 'failed';
      const saved = store.get('config', 'siyuan-check') ?? {};
      if (current.baseUrl) store.put('config', { ...saved, status: 'unavailable', connectionEpoch: epoch, lastError: publicError(error).body.error, checkedAt: now() }, 'siyuan-check');
      notices.push({ code: 'SIYUAN_UNAVAILABLE', message: '连接检查未通过，手工功能仍可使用。' });
    }
    if (settings.siyuan().baseUrl) siyuan.assertEpoch(epoch);
    return { connection: settings.connectionStatus().siyuan, checks, notices };
  }, { asyncRead: true });
  route('GET', '/siyuan/notebooks', async ({ query }) => list(await siyuan.notebooks(), query), { query: PAGE });
  route('POST', '/sources/import', ({ body }) => {
    const data = input(body, ['projectId', 'kind', 'documentId', 'blockId', 'url', 'extractCandidates']);
    choice(data.kind, ['siyuan_document', 'siyuan_block', 'feishu_document'], 'kind');
    domain.project(data.projectId, true);
    requireValue(data.projectId === null || typeof data.projectId === 'string', 'projectId 必须为 ID 或 null。');
    requireValue(data.extractCandidates === undefined || typeof data.extractCandidates === 'boolean', 'extractCandidates 必须为布尔值。');
    if (data.kind === 'feishu_document') {
      onlyFields(data, ['projectId', 'kind', 'url', 'extractCandidates']); feishu.selectedDocument(data.url);
      const config = settings.public().feishu;
      if (!config.enabled || !config.appId || !config.appSecretConfigured) fail(503, 'CONNECTION_UNAVAILABLE', '飞书尚未配置或启用。');
    } else {
      const field = data.kind === 'siyuan_block' ? 'blockId' : 'documentId';
      onlyFields(data, ['projectId', 'kind', field, 'extractCandidates']);
      requireValue(typeof data[field] === 'string' && /^\d{14}-[a-z0-9]{7}$/.test(data[field]), 'SiYuan 文档/块 ID 无效。');
      if (!settings.siyuan().baseUrl) fail(503, 'CONNECTION_UNAVAILABLE', '尚未配置 SiYuan。');
    }
    return jobs.enqueue('source_import', data, body.operationId, `source:${data.kind}:${data.blockId ?? data.documentId ?? data.url}`);
  }, { status: 202 });
  route('GET', '/sources', ({ query }) => {
    let items = store.all('source');
    const page = filter(items, query, ['title', 'content']);
    return { ...page, items: page.items.map(record => sources.ref(record)) };
  }, { query: [...PAGE, 'q', 'kind', 'projectId'] });
  route('GET', '/sources/:id', ({ params }) => sourceDto(store.require('source', params.id)));

  route('GET', '/connections/codex/scope', () => collector.publicScope());
  route('PUT', '/connections/codex/scope', ({ body }) => collector.setScope(input(body, ['enabled', 'allowedThreadIds', 'allowedProjectPaths', 'excludedThreadIds', 'excludedProjectPaths', 'includeArchived', 'allowManualImports'], store.require('config', 'codex-scope'))));
  route('GET', '/codex/threads', async ({ query }) => filter(await collector.threads(), query, ['title']), { query: [...PAGE, 'q', 'projectPath'] });
  route('GET', '/codex/discovery', async ({ query }) => {
    const options = Object.fromEntries([...query].map(([key, value]) => {
      requireValue(/^\d+$/.test(value), '标题浏览参数必须为整数。');
      return [key, Number(value)];
    }));
    const items = await collector.discovery(options);
    return { items, total: items.length };
  }, { query: ['days', 'limit'] });
  route('POST', '/codex/sync', ({ body }) => {
    const request = input(body, ['threadIds', 'projectId', 'maxThreads', 'maxMessages']);
    const scope = collector.scope();
    if (!scope.enabled || !scope.allowedThreadIds.length && !scope.allowedProjectPaths.length) fail(403, 'SCOPE_FORBIDDEN', '尚未启用明确的采集范围。');
    if (request.threadIds !== undefined) {
      request.threadIds = strings(request.threadIds, 'threadIds', 100, 512);
      requireValue(request.threadIds.length, 'threadIds 不能为空。');
      if (request.threadIds.some(threadId => scope.excludedThreadIds.includes(threadId) || !scope.allowedProjectPaths.length && !scope.allowedThreadIds.includes(threadId))) fail(403, 'SCOPE_FORBIDDEN', '请求包含未授权线程。');
    }
    request.maxThreads = integer(request.maxThreads ?? 20, 'maxThreads', 1, 100);
    request.maxMessages = integer(request.maxMessages ?? 500, 'maxMessages', 1, 1000);
    domain.project(request.projectId ?? null, true);
    return jobs.enqueue('codex_sync', { scope, request }, body.operationId, `codex:${scope.revision}`);
  }, { status: 202 });
  route('POST', '/codex/manual-import', ({ body }) => {
    const data = input(body, ['projectId', 'title', 'externalSourceId', 'messages']);
    collector.validateTranscript(data);
    return jobs.enqueue('manual_dialogue_import', data, body.operationId, `manual:${data.externalSourceId}`);
  }, { status: 202 });
  route('GET', '/connections/codex/options', () => store.get('config', 'codex-options') ?? { revision: 0, cliPath: null, days: 7, maxThreads: 20, pageSize: 100, maxPages: 20 });
  route('PUT', '/connections/codex/options', ({ body }) => {
    const current = store.get('config', 'codex-options') ?? { revision: 0 };
    const data = input(body, ['cliPath', 'days', 'maxThreads', 'pageSize', 'maxPages'], current);
    if (data.cliPath !== null) text(data.cliPath, 'cliPath', 2000);
    integer(data.days, 'days', 1, 90); integer(data.maxThreads, 'maxThreads', 1, 100); integer(data.pageSize, 'pageSize', 1, 100); integer(data.maxPages, 'maxPages', 1, 20);
    return store.put('config', data, 'codex-options');
  });

  route('GET', '/daily-plan', ({ query }) => dto('plans', learning.plan(query.get('date') ?? undefined, query.get('timeZone') ?? undefined)), { query: ['date', 'timeZone'] });
  route('POST', '/daily-plan/generate', ({ body }) => {
    const payload = learning.validateGeneration(input(body, ['date', 'expectedProfileRevision', 'expectedPlanRevision', 'mode', 'allowTemplateFallback']));
    return jobs.enqueue('daily_plan_generate', payload, body.operationId, `plan:${payload.date}:${payload.timeZone}`);
  }, { status: 202 });
  route('GET', '/practices', ({ query }) => filter(store.all('practice').map(record => ({ ...dto('practices', record),
    ...(record.provenance?.label ? { selectionReason: record.provenance.label } : {}) })), query, ['prompt', 'goal', 'skill']), { query: [...PAGE, 'q', 'projectId', 'kind', 'status'] });
  route('POST', '/practices', ({ body }) => dto('practices', learning.createPractice(input(body, ['projectId', 'kind', 'goal', 'skill', 'prompt', 'estimatedMinutes', 'rubric', 'sourceRefs']))), { status: 201 });
  route('GET', '/practices/:id/attempts', ({ params, query }) => { store.require('practice', params.id); return list(store.all('attempt').filter(record => record.practiceId === params.id).map(record => dto('attempts', record)), query); }, { query: PAGE });
  route('POST', '/practices/:id/attempts', ({ params, body }) => dto('attempts', learning.attempt(params.id, input(body, ['output', 'assistanceLevel', 'evidenceRefs']))), { status: 201 });
  route('POST', '/attempts/:id/feedback', ({ params, body }) => {
    store.require('attempt', params.id);
    const request = input(body, ['mode', 'allowTemplateFallback', 'manual']);
    choice(request.mode, ['template', 'model', 'manual'], 'mode');
    requireValue(request.mode === 'manual' ? request.manual : request.manual === undefined, 'manual 字段与反馈模式不匹配。');
    learning.validateFeedback(params.id, request);
    return jobs.enqueue('practice_feedback', { attemptId: params.id, request }, body.operationId, `feedback:${params.id}`);
  }, { status: 202 });
  route('GET', '/outputs', ({ query }) => filter(store.all('output').map(record => dto('outputs', record)), query, ['title', 'content', 'goal']), { query: [...PAGE, 'q', 'projectId', 'practiceId', 'status'] });
  route('POST', '/outputs', ({ body }) => dto('outputs', learning.output(input(body, ['projectId', 'practiceId', 'title', 'content', 'goal', 'status', 'sourceRefs', 'evidenceRefs']))), { status: 201 });
  route('PATCH', '/outputs/:id', ({ params, body }) => dto('outputs', learning.output(input(body, ['projectId', 'practiceId', 'title', 'content', 'goal', 'status', 'sourceRefs', 'evidenceRefs'], store.require('output', params.id)), params.id)));

  route('POST', '/review-sessions', async ({ body }) => {
    const result = await reviews.create(input(body, ['projectId', 'limit']));
    return response(result.session, result.reused ? 200 : 201);
  }, { asyncRead: true });
  route('GET', '/review-sessions/:id/next', ({ params }) => reviews.next(params.id));
  route('POST', '/review-sessions/:id/reveal', ({ params, body }) => reviews.reveal(params.id, input(body, ['presentationId', 'cardId'])));
  route('POST', '/review-sessions/:id/responses', ({ params, body }) => reviews.queueResponse(params.id, input(body, ['presentationId', 'cardId', 'rating', 'elapsedMs', 'answer']), body.operationId), { status: 202 });

  route('GET', '/settings', () => settings.public());
  route('GET', '/automation', () => automation.public());
  route('PUT', '/automation', ({ body }) => automation.update(input(body, ['enabled'], automation.config())));
  route('GET', '/today', () => automation.today());
  route('PUT', '/settings', ({ body }) => settings.update(input(body, ['model', 'feishu', 'scheduler'], settings.raw())));
  route('GET', '/jobs/:id', ({ params }) => jobs.public(params.id));
  route('GET', '/jobs', ({ query }) => filter(store.all('job').map(record => jobs.public(record.id)), query), { query: [...PAGE, 'status', 'type'] });
  route('POST', '/jobs/:id/reconcile', ({ params, body }) => {
    input(body, []);
    const original = store.require('job', params.id);
    if (original.status !== 'uncertain' || !['review_response', 'knowledge_sync'].includes(original.kind)) fail(409, 'INVALID_STATE', '该作业不支持安全调和。');
    return jobs.enqueue('reconcile', { originalJobId: original.id }, body.operationId, `reconcile:${original.id}`);
  }, { status: 202 });

  route('POST', '/exports', ({ body }) => {
    const result = backup.export(input(body, ['scope', 'projectIds', 'includeSourceContent']));
    return response(result.artifact, 200, { Location: `/api/v1/exports/${result.id}` });
  });
  route('GET', '/exports/:id', ({ params }) => {
    const record = store.require('export', params.id);
    return select(record, ['filename', 'mediaType', 'schemaVersion', 'content', 'byteLength', 'sha256']);
  });
  route('POST', '/imports', ({ body }) => backup.import(input(body, ['document', 'mode', 'applyProfile', 'expectedProfileRevision'])));
  route('GET', '/dashboard', async () => {
    const profile = domain.profile();
    let reviewDue = null;
    const warnings = [];
    try { reviewDue = reviews.eligible((await siyuan.dueCards()).cards, null).length; }
    catch { warnings.push({ code: 'SIYUAN_UNAVAILABLE', message: '尚未获得真实到期数量。' }); }
    return { date: dateInZone(new Date(), profile.timeZone), timeZone: profile.timeZone, profile: dto('profile', profile),
      summary: { projectsActive: store.all('project').filter(item => item.status === 'active').length,
        knowledgeDraft: store.all('knowledge').filter(item => item.status === 'draft').length, knowledgeAccepted: store.all('knowledge').filter(item => item.status === 'accepted').length,
        knowledgeNeedsRecheck: store.all('knowledge').filter(item => item.status === 'needs_recheck').length, reviewDue,
        practiceOpen: store.all('practice').filter(item => item.status === 'open').length, outputsDraft: store.all('output').filter(item => item.status === 'draft').length },
      dailyPlan: dto('plans', learning.plan()), recentCheckpoints: store.all('checkpoint').slice(0, 5).map(record => dto('checkpoints', record)), connections: settings.connections(), warnings };
  });

  let closed = false;
  return { server: http.server, store, secrets, settings, sources, domain, siyuan, feishu, model, collector, learning, jobs, reviews, backup, scheduler, automation,
    async listen(port) { const address = await http.listen(port); jobs.start(); if (options.scheduler !== false) scheduler.start(); return address; },
    async close() { if (closed) return; closed = true; scheduler.stop(); await collector.close(); await http.close(); await jobs.stop(); store.close(); },
    get origin() { return http.origin; }, version,
  };
}
