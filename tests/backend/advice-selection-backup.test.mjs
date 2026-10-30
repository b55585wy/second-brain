import test from 'node:test';
import assert from 'node:assert/strict';
import { dto } from '../../server/dto.mjs';
import { appFor, ok, profile, request, settings } from './helpers.mjs';

// Requirements: saved/dismissed history, dependencies, project scope, old-v1 compatibility,
// atomic malformed-input rejection, missing-dependency conflicts, and inert restored runtime.
async function selection(app, { state = 'saved', retainedOutput = state === 'saved', projectId = null } = {}) {
  const source = app.sources.capture({ kind: 'manual', externalId: `selection-${app.store.all('practice').length}`,
    title: 'Replay evidence', content: 'The same operation must retain one saved result.', projectId });
  const refs = [app.sources.ref(source)];
  const practice = app.learning.createPractice({ projectId, kind: 'explanation', goal: 'Reliable storage', skill: '',
    prompt: 'Describe one observable replay check.', estimatedMinutes: 5, sourceRefs: refs,
    rubric: [{ label: 'Evidence', description: 'Give an observable result.', expectedEvidence: ['Record count'] }] }, app.learning.provenance('template', refs));
  const attempt = app.learning.attempt(practice.id, { output: 'Replay once and compare the record count.', assistanceLevel: 'none', evidenceRefs: [] });
  const { feedback } = app.learning.saveFeedback(attempt.id, 'model', { summary: 'Use an explicit expected count.',
    observations: [{ criterionId: practice.rubric[0].id, finding: 'partial', comment: 'Specify one resulting record.', evidenceRefs: [] }],
    nextActions: ['Compare the count before and after replay.'], limitations: ['A suggestion does not establish mastery.'] });
  const output = retainedOutput ? app.learning.output({ projectId: null, practiceId: practice.id, title: 'Accepted advice',
    content: feedback.summary, goal: practice.goal, status: 'final', sourceRefs: refs.map(ref => ({ sourceId: ref.sourceId })), evidenceRefs: [] }) : null;
  const record = app.store.put('advice-selection', { feedbackId: feedback.id, attemptId: attempt.id, state,
    outputId: output?.id ?? null, selectedAt: '2026-10-30T01:00:00.000Z' }, feedback.id);
  return { record, source, practice, attempt, feedback, output };
}

async function sourceApp(t) {
  const app = await appFor(t); await profile(app, { goals: ['Reliable storage'] });
  await settings(app, { model: { model: 'synthetic-backup-model' } });
  app.learning.onAttempt = null;
  return app;
}
async function document(app, scope = 'all', projectIds = []) {
  return JSON.parse((await ok(app, 'POST', '/exports', { scope, projectIds, includeSourceContent: true })).content);
}
async function restore(app, backup) { return ok(app, 'POST', '/imports', { document: backup, mode: 'merge' }); }

for (const [state, retainedOutput] of [['saved', true], ['dismissed', false], ['dismissed', true]]) {
  test(`${state} advice selection round-trips${retainedOutput ? ' with its saved output history' : ' without an output'}`, async t => {
    const source = await sourceApp(t); const saved = await selection(source, { state, retainedOutput });
    const backup = await document(source); const target = await appFor(t); const report = await restore(target, backup);
    assert.deepEqual(backup.data.adviceSelections, [dto('adviceSelections', saved.record)]);
    assert.equal(report.conflictTotal, 0); assert.equal(report.counts.adviceSelections.inserted, 1);
    assert.deepEqual(dto('adviceSelections', target.store.require('advice-selection', saved.feedback.id)), backup.data.adviceSelections[0]);
    assert.ok(target.store.get('feedback', saved.feedback.id)); assert.ok(target.store.get('attempt', saved.attempt.id));
    assert.ok(target.store.get('practice', saved.practice.id)); assert.ok(target.store.get('source', saved.source.id));
    assert.equal(target.store.all('output').length, retainedOutput ? 1 : 0);
    if (saved.output) assert.equal(target.store.require('output', saved.output.id).content, saved.output.content);
    const repeated = await restore(target, backup);
    assert.equal(repeated.counts.adviceSelections.inserted, 0); assert.equal(repeated.counts.adviceSelections.skipped, 1);
    assert.equal(target.store.all('advice-selection').length, 1);
  });
}

test('project-scoped backup selects advice through its attempt and retains the saved output dependencies', async t => {
  const app = await sourceApp(t); const a = app.domain.createProject({ title: 'A', goal: '' });
  const b = app.domain.createProject({ title: 'B', goal: '' });
  const chosen = await selection(app, { projectId: a.id }); await selection(app, { projectId: b.id, state: 'dismissed' });
  const backup = await document(app, 'projects', [a.id]);
  assert.deepEqual(backup.data.adviceSelections.map(item => item.id), [chosen.feedback.id]);
  assert.deepEqual(backup.data.attempts.map(item => item.id), [chosen.attempt.id]);
  assert.deepEqual(backup.data.feedback.map(item => item.id), [chosen.feedback.id]);
  assert.deepEqual(backup.data.outputs.map(item => item.id), [chosen.output.id]);
  assert.deepEqual(backup.data.projects.map(item => item.id), [a.id]);
  const target = await appFor(t); const report = await restore(target, backup);
  assert.equal(report.conflictTotal, 0); assert.equal(target.store.all('advice-selection').length, 1);
});

