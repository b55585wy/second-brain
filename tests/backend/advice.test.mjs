import test from 'node:test';
import assert from 'node:assert/strict';
import { Advice } from '../../server/advice.mjs';
import { ApiError } from '../../server/errors.mjs';
import { appFor, profile, settings, scope, jobDone } from './helpers.mjs';

async function fixture(t, options = {}) {
  const app = await appFor(t, { ...(options.keep ? { keep: true } : {}) });
  app.learning.onAttempt = null;
  const clock = { value: new Date('2026-10-30T01:00:00.000Z') };
  await profile(app, { goals: ['Explain reliable storage'], timeZone: 'Asia/Shanghai', dailyBudgetMinutes: 15 });
  await settings(app, { model: { enabled: true, endpoint: 'http://127.0.0.1:1234/v1', model: 'synthetic', allowExternalProcessing: false } });
  const state = { calls: 0, inputs: [], before: null, failure: null, usage: null };
  app.model.generate = async (_instruction, input, request) => {
    state.calls++; state.inputs.push(structuredClone(input));
    await state.before?.(input);
    request.onUsage?.(state.usage);
    if (state.failure) throw state.failure;
    return { summary: 'You proposed a checkable action.', observations: input.rubric.map(criterion => ({
      criterionId: criterion.id, finding: 'partial', comment: 'Explain the expected outcome as well.', evidenceRefs: [],
      outputExcerpt: [...input.output].slice(0, 20).join('') })), nextActions: ['Add the expected outcome of your replay check.'], limitations: [] };
  };
  const advice = new Advice(app.store, app.settings, app.domain, app.collector, app.learning, app.model, app.jobs, { clock: () => clock.value });
  app.jobs.register('answer_advice', (payload, job) => advice.run(payload, job));
  const create = (values = {}) => {
    const source = values.source ?? app.sources.capture({ kind: 'manual', externalId: 'advice-fixture', title: 'Replay evidence', content: 'A replay should not save another copy.' });
    const practice = app.learning.createPractice({ projectId: null, kind: 'new_scenario', goal: 'Explain reliable storage', skill: '',
      prompt: 'Explain a check for duplicate writes.', estimatedMinutes: 5,
      rubric: values.rubric ?? [{ label: 'Evidence', description: 'Give a checkable expected result.', expectedEvidence: ['Replay result'] }],
      sourceRefs: values.refs ?? [app.sources.ref(source)] }, app.learning.provenance('template', values.refs ?? [app.sources.ref(source)]));
    const attempt = app.learning.attempt(practice.id, { output: values.output ?? 'I will replay the same operation and compare the saved record count.',
      assistanceLevel: values.assistanceLevel ?? 'none', evidenceRefs: [] });
    return { source, practice, attempt };
  };
  return { app, advice, state, clock, create };
}

function enable(f, dailyCallLimit = 3) { return f.advice.update({ enabled: true, dailyCallLimit }); }
async function run(f, attempt, expected = 'succeeded', request = {}) {
  const queued = f.advice.schedule(attempt.id, request);
  assert.ok(queued.jobId); await jobDone(f.app, { jobId: queued.jobId }, expected);
  return f.advice.public(attempt.id);
}

test('advice defaults off and enabling does not queue historical answers', async t => {
  const f = await fixture(t); const saved = f.create();
  const before = f.app.store.all('job').length;
  assert.equal(f.advice.settingsPublic().enabled, false); assert.equal(f.advice.public(saved.attempt.id).status, 'off');
  enable(f); assert.equal(f.app.store.all('job').length, before); assert.equal(f.state.calls, 0);
  assert.equal(f.advice.public(saved.attempt.id).status, 'idle');
});

