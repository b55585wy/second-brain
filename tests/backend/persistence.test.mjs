import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appFor, ok, request, profile, knowledge, output, settings, scratch, operation, fakeSiyuan } from './helpers.mjs';

test('SQLite restart retains projects, checkpoints, artifacts, revisions and operation replays', async t => {
  const root = scratch();
  const first = await appFor(t, { root, keep: true });
  const body = { operationId: operation(), title: '持久项目', goal: '保存上下文' };
  const project = await ok(first, 'POST', '/projects', body, 201);
  await ok(first, 'POST', `/projects/${project.id}/checkpoints`, { progress: '真实进度', nextAction: '继续验证', openQuestion: '一个问题' }, 201);
  const artifact = await output(first, { projectId: project.id, content: '用户写下的持久产物' });
  await profile(first, { goals: ['用户明确目标'] });
  await first.close();
  const second = await appFor(t, { root });
  assert.deepEqual(await ok(second, 'POST', '/projects', body, 201), project);
  assert.equal((await ok(second, 'GET', `/projects/${project.id}/checkpoints`)).items[0].progress, '真实进度');
  assert.equal((await ok(second, 'GET', '/outputs')).items[0].content, artifact.content);
  assert.equal((await ok(second, 'GET', '/learning-profile')).goals[0], '用户明确目标');
  assert.equal((await ok(second, 'GET', '/learning-profile/revisions')).total, 2);
});

test('settings and exports never contain credential values and default exports omit source content', async t => {
  const app = await appFor(t);
  const secret = 'sk-test-secret-value-abcdefghijklmnop';
  await settings(app, { model: { apiKey: secret }, feishu: { appId: 'fake-app', appSecret: 'feishu-super-secret-value' } });
  const item = await knowledge(app, { sourceRefs: [{ kind: 'manual', title: '用户材料', url: null, excerpt: `source text api_key=${secret}` }], answer: `已保存的产物 ${secret}` });
  const publicSettings = await ok(app, 'GET', '/settings');
  assert.equal(publicSettings.model.apiKeyConfigured, true); assert.equal(publicSettings.model.apiKey, undefined);
  const connections = await ok(app, 'GET', '/connections');
  assert.ok(!JSON.stringify(connections).includes(secret));
  const exported = await request(app, 'POST', '/exports', { scope: 'all', projectIds: [] });
  assert.equal(exported.status, 200);
  const document = JSON.parse(exported.data.content);
  assert.equal(document.sourceContentIncluded, false); assert.equal(document.data.sources[0].text, null);
  assert.equal(document.data.knowledge[0].sourceRefs[0].excerpt, null);
  for (const key of ['settings', 'connections', 'secrets']) assert.equal(document.data[key], undefined);
  assert.ok(!exported.data.content.includes(secret)); assert.ok(!exported.data.content.includes('feishu-super-secret-value')); assert.ok(!exported.data.content.includes('tokenFile'));
  assert.equal(exported.data.byteLength, Buffer.byteLength(exported.data.content));
  const fetched = await ok(app, 'GET', exported.headers.get('location'));
  assert.deepEqual(fetched, exported.data);
  const full = await ok(app, 'POST', '/exports', { scope: 'all', projectIds: [], includeSourceContent: true });
  assert.ok(JSON.parse(full.content).data.sources[0].text.includes('[REDACTED]'));
});

test('merge restore requires recheck, drops external authority, keeps stable identities and preserves local conflicts', async t => {
  const source = await appFor(t);
  const project = await ok(source, 'POST', '/projects', { title: '备份项目', goal: '' }, 201);
  const accepted = await knowledge(source, { projectId: project.id }, true);
  const artifact = await output(source, { projectId: project.id, content: '原始用户写作' });
  const document = JSON.parse((await ok(source, 'POST', '/exports', { scope: 'all', projectIds: [], includeSourceContent: true })).content);
  const target = await appFor(t);
  const report = await ok(target, 'POST', '/imports', { document, mode: 'merge' });
  assert.equal(report.needsRecheck, 1); assert.equal(report.profileApplied, false);
  const restored = await ok(target, 'GET', `/knowledge/${accepted.id}`);
  assert.equal(restored.status, 'needs_recheck'); assert.equal(restored.origin, 'backup'); assert.equal(restored.siyuanBlockId, null); assert.equal(restored.sync.status, 'not_synced');
  const repeated = await ok(target, 'POST', '/imports', { document, mode: 'merge' });
  assert.equal(repeated.counts.outputs.inserted, 0); assert.equal((await ok(target, 'GET', '/outputs')).total, 1);
  await ok(target, 'PATCH', `/outputs/${artifact.id}`, { expectedRevision: artifact.revision, content: '本地更新优先' });
  const changedDocument = structuredClone(document); changedDocument.exportedAt = new Date(Date.now() + 1).toISOString(); changedDocument.data.outputs[0].content = '外来不同内容';
  const conflicts = await ok(target, 'POST', '/imports', { document: changedDocument, mode: 'merge' });
  assert.ok(conflicts.conflictTotal >= 1); assert.equal((await ok(target, 'GET', '/outputs')).items[0].content, '本地更新优先');
});

