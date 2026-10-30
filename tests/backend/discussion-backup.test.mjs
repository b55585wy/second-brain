import test from 'node:test';
import assert from 'node:assert/strict';
import { appFor, ok, request, operation, settings } from './helpers.mjs';
import { discussionFixture, waitReady, waitForStatus } from './discussion-fixture.mjs';

// B1 complete/saved/pending history restores inertly; B2 old optional schema;
// B3 malformed fields fail atomically; B4 project dependency closure;
// B5 missing feedback/attempt/output/version/turn/retry dependencies conflict.
const collections = ['adviceDiscussions', 'adviceDiscussionTurns', 'adviceDiscussionVersions'];
const kinds = ['advice-discussion', 'advice-discussion-turn', 'advice-discussion-version'];
const version = (f, number, feedbackId = f.feedback.id) => f.app.store.all('advice-discussion-version').find(item => item.feedbackId === feedbackId && item.version === number);
const turn = f => f.app.store.all('advice-discussion-turn').find(item => item.feedbackId === f.feedback.id);
const follow = (f, expectedVersion = 0, record = f) => ok(f.app, 'POST', record.path, { message: 'Explain the observable replay result.', expectedVersion });
const save = (f, expectedVersion = 1, record = f) => ok(f.app, 'POST', record.path + '/save', { expectedVersion });
const document = async (app, scope = 'all', projectIds = []) => JSON.parse((await ok(app, 'POST', '/exports', { scope, projectIds, includeSourceContent: true })).content);
const restore = (app, backup) => ok(app, 'POST', '/imports', { document: backup, mode: 'merge' });

async function savedFixture(t) {
  const f = await discussionFixture(t);
  await follow(f); await waitReady(f); await save(f);
  return f;
}

function assertNoAuthority(app) {
  assert.equal(app.store.all('job').length, 0);
  assert.equal(app.store.all('advice-call').length, 0);
  assert.equal(app.advice.settingsPublic().enabled, false);
  assert.equal(app.feishuChat.public().cardsEnabled, false);
  assert.equal(app.feishuChat.public().enabled, false);
  assert.equal(app.settings.raw().model.enabled, false);
  for (const kind of ['feishu-card', 'feishu-card-nonce', 'feishu-card-event', 'feishu-chat-binding', 'feishu-chat-outbox']) {
    assert.equal(app.store.all(kind).length, 0, kind);
  }
}

for (const pendingStatus of ['queued', 'running']) {
  test(`saved version and ${pendingStatus} followup round-trip as history without jobs, quota calls or channel authority`, async t => {
    const f = await savedFixture(t); const saved = version(f, 1);
    const output = structuredClone(f.app.store.require('output', saved.outputId));
    await f.app.jobs.stop(); await follow(f, 1);
    const pending = f.app.store.all('advice-discussion-turn').find(item => item.status === 'queued');
    assert.ok(pending);
    f.app.store.put('advice-discussion-turn', { ...pending, status: pendingStatus,
      channel: { privateRuntimeMarker: 'EXCLUDED_DISCUSSION_CHANNEL' } }, pending.id);
    const aggregate = f.app.discussion.state(f.feedback.id);
    f.app.store.put('advice-discussion', { ...aggregate, lastError: { code: 'SYNTHETIC_RUNTIME',
      message: 'EXCLUDED_AGGREGATE_RUNTIME_ERROR', retryable: false } }, aggregate.id);
    f.app.feishuChat.update({ enabled: true, cardsEnabled: true });
    for (const kind of ['feishu-card', 'feishu-card-nonce', 'feishu-card-event', 'feishu-chat-binding', 'feishu-chat-outbox', 'advice-call']) {
      f.app.store.put(kind, { privateRuntimeMarker: `EXCLUDED_RUNTIME_${kind}` });
    }
    const backup = await document(f.app); const serialized = JSON.stringify(backup);
    assert.ok(!serialized.includes('EXCLUDED_'));
    const exportedAggregate = backup.data.adviceDiscussions[0];
    for (const key of ['pendingTurnId', 'status', 'lastError']) assert.ok(!Object.hasOwn(exportedAggregate, key), key);
    assert.equal(backup.data.adviceDiscussionTurns.length, 2);
    assert.ok(backup.data.adviceDiscussionTurns.every(item => !Object.hasOwn(item, 'jobId') && !Object.hasOwn(item, 'channel')));
    assert.equal(backup.data.adviceDiscussionVersions.length, 2);
    assert.ok(backup.data.jobHistory.some(item => item.type === 'advice_discussion'));
    const target = await appFor(t); const report = await restore(target, backup);
    assert.equal(report.conflictTotal, 0);
    assert.equal(report.counts.adviceDiscussions.inserted, 1);
    assert.equal(report.counts.adviceDiscussionTurns.inserted, 2);
    assert.equal(report.counts.adviceDiscussionVersions.inserted, 2);
    const restoredAggregate = target.store.require('advice-discussion', f.feedback.id);
    assert.equal(restoredAggregate.currentVersion, 1); assert.equal(restoredAggregate.status, 'ready');
    assert.equal(restoredAggregate.pendingTurnId, null); assert.equal(restoredAggregate.lastError, null);
    const restoredPending = target.store.require('advice-discussion-turn', pending.id);
    assert.equal(restoredPending.status, 'failed'); assert.equal(restoredPending.jobId, null);
    assert.equal(restoredPending.lastError.code, 'RESTORED_HISTORY');
    assert.equal(restoredPending.lastError.retryable, false);
    const restoredVersion = target.store.require('advice-discussion-version', saved.id);
    assert.equal(restoredVersion.decision, 'saved'); assert.equal(restoredVersion.outputId, output.id);
    assert.deepEqual(restoredVersion.candidate, saved.candidate);
    assert.equal(target.store.require('output', output.id).content, output.content);
    assert.equal(target.store.require('attempt', f.attempt.id).output, f.attempt.output);
    assert.equal(target.store.require('feedback', f.feedback.id).summary, f.feedback.summary);
    assertNoAuthority(target);
    const repeated = await restore(target, backup);
    assert.equal(repeated.counts.adviceDiscussions.inserted, 0);
    assert.equal(repeated.counts.adviceDiscussionTurns.inserted, 0);
    assert.equal(target.store.all('advice-discussion-turn').length, 2);
    assertNoAuthority(target);
    assert.equal(f.upstream.calls.length, 1);
  });
}

