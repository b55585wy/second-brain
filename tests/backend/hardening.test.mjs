import test from 'node:test';
import assert from 'node:assert/strict';
import { appFor, ok, request, profile, knowledge, output, settings, fakeServer, jobDone, scope } from './helpers.mjs';

async function createPractice(app) {
  return ok(app, 'POST', '/practices', { projectId: null, kind: 'explanation', goal: '解释提交证据', skill: '', prompt: '用自己的话解释', estimatedMinutes: 5,
    rubric: [{ label: '证据', description: '给出真实例子', expectedEvidence: ['例子'] }], sourceRefs: [] }, 201);
}

test('nested import fields, unsafe URLs and inconsistent plan totals are rejected atomically', async t => {
  const source = await appFor(t);
  await knowledge(source, { sourceRefs: [{ kind: 'manual', title: '材料', url: 'https://example.com', excerpt: null }] });
  const p = await profile(source, { goals: ['可检查的明确目标'] });
  await jobDone(source, await ok(source, 'POST', '/daily-plan/generate', { expectedProfileRevision: p.revision, expectedPlanRevision: 0 }, 202));
  const document = JSON.parse((await ok(source, 'POST', '/exports', { scope: 'all', projectIds: [] })).content);
  const target = await appFor(t);
  const extra = structuredClone(document); extra.data.knowledge[0].validation.adminOverride = true;
  assert.equal((await request(target, 'POST', '/imports', { document: extra, mode: 'merge' })).status, 422);
  const unsafe = structuredClone(document); unsafe.data.knowledge[0].sourceRefs[0].url = 'javascript:alert(1)';
  assert.equal((await request(target, 'POST', '/imports', { document: unsafe, mode: 'merge' })).status, 422);
  const invalidTime = structuredClone(document); invalidTime.data.knowledge[0].createdAt = 'tomorrow';
  assert.equal((await request(target, 'POST', '/imports', { document: invalidTime, mode: 'merge' })).status, 422);
  const badBudget = structuredClone(document); badBudget.data.plans[0].scheduledMinutes++;
  assert.equal((await request(target, 'POST', '/imports', { document: badBudget, mode: 'merge' })).status, 422);
  assert.equal(target.store.all('source').length, 0); assert.equal(target.store.all('knowledge').length, 0);
});

test('backup restores real attempts/feedback and remaps applied profile revisions to local history', async t => {
  const source = await appFor(t); await profile(source, { goals: ['导入的明确目标'] });
  const practice = await createPractice(source);
  const attempt = await ok(source, 'POST', `/practices/${practice.id}/attempts`, { output: '真实输出与例子', assistanceLevel: 'hint', evidenceRefs: [] }, 201);
  const feedback = (await jobDone(source, await ok(source, 'POST', `/attempts/${attempt.id}/feedback`, { mode: 'template' }, 202))).result.feedback;
  const document = JSON.parse((await ok(source, 'POST', '/exports', { scope: 'all', projectIds: [], includeSourceContent: true })).content);
  const target = await appFor(t); const before = await profile(target, { goals: ['已有的本地目标'] });
  const report = await ok(target, 'POST', '/imports', { document, mode: 'merge', applyProfile: true, expectedProfileRevision: before.revision });
  assert.equal(report.profileApplied, true);
  const restoredProfile = await ok(target, 'GET', '/learning-profile'); assert.equal(restoredProfile.goals[0], '导入的明确目标'); assert.ok(restoredProfile.revision > before.revision);
  const restored = (await ok(target, 'GET', `/practices/${practice.id}/attempts`)).items[0];
  assert.equal(restored.output, attempt.output); assert.equal(restored.assistanceLevel, 'hint'); assert.equal(restored.feedback.id, feedback.id);
  const practiceRestored = (await ok(target, 'GET', '/practices')).items[0]; assert.equal(practiceRestored.provenance.profileRevision, restoredProfile.revision);
  assert.ok((await ok(target, 'GET', '/learning-profile/revisions')).items.some(item => item.values.goals[0] === '已有的本地目标'));
});

test('source identity plus digest deduplicates aliases without conflating independent messages', async t => {
  const source = await appFor(t);
  await knowledge(source, { sourceRefs: [{ kind: 'manual', title: '来源身份', url: null, excerpt: '相同的来源文本' }] });
  const document = JSON.parse((await ok(source, 'POST', '/exports', { scope: 'all', projectIds: [], includeSourceContent: true })).content);
  const original = document.data.sources[0];
  const target = await appFor(t);
  const existing = target.sources.capture({ kind: original.kind, externalId: original.externalId, title: original.title, content: original.text });
  document.data.sources[0].sourceId = 'different-source-alias';
  document.data.knowledge[0].sourceRefs[0].sourceId = 'different-source-alias';
  const report = await ok(target, 'POST', '/imports', { document, mode: 'merge' });
  assert.equal(report.counts.sources.inserted, 0); assert.equal(target.store.all('source').length, 1);
  assert.equal((await ok(target, 'GET', '/knowledge')).items[0].sourceRefs[0].sourceId, existing.id);
});