test('old v1 backups without adviceSelections or focusArtifacts remain importable', async t => {
  const source = await sourceApp(t); const saved = await selection(source); const backup = await document(source);
  delete backup.data.adviceSelections; delete backup.data.focusArtifacts;
  const target = await appFor(t); const report = await restore(target, backup);
  assert.equal(report.conflictTotal, 0); assert.equal(report.counts.adviceSelections.inserted, 0);
  assert.ok(target.store.get('output', saved.output.id)); assert.equal(target.store.all('advice-selection').length, 0);
});

const malformed = [
  ['non-array collection', doc => { doc.data.adviceSelections = null; }],
  ['unknown state', doc => { doc.data.adviceSelections[0].state = 'accepted'; }],
  ['different identity', doc => { doc.data.adviceSelections[0].id = 'different_feedback'; }],
  ['null saved output', doc => { doc.data.adviceSelections[0].outputId = null; }],
  ['empty output identity', doc => { doc.data.adviceSelections[0].outputId = ''; }],
  ['null attempt identity', doc => { doc.data.adviceSelections[0].attemptId = null; }],
  ['null feedback identity', doc => { doc.data.adviceSelections[0].feedbackId = null; }],
  ['null selection time', doc => { doc.data.adviceSelections[0].selectedAt = null; }],
  ['invalid creation time', doc => { doc.data.adviceSelections[0].createdAt = 'tomorrow'; }],
  ['zero revision', doc => { doc.data.adviceSelections[0].revision = 0; }],
  ['missing nullable field', doc => { delete doc.data.adviceSelections[0].outputId; }],
  ['unlisted runtime field', doc => { doc.data.adviceSelections[0].nonceHash = 'runtime'; }],
  ['duplicate identity', doc => { doc.data.adviceSelections.push(structuredClone(doc.data.adviceSelections[0])); }],
];
for (const [name, change] of malformed) {
  test(`a ${name} is rejected before any imported entity is written`, async t => {
    const source = await sourceApp(t); await selection(source); const backup = await document(source); change(backup);
    const target = await appFor(t); const result = await request(target, 'POST', '/imports', { document: backup, mode: 'merge' });
    assert.equal(result.status, 422);
    for (const kind of ['project', 'source', 'practice', 'attempt', 'feedback', 'output', 'advice-selection', 'import-audit']) assert.equal(target.store.all(kind).length, 0, kind);
  });
}

for (const dependency of ['feedback', 'attempts', 'outputs']) {
  test(`a missing ${dependency} dependency conflicts without creating an orphan selection`, async t => {
    const source = await sourceApp(t); const saved = await selection(source); const backup = await document(source);
    backup.data[dependency] = [];
    const target = await appFor(t); const report = await restore(target, backup);
    assert.equal(report.counts.adviceSelections.inserted, 0); assert.equal(report.counts.adviceSelections.conflicted, 1);
    assert.ok(report.conflicts.some(item => item.entity === 'adviceSelections' && item.id === saved.feedback.id && item.reason === 'missing_dependency'));
    assert.equal(target.store.all('advice-selection').length, 0);
  });
}

test('card action history imports as inert history and excludes runtime authority, nonces, callbacks, and decisions events', async t => {
  const source = await sourceApp(t); await selection(source); await source.jobs.stop();
  source.advice.update({ enabled: true, dailyCallLimit: 7 }); source.feishuChat.update({ cardsEnabled: true });
  source.jobs.enqueue('feishu_card_action', { cardId: 'private_card', trigger: 'user' }, 'backup_card_action');
  for (const kind of ['feishu-card', 'feishu-card-nonce', 'feishu-card-event', 'feishu-chat-binding', 'advice-call', 'advice-selection-event']) {
    source.store.put(kind, { privateRuntimeMarker: `EXCLUDED_${kind}` });
  }
  const backup = await document(source); const text = JSON.stringify(backup);
  assert.ok(backup.data.jobHistory.some(job => job.type === 'feishu_card_action'));
  assert.ok(!text.includes('EXCLUDED_')); assert.ok(!text.includes('private_card'));
  const target = await appFor(t); const report = await restore(target, backup);
  assert.equal(report.conflictTotal, 0); assert.equal(report.counts.adviceSelections.inserted, 1);
  assert.equal(target.advice.settingsPublic().enabled, false); assert.equal(target.feishuChat.public().cardsEnabled, false);
  assert.equal(target.store.all('job').length, 0); assert.equal(target.store.all('job-history').filter(job => job.type === 'feishu_card_action').length, 1);
  for (const kind of ['feishu-card', 'feishu-card-nonce', 'feishu-card-event', 'feishu-chat-binding', 'advice-call', 'advice-selection-event']) assert.equal(target.store.all(kind).length, 0, kind);
});