test('an unfinished first discussion restores the original ready v0 with failed history and no new AI candidate', async t => {
  const f = await discussionFixture(t); await f.app.jobs.stop(); await follow(f);
  const pending = turn(f); const backup = await document(f.app);
  assert.equal(backup.data.adviceDiscussionVersions.length, 1);
  const target = await appFor(t); const report = await restore(target, backup);
  assert.equal(report.conflictTotal, 0);
  const aggregate = target.store.require('advice-discussion', f.feedback.id);
  assert.equal(aggregate.currentVersion, 0); assert.equal(aggregate.status, 'ready'); assert.equal(aggregate.pendingTurnId, null);
  const restoredTurn = target.store.require('advice-discussion-turn', pending.id);
  assert.equal(restoredTurn.status, 'failed'); assert.equal(restoredTurn.reply, null); assert.equal(restoredTurn.resultVersion, null);
  assert.equal(restoredTurn.lastError.code, 'RESTORED_HISTORY'); assert.equal(restoredTurn.jobId, null);
  const originalVersion = target.store.all('advice-discussion-version');
  assert.equal(originalVersion.length, 1); assert.equal(originalVersion[0].version, 0);
  assert.equal(originalVersion[0].candidate.summary, f.feedback.summary);
  assert.equal(target.store.all('output').length, 0); assert.equal(f.upstream.calls.length, 0);
  assertNoAuthority(target);
});

test('default metadata-only backup resumes a bounded discussion without inventing source bodies or changing originals', async t => {
  const f = await discussionFixture(t);
  const backup = JSON.parse((await ok(f.app, 'POST', '/exports', { scope: 'all', projectIds: [] })).content);
  assert.equal(backup.sourceContentIncluded, false);
  assert.ok(backup.data.sources.every(source => source.text === null));
  assert.ok(!JSON.stringify(backup).includes(f.source.content));
  const target = await appFor(t, { adviceOptions: { clock: () => f.clock.value }, discussionOptions: { clock: () => f.clock.value } });
  const report = await restore(target, backup);
  assert.equal(report.conflictTotal, 0); assertNoAuthority(target);
  const restoredSource = target.store.require('source', f.source.id);
  assert.equal(restoredSource.content, null); assert.equal(restoredSource.contentDigest, f.source.contentDigest);
  await settings(target, { model: { enabled: true, endpoint: f.upstream.origin + '/v1',
    model: 'synthetic-discussion-model', allowExternalProcessing: false } });
  target.advice.update({ enabled: true, dailyCallLimit: 5 });
  const originalAttempt = structuredClone(target.store.require('attempt', f.attempt.id));
  const originalFeedback = structuredClone(target.store.require('feedback', f.feedback.id));
  const queued = await ok(target, 'POST', f.path, { message: 'Explain the original suggestion using only the retained answer.', expectedVersion: 0 });
  assert.ok(queued.pendingTurnId);
  const ready = await waitReady({ app: target, feedback: f.feedback });
  assert.equal(ready.version, 1); assert.equal(ready.status, 'ready'); assert.equal(ready.saved, false);
  assert.equal(f.upstream.calls.length, 1); assert.equal(f.state.inputs.length, 1);
  const input = f.state.inputs[0];
  assert.deepEqual(input.base.evidenceSnapshots, []); assert.equal(input.base.coverage.sourceCount, 0);
  assert.equal(input.base.output, originalAttempt.output);
  assert.ok(!JSON.stringify(input).includes(f.source.content));
  assert.equal(target.store.require('source', f.source.id).content, null);
  assert.deepEqual(target.store.require('attempt', f.attempt.id), originalAttempt);
  assert.deepEqual(target.store.require('feedback', f.feedback.id), originalFeedback);
  assert.equal(target.store.all('feedback').length, 1); assert.equal(target.store.all('output').length, 0);
  const calls = target.store.all('advice-call');
  assert.equal(calls.length, 1); assert.equal(calls[0].status, 'complete'); assert.equal(calls[0].coverage.sourceCount, 0);
  assert.equal(target.advice.settingsPublic().callsToday, 1); assert.equal(target.advice.settingsPublic().remainingToday, 4);
});

