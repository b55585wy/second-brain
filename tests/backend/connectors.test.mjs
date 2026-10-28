import test from 'node:test';
import assert from 'node:assert/strict';
import { appFor, ok, request, fakeServer, fakeSiyuan, configureSiyuan, syncedKnowledge, jobDone, settings, knowledge } from './helpers.mjs';

test('SiYuan uses POST/Token, checks HTTP-200 codes, flushes indexes and preserves originals', async t => {
  const upstream = await fakeSiyuan(t);
  const app = await appFor(t);
  const connection = await configureSiyuan(app, upstream, 'test-token-siyuan-secret');
  assert.equal(connection.tokenConfigured, true); assert.equal(connection.token, undefined);
  const checked = await ok(app, 'POST', '/connections/siyuan/check', {});
  assert.equal(checked.checks.version, 'passed'); assert.equal(checked.checks.auth, 'passed'); assert.equal(upstream.state.notebooks.length, 0);
  const imported = await jobDone(app, await ok(app, 'POST', '/sources/import', { projectId: null, kind: 'siyuan_block', blockId: upstream.state.originalId }, 202));
  assert.equal(imported.result.candidatesCreated, 1);
  let candidate = await ok(app, 'GET', '/knowledge/' + imported.result.knowledgeIds[0]);
  assert.equal(candidate.status, 'draft'); assert.equal(candidate.validation.status, 'unverified'); assert.ok(candidate.sourceRefs.length);
  candidate = await ok(app, 'POST', `/knowledge/${candidate.id}/decision`, { expectedRevision: candidate.revision, decision: 'accept' });
  await jobDone(app, await ok(app, 'POST', `/knowledge/${candidate.id}/sync`, { expectedRevision: candidate.revision }, 202));
  assert.equal(upstream.state.cards.length, 1); assert.equal(upstream.state.notebooks.length, 1);
  for (const call of upstream.calls) { assert.equal(call.method, 'POST'); assert.equal(call.headers.authorization, 'Token test-token-siyuan-secret'); }
  for (let index = 0; index < upstream.calls.length; index++) if (upstream.calls[index].path === '/api/query/sql') assert.equal(upstream.calls[index - 1].path, '/api/sqlite/flushTransaction');
  assert.ok(!upstream.calls.some(call => ['/api/block/updateBlock', '/api/attr/setBlockAttrs', '/api/riff/addRiffCards'].includes(call.path) && (call.body.id === upstream.state.originalId || call.body.blockIDs?.includes(upstream.state.originalId))));
  upstream.state.codes = { '/api/block/getBlockKramdown': -1 };
  const failure = await jobDone(app, await ok(app, 'POST', '/sources/import', { projectId: null, kind: 'siyuan_block', blockId: upstream.state.originalId }, 202), 'failed');
  assert.equal(failure.error.code, 'UPSTREAM_ERROR');
});

test('source changes preserve reviewed answers and app-owned resync keeps one native card', async t => {
  const upstream = await fakeSiyuan(t);
  const app = await appFor(t); await configureSiyuan(app, upstream);
  let imported = await jobDone(app, await ok(app, 'POST', '/sources/import', { projectId: null, kind: 'siyuan_document', documentId: upstream.state.originalId }, 202));
  let item = await ok(app, 'GET', '/knowledge/' + imported.result.knowledgeIds[0]);
  item = await ok(app, 'POST', `/knowledge/${item.id}/decision`, { expectedRevision: item.revision, decision: 'accept' });
  const previousAnswer = item.answer;
  upstream.state.sourceText = '来源发生了实质变化。';
  imported = await jobDone(app, await ok(app, 'POST', '/sources/import', { projectId: null, kind: 'siyuan_document', documentId: upstream.state.originalId }, 202));
  assert.equal(imported.result.candidatesCreated, 0);
  item = await ok(app, 'GET', '/knowledge/' + item.id);
  assert.equal(item.status, 'needs_recheck'); assert.equal(item.answer, previousAnswer); assert.equal(app.store.all('source-version').length, 1);
  item = await ok(app, 'POST', `/knowledge/${item.id}/decision`, { expectedRevision: item.revision, decision: 'accept' });
  await jobDone(app, await ok(app, 'POST', `/knowledge/${item.id}/sync`, { expectedRevision: item.revision }, 202));
  item = await ok(app, 'GET', '/knowledge/' + item.id);
  const cardBlockId = item.siyuanBlockId;
  item = await ok(app, 'PATCH', `/knowledge/${item.id}`, { expectedRevision: item.revision, answer: '用户核验后的更新' });
  assert.equal(item.sync.status, 'stale');
  item = await ok(app, 'POST', `/knowledge/${item.id}/decision`, { expectedRevision: item.revision, decision: 'accept' });
  await jobDone(app, await ok(app, 'POST', `/knowledge/${item.id}/sync`, { expectedRevision: item.revision }, 202));
  item = await ok(app, 'GET', '/knowledge/' + item.id);
  assert.equal(item.siyuanBlockId, cardBlockId); assert.equal(upstream.state.cards.length, 1); assert.equal(upstream.state.docs.length, 1);
});