test('one requested answer receives a cited saved feedback while the original output stays unchanged', async t => {
  const f = await fixture(t); enable(f); const saved = f.create();
  const result = await run(f, saved.attempt);
  assert.equal(result.status, 'ready'); assert.equal(result.feedback.mode, 'model'); assert.equal(f.state.calls, 1);
  assert.equal(f.app.store.require('attempt', saved.attempt.id).output, saved.attempt.output);
  assert.equal(result.feedback.observations.length, saved.practice.rubric.length);
  assert.match(result.feedback.observations[0].comment, /I will replay/);
  assert.equal(f.advice.settingsPublic().callsToday, 1); assert.equal(f.advice.settingsPublic().remainingToday, 2);
});

test('queued duplicate requests and ready requests including retry reuse one model operation', async t => {
  const f = await fixture(t); enable(f); const saved = f.create(); await f.app.jobs.stop();
  const first = f.advice.schedule(saved.attempt.id, { automatic: true });
  const repeated = f.advice.schedule(saved.attempt.id); const retry = f.advice.schedule(saved.attempt.id, { retry: true });
  assert.equal(first.jobId, repeated.jobId); assert.equal(first.jobId, retry.jobId);
  f.app.jobs.start(); await jobDone(f.app, { jobId: first.jobId });
  const ready = f.advice.schedule(saved.attempt.id, { retry: true });
  assert.equal(ready.feedback.id, f.advice.public(saved.attempt.id).feedback.id);
  assert.equal(f.state.calls, 1); assert.equal(f.app.store.all('advice-call').length, 1);
});

test('successful results preserve prior feedback rows and never overwrite the submitted answer', async t => {
  const f = await fixture(t); enable(f); const saved = f.create();
  const previous = (await f.app.learning.feedback(saved.attempt.id, { mode: 'template' })).feedback;
  const result = await run(f, saved.attempt);
  assert.notEqual(result.feedback.id, previous.id); assert.deepEqual(f.app.store.require('feedback', previous.id), previous);
  assert.equal(f.app.store.require('attempt', saved.attempt.id).output, saved.attempt.output);
});

for (const value of [0, 20]) {
  test(`daily advice limit accepts ${value} and remains independent of digest usage`, async t => {
    const f = await fixture(t); enable(f, value); const saved = f.create();
    for (let index = 0; index < 3; index++) f.app.store.put('automation-call', { date: f.advice.date(), status: 'complete' }, 'digest_' + index);
    const result = f.advice.schedule(saved.attempt.id);
    assert.equal(f.advice.settingsPublic().dailyCallLimit, value);
    if (!value) { assert.equal(result.status, 'limited'); assert.equal(f.state.calls, 0); assert.equal(result.jobId, null); }
    else { await jobDone(f.app, { jobId: result.jobId }); assert.equal(f.state.calls, 1); }
    assert.equal(f.app.store.all('automation-call').length, 3);
  });
}

for (const value of [-1, 21, 1.5, '3', null]) {
  test(`invalid advice budget ${JSON.stringify(value)} changes no settings`, async t => {
    const f = await fixture(t); const before = f.advice.settingsPublic();
    assert.throws(() => f.advice.update({ dailyCallLimit: value })); assert.deepEqual(f.advice.settingsPublic(), before);
  });
}

test('failed and uncertain calls consume the same fresh daily budget with no implicit retries', async t => {
  const f = await fixture(t); enable(f, 2);
  f.state.failure = new ApiError(502, 'UPSTREAM_ERROR', 'Synthetic invalid model response.');
  const first = f.create(); const failed = await run(f, first.attempt, 'failed');
  assert.equal(failed.status, 'failed'); assert.equal(failed.canRetry, true);
  assert.equal(f.advice.schedule(first.attempt.id).jobId, failed.jobId); assert.equal(f.state.calls, 1);
  const uncertain = new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'Synthetic unknown request.'); uncertain.uncertain = true;
  f.state.failure = uncertain; const second = f.create(); const result = await run(f, second.attempt, 'failed');
  assert.equal(result.status, 'uncertain'); assert.equal(result.canRetry, false);
  assert.equal(f.advice.settingsPublic().callsToday, 2); assert.equal(f.advice.settingsPublic().remainingToday, 0);
  assert.equal(f.advice.schedule(f.create().attempt.id).status, 'limited'); assert.equal(f.state.calls, 2);
  assert.equal(f.app.store.require('attempt', first.attempt.id).output, first.attempt.output);
});

