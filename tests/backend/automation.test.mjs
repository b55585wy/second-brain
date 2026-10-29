import test from 'node:test';
import assert from 'node:assert/strict';
import { appFor, ok, scope, profile, settings, fakeServer, request, jobDone } from './helpers.mjs';
import { ApiError } from '../../server/errors.mjs';

const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const assistant = (id, text) => ({ id, type: 'agentMessage', text });
const page = (data, nextCursor = null) => ({ data, nextCursor });

async function fixture(t, options = {}) {
  const clock = { value: new Date('2026-10-28T01:00:00.000Z') };
  const state = { calls: [], inputs: [], beforeModel: null, beforeRpc: null, transformResult: null,
    threads: options.threads ?? ['A'], pages: options.pages ?? { start: page([user('u', 'How does reliable storage avoid partial changes?'), assistant('a', 'A transaction saves related changes together.')]) } };
  const upstream = await fakeServer(t, async (_req, body) => {
    const input = JSON.parse(body.messages[1].content); state.inputs.push(input);
    await state.beforeModel?.(input);
    const segment = input.segments[0];
    const result = { highlights: [{ title: 'Reliable storage', summary: 'Save related changes together.', goalIndex: 0,
      whyRelevant: 'Helps explain reliable storage.', evidence: [{ sourceId: segment.sourceId, quote: segment.text.slice(0, 60) }] }],
      exercise: input.budgetMinutes ? { kind: 'new_scenario', prompt: 'Describe a new partial-update failure and a checkable remedy.',
        estimatedMinutes: Math.min(5, input.budgetMinutes), highlightIndex: 0,
        rubric: [{ label: 'Evidence', description: 'Explain a concrete check.', expectedEvidence: ['An example'] }] } : null };
    return { choices: [{ message: { content: JSON.stringify(state.transformResult ? state.transformResult(result) : result) } }] };
  });
  const rpcFactory = () => ({ verifiedStateDbOnly: true, async start() {}, async close() {}, async request(method, params) {
    state.calls.push({ method, ...params });
    await state.beforeRpc?.(method, params);
    if (method === 'thread/list') return page(state.threads.map(id => ({ id, name: 'Synthetic authorized learning', updatedAt: Date.now() })));
    assert.equal(method, 'thread/items/list'); assert.ok(state.threads.includes(params.threadId));
    const pages = Object.hasOwn(state.pages, 'start') ? state.pages : state.pages[params.threadId];
    return pages[params.cursor ?? 'start'];
  } });
  const app = await appFor(t, { rpcFactory, automationClock: () => new Date(clock.value), ...(options.keep ? { keep: true } : {}),
    collectorOptions: { days: 7, maxThreads: 20, pageSize: 100, maxPages: 1, cliPath: null } });
  state.app = app;
  await profile(app, { goals: ['Reliable storage'], careerDirection: 'Research engineer', skills: ['Evidence'], dailyBudgetMinutes: options.budget ?? 15 });
  await scope(app, { enabled: true, allowedThreadIds: state.threads });
  await settings(app, { model: { enabled: true, endpoint: upstream.origin + '/v1', model: 'synthetic', allowExternalProcessing: false } });
  return { app, state, clock, upstream, rpcFactory };
}

async function enable(app, enabled = true) {
  const current = await ok(app, 'GET', '/automation');
  return ok(app, 'PUT', '/automation', { enabled, expectedRevision: current.revision });
}