test('an old 0.4 backup without any discussion collections still imports prior feedback and saved outputs', async t => {
  const f = await savedFixture(t); const saved = version(f, 1); const backup = await document(f.app);
  for (const name of collections) delete backup.data[name];
  backup.productVersion = '0.4.0';
  const target = await appFor(t); const report = await restore(target, backup);
  assert.equal(report.conflictTotal, 0);
  for (const name of collections) assert.equal(report.counts[name].inserted, 0, name);
  for (const kind of kinds) assert.equal(target.store.all(kind).length, 0, kind);
  assert.ok(target.store.get('feedback', f.feedback.id)); assert.ok(target.store.get('attempt', f.attempt.id));
  assert.ok(target.store.get('output', saved.outputId)); assert.equal(target.store.all('advice-selection').length, 1);
  assertNoAuthority(target);
});

test('project scope includes only selected discussion history and saved-output dependencies', async t => {
  const f = await discussionFixture(t); const chosenProject = f.app.domain.createProject({ title: 'Chosen discussion project', goal: '' });
  const otherProject = f.app.domain.createProject({ title: 'Other discussion project', goal: '' });
  const chosen = f.createCase({ projectId: chosenProject.id, label: 'chosen' });
  const other = f.createCase({ projectId: otherProject.id, label: 'other' });
  await follow(f, 0, chosen); await waitReady(f, 1, chosen.feedback.id); await save(f, 1, chosen);
  await follow(f, 0, other); await waitReady(f, 1, other.feedback.id);
  const outputId = version(f, 1, chosen.feedback.id).outputId;
  const backup = await document(f.app, 'projects', [chosenProject.id]);
  assert.deepEqual(backup.data.projects.map(item => item.id), [chosenProject.id]);
  assert.deepEqual(backup.data.feedback.map(item => item.id), [chosen.feedback.id]);
  assert.deepEqual(backup.data.attempts.map(item => item.id), [chosen.attempt.id]);
  assert.deepEqual(backup.data.outputs.map(item => item.id), [outputId]);
  for (const name of collections) {
    assert.ok(backup.data[name].length > 0, name);
    assert.ok(backup.data[name].every(item => item.feedbackId === chosen.feedback.id), name);
  }
  assert.deepEqual(backup.data.sources.map(item => item.sourceId), [chosen.source.id]);
  const target = await appFor(t); const report = await restore(target, backup);
  assert.equal(report.conflictTotal, 0); assert.ok(target.store.get('output', outputId));
  assert.equal(target.store.all('advice-discussion').length, 1);
  assert.ok(!target.store.get('feedback', other.feedback.id)); assertNoAuthority(target);
});