test('an explicit retry reserves a new attempt and recovers while retaining the failed ledger', async t => {
  const f = await fixture(t); enable(f); const saved = f.create();
  f.state.failure = new ApiError(502, 'UPSTREAM_ERROR', 'Synthetic failure.'); await run(f, saved.attempt, 'failed');
  const original = f.app.store.all('advice-call')[0]; f.state.failure = null;
  const result = await run(f, saved.attempt, 'succeeded', { retry: true });
  assert.equal(result.status, 'ready'); assert.equal(f.state.calls, 2);
  assert.deepEqual(f.app.store.require('advice-call', original.id), original);
});

test('queued answers cannot overrun a shared daily budget when they all looked eligible before execution', async t => {
  const f = await fixture(t); enable(f, 2); await f.app.jobs.stop();
  const answers = Array.from({ length: 3 }, () => f.create().attempt);
  const queued = answers.map(answer => f.advice.schedule(answer.id));
  assert.ok(queued.every(item => item.status === 'queued'));
  f.app.jobs.start();
  for (const item of queued) {
    const end = Date.now() + 8000;
    while (['queued', 'running'].includes(f.app.store.require('job', item.jobId).status)) {
      assert.ok(Date.now() < end); await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  const statuses = answers.map(answer => f.advice.public(answer.id).status).sort();
  assert.deepEqual(statuses, ['limited', 'ready', 'ready']); assert.equal(f.state.calls, 2);
  assert.equal(f.advice.settingsPublic().callsToday, 2);
});

test('an explicitly retried uncertain request retains its original uncertainty and consumes one new attempt', async t => {
  const f = await fixture(t); enable(f); const saved = f.create();
  const error = new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'Synthetic uncertain request.'); error.uncertain = true;
  f.state.failure = error; await run(f, saved.attempt, 'failed');
  const original = f.app.store.all('advice-call')[0];
  assert.equal(original.status, 'uncertain'); assert.equal(f.advice.schedule(saved.attempt.id).status, 'uncertain');
  assert.equal(f.state.calls, 1); f.state.failure = null;
  assert.equal((await run(f, saved.attempt, 'succeeded', { retry: true })).status, 'ready');
  assert.equal(f.state.calls, 2); assert.deepEqual(f.app.store.require('advice-call', original.id), original);
});

test('a local-date boundary restores budget using the profile timezone without rewriting previous calls', async t => {
  const f = await fixture(t); enable(f, 1); f.clock.value = new Date('2026-10-30T15:59:00Z');
  await run(f, f.create().attempt); const old = f.app.store.all('advice-call')[0];
  assert.equal(old.date, '2026-10-30'); assert.equal(f.advice.schedule(f.create().attempt.id).status, 'limited');
  f.clock.value = new Date('2026-10-30T16:01:00Z'); assert.equal(f.advice.settingsPublic().callsToday, 0);
  await run(f, f.create().attempt); assert.equal(f.advice.settingsPublic().callsToday, 1);
  assert.equal(f.app.store.all('advice-call').length, 2); assert.deepEqual(f.app.store.require('advice-call', old.id), old);
});

test('a previously limited answer becomes requestable when its next local day has budget', async t => {
  const f = await fixture(t); enable(f, 0); const saved = f.create();
  assert.equal(f.advice.schedule(saved.attempt.id).status, 'limited');
  enable(f, 1); f.clock.value = new Date('2026-10-31T01:00:00Z');
  assert.equal(f.advice.public(saved.attempt.id).status, 'idle');
  assert.equal(f.advice.public(saved.attempt.id).canRequest, true); await run(f, saved.attempt);
});

test('unavailable model can be configured later without losing an answer or making a background call', async t => {
  const f = await fixture(t); enable(f); const saved = f.create();
  await settings(f.app, { model: { enabled: false } });
  assert.equal(f.advice.schedule(saved.attempt.id).status, 'unavailable'); assert.equal(f.state.calls, 0);
  await settings(f.app, { model: { enabled: true } });
  assert.equal(f.advice.public(saved.attempt.id).status, 'idle'); await run(f, saved.attempt);
});

test('external models require both permission and a configured key before queueing a paid call', async t => {
  const f = await fixture(t); enable(f); const saved = f.create();
  await settings(f.app, { model: { endpoint: 'https://api.deepseek.com', allowExternalProcessing: false } });
  assert.equal(f.advice.schedule(saved.attempt.id).status, 'unavailable');
  await settings(f.app, { model: { allowExternalProcessing: true } });
  assert.equal(f.advice.schedule(saved.attempt.id).status, 'unavailable');
  assert.equal(f.state.calls, 0); assert.equal(f.app.store.all('advice-call').length, 0);
});

test('automatic scheduling failure does not prevent a saved answer or trigger model work', async t => {
  const f = await fixture(t); enable(f); const enqueue = f.app.jobs.enqueue;
  f.app.jobs.enqueue = () => { throw new ApiError(429, 'RATE_LIMITED', 'Synthetic full local queue.'); };
  f.app.learning.onAttempt = attempt => f.advice.schedule(attempt.id, { automatic: true });
  const saved = f.create(); f.app.jobs.enqueue = enqueue;
  assert.equal(f.app.store.require('attempt', saved.attempt.id).output, saved.attempt.output);
  assert.equal(f.advice.public(saved.attempt.id).status, 'failed'); assert.equal(f.state.calls, 0);
  assert.equal(f.advice.schedule('missing', { automatic: true }), null);
});

for (const change of ['disable', 'model', 'source', 'answer', 'practice']) {
  test(`a queued ${change} change prevents model work before reservation`, async t => {
    const f = await fixture(t); enable(f); const saved = f.create(); await f.app.jobs.stop();
    const queued = f.advice.schedule(saved.attempt.id);
    if (change === 'disable') f.advice.update({ enabled: false });
    if (change === 'model') await settings(f.app, { model: { model: 'different-synthetic' } });
    if (change === 'source') f.app.sources.capture({ ...saved.source, content: 'Changed source text.' });
    if (change === 'answer') f.app.store.put('attempt', { ...saved.attempt, output: 'Changed saved output.' }, saved.attempt.id);
    if (change === 'practice') f.app.store.put('practice', { ...saved.practice, prompt: 'Changed question.' }, saved.practice.id);
    f.app.jobs.start(); await jobDone(f.app, { jobId: queued.jobId }, 'failed');
    assert.equal(f.state.calls, 0); assert.equal(f.app.store.all('advice-call').length, 0);
    assert.equal(f.app.store.all('feedback').length, 0);
  });
}

for (const change of ['disable', 'model', 'source', 'scope']) {
  test(`an in-flight ${change} change consumes one attempt but publishes no late feedback`, async t => {
    const f = await fixture(t); enable(f); const saved = f.create();
    f.state.before = async () => {
      if (change === 'disable') f.advice.update({ enabled: false });
      if (change === 'model') await settings(f.app, { model: { enabled: false } });
      if (change === 'source') f.app.sources.capture({ ...saved.source, content: 'Changed source text.' });
      if (change === 'scope') await scope(f.app, { allowManualImports: false });
    };
    await run(f, saved.attempt, 'failed'); assert.equal(f.state.calls, 1);
    assert.equal(f.app.store.all('advice-call').length, 1); assert.equal(f.app.store.all('feedback').length, 0);
    assert.equal(f.app.store.require('attempt', saved.attempt.id).output, saved.attempt.output);
  });
}

test('a profile goal change alone retains the original question and can complete its advice', async t => {
  const f = await fixture(t); enable(f); const saved = f.create();
  f.state.before = async () => profile(f.app, { goals: ['A new explicit goal'] });
  const result = await run(f, saved.attempt);
  assert.equal(result.status, 'ready'); assert.equal(f.state.inputs[0].goal, saved.practice.goal);
});

test('Codex thread authorization is checked again while a response is in flight', async t => {
  const f = await fixture(t); enable(f); await scope(f.app, { enabled: true, allowedThreadIds: ['A'] });
  const source = f.app.sources.capture({ kind: 'codex', externalId: 'codex_A_message', threadId: 'A', title: 'Authorized source', content: 'Check a replay.' });
  const saved = f.create({ source });
  f.state.before = async () => scope(f.app, { excludedThreadIds: ['A'] });
  const result = await run(f, saved.attempt, 'failed');
  assert.equal(result.status, 'stale'); assert.equal(f.state.calls, 1); assert.equal(f.app.store.all('feedback').length, 0);
});

test('all referenced sources are authorized even when the model input would include only four', async t => {
  const f = await fixture(t); enable(f); await scope(f.app, { enabled: true, allowedThreadIds: ['A'] });
  const refs = Array.from({ length: 5 }, (_, index) => f.app.sources.ref(f.app.sources.capture({ kind: index === 4 ? 'codex' : 'manual',
    externalId: 'source_' + index, threadId: index === 4 ? 'B' : null, title: 'Source ' + index, content: 'Some original source.' })));
  const saved = f.create({ refs }); const result = f.advice.schedule(saved.attempt.id);
  assert.equal(result.status, 'stale'); assert.equal(f.state.calls, 0); assert.equal(result.jobId, null);
});

test('current project-scope receipts authorize stored Codex sources without inventing a missing path', async t => {
  const f = await fixture(t); enable(f); await scope(f.app, { enabled: true, allowedProjectPaths: [f.app.collector.root] });
  const source = f.app.sources.capture({ kind: 'codex', externalId: 'project_source', threadId: 'project_thread', title: 'Source', content: 'Check a replay.' });
  const saved = f.create({ source });
  assert.equal(f.advice.schedule(saved.attempt.id).status, 'stale');
  f.app.store.put('automation-receipt', { sourceId: source.id, contentDigest: source.contentDigest, scopeRevision: f.app.collector.scope().revision }, 'capture_proof');
  const result = await run(f, saved.attempt, 'succeeded', { retry: true }); assert.equal(result.status, 'ready');
});

test('stale project receipts and disabled manual imports do not authorize external advice input', async t => {
  const f = await fixture(t); enable(f); await scope(f.app, { enabled: true, allowedProjectPaths: [f.app.collector.root], allowManualImports: false });
  const codex = f.app.sources.capture({ kind: 'codex', externalId: 'project_source', threadId: 'project_thread', title: 'Source', content: 'Check a replay.' });
  f.app.store.put('automation-receipt', { sourceId: codex.id, contentDigest: codex.contentDigest, scopeRevision: f.app.collector.scope().revision - 1 }, 'old_capture');
  assert.equal(f.advice.schedule(f.create({ source: codex }).attempt.id).status, 'stale');
  const manual = f.app.sources.capture({ kind: 'manual_dialogue', externalId: 'import_source', threadId: 'imported', title: 'Source', content: 'Check a replay.' });
  assert.equal(f.advice.schedule(f.create({ source: manual }).attempt.id).status, 'stale'); assert.equal(f.state.calls, 0);
});

test('bounded input records partial coverage without truncating the original answer or full rubric feedback', async t => {
  const f = await fixture(t); enable(f);
  const source = f.app.sources.capture({ kind: 'manual', externalId: 'long_source', title: 'Long source', content: '原'.repeat(10000) });
  const saved = f.create({ source, output: '🧠'.repeat(7000), rubric: Array.from({ length: 10 }, (_, index) => ({
    label: 'Rule ' + index, description: 'D'.repeat(2000), expectedEvidence: Array.from({ length: 10 }, () => 'E'.repeat(500)) })) });
  const result = await run(f, saved.attempt); const input = f.state.inputs[0];
  assert.ok([...JSON.stringify(input)].length <= 12000); assert.ok(input.coverage.reviewedCharacters <= 6000);
  assert.equal(input.coverage.answerCharacters, 7000); assert.equal(input.rubric.length, 5);
  assert.ok(input.evidenceSnapshots.reduce((sum, entry) => sum + [...entry.text].length, 0) <= 2500);
  assert.equal(f.app.store.require('attempt', saved.attempt.id).output, saved.attempt.output);
  assert.equal(result.feedback.observations.length, 10);
  assert.ok(result.feedback.observations.slice(5).every(item => item.finding === 'not_assessed' && /未覆盖/.test(item.comment)));
  assert.ok(!JSON.stringify(f.app.store.all('advice-call')).includes('🧠'.repeat(100)));
});

test('usage remains unknown when missing and provider-reported usage is saved without an extra request', async t => {
  const f = await fixture(t); enable(f); await run(f, f.create().attempt);
  assert.equal(f.app.store.all('advice-call')[0].usage, null);
  f.state.usage = { promptTokens: 100, completionTokens: 30, totalTokens: 130 };
  const second = f.create(); await run(f, second.attempt);
  const call = f.app.store.all('advice-call').find(item => item.attemptId === second.attempt.id);
  assert.deepEqual(call.usage, f.state.usage); assert.equal(f.state.calls, 2);
});

test('a recovered reserved request is marked uncertain and never resent', async t => {
  const f = await fixture(t); enable(f); const saved = f.create(); await f.app.jobs.stop();
  const queued = f.advice.schedule(saved.attempt.id);
  f.app.store.put('advice-call', { date: f.advice.date(), attemptId: saved.attempt.id, status: 'reserved', attemptedAt: f.clock.value.toISOString(), usage: null }, queued.jobId);
  f.app.jobs.start(); await jobDone(f.app, { jobId: queued.jobId });
  assert.equal(f.advice.public(saved.attempt.id).status, 'uncertain'); assert.equal(f.state.calls, 0);
  assert.equal(f.app.store.require('advice-call', queued.jobId).status, 'uncertain');
  assert.equal(f.advice.settingsPublic().callsToday, 1);
});

test('a recovered known failed request retains its failure and original error without resending', async t => {
  const f = await fixture(t); enable(f); const saved = f.create(); await f.app.jobs.stop();
  const queued = f.advice.schedule(saved.attempt.id);
  const originalError = { code: 'UPSTREAM_ERROR', message: 'Synthetic known format failure.', retryable: false };
  const originalCall = f.app.store.put('advice-call', { date: f.advice.date(), attemptId: saved.attempt.id, status: 'failed',
    attemptedAt: f.clock.value.toISOString(), failedAt: f.clock.value.toISOString(), errorCode: originalError.code, usage: null }, queued.jobId);
  f.advice.save(saved.attempt.id, { status: 'failed', lastError: originalError });
  f.app.jobs.start(); await jobDone(f.app, { jobId: queued.jobId });
  const recovered = f.advice.public(saved.attempt.id);
  assert.equal(recovered.status, 'failed'); assert.deepEqual(recovered.lastError, originalError);
  assert.equal(f.state.calls, 0); assert.equal(f.advice.settingsPublic().callsToday, 1);
  assert.deepEqual(f.app.store.require('advice-call', queued.jobId), originalCall);
});

test('SQLite restart retains ready feedback and the consumed advice budget', async t => {
  const f = await fixture(t, { keep: true }); enable(f); const saved = f.create(); const ready = await run(f, saved.attempt);
  const root = f.app.collector.root; await f.app.close();
  const app = await appFor(t, { root }); app.learning.onAttempt = null;
  const advice = new Advice(app.store, app.settings, app.domain, app.collector, app.learning, app.model, app.jobs, { clock: () => f.clock.value });
  assert.equal(advice.settingsPublic().callsToday, 1);
  assert.equal(advice.public(saved.attempt.id).feedback.id, ready.feedback.id);
  assert.equal(advice.schedule(saved.attempt.id).status, 'ready'); assert.equal(app.store.all('advice-call').length, 1);
});
