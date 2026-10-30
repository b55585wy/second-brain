import test from 'node:test';
import assert from 'node:assert/strict';
import { Advice } from '../../server/advice.mjs';
import { AdviceDiscussion } from '../../server/advice-discussion.mjs';
import { ApiError } from '../../server/errors.mjs';
import { appFor, profile, settings, scope, jobDone, operation } from './helpers.mjs';

// Requirements: inert reads; immutable answers/feedback/drafts; explicit per-version saves;
// operation dedup/overlap; bounded discussion; shared budget/time zone; failure/restart recovery;
// source/model/channel guards before calls and publication; old versions and acknowledgments.
async function fixture(t, { kind = 'manual' } = {}) {
  const app = await appFor(t); app.learning.onAttempt = null;
  const clock = { value: new Date('2026-10-31T01:00:00.000Z') };
  await profile(app, { goals: ['Reliable storage'], timeZone: 'Asia/Shanghai' });
  await settings(app, { model: { enabled: true, endpoint: 'http://127.0.0.1:1234/v1', model: 'synthetic', allowExternalProcessing: false } });
  const advice = new Advice(app.store, app.settings, app.domain, app.collector, app.learning, app.model, app.jobs, { clock: () => clock.value });
  advice.update({ enabled: true, dailyCallLimit: 20 });
  const discussion = new AdviceDiscussion(app.store, advice, app.learning, app.jobs, { clock: () => clock.value });
  app.jobs.register('advice_discussion', (payload, job) => discussion.run(payload, job));
  const source = app.sources.capture({ kind, externalId: 'discussion-fixture', title: 'Replay evidence', content: 'Replay one operation and retain one result.' });
  const refs = [app.sources.ref(source)];
  const practice = app.learning.createPractice({ projectId: null, kind: 'explanation', goal: 'Reliable storage', skill: '',
    prompt: 'Explain a replay check.', estimatedMinutes: 5, sourceRefs: refs,
    rubric: [{ label: 'Evidence', description: 'Use an observable count.', expectedEvidence: ['Record count'] }] }, app.learning.provenance('template', refs));
  const attempt = app.learning.attempt(practice.id, { output: 'Replay the same operation and compare the record count.', assistanceLevel: 'none', evidenceRefs: [] });
  const { feedback } = app.learning.saveFeedback(attempt.id, 'model', { summary: 'State the expected count.',
    observations: [{ criterionId: practice.rubric[0].id, finding: 'not_assessed', comment: 'Describe the expected record count.', evidenceRefs: [] }],
    nextActions: ['Write one expected result.'], limitations: ['No mastery claim.'] });
  const provider = { calls: 0, inputs: [], before: null, error: null };
  app.model.generate = async (_instruction, input, options) => {
    provider.calls++; provider.inputs.push(structuredClone(input)); await provider.before?.();
    options.onUsage?.({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    if (provider.error) throw provider.error;
    return { reply: 'Compare the expected result with the observed result.', candidate: { summary: `Revised suggestion ${provider.calls}.`,
      observations: input.base.rubric.map(item => ({ criterionId: item.id, finding: 'not_assessed', comment: 'Use one observable count.', evidenceRefs: [], outputExcerpt: '' })),
      nextActions: ['Record the expected count.'], limitations: ['The original answer has not changed.'] } };
  };
  const submit = (values = {}) => discussion.submit(feedback.id, { message: 'Why is an expected count useful?',
    expectedVersion: discussion.public(feedback.id).version, operationId: operation(), ...values });
  const wait = async (view, expected = 'succeeded') => {
    const turn = app.store.require('advice-discussion-turn', view.pendingTurnId);
    await jobDone(app, { jobId: turn.jobId }, expected); return discussion.public(feedback.id);
  };
  return { app, advice, discussion, clock, source, practice, attempt, feedback, provider, submit, wait };
}

test('reading original advice creates no discussion rows, outputs, jobs, or model calls', async t => {
  const f = await fixture(t); const before = f.app.store.all('job').length;
  const view = f.discussion.public(f.feedback.id);
  assert.equal(view.version, 0); assert.equal(view.candidate.summary, f.feedback.summary); assert.equal(view.saved, false);
  assert.equal(f.app.store.all('advice-discussion').length, 0); assert.equal(f.app.store.all('advice-discussion-version').length, 0);
  assert.equal(f.app.store.all('job').length, before); assert.equal(f.provider.calls, 0);
});

test('one discussion produces a candidate version without changing the original answer or feedback', async t => {
  const f = await fixture(t); const original = f.app.store.require('attempt', f.attempt.id);
  const view = await f.wait(f.submit()); assert.equal(view.version, 1); assert.equal(view.status, 'ready');
  assert.equal(view.saved, false); assert.equal(f.app.store.all('output').length, 0); assert.equal(f.provider.calls, 1);
  assert.deepEqual(f.app.store.require('attempt', f.attempt.id), original); assert.deepEqual(f.app.store.require('feedback', f.feedback.id), f.feedback);
  assert.equal(f.app.store.all('feedback').length, 1); assert.equal(f.app.store.all('advice-discussion-version').length, 2);
  assert.equal(f.advice.calls().length, 1); assert.deepEqual(f.advice.calls()[0].usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

test('explicit saves are once per candidate version and later drafts preserve earlier saved outputs', async t => {
  const f = await fixture(t); const first = await f.wait(f.submit());
  const saved = f.discussion.save(f.feedback.id, { expectedVersion: first.version, operationId: operation() }); assert.equal(saved.saved, true);
  f.discussion.save(f.feedback.id, { expectedVersion: first.version, operationId: operation() });
  const oldOutput = f.app.store.all('output')[0]; assert.equal(f.app.store.all('output').length, 1);
  const second = await f.wait(f.submit()); assert.equal(second.saved, false); assert.equal(second.canSave, true);
  f.discussion.save(f.feedback.id, { expectedVersion: second.version, operationId: operation() });
  assert.equal(f.app.store.all('output').length, 2); assert.deepEqual(f.app.store.require('output', oldOutput.id), oldOutput);
  assert.notEqual(f.app.store.require('advice-selection', f.feedback.id).outputId, oldOutput.id);
});

test('dismissing a new version retains the historical saved output and never changes candidate content', async t => {
  const f = await fixture(t); f.discussion.save(f.feedback.id, { expectedVersion: 0, operationId: operation() });
  const oldOutput = f.app.store.all('output')[0]; const view = await f.wait(f.submit()); const candidate = view.candidate;
  const dismissed = f.discussion.dismiss(f.feedback.id, { expectedVersion: view.version, operationId: operation() });
  assert.equal(dismissed.dismissed, true); assert.deepEqual(dismissed.candidate, candidate); assert.equal(f.app.store.all('output').length, 1);
  assert.equal(f.app.store.require('advice-selection', f.feedback.id).outputId, oldOutput.id);
});

test('same operation is reused while queued and after success without another paid call', async t => {
  const f = await fixture(t); await f.app.jobs.stop(); const op = operation();
  const view = f.submit({ operationId: op }); assert.equal(f.submit({ operationId: op }).pendingTurnId, view.pendingTurnId);
  f.app.jobs.start(); await f.wait(view);
  assert.equal(f.submit({ operationId: op, expectedVersion: 0 }).version, 1);
  assert.equal(f.provider.calls, 1); assert.equal(f.app.store.all('advice-discussion-turn').length, 1);
  const turn = f.app.store.all('advice-discussion-turn')[0]; const job = f.app.store.require('job', turn.jobId);
  await f.discussion.run(job.payload, job); assert.equal(f.provider.calls, 1); assert.equal(f.discussion.public(f.feedback.id).version, 1);
});

test('pending discussion rejects overlap and save inside the transaction without outputs', async t => {
  const f = await fixture(t); await f.app.jobs.stop(); f.submit();
  assert.throws(() => f.submit(), error => error.code === 'DISCUSSION_PENDING');
  assert.throws(() => f.discussion.save(f.feedback.id, { expectedVersion: 0, operationId: operation() }), error => error.code === 'DISCUSSION_PENDING');
  assert.equal(f.app.store.all('output').length, 0); assert.equal(f.advice.calls().length, 0);
});

test('a stale draft version cannot be submitted or saved', async t => {
  const f = await fixture(t); await f.wait(f.submit());
  assert.throws(() => f.submit({ expectedVersion: 0 }), error => error.code === 'DISCUSSION_VERSION_CHANGED');
  assert.throws(() => f.discussion.save(f.feedback.id, { expectedVersion: 0, operationId: operation() }), error => error.code === 'DISCUSSION_VERSION_CHANGED');
  assert.equal(f.provider.calls, 1); assert.equal(f.app.store.all('output').length, 0);
});

for (const message of ['', ' ', 'x'.repeat(1001), null]) {
  test(`invalid discussion message ${message === null ? 'null' : message.length} is rejected before queue or quota reservation`, async t => {
    const f = await fixture(t); assert.throws(() => f.submit({ message }));
    assert.equal(f.app.store.all('advice-discussion-turn').length, 0); assert.equal(f.provider.calls, 0);
  });
}

test('a maximum-length message is bounded and only the latest three history turns reach the model', async t => {
  const f = await fixture(t); await f.wait(f.submit({ message: '问'.repeat(1000) }));
  for (let index = 0; index < 4; index++) await f.wait(f.submit());
  const input = f.provider.inputs.at(-1); assert.ok(input.turns.length <= 3); assert.equal(input.coverage.historyTurnsTotal, 4);
  assert.equal(input.base.output, f.attempt.output); assert.equal(f.app.store.all('advice-discussion-turn').length, 5);
});

for (const ack of ['好', '好的', 'OK', 'ok', '收到', '谢谢']) {
  test(`short acknowledgment ${ack} creates no model call, version, selection, or output`, async t => {
    const f = await fixture(t); const view = f.submit({ message: ack }); assert.equal(view.version, 0);
    for (const kind of ['advice-discussion', 'advice-discussion-version', 'advice-discussion-turn', 'advice-selection', 'output', 'advice-call']) assert.equal(f.app.store.all(kind).length, 0, kind);
    assert.equal(f.provider.calls, 0);
  });
}

for (const limit of [0, 20]) {
  test(`discussion shares the advice budget at limit ${limit}`, async t => {
    const f = await fixture(t); f.advice.update({ dailyCallLimit: limit });
    if (!limit) assert.throws(() => f.submit(), error => error.code === 'ADVICE_LIMIT');
    else {
      for (let index = 0; index < limit; index++) f.app.store.put('advice-call', { date: f.advice.date(), status: 'failed' }, `prior_${index}`);
      assert.throws(() => f.submit(), error => error.code === 'ADVICE_LIMIT');
    }
    assert.equal(f.provider.calls, 0); assert.equal(f.advice.calls().length, limit);
  });
}

test('shared daily quota resets at the profile time-zone midnight and allows historical feedback discussion', async t => {
  const f = await fixture(t); f.advice.update({ dailyCallLimit: 1 }); f.clock.value = new Date('2026-10-31T15:59:00.000Z');
  await f.wait(f.submit()); assert.throws(() => f.submit(), error => error.code === 'ADVICE_LIMIT');
  f.clock.value = new Date('2026-10-31T16:01:00.000Z'); assert.equal(f.advice.calls().length, 0);
  assert.equal((await f.wait(f.submit())).version, 2); assert.equal(f.provider.calls, 2);
});

for (const uncertain of [false, true]) {
  test(`${uncertain ? 'uncertain' : 'failed'} calls count and only an explicit retry creates a new provider operation`, async t => {
    const f = await fixture(t); const error = new ApiError(503, 'SYNTHETIC_FAILURE', 'Synthetic failure.'); error.uncertain = uncertain; f.provider.error = error;
    const failed = await f.wait(f.submit(), 'failed'); assert.equal(failed.status, uncertain ? 'uncertain' : 'failed');
    const turn = f.app.store.all('advice-discussion-turn')[0]; assert.equal(f.advice.calls().length, 1);
    assert.equal(f.provider.calls, 1); f.provider.error = null;
    const retry = f.discussion.retry(f.feedback.id, { turnId: turn.id, expectedVersion: 0, operationId: operation() });
    assert.equal((await f.wait(retry)).version, 1); assert.equal(f.provider.calls, 2); assert.equal(f.advice.calls().length, 2);
    const jobs = f.app.store.all('job').filter(job => job.kind === 'advice_discussion'); assert.equal(jobs.length, 2);
    assert.notEqual(jobs[0].operationId, jobs[1].operationId); assert.notEqual(jobs[0].operationId, turn.operationId);
  });
}

for (const priorStatus of ['reserved', 'failed']) {
  test(`restart with a ${priorStatus} ledger never resends the discussion`, async t => {
    const f = await fixture(t); await f.app.jobs.stop(); const view = f.submit(); const turn = f.app.store.require('advice-discussion-turn', view.pendingTurnId);
    const lastError = { code: 'ORIGINAL_FAILURE', message: 'Keep original error.', retryable: false };
    f.app.store.put('advice-discussion-turn', { ...turn, lastError }, turn.id);
    f.app.store.put('advice-call', { date: f.advice.date(), status: priorStatus }, turn.jobId);
    const restarted = new AdviceDiscussion(f.app.store, f.advice, f.app.learning, f.app.jobs, { clock: () => f.clock.value });
    f.app.jobs.register('advice_discussion', (payload, job) => restarted.run(payload, job)); f.app.jobs.start();
    await jobDone(f.app, { jobId: turn.jobId }); assert.equal(restarted.public(f.feedback.id).status, priorStatus === 'failed' ? 'failed' : 'uncertain');
    if (priorStatus === 'failed') assert.deepEqual(f.app.store.require('advice-discussion-turn', turn.id).lastError, lastError);
    assert.equal(f.provider.calls, 0); assert.equal(f.advice.calls().length, 1);
  });
}

for (const afterCall of [false, true]) {
  test(`source changes ${afterCall ? 'during' : 'before'} generation block result publication`, async t => {
    const f = await fixture(t); const change = () => f.app.sources.capture({ ...f.source, content: 'Changed evidence.' });
    if (afterCall) f.provider.before = change; else await f.app.jobs.stop();
    const queued = f.submit(); if (!afterCall) { change(); f.app.jobs.start(); }
    const view = await f.wait(queued, 'failed'); assert.equal(view.version, 0); assert.equal(view.status, 'stale');
    assert.equal(f.provider.calls, afterCall ? 1 : 0); assert.equal(f.app.store.all('output').length, 0);
  });
}

test('revoked dialogue authorization blocks historical feedback discussion without a model request', async t => {
  const f = await fixture(t, { kind: 'manual_dialogue' }); await scope(f.app, { allowManualImports: false });
  assert.throws(() => f.submit(), error => error.code === 'ADVICE_CONTEXT_CHANGED'); assert.equal(f.provider.calls, 0);
  assert.equal(f.discussion.public(f.feedback.id).canSave, false);
});

for (const afterCall of [false, true]) {
  test(`Feishu binding changes ${afterCall ? 'during' : 'before'} generation suppress calls or publication`, async t => {
    const f = await fixture(t); let valid = true; f.discussion.channelGuard = () => valid;
    if (afterCall) f.provider.before = () => { valid = false; }; else await f.app.jobs.stop();
    const queued = f.submit({ channel: { bindingEpoch: 'synthetic' } });
    if (!afterCall) { valid = false; f.app.jobs.start(); }
    const view = await f.wait(queued, 'failed'); assert.equal(view.version, 0); assert.equal(view.status, 'stale');
    assert.equal(f.provider.calls, afterCall ? 1 : 0);
  });
}

test('disabling advice while queued refuses the model call without spending quota', async t => {
  const f = await fixture(t); await f.app.jobs.stop(); const queued = f.submit(); f.advice.update({ enabled: false });
  f.app.jobs.start(); const view = await f.wait(queued, 'failed'); assert.equal(view.version, 0); assert.equal(f.provider.calls, 0); assert.equal(f.advice.calls().length, 0);
});