const malformed = [
  ['non-array discussion collection', doc => { doc.data.adviceDiscussions = null; }],
  ['aggregate runtime pending identity', doc => { doc.data.adviceDiscussions[0].pendingTurnId = 'private_pending'; }],
  ['aggregate runtime status', doc => { doc.data.adviceDiscussions[0].status = 'running'; }],
  ['aggregate runtime error', doc => { doc.data.adviceDiscussions[0].lastError = null; }],
  ['aggregate feedback identity mismatch', doc => { doc.data.adviceDiscussions[0].feedbackId = 'another_feedback'; }],
  ['turn executable job identity', doc => { doc.data.adviceDiscussionTurns[0].jobId = 'private_job'; }],
  ['turn channel authority', doc => { doc.data.adviceDiscussionTurns[0].channel = { appIdentity: 'private' }; }],
  ['turn forbidden payload', doc => { doc.data.adviceDiscussionTurns[0].payload = { send: true }; }],
  ['turn unknown state', doc => { doc.data.adviceDiscussionTurns[0].status = 'mastered'; }],
  ['turn missing nullable field', doc => { delete doc.data.adviceDiscussionTurns[0].retryOfTurnId; }],
  ['turn 1001-character question', doc => { doc.data.adviceDiscussionTurns[0].message = 'x'.repeat(1001); }],
  ['turn inconsistent result version', doc => { doc.data.adviceDiscussionTurns[0].resultVersion = 8; }],
  ['version identity digest mismatch', doc => { doc.data.adviceDiscussionVersions[0].id = 'dv_invented'; }],
  ['saved version without output', doc => { doc.data.adviceDiscussionVersions.find(item => item.version === 1).outputId = null; }],
  ['candidate extra model field', doc => { doc.data.adviceDiscussionVersions[0].candidate.masteryScore = 100; }],
  ['candidate secret field', doc => { doc.data.adviceDiscussionVersions[0].candidate.apiKey = 'synthetic-private-key'; }],
  ['duplicate version record', doc => { doc.data.adviceDiscussionVersions.push(structuredClone(doc.data.adviceDiscussionVersions[0])); }],
];
for (const [name, mutate] of malformed) {
  test('malformed backup rejects ' + name + ' before importing any entity', async t => {
    const f = await savedFixture(t); const backup = await document(f.app); mutate(backup);
    const target = await appFor(t); const result = await request(target, 'POST', '/imports', { document: backup, mode: 'merge' });
    assert.equal(result.status, 422);
    for (const kind of ['project', 'source', 'practice', 'attempt', 'feedback', 'output', 'advice-selection', ...kinds, 'import-audit']) {
      assert.equal(target.store.all(kind).length, 0, kind);
    }
    assertNoAuthority(target);
  });
}

const missingDependencies = [
  ['feedback', (doc, f) => { doc.data.feedback = []; return ['adviceDiscussions', f.feedback.id]; }],
  ['attempt', (doc, f) => { doc.data.attempts = []; return ['adviceDiscussions', f.feedback.id]; }],
  ['saved output', (doc, f) => { doc.data.outputs = []; return ['adviceDiscussionVersions', version(f, 1).id]; }],
  ['current version', (doc, f) => { doc.data.adviceDiscussionVersions = doc.data.adviceDiscussionVersions.filter(item => item.version !== 1); return ['adviceDiscussions', f.feedback.id]; }],
  ['base version', (doc, f) => { doc.data.adviceDiscussionVersions = doc.data.adviceDiscussionVersions.filter(item => item.version !== 0); return ['adviceDiscussionTurns', turn(f).id]; }],
  ['version-producing turn', (doc, f) => { doc.data.adviceDiscussionTurns = []; return ['adviceDiscussionVersions', version(f, 1).id]; }],
];
for (const [name, remove] of missingDependencies) {
  test('missing ' + name + ' reports a dependency conflict and does not restore an orphan aggregate', async t => {
    const f = await savedFixture(t); const backup = await document(f.app); const [entity, recordId] = remove(backup, f);
    const target = await appFor(t); const report = await restore(target, backup);
    assert.ok(report.conflictTotal > 0);
    assert.ok(report.conflicts.some(item => item.entity === entity && item.id === recordId && item.reason === 'missing_dependency'));
    assert.equal(target.store.all('advice-discussion').length, 0); assertNoAuthority(target);
  });
}

test('a missing retry parent conflicts without restoring a retry turn or its candidate version', async t => {
  const f = await discussionFixture(t); f.state.malformed = true;
  await follow(f); await waitForStatus(f, 'failed'); const failed = turn(f);
  f.state.malformed = false;
  await ok(f.app, 'POST', f.path + '/retry', { turnId: failed.id, expectedVersion: 0, operationId: operation() });
  await waitReady(f); await save(f);
  const completed = f.app.store.all('advice-discussion-turn').find(item => item.status === 'ready');
  const backup = await document(f.app);
  backup.data.adviceDiscussionTurns = backup.data.adviceDiscussionTurns.filter(item => item.id !== failed.id);
  const target = await appFor(t); const report = await restore(target, backup);
  assert.ok(report.conflicts.some(item => item.entity === 'adviceDiscussionTurns' && item.id === completed.id && item.reason === 'missing_dependency'));
  assert.ok(!target.store.get('advice-discussion-turn', completed.id));
  assert.ok(!target.store.get('advice-discussion-version', version(f, 1).id));
  assert.equal(target.store.all('advice-discussion').length, 0); assertNoAuthority(target);
});
