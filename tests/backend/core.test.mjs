import test from 'node:test';
import assert from 'node:assert/strict';
import { appFor, ok, request, profile, knowledge, operation } from './helpers.mjs';

test('profile has no invented identity, validates boundaries and records only actual revisions', async t => {
  const app = await appFor(t);
  const initial = await ok(app, 'GET', '/learning-profile');
  assert.deepEqual(initial.goals, []); assert.equal(initial.careerDirection, ''); assert.equal(initial.dailyBudgetMinutes, 15); assert.equal(initial.timeZone, 'Asia/Shanghai');
  const same = await profile(app); assert.equal(same.revision, initial.revision);
  const changed = await profile(app, { goals: ['独立检查项目证据'], dailyBudgetMinutes: 0 });
  assert.equal(changed.revision, 2); assert.match(changed.updatedAt, /Z$/);
  for (const values of [{ dailyBudgetMinutes: -1 }, { dailyBudgetMinutes: 121 }, { dailyBudgetMinutes: 0.5 }, { timeZone: 'Imaginary/Moon' }, { skills: [''] }]) {
    const { revision, createdAt, updatedAt, ...fields } = changed;
    assert.equal((await request(app, 'PUT', '/learning-profile', { ...fields, ...values, expectedRevision: revision })).status, 422);
  }
  const revisions = await ok(app, 'GET', '/learning-profile/revisions');
  assert.deepEqual(revisions.items.map(item => item.profileRevision), [2, 1]);
});

test('projects, case-insensitive search, AND filters, checkpoints and safe archive transitions', async t => {
  const app = await appFor(t);
  let project = await ok(app, 'POST', '/projects', { title: 'SQLite 学习', goal: '验证重启持久化' }, 201);
  await ok(app, 'POST', '/projects', { title: '其他', goal: '', status: 'paused' }, 201);
  assert.equal((await ok(app, 'GET', '/projects?q=sqlite&status=active&limit=1')).total, 1);
  assert.equal((await ok(app, 'GET', '/projects?q=sqlite&status=paused')).total, 0);
  const checkpoint = await ok(app, 'POST', `/projects/${project.id}/checkpoints`, { progress: '已运行一次', nextAction: '重启', openQuestion: '' }, 201);
  assert.equal(checkpoint.projectId, project.id);
  assert.equal((await request(app, 'POST', `/projects/${project.id}/checkpoints`, { progress: '', nextAction: '', openQuestion: '' })).status, 422);
  const archived = await ok(app, 'DELETE', '/projects/' + project.id, { expectedRevision: project.revision });
  assert.equal(archived.status, 'archived');
  assert.equal((await request(app, 'POST', `/projects/${project.id}/checkpoints`, { progress: 'x', nextAction: '', openQuestion: '' })).status, 409);
  assert.equal((await ok(app, 'GET', `/projects/${project.id}/checkpoints`)).total, 1);
  project = await ok(app, 'PATCH', '/projects/' + project.id, { expectedRevision: archived.revision, status: 'maintenance' });
  assert.equal(project.status, 'maintenance');
  assert.equal((await request(app, 'PATCH', '/projects/' + project.id, { expectedRevision: 1, goal: 'bad' })).error.code, 'REVISION_CONFLICT');
});

test('acceptance is explicit, idempotent, independent of verification and never auto-syncs', async t => {
  const app = await appFor(t);
  let item = await knowledge(app);
  assert.equal(item.status, 'draft'); assert.equal(item.validation.status, 'unverified');
  const decision = { operationId: operation(), expectedRevision: item.revision, decision: 'accept' };
  item = await ok(app, 'POST', `/knowledge/${item.id}/decision`, decision);
  assert.equal(item.status, 'accepted'); assert.equal(item.validation.status, 'unverified'); assert.equal(item.siyuanBlockId, null); assert.equal(item.sync.status, 'not_synced');
  const replay = await ok(app, 'POST', `/knowledge/${item.id}/decision`, decision);
  assert.deepEqual(replay, item);
  assert.equal((await request(app, 'POST', `/knowledge/${item.id}/sync`, { expectedRevision: item.revision })).status, 503);
  item = await ok(app, 'PATCH', `/knowledge/${item.id}`, { expectedRevision: item.revision, answer: '修订后的答案' });
  assert.equal(item.status, 'needs_recheck');
  assert.equal((await request(app, 'PATCH', `/knowledge/${item.id}`, { expectedRevision: item.revision, status: 'accepted' })).status, 422);
  item = await ok(app, 'POST', `/knowledge/${item.id}/decision`, { expectedRevision: item.revision, decision: 'reject' });
  assert.equal(item.status, 'rejected');
  assert.equal((await request(app, 'POST', `/knowledge/${item.id}/decision`, { expectedRevision: item.revision, decision: 'accept' })).status, 409);
  item = await ok(app, 'PATCH', `/knowledge/${item.id}`, { expectedRevision: item.revision, status: 'draft' });
  assert.equal(item.status, 'draft');
});

test('manual references and explicit evidence validation preserve the source/claim distinction', async t => {
  const app = await appFor(t);
  let item = await knowledge(app, { sourceRefs: [{ kind: 'manual', title: '执行记录', url: null, excerpt: '记录只能证明已运行。' }] });
  assert.equal(item.sourceRefs[0].kind, 'manual'); assert.match(item.sourceRefs[0].contentDigest, /^[a-f0-9]{64}$/);
  const evidence = { kind: 'source', id: item.sourceRefs[0].sourceId, url: null, label: '执行记录' };
  assert.equal((await request(app, 'PATCH', `/knowledge/${item.id}`, { expectedRevision: item.revision, validation: { status: 'supported', method: 'source_check', notes: '', evidenceRefs: [] } })).status, 422);
  item = await ok(app, 'PATCH', `/knowledge/${item.id}`, { expectedRevision: item.revision, validation: { status: 'supported', method: 'source_check', notes: '用户核对', evidenceRefs: [evidence] } });
  assert.equal(item.validation.checkedBy, 'user'); assert.equal(item.status, 'draft');
  assert.equal((await ok(app, 'GET', '/knowledge?validationStatus=supported&sourceKind=manual')).total, 1);
});
