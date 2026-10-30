import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, request, operation } from './helpers.mjs';
import { discussionFixture, waitReady, waitForStatus } from './discussion-fixture.mjs';

// A1 inert reads; A2 asynchronous one-call draft and immutable originals;
// A3 request/version/pending guards; A4 explicit immutable-version saves;
// A5 invalid inputs before calls; A6 cached failure and explicit retry only.
const discussionKinds = ['advice-discussion', 'advice-discussion-turn', 'advice-discussion-version'];
const turns = f => f.app.store.all('advice-discussion-turn');
const version = (f, number) => f.app.store.all('advice-discussion-version').find(item => item.feedbackId === f.feedback.id && item.version === number);
const submit = (f, message, expectedVersion = 0, operationId = operation()) => ok(f.app, 'POST', f.path, { message, expectedVersion, operationId });
const select = (f, action, expectedVersion, operationId = operation()) => ok(f.app, 'POST', f.path + '/' + action, { expectedVersion, operationId });

test('repeated discussion GETs are inert and expose the original unsaved suggestion', async t => {
  const f = await discussionFixture(t);
  const first = await ok(f.app, 'GET', f.path);
  for (let index = 0; index < 3; index++) assert.deepEqual(await ok(f.app, 'GET', f.path), first);
  assert.equal(first.version, 0); assert.equal(first.saved, false); assert.equal(first.pendingTurnId, null);
  assert.equal(first.candidate.summary, f.feedback.summary);
  for (const kind of [...discussionKinds, 'advice-call', 'output']) assert.equal(f.app.store.all(kind).length, 0, kind);
  assert.equal(f.upstream.calls.length, 0);
});

test('one followup is asynchronous, uses one shared-quota call and leaves originals unsaved and unchanged', async t => {
  const f = await discussionFixture(t); await f.app.jobs.stop();
  const originalAttempt = structuredClone(f.app.store.require('attempt', f.attempt.id));
  const originalFeedback = structuredClone(f.app.store.require('feedback', f.feedback.id));
  const queued = await submit(f, 'Explain why the expected count matters.');
  assert.equal(queued.version, 0); assert.equal(queued.status, 'queued'); assert.ok(queued.pendingTurnId);
  assert.equal(f.upstream.calls.length, 0); assert.equal(f.app.store.all('output').length, 0);
  f.app.jobs.start(); const ready = await waitReady(f);
  assert.equal(ready.version, 1); assert.equal(ready.saved, false); assert.equal(ready.pendingTurnId, null);
  assert.ok(ready.reply.includes('Synthetic explanation 1'));
  assert.equal(f.upstream.calls.length, 1); assert.equal(f.app.store.all('advice-call').length, 1);
  assert.equal(f.app.advice.settingsPublic().callsToday, 1); assert.equal(f.app.advice.settingsPublic().remainingToday, 4);
  assert.deepEqual(f.app.store.all('advice-call')[0].usage, { prompt_tokens: 70, completion_tokens: 50, total_tokens: 120 });
  assert.deepEqual(f.app.store.require('attempt', f.attempt.id), originalAttempt);
  assert.deepEqual(f.app.store.require('feedback', f.feedback.id), originalFeedback);
  assert.equal(f.app.store.all('feedback').length, 1); assert.equal(f.app.store.all('output').length, 0);
  assert.equal(f.state.inputs[0].newMessage, 'Explain why the expected count matters.');
  assert.equal(f.state.inputs[0].base.output, originalAttempt.output);
});

test('replayed operation creates one turn and request, while stale version is rejected', async t => {
  const f = await discussionFixture(t); const op = operation();
  const body = { message: 'Clarify one concrete check.', expectedVersion: 0, operationId: op };
  const first = await ok(f.app, 'POST', f.path, body); await waitReady(f);
  assert.deepEqual(await ok(f.app, 'POST', f.path, body), first);
  assert.equal(turns(f).length, 1); assert.equal(f.upstream.calls.length, 1);
  assert.equal(f.app.store.all('advice-call').length, 1);
  const stale = await request(f.app, 'POST', f.path, { message: 'Use the old displayed version.', expectedVersion: 0 });
  assert.equal(stale.status, 409); assert.equal(stale.error.code, 'DISCUSSION_VERSION_CHANGED');
  assert.equal(turns(f).length, 1); assert.equal(f.upstream.calls.length, 1);
});

test('save and dismiss reject a pending generation without creating outputs or extra requests', async t => {
  const f = await discussionFixture(t); await f.app.jobs.stop();
  await submit(f, 'Please clarify the unsaved draft.');
  for (const action of ['save', 'dismiss']) {
    const result = await request(f.app, 'POST', f.path + '/' + action, { expectedVersion: 0 });
    assert.equal(result.status, 409); assert.equal(result.error.code, 'DISCUSSION_PENDING');
  }
  assert.equal(f.app.store.all('output').length, 0); assert.equal(f.upstream.calls.length, 0);
  f.app.jobs.start(); await waitReady(f);
  assert.equal(f.upstream.calls.length, 1); assert.equal(f.app.store.all('output').length, 0);
});