test('ownership mismatches prohibit overwriting an existing native block', async t => {
  const upstream = await fakeSiyuan(t);
  const app = await appFor(t);
  let item = await syncedKnowledge(app, upstream);
  upstream.state.attrs[item.siyuanBlockId]['custom-second-brain-owner'] = 'someone-else';
  item = await ok(app, 'PATCH', `/knowledge/${item.id}`, { expectedRevision: item.revision, answer: 'new' });
  item = await ok(app, 'POST', `/knowledge/${item.id}/decision`, { expectedRevision: item.revision, decision: 'accept' });
  const before = upstream.calls.filter(call => call.path === '/api/block/updateBlock').length;
  const job = await jobDone(app, await ok(app, 'POST', `/knowledge/${item.id}/sync`, { expectedRevision: item.revision }, 202), 'failed');
  assert.equal(job.error.code, 'OWNERSHIP_REQUIRED'); assert.equal(upstream.calls.filter(call => call.path === '/api/block/updateBlock').length, before);
});

test('unsafe provider addresses and redirects are rejected without external reads', async t => {
  const app = await appFor(t);
  const current = (await ok(app, 'GET', '/connections')).items[0];
  for (const baseUrl of ['https://evil.example', 'http://192.168.1.10:6806', 'http://127.0.0.1:6806/path', 'http://user:pass@127.0.0.1:6806']) {
    assert.equal((await request(app, 'PUT', '/connections/siyuan', { expectedRevision: current.revision, useRuntimeConnection: false, baseUrl, notebookTitle: 'notes' })).status, 422);
  }
  assert.equal((await request(app, 'POST', '/sources/import', { projectId: null, kind: 'feishu_document', url: 'http://127.0.0.1/private' })).status, 422);
  const upstream = await fakeServer(t, () => ({ status: 302, headers: { Location: 'http://192.168.1.1/internal' }, json: {} }));
  await configureSiyuan(app, upstream);
  const check = await ok(app, 'POST', '/connections/siyuan/check', {});
  assert.equal(check.connection.status, 'unavailable'); assert.ok(check.connection.lastError);
});

for (const failureStatus of [401, 403, 429]) test(`Feishu ${failureStatus} uses official service API and records an honest failure`, async t => {
  const upstream = await fakeServer(t, req => {
    if (req.url === '/open-apis/auth/v3/tenant_access_token/internal') return { code: 0, tenant_access_token: 'fake-feishu-access-token', expire: 7200 };
    return { status: failureStatus, json: { code: -1, msg: 'contains no user credential' } };
  });
  const calls = [];
  const app = await appFor(t, { transport: { fetch: (url, init) => { calls.push(url); const parsed = new URL(url); assert.equal(parsed.origin, 'https://open.feishu.cn'); return fetch(upstream.origin + parsed.pathname + parsed.search, init); } } });
  assert.equal((await request(app, 'POST', '/sources/import', { projectId: null, kind: 'feishu_document', url: 'https://tenant.feishu.cn/docx/abcdef123' })).status, 503);
  await settings(app, { feishu: { enabled: true, appId: 'fake-app-id', appSecret: 'fake-feishu-app-secret' } });
  const job = await jobDone(app, await ok(app, 'POST', '/sources/import', { projectId: null, kind: 'feishu_document', url: 'https://tenant.feishu.cn/docx/abcdef123' }, 202), 'failed');
  assert.equal(job.error.code, failureStatus === 429 ? 'RATE_LIMITED' : 'SCOPE_FORBIDDEN');
  assert.equal(job.error.retryable, failureStatus === 429); assert.equal(upstream.calls.length, 2); assert.equal((await ok(app, 'GET', '/sources')).total, 0);
});