async function settled(app) {
  const end = Date.now() + 8000;
  for (;;) {
    const jobs = app.store.all('job').filter(job => job.kind === 'learning_automation');
    if (jobs.length && jobs.every(job => !['queued', 'running'].includes(job.status))) return jobs[0];
    if (Date.now() > end) assert.fail('Synthetic automatic cycle did not settle.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function advance(f, milliseconds) { f.clock.value = new Date(+f.clock.value + milliseconds); f.app.automation.tick(f.clock.value); return settled(f.app); }

function resetQuota(app) {
  const date = app.automation.date();
  app.store.put('automation-quota-reset', { callIds: app.store.all('automation-call').filter(call => call.date === date).map(call => call.id) }, date);
}

test('a developer reset preserves the ledger and charges new failed and uncertain attempts against the fresh budget', async t => {
  const f = await fixture(t); const date = f.app.automation.date();
  const history = [3, 2, 1].map(hours => f.app.store.put('automation-call', { date, status: 'complete',
    attemptedAt: new Date(+f.clock.value - hours * 3600000).toISOString() }, 'before-reset-' + hours));
  const previousDay = f.app.store.put('automation-call', { date: '2026-10-27', status: 'complete' }, 'previous-day');
  assert.equal((await ok(f.app, 'GET', '/automation')).callsToday, 3);
  resetQuota(f.app); assert.equal((await ok(f.app, 'GET', '/automation')).callsToday, 0);
  for (const status of ['failed', 'uncertain', 'complete']) f.app.store.put('automation-call', { date, status }, 'new-' + status);
  assert.equal((await ok(f.app, 'GET', '/automation')).callsToday, 3);
  await enable(f.app); await settled(f.app);
  assert.equal(f.state.inputs.length, 0); assert.equal(f.app.automation.digestDue(), false);
  resetQuota(f.app); assert.equal((await ok(f.app, 'GET', '/automation')).callsToday, 0);
  assert.equal(f.app.automation.calls('2026-10-27').length, 1);
  for (const old of [...history, previousDay]) assert.deepEqual(f.app.store.require('automation-call', old.id), old);
  f.clock.value = new Date('2026-10-29T01:00:00.000Z');
  f.app.store.put('automation-call', { date: f.app.automation.date(), status: 'failed' }, 'next-day');
  assert.equal((await ok(f.app, 'GET', '/automation')).callsToday, 1);
});

test('a quota reset preserves the real cooldown and resumes eligible new analysis after one hour', async t => {
  const f = await fixture(t); await enable(f.app); await settled(f.app);
  const original = f.app.store.all('automation-call')[0]; const nextAttempt = f.app.automation.nextAttempt();
  resetQuota(f.app); await profile(f.app, { goals: ['A revised reliable storage goal'] });
  assert.deepEqual(f.app.automation.nextAttempt(), nextAttempt);
  await advance(f, 3599999); assert.equal(f.state.inputs.length, 1);
  assert.equal((await ok(f.app, 'GET', '/automation')).callsToday, 0);
  await advance(f, 1); assert.equal(f.state.inputs.length, 2);
  assert.equal((await ok(f.app, 'GET', '/automation')).callsToday, 1);
  assert.deepEqual(f.app.store.require('automation-call', original.id), original);
  assert.ok((await ok(f.app, 'GET', '/today')).practice);
});

test('a persisted quota reset survives SQLite restart and malformed markers leave usage counted', async t => {
  const f = await fixture(t, { keep: true }); await enable(f.app); await settled(f.app);
  const original = f.app.store.all('automation-call')[0]; resetQuota(f.app);
  const root = f.app.collector.root; const collectorOptions = f.app.store.get('config', 'codex-options');
  await f.app.close();
  const app = await appFor(t, { root, rpcFactory: f.rpcFactory, automationClock: () => new Date(f.clock.value), collectorOptions });
  assert.equal((await ok(app, 'GET', '/automation')).callsToday, 0);
  assert.deepEqual(app.automation.lastCall(), original);
  app.store.put('automation-quota-reset', { callIds: 'invalid' }, app.automation.date());
  assert.equal((await ok(app, 'GET', '/automation')).callsToday, 1);
  assert.deepEqual(app.store.require('automation-call', original.id), original);
});

function modelFailures(f, codes, delayMs = 0) {
  const original = f.app.model.digest.bind(f.app.model); const state = { attempts: 0 };
  f.app.model.digest = async input => {
    state.attempts++; const code = codes.shift();
    if (!code) return original(input);
    if (delayMs) f.clock.value = new Date(+f.clock.value + delayMs);
    const error = new ApiError(502, code, 'Synthetic model failure.', false);
    error.uncertain = ['UPSTREAM_UNAVAILABLE', 'UPSTREAM_TIMEOUT'].includes(code);
    throw error;
  };
  return state;
}

test('a connection failure waits sixty seconds and recovers with one separately reserved attempt', async t => {
  const f = await fixture(t); const provider = modelFailures(f, ['UPSTREAM_UNAVAILABLE']);
  const started = +f.clock.value; await enable(f.app); assert.equal((await settled(f.app)).status, 'failed');
  const first = f.app.store.all('automation-call')[0];
  assert.equal((await ok(f.app, 'GET', '/automation')).nextRunAt, new Date(started + 60000).toISOString());
  await advance(f, 59000); assert.equal(provider.attempts, 1);
  await advance(f, 1000); assert.equal(provider.attempts, 2);
  const calls = f.app.store.all('automation-call'); const retry = calls.find(call => call.id !== first.id);
  assert.equal(retry.quickRetryOf, first.id); assert.equal(retry.status, 'complete');
  assert.deepEqual(f.app.store.require('automation-call', first.id), first);
  assert.equal((await ok(f.app, 'GET', '/automation')).callsToday, 2); assert.ok((await ok(f.app, 'GET', '/today')).practice);
});

test('two connection failures consume the quick recovery and return to the normal one-hour interval', async t => {
  const f = await fixture(t); const provider = modelFailures(f, ['UPSTREAM_UNAVAILABLE', 'UPSTREAM_UNAVAILABLE']);
  await enable(f.app); await settled(f.app); await advance(f, 60000);
  assert.equal(provider.attempts, 2);
  const retryTime = +f.clock.value;
  assert.equal((await ok(f.app, 'GET', '/automation')).nextRunAt, new Date(retryTime + 3600000).toISOString());
  await advance(f, 60000); assert.equal(provider.attempts, 2); assert.equal(f.app.store.all('automation-call').length, 2);
});

test('the quick-recovery delay starts when the connection fails rather than when the request starts', async t => {
  const f = await fixture(t); const provider = modelFailures(f, ['UPSTREAM_UNAVAILABLE'], 20000);
  const started = +f.clock.value; await enable(f.app); await settled(f.app);
  assert.equal((await ok(f.app, 'GET', '/automation')).nextRunAt, new Date(started + 80000).toISOString());
  await advance(f, 59000); assert.equal(provider.attempts, 1); await advance(f, 1000); assert.equal(provider.attempts, 2);
});

test('restart and a new local date retain the consumed quick-recovery chain and historical ledger', async t => {
  const f = await fixture(t, { keep: true }); const provider = modelFailures(f, ['UPSTREAM_UNAVAILABLE', 'UPSTREAM_UNAVAILABLE']);
  await enable(f.app); await settled(f.app); await advance(f, 60000); assert.equal(provider.attempts, 2);
  const history = f.app.store.all('automation-call'); const root = f.app.collector.root; const collectorOptions = f.app.store.get('config', 'codex-options');
  await f.app.close();
  const app = await appFor(t, { root, rpcFactory: f.rpcFactory, automationClock: () => new Date(f.clock.value), collectorOptions });
  const recovered = { ...f, app }; const nextProvider = modelFailures(recovered, ['UPSTREAM_UNAVAILABLE']);
  await advance(recovered, 60000); assert.equal(nextProvider.attempts, 0);
  f.clock.value = new Date('2026-10-29T01:00:00.000Z'); app.automation.tick(f.clock.value); await settled(app);
  assert.equal(nextProvider.attempts, 1); assert.equal((await ok(app, 'GET', '/automation')).callsToday, 1);
  await advance(recovered, 60000); assert.equal(nextProvider.attempts, 1);
  assert.equal(app.store.all('automation-call').length, 3);
  for (const old of history) assert.deepEqual(app.store.require('automation-call', old.id), old);
});

test('an old uncertain connection failure without new metadata gets one recovery without rewriting its record', async t => {
  const f = await fixture(t); const provider = modelFailures(f, ['UPSTREAM_UNAVAILABLE']);
  await enable(f.app); await settled(f.app);
  const current = f.app.store.all('automation-call')[0]; const { errorCode, failedAt, quickRetryOf, ...legacy } = current;
  const old = f.app.store.put('automation-call', legacy, current.id);
  assert.equal(old.status, 'uncertain'); assert.equal((await ok(f.app, 'GET', '/automation')).lastError.code, 'CONNECTION_UNAVAILABLE');
  await advance(f, 59000); assert.equal(provider.attempts, 1); await advance(f, 1000); assert.equal(provider.attempts, 2);
  assert.deepEqual(f.app.store.require('automation-call', old.id), old);
  assert.ok(f.app.store.all('automation-call').some(call => call.quickRetryOf === old.id));
});

for (const code of ['UPSTREAM_UNAUTHORIZED', 'UPSTREAM_FORBIDDEN', 'UPSTREAM_RATE_LIMITED', 'UPSTREAM_TIMEOUT', 'UPSTREAM_ERROR', 'UPSTREAM_HTTP_ERROR']) {
  test(`${code} never receives a sixty-second model retry`, async t => {
    const f = await fixture(t); const provider = modelFailures(f, [code]); const started = +f.clock.value;
    await enable(f.app); await settled(f.app); await advance(f, 60000);
    assert.equal(provider.attempts, 1); assert.equal((await ok(f.app, 'GET', '/automation')).callsToday, 1);
    assert.equal((await ok(f.app, 'GET', '/automation')).nextRunAt, new Date(started + 3600000).toISOString());
  });
}

test('quick recovery cannot exceed the existing daily three-attempt budget or reset prior records', async t => {
  const f = await fixture(t); const provider = modelFailures(f, ['UPSTREAM_UNAVAILABLE']); const context = f.app.automation.context();
  const history = [2, 1].map(hours => f.app.store.put('automation-call', { date: f.app.automation.date(), context,
    attemptedAt: new Date(+f.clock.value - hours * 3600000).toISOString(), status: 'complete' }, 'already_spent_' + hours));
  await enable(f.app); await settled(f.app); await advance(f, 60000);
  assert.equal(provider.attempts, 1); assert.equal((await ok(f.app, 'GET', '/automation')).callsToday, 3);
  for (const old of history) assert.deepEqual(f.app.store.require('automation-call', old.id), old);
});

for (const change of ['disable', 'profile', 'scope', 'model']) {
  test(`a pending quick recovery respects ${change} changes`, async t => {
    const f = await fixture(t); const provider = modelFailures(f, ['UPSTREAM_UNAVAILABLE']);
    await enable(f.app); await settled(f.app); const original = f.app.store.all('automation-call')[0];
    if (change === 'disable') await enable(f.app, false);
    if (change === 'profile') await profile(f.app, { goals: ['A new explicit goal'] });
    if (change === 'scope') await scope(f.app, { enabled: false });
    if (change === 'model') await settings(f.app, { model: { model: 'changed-synthetic-model' } });
    await advance(f, 60000); assert.equal(provider.attempts, 1);
    assert.deepEqual(f.app.store.require('automation-call', original.id), original);
  });
}

test('GET home and automation are inert and report setup without inventing content', async t => {
  const app = await appFor(t, { rpcFactory: () => { throw new Error('GET must not launch Codex.'); } });
  const before = app.store.all('job').length;
  const status = await ok(app, 'GET', '/automation'); const today = await ok(app, 'GET', '/today');
  assert.equal(status.enabled, false); assert.equal(status.state, 'off'); assert.equal(status.dailyCallLimit, 3); assert.equal(status.callsToday, 0);
  assert.equal(status.setup.profile, false); assert.equal(status.setup.scope, false); assert.equal(status.setup.model, false);
  assert.deepEqual(today.highlights, []); assert.equal(today.practice, null); assert.equal(today.attempt, null);
  assert.equal(app.store.all('job').length, before);
});

test('enable schedules once, enforces revisions and leaves legacy settings unchanged', async t => {
  const f = await fixture(t); const before = await ok(f.app, 'GET', '/settings');
  const enabled = await enable(f.app); await settled(f.app);
  assert.equal(enabled.enabled, true);
  const rejected = await request(f.app, 'PUT', '/automation', { enabled: false, expectedRevision: enabled.revision - 1 });
  assert.equal(rejected.status, 409);
  assert.deepEqual(await ok(f.app, 'GET', '/settings'), before);
  f.app.automation.tick(f.clock.value); await settled(f.app);
  assert.equal(f.app.store.all('job').filter(job => job.kind === 'learning_automation').length, 1);
});

test('replaying the enable operation cannot enqueue a second cycle', async t => {
  const f = await fixture(t); const status = await ok(f.app, 'GET', '/automation');
  const body = { enabled: true, expectedRevision: status.revision, operationId: 'automatic_enable_replay' };
  const first = await ok(f.app, 'PUT', '/automation', body); const replay = await ok(f.app, 'PUT', '/automation', body);
  assert.deepEqual(replay, first); await settled(f.app);
  assert.equal(f.app.store.all('job').filter(job => job.kind === 'learning_automation').length, 1);
});

test('enabling incomplete setup creates no job or external request', async t => {
  const app = await appFor(t, { rpcFactory: () => { throw new Error('Incomplete setup must not launch Codex.'); } });
  const status = await enable(app);
  assert.equal(status.enabled, true); assert.equal(status.state, 'setup'); assert.equal(app.store.all('job').length, 0);
});

test('disabling a queued cycle prevents later collection and model requests', async t => {
  const f = await fixture(t); await f.app.jobs.stop(); await enable(f.app); await enable(f.app, false);
  f.app.jobs.start(); await settled(f.app);
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.inputs.length, 0);
  const count = f.app.store.all('job').length; f.app.automation.tick(new Date(+f.clock.value + 2 * 3600000));
  assert.equal(f.app.store.all('job').length, count); assert.equal((await ok(f.app, 'GET', '/automation')).state, 'off');
});

test('one enable continues authorized pages automatically without raw assistant drafts', async t => {
  const f = await fixture(t, { pages: { start: page([user('u', 'Reliable storage question')], 'next'), next: page([assistant('a', 'Use an atomic transaction.')]) } });
  await enable(f.app); await settled(f.app); await advance(f, 15000);
  assert.equal(f.app.store.all('source').length, 2); assert.equal(f.app.store.all('knowledge').length, 0);
  assert.deepEqual(f.state.calls.filter(call => call.method === 'thread/items/list').map(call => call.cursor), [null, 'next']);
  const today = await ok(f.app, 'GET', '/today');
  assert.ok(today.highlights.length <= 3); assert.ok(today.practice); assert.equal(today.practice.provenance.mode, 'model');
});

test('automatic capture keeps the manual checkpoint and explicit draft extraction available', async t => {
  const f = await fixture(t); await enable(f.app); await settled(f.app);
  const ack = await ok(f.app, 'POST', '/codex/sync', { threadIds: ['A'] }, 202); await jobDone(f.app, ack);
  assert.equal(f.app.store.all('source').length, 2); assert.equal(f.app.store.all('knowledge').length, 1);
});

test('digest inputs never include historical sources without current authorized receipts', async t => {
  const f = await fixture(t);
  f.app.sources.capture({ kind: 'codex', externalId: 'FORBIDDEN:x', threadId: 'FORBIDDEN', messageId: 'x', role: 'assistant', title: 'Do not process', content: 'UNRECEIPTED-MATERIAL' });
  await enable(f.app); await settled(f.app);
  assert.equal(f.state.inputs.length, 1); assert.ok(!JSON.stringify(f.state.inputs).includes('UNRECEIPTED-MATERIAL'));
});

test('source fragments are bounded and retain long unprocessed tails', async t => {
  const f = await fixture(t, { pages: { start: page([user('u', 'Reliable storage ' + 'x'.repeat(40000))]) } });
  await enable(f.app); await settled(f.app);
  assert.ok(f.state.inputs[0].segments.reduce((sum, part) => sum + [...part.text].length, 0) <= 12000);
  const receipt = f.app.store.all('automation-receipt')[0];
  assert.ok(receipt.offset > 0 && receipt.offset < receipt.length);
  const firstText = f.state.inputs[0].segments[0].text;
  await advance(f, 61 * 60000);
  assert.ok(f.state.inputs.length >= 2); assert.notEqual(f.state.inputs[1].segments[0].text, firstText);
});

test('three daily attempts enforce cooldown and reset on the next profile-local date', async t => {
  const f = await fixture(t, { pages: { start: page([user('u', 'Reliable storage ' + 'x'.repeat(80000))]) } });
  await enable(f.app); await settled(f.app);
  await advance(f, 15000); assert.equal(f.state.inputs.length, 1);
  await advance(f, 61 * 60000); await advance(f, 61 * 60000); await advance(f, 61 * 60000);
  assert.equal(f.state.inputs.length, 3); assert.equal((await ok(f.app, 'GET', '/automation')).callsToday, 3);
  assert.equal((await ok(f.app, 'GET', '/automation')).state, 'limited');
  f.clock.value = new Date('2026-10-29T01:00:00.000Z'); f.app.automation.tick(f.clock.value); await settled(f.app);
  assert.equal((await ok(f.app, 'GET', '/automation')).callsToday, 1);
});

test('SQLite reopening resumes the automatic native cursor without duplicate drafts or model requests', async t => {
  const f = await fixture(t, { keep: true, pages: { start: page([user('u', 'Reliable storage')], 'next'), next: page([assistant('a', 'Use a transaction.')]) } });
  await enable(f.app); await settled(f.app);
  const root = f.app.collector.root; const collectorOptions = f.app.store.get('config', 'codex-options');
  await f.app.close();
  const app = await appFor(t, { root, rpcFactory: f.rpcFactory, automationClock: () => new Date(f.clock.value), collectorOptions });
  f.clock.value = new Date(+f.clock.value + 15000); app.automation.tick(f.clock.value); await settled(app);
  assert.deepEqual(f.state.calls.filter(call => call.method === 'thread/items/list').map(call => call.cursor), [null, 'next']);
  assert.equal(app.store.all('source').length, 2); assert.equal(app.store.all('knowledge').length, 0); assert.equal(f.state.inputs.length, 1);
});

test('model failures spend an attempt, preserve fragment offsets and allow local continuation without an immediate model retry', async t => {
  const f = await fixture(t, { pages: { start: page([user('u', 'Reliable storage')], 'next'), next: page([assistant('a', 'Use an atomic transaction.')]) } });
  f.state.transformResult = () => ({ invalid: true });
  await enable(f.app); assert.equal((await settled(f.app)).status, 'failed');
  assert.equal((await ok(f.app, 'GET', '/automation')).callsToday, 1);
  assert.ok(f.app.store.all('automation-receipt').every(receipt => receipt.offset === 0));
  f.state.transformResult = null; await advance(f, 15000);
  assert.equal(f.app.store.all('source').length, 2); assert.equal(f.state.inputs.length, 1);
  await advance(f, 61 * 60000); assert.equal(f.state.inputs.length, 2); assert.ok((await ok(f.app, 'GET', '/today')).highlights.length);
});

test('a transient native failure retries once and waits before starting another cycle', async t => {
  const f = await fixture(t);
  f.state.beforeRpc = method => { if (method === 'thread/items/list') throw new ApiError(502, 'UPSTREAM_ERROR', 'Synthetic transient read.', true); };
  await enable(f.app); assert.equal((await settled(f.app)).status, 'failed');
  assert.equal(f.state.calls.filter(call => call.method === 'thread/items/list').length, 2); assert.equal(f.state.inputs.length, 0);
  const count = f.app.store.all('job').length; f.app.automation.tick(f.clock.value); assert.equal(f.app.store.all('job').length, count);
  f.state.beforeRpc = null; await advance(f, 61 * 60000); assert.equal(f.state.inputs.length, 1);
});

test('input selection includes different authorized threads and preserves lower-ranked material', async t => {
  const f = await fixture(t, { threads: ['A', 'B'], pages: {
    A: { start: page([user('uA', 'Reliable storage ' + 'a'.repeat(30000))]) },
    B: { start: page([user('uB', 'A different explanation needing semantic judgment.')]) },
  } });
  await enable(f.app); await settled(f.app); await advance(f, 15000); await advance(f, 61 * 60000);
  const input = f.state.inputs[1];
  assert.deepEqual(new Set(input.segments.map(part => f.app.store.require('source', part.sourceId).threadId)), new Set(['A', 'B']));
  assert.ok(input.segments.reduce((sum, part) => sum + [...part.text].length, 0) <= 12000);
});

test('each automatic capture processes at most one hundred visible source identities', async t => {
  const entries = Array.from({ length: 120 }, (_, index) => user('u' + index, 'Reliable storage question ' + index));
  const f = await fixture(t, { pages: { start: page(entries) } }); await enable(f.app); await settled(f.app);
  assert.equal(f.app.store.all('source').length, 100); assert.equal(f.app.store.all('automation-receipt').length, 100);
  await advance(f, 15000); assert.equal(f.app.store.all('source').length, 120); assert.equal(f.app.store.all('knowledge').length, 0);
});

test('a queued job with an existing request reservation cannot resend after recovery or quota reset', async t => {
  const f = await fixture(t); await f.app.jobs.stop(); await enable(f.app);
  const job = f.app.store.all('job').find(item => item.kind === 'learning_automation');
  f.app.store.put('automation-call', { date: '2026-10-28', attemptedAt: f.clock.value.toISOString(), status: 'reserved', context: job.payload.context }, job.id);
  f.app.store.put('automation-quota-reset', { callIds: [job.id] }, f.app.automation.date());
  f.app.jobs.start(); await settled(f.app);
  assert.equal(f.state.inputs.length, 0); assert.equal((await ok(f.app, 'GET', '/automation')).callsToday, 0);
  assert.equal(f.app.store.require('automation-call', job.id).status, 'reserved');
});

test('the attempt ledger follows the profile timezone rather than the UTC date', async t => {
  const f = await fixture(t, { pages: { start: page([user('u', 'Reliable storage ' + 'x'.repeat(40000))]) } });
  f.clock.value = new Date('2026-10-28T15:30:00.000Z'); await enable(f.app); await settled(f.app);
  assert.equal((await ok(f.app, 'GET', '/today')).date, '2026-10-28');
  f.clock.value = new Date('2026-10-28T16:31:00.000Z'); f.app.automation.tick(f.clock.value); await settled(f.app);
  const today = await ok(f.app, 'GET', '/today'); assert.equal(today.date, '2026-10-29'); assert.equal(today.automation.callsToday, 1);
});

test('unchanged material is not resent and same-day practice plus saved output remain stable', async t => {
  const f = await fixture(t); await enable(f.app); await settled(f.app);
  const first = await ok(f.app, 'GET', '/today');
  const attempt = await ok(f.app, 'POST', `/practices/${first.practice.id}/attempts`, { output: 'My independent explanation.', assistanceLevel: 'none', evidenceRefs: [] }, 201);
  await advance(f, 61 * 60000);
  const second = await ok(f.app, 'GET', '/today');
  assert.equal(f.state.inputs.length, 1); assert.equal(second.practice.id, first.practice.id); assert.equal(second.attempt.id, attempt.id);
  f.state.pages.start.data.push(assistant('a-new', 'Use a durable commit receipt.'));
  await advance(f, 61 * 60000);
  const third = await ok(f.app, 'GET', '/today'); assert.equal(third.practice.id, first.practice.id); assert.equal(third.attempt.output, attempt.output);
});

test('an open same-day practice is not replaced by a later relevant batch', async t => {
  const f = await fixture(t); await enable(f.app); await settled(f.app);
  const first = await ok(f.app, 'GET', '/today');
  f.state.pages.start.data.push(assistant('a-new', 'A durable receipt makes completion checkable.'));
  await advance(f, 61 * 60000); const next = await ok(f.app, 'GET', '/today');
  assert.equal(next.practice.id, first.practice.id); assert.equal(next.practice.prompt, first.practice.prompt); assert.equal(next.attempt, null);
});

test('a new profile revision makes receipted material eligible under the new explicit goal', async t => {
  const f = await fixture(t); await enable(f.app); await settled(f.app);
  const previous = await ok(f.app, 'GET', '/today'); await profile(f.app, { goals: ['New explicit research goal'] });
  assert.deepEqual((await ok(f.app, 'GET', '/today')).highlights, []);
  await advance(f, 61 * 60000); const next = await ok(f.app, 'GET', '/today');
  assert.equal(f.state.inputs.length, 2); assert.deepEqual(f.state.inputs[1].profile.goals, ['New explicit research goal']);
  assert.equal(next.highlights[0].goal, 'New explicit research goal'); assert.notEqual(next.practice.id, previous.practice.id);
  assert.ok(f.app.store.get('practice', previous.practice.id));
});

test('scope revocation during native collection saves no receipt, source or model request', async t => {
  const f = await fixture(t);
  f.state.beforeRpc = async method => { if (method === 'thread/items/list') { f.state.beforeRpc = null; await scope(f.app, { enabled: false }); } };
  await enable(f.app); assert.equal((await settled(f.app)).status, 'failed');
  assert.equal(f.app.store.all('source').length, 0); assert.equal(f.app.store.all('automation-receipt').length, 0); assert.equal(f.state.inputs.length, 0);
});

test('a following day reuses current focus for a cited template practice without a model call', async t => {
  const f = await fixture(t); await enable(f.app); await settled(f.app);
  const first = await ok(f.app, 'GET', '/today');
  f.clock.value = new Date('2026-10-29T01:00:00.000Z'); f.app.automation.tick(f.clock.value); await settled(f.app);
  const next = await ok(f.app, 'GET', '/today');
  assert.equal(f.state.inputs.length, 1); assert.notEqual(next.practice.id, first.practice.id);
  assert.equal(next.practice.provenance.mode, 'template'); assert.ok(next.practice.sourceRefs.length > 0);
});

const threeIdeas = prefix => result => ({ ...result, highlights: Array.from({ length: 3 }, (_, index) => ({ ...result.highlights[0],
  title: `${prefix} idea ${index + 1}`, summary: `${prefix} reusable explanation ${index + 1}.` })) });

async function dailyBacklog(t, budget = 15) {
  const f = await fixture(t, { budget, pages: { start: page([assistant('a', 'Reliable storage idea A.')]) } });
  f.state.transformResult = threeIdeas('A'); await enable(f.app); await settled(f.app);
  const first = await ok(f.app, 'GET', '/today'); let history = null;
  if (first.practice) {
    const attempt = await ok(f.app, 'POST', `/practices/${first.practice.id}/attempts`, { output: 'My original independent A explanation.', assistanceLevel: 'none', evidenceRefs: [] }, 201);
    const output = await ok(f.app, 'POST', '/outputs', { projectId: null, practiceId: first.practice.id, title: 'Original A output', content: 'My original A artifact.',
      goal: 'Reliable storage', status: 'final', sourceRefs: [], evidenceRefs: [] }, 201);
    history = { practice: f.app.store.require('practice', first.practice.id), attempt: f.app.store.require('attempt', attempt.id), output: f.app.store.require('output', output.id) };
  }
  f.state.pages.start.data.push(assistant('b', 'Reliable storage idea B.')); f.state.transformResult = threeIdeas('B');
  await advance(f, 61 * 60000);
  assert.deepEqual((await ok(f.app, 'GET', '/today')).highlights, first.highlights);
  assert.ok(f.app.store.all('focus-artifact').some(item => item.highlights.every(highlight => highlight.title.startsWith('B idea'))));
  return { ...f, first, history };
}

async function nextStudyDay(f, instant) { return advance(f, +new Date(instant) - +f.clock.value); }

test('new days schedule archived B before reviewing the least recently scheduled A without model cost or history changes', async t => {
  const f = await dailyBacklog(t); const calls = f.state.inputs.length;
  await nextStudyDay(f, '2026-10-29T01:00:00.000Z'); const second = await ok(f.app, 'GET', '/today');
  assert.deepEqual(second.highlights.map(item => item.title), ['B idea 1', 'B idea 2', 'B idea 3']);
  assert.equal(second.practice.provenance.mode, 'template'); assert.notEqual(second.practice.id, f.first.practice.id);
  assert.ok(second.highlights.every(item => item.sourceRefs.every(ref => f.app.store.require('source', ref.sourceId).messageId === 'b')));
  assert.ok(f.app.automation.currentFocus().sourceDigests.every(item => f.app.store.require('source', item.sourceId).messageId === 'b'));
  const stable = await ok(f.app, 'GET', '/today'); f.app.automation.tick(f.clock.value);
  assert.equal((await ok(f.app, 'GET', '/today')).practice.id, stable.practice.id);
  await nextStudyDay(f, '2026-10-30T01:00:00.000Z'); const third = await ok(f.app, 'GET', '/today');
  assert.deepEqual(third.highlights.map(item => item.title), ['A idea 1', 'A idea 2', 'A idea 3']);
  assert.notEqual(third.practice.id, f.first.practice.id); assert.equal(third.practice.provenance.mode, 'template');
  await nextStudyDay(f, '2026-10-31T01:00:00.000Z');
  assert.deepEqual((await ok(f.app, 'GET', '/today')).highlights.map(item => item.title), ['B idea 1', 'B idea 2', 'B idea 3']);
  assert.equal(f.state.inputs.length, calls);
  for (const [kind, record] of Object.entries(f.history)) assert.deepEqual(f.app.store.require(kind, record.id), record);
});

test('new C generated after day-two B stays archived that day and becomes the next day focus without another model call', async t => {
  const f = await dailyBacklog(t);
  await nextStudyDay(f, '2026-10-29T01:00:00.000Z'); const before = await ok(f.app, 'GET', '/today');
  f.state.pages.start.data.push(assistant('c', 'Reliable storage idea C.')); f.state.transformResult = threeIdeas('C');
  await advance(f, 61 * 60000); const sameDay = await ok(f.app, 'GET', '/today');
  assert.deepEqual(sameDay.highlights, before.highlights); assert.equal(sameDay.practice.id, before.practice.id);
  const calls = f.state.inputs.length; await nextStudyDay(f, '2026-10-30T01:00:00.000Z');
  const next = await ok(f.app, 'GET', '/today'); assert.deepEqual(next.highlights.map(item => item.title), ['C idea 1', 'C idea 2', 'C idea 3']);
  assert.equal(f.state.inputs.length, calls); assert.equal(next.practice.provenance.mode, 'template');
  assert.ok(next.practice.sourceRefs.every(ref => f.app.store.require('source', ref.sourceId).messageId === 'c'));
});

test('cross-day choices exclude changed sources without treating archived extras as previously scheduled or creating zero-budget practice', async t => {
  const f = await dailyBacklog(t, 0);
  f.state.pages.start.data.push(assistant('c', 'Reliable storage idea C.')); f.state.transformResult = threeIdeas('C'); await advance(f, 61 * 60000);
  const source = f.app.store.all('source').find(item => item.messageId === 'a');
  f.app.sources.capture({ ...source, content: 'A is no longer the same evidence.' });
  const day = '2026-10-29T01:00:00.000Z'; f.app.automation.saveState({ nextCollectAt: new Date(+new Date(day) + 3600000).toISOString() });
  const calls = f.state.inputs.length; await nextStudyDay(f, day); const next = await ok(f.app, 'GET', '/today');
  assert.deepEqual(next.highlights.map(item => item.title), ['B idea 1', 'B idea 2', 'B idea 3']);
  assert.ok(next.highlights.every(item => item.sourceRefs.every(ref => ref.sourceId !== source.id && f.app.store.require('source', ref.sourceId).contentDigest === ref.contentDigest)));
  assert.equal(next.practice, null); assert.equal(f.app.store.all('practice').length, 0); assert.equal(f.state.inputs.length, calls);
});

async function movedFocus(t, budget = 15) {
  const f = await fixture(t, { budget, pages: { start: page([assistant('a', 'Reliable storage idea A uses atomic updates.')]) } });
  await enable(f.app); await settled(f.app);
  const first = await ok(f.app, 'GET', '/today');
  const sourceA = f.app.store.all('source').find(source => source.messageId === 'a');
  let history = null;
  if (first.practice) {
    const attempt = await ok(f.app, 'POST', `/practices/${first.practice.id}/attempts`, { output: 'My independent A explanation.', assistanceLevel: 'none', evidenceRefs: [] }, 201);
    const output = await ok(f.app, 'POST', '/outputs', { projectId: null, practiceId: first.practice.id, title: 'Preserved A artifact', content: 'My completed A artifact.',
      goal: 'Reliable storage', status: 'final', sourceRefs: [], evidenceRefs: [] }, 201);
    history = { practice: f.app.store.require('practice', first.practice.id), attempt: f.app.store.require('attempt', attempt.id), output: f.app.store.require('output', output.id) };
  }
  f.state.pages.start.data.push(assistant('b', 'Reliable storage idea B needs an independent durable receipt.'));
  f.state.transformResult = result => ({ ...result, highlights: result.highlights.map(item => ({ ...item, title: 'Independent receipt', summary: 'Check completion using independent durable evidence.' })) });
  await advance(f, 61 * 60000);
  const second = await ok(f.app, 'GET', '/today');
  assert.deepEqual(second.highlights.map(item => item.title), ['Reliable storage', 'Independent receipt']);
  assert.equal(second.practice?.id ?? null, first.practice?.id ?? null);
  assert.ok(second.highlights[1].sourceRefs.every(ref => f.app.store.require('source', ref.sourceId).messageId === 'b'));
  return { ...f, sourceA, first, history };
}

for (const unavailable of ['daily budget exhausted', 'temporary model failure']) {
  test(`an invalid reused practice is replaced locally from the valid focus despite ${unavailable}`, async t => {
    const f = await movedFocus(t);
    if (unavailable === 'daily budget exhausted') {
      f.state.pages.start.data.push(assistant('c', 'Unrelated material ' + 'x'.repeat(40000)));
      f.state.transformResult = () => ({ highlights: [], exercise: null });
      await advance(f, 61 * 60000); assert.equal((await ok(f.app, 'GET', '/automation')).callsToday, 3);
    } else {
      f.app.automation.saveState({ lastError: { code: 'UPSTREAM_UNAVAILABLE', message: 'Synthetic temporary provider failure.', retryable: false },
        errorContext: f.app.automation.context(), lastErrorStage: 'model' });
    }
    f.state.pages.start.data[0] = assistant('a', 'Reliable storage idea A has changed.');
    f.app.sources.capture({ ...f.sourceA, content: 'Reliable storage idea A has changed.' });
    const before = await ok(f.app, 'GET', '/today'); const calls = f.state.inputs.length;
    assert.equal(before.highlights[0].title, 'Independent receipt'); assert.equal(before.practice, null); assert.equal(before.attempt, null);
    f.app.automation.tick(f.clock.value);
    const next = await ok(f.app, 'GET', '/today');
    assert.equal(f.state.inputs.length, calls); assert.equal(next.highlights[0].title, 'Independent receipt');
    assert.ok(next.practice); assert.notEqual(next.practice.id, f.first.practice.id); assert.equal(next.practice.provenance.mode, 'template');
    assert.ok(next.practice.sourceRefs.every(ref => ref.sourceId !== f.sourceA.id && f.app.store.require('source', ref.sourceId).contentDigest === ref.contentDigest));
    assert.equal(next.attempt, null);
    for (const [kind, record] of Object.entries(f.history)) assert.deepEqual(f.app.store.require(kind, record.id), record);
    const count = f.app.store.all('practice').length; f.app.automation.tick(f.clock.value);
    assert.equal((await ok(f.app, 'GET', '/today')).practice.id, next.practice.id); assert.equal(f.app.store.all('practice').length, count);
  });
}

test('valid focus with zero daily budget never creates a replacement practice', async t => {
  const f = await movedFocus(t, 0);
  f.app.sources.capture({ ...f.sourceA, content: 'Reliable storage idea A changed after B.' });
  const calls = f.state.inputs.length; f.app.automation.tick(f.clock.value);
  const next = await ok(f.app, 'GET', '/today');
  assert.equal(next.highlights[0].title, 'Independent receipt'); assert.equal(next.practice, null); assert.equal(next.attempt, null);
  assert.equal(f.app.store.all('practice').length, 0); assert.equal(f.state.inputs.length, calls);
});

test('A then B then repeated A keeps the first three unique daily highlights and retains extra artifacts', async t => {
  const f = await fixture(t, { pages: { start: page([assistant('a', 'Reliable storage idea A.')]) } });
  const ideas = prefix => result => ({ ...result, highlights: Array.from({ length: 3 }, (_, index) => ({ ...result.highlights[0],
    title: `${prefix} idea ${index + 1}`, summary: `${prefix} reusable explanation ${index + 1}.` })) });
  f.state.transformResult = ideas('A'); await enable(f.app); await settled(f.app);
  const first = await ok(f.app, 'GET', '/today'); const practice = f.app.store.require('practice', first.practice.id);
  assert.equal(first.highlights.length, 3);
  f.state.pages.start.data.push(assistant('b', 'Reliable storage idea B.')); f.state.transformResult = ideas('B');
  await advance(f, 61 * 60000); const second = await ok(f.app, 'GET', '/today');
  assert.deepEqual(second.highlights, first.highlights); assert.equal(second.practice.id, first.practice.id);
  const artifacts = f.app.store.all('focus-artifact');
  assert.equal(artifacts.length, 2); assert.ok(artifacts.some(item => item.highlights.every(highlight => highlight.title.startsWith('B idea'))));
  f.state.pages.start.data.push(assistant('a-repeat', 'Reliable storage idea A.')); f.state.transformResult = ideas('A');
  await advance(f, 61 * 60000); const third = await ok(f.app, 'GET', '/today');
  assert.deepEqual(third.highlights, first.highlights); assert.equal(new Set(third.highlights.map(item => item.id)).size, 3);
  assert.equal(third.practice.id, first.practice.id); assert.deepEqual(f.app.store.require('practice', practice.id), practice);
  assert.equal(f.app.store.all('focus-artifact').length, 2);
  const previous = f.state.inputs[2].previousHighlights;
  assert.equal(previous.length, 6); assert.ok(previous.length <= 12);
  assert.deepEqual(new Set(previous.map(item => item.title)), new Set(['A idea 1', 'A idea 2', 'A idea 3', 'B idea 1', 'B idea 2', 'B idea 3']));
  for (const artifact of artifacts) assert.ok(artifact.highlights.every(item => item.sourceRefs.every(ref => f.app.store.get('source', ref.sourceId))));
});

test('zero daily learning budget yields focus without a practice', async t => {
  const f = await fixture(t, { budget: 0 }); await enable(f.app); await settled(f.app);
  const today = await ok(f.app, 'GET', '/today'); assert.ok(today.highlights.length); assert.equal(today.practice, null);
});

for (const change of ['disable', 'profile', 'scope', 'model', 'source']) {
  test(`in-flight ${change} change publishes no stale focus or practice`, async t => {
    const f = await fixture(t);
    f.state.beforeModel = async () => {
      f.state.beforeModel = null;
      if (change === 'disable') await enable(f.app, false);
      if (change === 'profile') await profile(f.app, { goals: ['A new explicit goal'] });
      if (change === 'scope') await scope(f.app, { enabled: false });
      if (change === 'model') await settings(f.app, { model: { enabled: false } });
      if (change === 'source') { const source = f.app.store.all('source')[0]; f.app.sources.capture({ ...source, content: 'Changed while the model answered.' }); }
    };
    await enable(f.app); const job = await settled(f.app);
    assert.equal(job.status, 'failed'); assert.equal(f.app.store.all('focus-artifact').length, 0); assert.equal(f.app.store.all('practice').length, 0);
    assert.equal(f.app.store.all('automation-call').length, 1);
  });
}

test('source and profile changes hide old highlights before any new model request', async t => {
  const f = await fixture(t); await enable(f.app); await settled(f.app);
  assert.ok((await ok(f.app, 'GET', '/today')).highlights.length);
  const source = f.app.store.all('source')[0]; f.app.sources.capture({ ...source, content: 'Changed source evidence.' });
  assert.deepEqual((await ok(f.app, 'GET', '/today')).highlights, []);
  await profile(f.app, { goals: ['New explicit goal'] });
  assert.deepEqual((await ok(f.app, 'GET', '/today')).highlights, []); assert.equal(f.state.inputs.length, 1);
});

test('legacy scheduled raw collection yields without changing legacy configuration', async t => {
  const f = await fixture(t);
  await settings(f.app, { scheduler: { enabled: true, codexSyncEnabled: true, catchUpEnabled: true } });
  await enable(f.app); await settled(f.app);
  const before = await ok(f.app, 'GET', '/settings'); f.app.scheduler.tick(f.clock.value); await settled(f.app);
  assert.equal(f.app.store.all('job').filter(job => job.kind === 'codex_sync').length, 0);
  assert.deepEqual(await ok(f.app, 'GET', '/settings'), before);
});

for (const trigger of ['scheduler', 'recovery']) {
  test(`legacy ${trigger} work queued before enable is skipped while automatic and manual collection remain usable`, async t => {
    const f = await fixture(t);
    await settings(f.app, { scheduler: { enabled: true, codexSyncEnabled: true, catchUpEnabled: true } });
    const previousSettings = await ok(f.app, 'GET', '/settings'); await f.app.jobs.stop();
    const currentScope = f.app.collector.scope();
    const legacy = f.app.jobs.enqueue('codex_sync', { scope: currentScope, request: {}, trigger: 'scheduler' }, 'legacy_scheduled_before_automatic', `codex:${currentScope.revision}`);
    if (trigger === 'recovery') {
      const queued = f.app.store.require('job', legacy.jobId);
      f.app.store.put('job', { ...queued, trigger: 'recovery', status: 'running', leaseOwner: 'exited-worker', leaseUntil: 0 }, queued.id);
    }
    await enable(f.app); f.app.jobs.start();
    const skipped = await jobDone(f.app, legacy); await settled(f.app);
    assert.equal(skipped.result.sourcesCreated, 0); assert.equal(skipped.result.candidatesCreated, 0);
    assert.ok(skipped.result.notices.some(notice => notice.code === 'SUPERSEDED_BY_AUTOMATION'));
    assert.equal(f.app.store.all('knowledge').length, 0); assert.equal(f.app.store.all('source').length, 2);
    assert.equal(f.state.inputs.length, 1); assert.ok((await ok(f.app, 'GET', '/today')).practice);
    assert.deepEqual(await ok(f.app, 'GET', '/settings'), previousSettings);
    const manual = await ok(f.app, 'POST', '/codex/sync', { threadIds: ['A'] }, 202); await jobDone(f.app, manual);
    assert.equal(f.app.store.all('knowledge').length, 1);
  });
}