test('a profile change while a model responds cannot publish a stale practice or plan', async t => {
  let release; let started = false; const wait = new Promise(resolveWait => { release = resolveWait; });
  const upstream = await fakeServer(t, async () => { started = true; await wait; return { choices: [{ message: { content: JSON.stringify({ kind: 'artifact', prompt: '产物', estimatedMinutes: 2, rubric: [{ label: '证据', description: '验证', expectedEvidence: [] }] }) } }] }; });
  const app = await appFor(t); await settings(app, { model: { enabled: true, endpoint: upstream.origin + '/v1', model: 'test' } });
  const current = await profile(app, { goals: ['SQL 事务'] });
  await knowledge(app, { question: 'SQL 事务', answer: 'SQL 事务必须关联提交证据。' }, true);
  const ack = await ok(app, 'POST', '/daily-plan/generate', { expectedProfileRevision: current.revision, expectedPlanRevision: 0, mode: 'model' }, 202);
  while (!started) await new Promise(resolveWait => setTimeout(resolveWait, 5));
  await profile(app, { goals: ['已更新的目标'] }); release();
  assert.equal((await jobDone(app, ack, 'failed')).error.code, 'REVISION_CONFLICT');
  assert.equal((await ok(app, 'GET', '/practices')).total, 0); assert.equal((await ok(app, 'GET', '/daily-plan')).status, 'not_generated');
});

test('invalid model schemas never become apparently successful AI exercises', async t => {
  const upstream = await fakeServer(t, () => ({ choices: [{ message: { content: JSON.stringify({ kind: 'artifact', prompt: 'x', estimatedMinutes: 200, rubric: [], score: 100 }) } }] }));
  const app = await appFor(t); await settings(app, { model: { enabled: true, endpoint: upstream.origin + '/v1', model: 'test' } });
  const current = await profile(app, { goals: ['SQL 索引'] });
  await knowledge(app, { question: 'SQL 索引', answer: 'SQL 索引需要执行计划证据。' }, true);
  const ack = await ok(app, 'POST', '/daily-plan/generate', { expectedProfileRevision: current.revision, expectedPlanRevision: 0, mode: 'model', allowTemplateFallback: false }, 202);
  assert.equal((await jobDone(app, ack, 'failed')).error.code, 'UPSTREAM_ERROR'); assert.equal((await ok(app, 'GET', '/practices')).total, 0);
});

test('manual feedback validates every rubric and invalid IDs fail before creating jobs', async t => {
  const app = await appFor(t); const practice = await createPractice(app);
  const attempt = await ok(app, 'POST', `/practices/${practice.id}/attempts`, { output: '真实解释', assistanceLevel: 'none', evidenceRefs: [] }, 201);
  const count = app.store.all('job').length;
  const invalid = await request(app, 'POST', `/attempts/${attempt.id}/feedback`, { mode: 'manual', manual: { summary: '用户判断', observations: [{ criterionId: 'unknown', finding: 'met', comment: '', evidenceRefs: [] }], nextActions: [], limitations: [] } });
  assert.equal(invalid.status, 422); assert.equal(app.store.all('job').length, count);
  const valid = await jobDone(app, await ok(app, 'POST', `/attempts/${attempt.id}/feedback`, { mode: 'manual', manual: { summary: '我核对了例子', observations: [{ criterionId: practice.rubric[0].id, finding: 'partial', comment: '需要补充执行证据', evidenceRefs: [] }], nextActions: [], limitations: ['属于用户判断'] } }, 202));
  assert.equal(valid.result.feedback.basis, 'user_judgment'); assert.equal(valid.result.feedback.observations[0].finding, 'partial');
});

test('Unicode code-point limits and literal query text are enforced without interpreting source text', async t => {
  const app = await appFor(t);
  assert.equal((await request(app, 'POST', '/projects', { title: '😀'.repeat(200), goal: '' })).status, 201);
  assert.equal((await request(app, 'POST', '/projects', { title: '😀'.repeat(201), goal: '' })).status, 422);
  const artifact = await output(app, { content: '字'.repeat(100000) }); assert.equal(artifact.content.length, 100000);
  assert.equal((await request(app, 'PATCH', `/outputs/${artifact.id}`, { expectedRevision: artifact.revision, content: '字'.repeat(100001) })).status, 422);
  assert.equal((await ok(app, 'GET', '/projects?q=' + encodeURIComponent("' OR 1=1 --"))).total, 0);
  assert.equal((await ok(app, 'GET', '/projects')).total, 1);
});

test('identical assistant text with independent message IDs remains distinct in manual fallback', async t => {
  const app = await appFor(t);
  const doc = { projectId: null, title: '选择的材料', externalSourceId: 'same-text-two-events', messages: [
    { sourceMessageId: 'u', role: 'user', content: '问题', occurredAt: null }, { sourceMessageId: 'a1', role: 'assistant', content: '相同文本', occurredAt: null }, { sourceMessageId: 'a2', role: 'assistant', content: '相同文本', occurredAt: null },
  ] };
  const result = (await jobDone(app, await ok(app, 'POST', '/codex/manual-import', doc, 202))).result;
  assert.equal(result.sourcesCreated, 3); assert.equal(result.candidatesCreated, 2);
  const scopeBefore = await ok(app, 'GET', '/connections/codex/scope');
  await scope(app, { allowManualImports: false });
  assert.equal((await request(app, 'POST', '/codex/manual-import', doc)).status, 403);
});