test('saving the displayed version is idempotent and later discussion never overwrites its output', async t => {
  const f = await discussionFixture(t); await submit(f, 'Make the check more concrete.'); await waitReady(f);
  const op = operation(); const saved = await select(f, 'save', 1, op);
  assert.equal(saved.saved, true); assert.equal(f.app.store.all('output').length, 1);
  const firstOutputId = version(f, 1).outputId; const firstOutput = structuredClone(f.app.store.require('output', firstOutputId));
  assert.deepEqual(await select(f, 'save', 1, op), saved);
  await select(f, 'save', 1); assert.equal(f.app.store.all('output').length, 1);
  await submit(f, 'Now explain a different limitation.', 1); const second = await waitReady(f, 2);
  assert.equal(second.saved, false); assert.equal(second.version, 2);
  assert.equal(f.app.store.all('output').length, 1);
  assert.deepEqual(f.app.store.require('output', firstOutputId), firstOutput);
  assert.equal(version(f, 2).outputId, null);
  const staleSave = await request(f.app, 'POST', f.path + '/save', { expectedVersion: 1 });
  assert.equal(staleSave.status, 409); assert.equal(staleSave.error.code, 'DISCUSSION_VERSION_CHANGED');
  await select(f, 'save', 2); await select(f, 'save', 2);
  assert.equal(f.app.store.all('output').length, 2);
  assert.notEqual(version(f, 2).outputId, firstOutputId);
  assert.deepEqual(f.app.store.require('output', firstOutputId), firstOutput);
  assert.equal(f.upstream.calls.length, 2);
});

test('dismissing the latest draft retains its candidate, original records and any earlier saved output', async t => {
  const f = await discussionFixture(t); await submit(f, 'Explain this check.'); await waitReady(f);
  await select(f, 'save', 1); const output = structuredClone(f.app.store.all('output')[0]);
  await submit(f, 'Which part should I check next?', 1); const ready = await waitReady(f, 2);
  const dismissed = await select(f, 'dismiss', 2);
  assert.equal(dismissed.dismissed, true); assert.equal(dismissed.saved, false);
  assert.deepEqual(dismissed.candidate, ready.candidate);
  assert.deepEqual(f.app.store.require('output', output.id), output);
  assert.equal(f.app.store.all('output').length, 1);
  assert.equal(f.app.store.require('attempt', f.attempt.id).output, f.attempt.output);
});

const invalid = [
  ['empty message', '', { message: '', expectedVersion: 0 }],
  ['whitespace message', '', { message: '  \n', expectedVersion: 0 }],
  ['1001-character message', '', { message: 'x'.repeat(1001), expectedVersion: 0 }],
  ['unknown submit field', '', { message: 'Explain one check.', expectedVersion: 0, candidate: 'injected' }],
  ['missing submit version', '', { message: 'Explain one check.' }],
  ['missing save version', '/save', {}],
  ['missing dismiss version', '/dismiss', {}],
  ['unknown save field', '/save', { expectedVersion: 0, candidate: 'injected' }],
];
for (const [name, suffix, body] of invalid) {
  test('invalid API request rejects ' + name + ' before a provider call', async t => {
    const f = await discussionFixture(t); const result = await request(f.app, 'POST', f.path + suffix, body);
    assert.ok(result.status >= 400 && result.status < 500, JSON.stringify(result.error));
    assert.equal(f.upstream.calls.length, 0); assert.equal(f.app.store.all('advice-call').length, 0);
    assert.equal(f.app.store.all('advice-discussion-turn').length, 0); assert.equal(f.app.store.all('output').length, 0);
  });
}

test('1000-character followup is accepted without silently truncating the stored question', async t => {
  const f = await discussionFixture(t); const message = '问'.repeat(1000);
  await submit(f, message); const ready = await waitReady(f);
  assert.equal(ready.lastUserMessage, message); assert.equal(f.state.inputs[0].newMessage, message);
  assert.equal(f.upstream.calls.length, 1);
});

test('a failed round stays cached until explicit retry, which preserves user text and uses one new call', async t => {
  const f = await discussionFixture(t); f.state.malformed = true;
  const op = operation(); const message = 'Explain what evidence is still missing.';
  const body = { message, expectedVersion: 0, operationId: op };
  const ack = await ok(f.app, 'POST', f.path, body); const failed = await waitForStatus(f, 'failed');
  assert.equal(failed.version, 0); assert.equal(f.upstream.calls.length, 1);
  const originalTurn = turns(f)[0]; assert.equal(originalTurn.status, 'failed');
  for (let index = 0; index < 3; index++) await ok(f.app, 'GET', f.path);
  assert.deepEqual(await ok(f.app, 'POST', f.path, body), ack);
  assert.equal(f.upstream.calls.length, 1); assert.equal(turns(f).length, 1);
  f.state.malformed = false;
  const retryBody = { turnId: originalTurn.id, expectedVersion: 0, operationId: operation() };
  const retry = await ok(f.app, 'POST', f.path + '/retry', retryBody); await waitReady(f);
  assert.deepEqual(await ok(f.app, 'POST', f.path + '/retry', retryBody), retry);
  assert.equal(f.upstream.calls.length, 2); assert.equal(f.app.store.all('advice-call').length, 2);
  assert.equal(turns(f).length, 2);
  const completed = turns(f).find(turn => turn.status === 'ready');
  assert.equal(completed.retryOfTurnId, originalTurn.id); assert.equal(completed.message, message);
  assert.equal(f.state.inputs[1].newMessage, message);
  assert.equal(f.app.store.require('advice-discussion-turn', originalTurn.id).status, 'failed');
  assert.equal(f.app.store.all('output').length, 0);
});