test('authorized Feishu wiki document import resolves a node and reads its actual text', async t => {
  const upstream = await fakeServer(t, req => {
    if (req.url.includes('/auth/')) return { code: 0, tenant_access_token: 'fake-feishu-access-token', expire: 7200 };
    if (req.url.includes('/wiki/')) return { code: 0, data: { node: { obj_type: 'docx', obj_token: 'actualdoc123' } } };
    return { code: 0, data: { content: '真实授权的飞书文档内容。' } };
  });
  const app = await appFor(t, { transport: { fetch: (url, init) => { const parsed = new URL(url); return fetch(upstream.origin + parsed.pathname + parsed.search, init); } } });
  await settings(app, { feishu: { enabled: true, appId: 'fake-app', appSecret: 'fake-app-secret' } });
  const result = (await jobDone(app, await ok(app, 'POST', '/sources/import', { projectId: null, kind: 'feishu_document', url: 'https://tenant.feishu.cn/wiki/wikinode123', extractCandidates: false }, 202))).result;
  assert.equal(result.candidatesCreated, 0);
  const source = await ok(app, 'GET', '/sources/' + result.sourceIds[0]);
  assert.equal(source.text, '真实授权的飞书文档内容。'); assert.equal(source.documentId, 'actualdoc123');
  assert.equal(upstream.calls[1].path, '/open-apis/wiki/v2/spaces/get_node?token=wikinode123');
  assert.ok(upstream.calls[2].path.endsWith('/actualdoc123/raw_content'));
});

test('uncertain notebook creation blocks a second create while the first upstream request is still running', async t => {
  const upstream = await fakeSiyuan(t, { notebookDelay: 250 });
  const app = await appFor(t, { transport: { timeoutMs: 50 } }); await configureSiyuan(app, upstream);
  const first = await knowledge(app, {}, true);
  await jobDone(app, await ok(app, 'POST', `/knowledge/${first.id}/sync`, { expectedRevision: first.revision }, 202), 'uncertain');
  const second = await knowledge(app, { question: '另一个知识点' }, true);
  const retry = await jobDone(app, await ok(app, 'POST', `/knowledge/${second.id}/sync`, { expectedRevision: second.revision }, 202), 'uncertain');
  assert.equal(retry.error.code, 'RECONCILIATION_REQUIRED');
  assert.equal(upstream.calls.filter(call => call.path === '/api/notebook/createNotebook').length, 1);
});

test('a known native card ID persists when a later resync finds no currently due card', async t => {
  const upstream = await fakeSiyuan(t); const app = await appFor(t);
  let item = await syncedKnowledge(app, upstream); const cardId = upstream.state.cards[0].cardID;
  upstream.state.cards[0].hidden = true;
  item = await ok(app, 'PATCH', `/knowledge/${item.id}`, { expectedRevision: item.revision, answer: '更新后的知识答案' });
  item = await ok(app, 'POST', `/knowledge/${item.id}/decision`, { expectedRevision: item.revision, decision: 'accept' });
  const ack = await ok(app, 'POST', `/knowledge/${item.id}/sync`, { expectedRevision: item.revision }, 202);
  const job = await jobDone(app, ack); assert.equal(job.result.cardId, cardId); assert.equal(upstream.state.cards.length, 1);
  assert.equal((await ok(app, 'GET', `/knowledge/${item.id}`)).sync.jobId, ack.jobId);
});