test('unsupported, malformed and credential-bearing imports fail without partial writes', async t => {
  const app = await appFor(t);
  const document = JSON.parse((await ok(app, 'POST', '/exports', { scope: 'all', projectIds: [] })).content);
  const target = await appFor(t);
  assert.equal((await request(target, 'POST', '/imports', { document: { ...document, schemaVersion: 'future' }, mode: 'merge' })).error.code, 'IMPORT_SCHEMA_UNSUPPORTED');
  const credentials = structuredClone(document); credentials.data.settings = { apiKey: 'evil' };
  assert.equal((await request(target, 'POST', '/imports', { document: credentials, mode: 'merge' })).status, 422);
  const malformed = structuredClone(document); delete malformed.data.outputs;
  assert.equal((await request(target, 'POST', '/imports', { document: malformed, mode: 'merge' })).status, 422);
  assert.equal((await ok(target, 'GET', '/projects')).total, 0); assert.equal(target.store.all('import-audit').length, 0);
});

test('project-scoped exports retain dependencies and never export executable jobs', async t => {
  const app = await appFor(t);
  const a = await ok(app, 'POST', '/projects', { title: 'A', goal: '' }, 201);
  const b = await ok(app, 'POST', '/projects', { title: 'B', goal: '' }, 201);
  await knowledge(app, { projectId: a.id, sourceRefs: [{ kind: 'manual', title: '依赖材料', url: null, excerpt: '真实材料' }] });
  await output(app, { projectId: b.id, content: '其他项目' });
  const document = JSON.parse((await ok(app, 'POST', '/exports', { scope: 'projects', projectIds: [a.id] })).content);
  assert.deepEqual(document.data.projects.map(item => item.id), [a.id]); assert.equal(document.data.knowledge.length, 1); assert.equal(document.data.sources.length, 1);
  assert.equal(document.data.outputs.length, 0); assert.deepEqual(document.data.jobHistory, []);
});

test('runtime discovery reads an actual manifest/token file and never returns its secret or path', async t => {
  const root = scratch(); const runtime = resolve(root, 'runtime'); mkdirSync(runtime);
  const upstream = await fakeSiyuan(t);
  const tokenFile = resolve(runtime, 'token.txt'); writeFileSync(tokenFile, 'runtime-test-secret');
  const manifest = { baseUrl: upstream.origin, version: '3.8.8', tokenFile: 'token.txt' };
  writeFileSync(resolve(runtime, 'connection.json'), JSON.stringify(manifest));
  const app = await appFor(t, { root });
  const connections = await ok(app, 'GET', '/connections'); const connection = connections.items[0];
  assert.equal(connection.configurationSource, 'runtime'); assert.equal(connection.tokenConfigured, true);
  assert.ok(!JSON.stringify(connections).includes('runtime-test-secret')); assert.ok(!JSON.stringify(connections).includes('token.txt'));
  await ok(app, 'POST', '/connections/siyuan/check', {});
  assert.equal(upstream.calls[0].headers.authorization, 'Token runtime-test-secret');
  assert.deepEqual(JSON.parse(readFileSync(resolve(runtime, 'connection.json'), 'utf8')), manifest);
});

test('unknown quoted credential fields, token file paths and JWT-shaped text are redacted on capture', async t => {
  const app = await appFor(t);
  const excerpt = '{"appSecret":"unconfigured-secret-123","tokenFile":"C:/Private Folder/token.txt"}\nAuthorization: Bearer unconfigured-private-token\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.fakeSignature123';
  const item = await knowledge(app, { sourceRefs: [{ kind: 'manual', title: '敏感材料', url: null, excerpt }] });
  const saved = await ok(app, 'GET', '/sources/' + item.sourceRefs[0].sourceId);
  for (const value of ['unconfigured-secret-123', 'C:/Private Folder/token.txt', 'unconfigured-private-token', 'fakeSignature123']) assert.ok(!JSON.stringify(saved).includes(value));
  assert.ok(saved.text.includes('[REDACTED]')); assert.equal(app.secrets.redact(saved.text), saved.text);
});
