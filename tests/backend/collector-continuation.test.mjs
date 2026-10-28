import test from 'node:test';
import assert from 'node:assert/strict';
import { appFor, ok, scope, jobDone, scratch, operation } from './helpers.mjs';
import { RpcError } from '../../server/codex-rpc.mjs';
import { ApiError } from '../../server/errors.mjs';

const metadata = (id, title = id) => ({ id, name: title, updatedAt: Date.now() });
const user = (id, text = `question-${id}`) => ({ type: 'userMessage', id, content: [{ type: 'text', text }] });
const assistant = (id, text = `answer-${id}`) => ({ type: 'agentMessage', id, text });
const hidden = (id, type = 'reasoning') => ({ type, id, text: `PRIVATE-${id}`, output: `PRIVATE-${id}` });
const page = (data, nextCursor = null) => ({ data, nextCursor });
const bodyMethods = ['thread/items/list', 'thread/turns/list', 'thread/read'];

function rpcFixture({ pages, mode = 'items', threads = [metadata('A')] }) {
  const calls = [];
  const state = { pages, mode, threads, before: null };
  const rpcFactory = () => ({
    verifiedStateDbOnly: true,
    async start() {}, async close() {},
    async request(method, params) {
      const call = { method, ...params };
      calls.push(call);
      await state.before?.(call);
      if (method === 'thread/list') return page(state.threads);
      const expected = { items: 'thread/items/list', turns: 'thread/turns/list', legacy: 'thread/read' }[state.mode];
      if (method !== expected) throw new RpcError(-32601);
      // Flat cursor maps have a start entry; a cursor may equal the thread ID.
      const pages = Object.hasOwn(state.pages, 'start') ? state.pages : state.pages[params.threadId];
      const selected = pages?.[params.cursor ?? 'start'];
      if (!selected) throw new ApiError(502, 'UPSTREAM_ERROR', 'Unknown synthetic cursor.');
      if (state.mode === 'items') return selected;
      if (state.mode === 'legacy') return { thread: { turns: [{ items: pages.start.data }] } };
      return { ...selected, data: [{ items: selected.data, itemsView: 'full' }] };
    },
  });
  return { calls, state, rpcFactory };
}

async function collectorApp(t, config) {
  const root = config.root ?? scratch();
  const fixture = rpcFixture(config);
  const options = { days: 7, maxThreads: 20, pageSize: 4, maxPages: config.maxPages ?? 1, cliPath: null };
  const app = await appFor(t, {
    rpcFactory: fixture.rpcFactory, collectorOptions: options, root,
    ...(config.keep === undefined ? {} : { keep: config.keep }),
  });
  await scope(app, { enabled: true, allowedThreadIds: fixture.state.threads.map(thread => thread.id) });
  return { ...fixture, app, options };
}

async function sync(app, body = {}, expected = 'succeeded') {
  return jobDone(app, await ok(app, 'POST', '/codex/sync', body, 202), expected);
}

async function settledJob(app, ack) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await ok(app, 'GET', `/jobs/${ack.jobId}`);
    if (['succeeded', 'failed', 'uncertain', 'blocked', 'cancelled'].includes(result.status)) return result;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  assert.fail('Synthetic continuation job did not finish.');
}

const checkpoint = app => app.store.all('collector-thread').find(record => record.scopeRevision !== undefined);
const progress = app => app.store.all('collector-cursor')[0];
const bodies = calls => calls.filter(call => bodyMethods.includes(call.method));
const snapshot = app => ({ cursor: app.store.all('collector-cursor'), thread: app.store.all('collector-thread') });
const sourceIds = app => app.store.all('source').map(source => source.messageId).sort();

test('bounded chunks capture every message beyond the former twenty-page history ceiling', async t => {
  const pages = {};
  for (let index = 0; index < 24; index++) {
    pages[index ? `p${index}` : 'start'] = page([index % 2 ? assistant(`m${index}`) : user(`m${index}`)], index < 23 ? `p${index + 1}` : null);
  }
  const f = await collectorApp(t, { pages, maxPages: 20 });
  const first = await sync(f.app);
  assert.equal(first.result.sourcesCreated, 20); assert.equal(first.result.hasMore, true);
  assert.equal(bodies(f.calls).length, 20);
  assert.equal(checkpoint(f.app).nativeCursor, 'p20'); assert.equal(checkpoint(f.app).nativeMode, 'items');
  assert.deepEqual(progress(f.app).pendingThreads.map(thread => thread.id), ['A']);
  const before = f.calls.length;
  const second = await sync(f.app);
  assert.equal(second.result.sourcesCreated, 4); assert.equal(second.result.hasMore, false);
  assert.deepEqual(bodies(f.calls.slice(before)).map(call => call.cursor), ['p20', 'p21', 'p22', 'p23']);
  assert.ok(!f.calls.slice(before).some(call => call.method === 'thread/list'));
  assert.equal(f.app.store.all('source').length, 24); assert.equal(f.app.store.all('knowledge').length, 12);
  assert.equal(new Set(sourceIds(f.app)).size, 24);
  assert.equal(checkpoint(f.app).nativeCursor, null); assert.equal(checkpoint(f.app).nativeMode, null);
});

test('visible-message quotas reread the same bounded chunk and advance only at its exact end', async t => {
  const f = await collectorApp(t, { maxPages: 2, pages: {
    start: page([user('u0'), assistant('a0')], 'p1'),
    p1: page([user('u1'), assistant('a1')], 'p2'), p2: page([user('u2'), assistant('a2')]),
  } });
  assert.equal((await sync(f.app, { maxMessages: 1 })).result.sourcesCreated, 1);
  assert.equal(checkpoint(f.app).nativeCursor, null); assert.equal(checkpoint(f.app).nativeMode, 'items');
  assert.equal(checkpoint(f.app).offset, 1); assert.match(checkpoint(f.app).prefixDigest, /^[a-f0-9]{64}$/);
  let before = f.calls.length;
  assert.equal((await sync(f.app, { maxMessages: 1 })).result.sourcesCreated, 1);
  assert.deepEqual(bodies(f.calls.slice(before)).map(call => call.cursor), [null, 'p1']);
  assert.equal(checkpoint(f.app).offset, 2); assert.equal(checkpoint(f.app).nativeCursor, null);
  before = f.calls.length;
  const boundary = await sync(f.app, { maxMessages: 2 });
  assert.equal(boundary.result.sourcesCreated, 2); assert.equal(boundary.result.hasMore, true);
  assert.deepEqual(bodies(f.calls.slice(before)).map(call => call.cursor), [null, 'p1']);
  assert.equal(checkpoint(f.app).offset, 0); assert.equal(checkpoint(f.app).nativeCursor, 'p2');
  const last = await sync(f.app, { maxMessages: 2 });
  assert.equal(last.result.sourcesCreated, 2); assert.equal(last.result.hasMore, false);
  assert.deepEqual(sourceIds(f.app), ['a0', 'a1', 'a2', 'u0', 'u1', 'u2']);
});

test('single-page partial quotas preserve cursor-cycle state and never reject a legitimate reread', async t => {
  const f = await collectorApp(t, { pages: {
    start: page([user('u0'), assistant('a0')], 'next'), next: page([user('u1'), assistant('a1')]),
  } });
  await sync(f.app, { maxMessages: 1 });
  const initialCheck = checkpoint(f.app).nativeCursorCheck;
  assert.equal(checkpoint(f.app).nativeCursor, null); assert.equal(checkpoint(f.app).offset, 1);
  assert.equal(checkpoint(f.app).nativeEntryOffset, 0);
  await sync(f.app, { maxMessages: 1 });
  assert.equal(checkpoint(f.app).nativeCursor, 'next'); assert.equal(checkpoint(f.app).offset, 0);
  assert.equal(checkpoint(f.app).nativeEntryOffset, 2);
  const advancedCheck = checkpoint(f.app).nativeCursorCheck;
  assert.notDeepEqual(advancedCheck, initialCheck);
  await sync(f.app, { maxMessages: 1 });
  assert.equal(checkpoint(f.app).nativeCursor, 'next'); assert.equal(checkpoint(f.app).offset, 1);
  assert.equal(checkpoint(f.app).nativeEntryOffset, 2);
  assert.deepEqual(checkpoint(f.app).nativeCursorCheck, advancedCheck);
  const last = await sync(f.app, { maxMessages: 1 });
  assert.equal(last.result.hasMore, false);
  assert.equal(checkpoint(f.app).nativeEntryOffset, 0);
  const lastAnswer = f.app.store.all('knowledge').find(item => item.sourceRefs.some(ref => ref.messageId === 'a1'));
  assert.equal(lastAnswer.question, 'question-u1');
  assert.deepEqual(bodies(f.calls).map(call => call.cursor), [null, null, 'next', 'next']);
  assert.deepEqual(sourceIds(f.app), ['a0', 'a1', 'u0', 'u1']);
});

test('cursor cycles across single-page jobs stop without advancing the last committed checkpoint', async t => {
  const f = await collectorApp(t, { pages: {
    start: page([user('u')], 'A'), A: page([assistant('a')], 'B'), B: page([user('uB')], 'A'),
  } });
  let failed = false; let completedChunks = 0;
  for (let index = 0; index < 16; index++) {
    const beforeState = snapshot(f.app); const before = f.calls.length;
    const result = await settledJob(f.app, await ok(f.app, 'POST', '/codex/sync', {}, 202));
    assert.ok(bodies(f.calls.slice(before)).length <= 1);
    if (result.status === 'failed') {
      assert.ok(completedChunks >= 2, 'The fixture must complete real continuation chunks before detecting the cursor cycle.');
      assert.equal(result.error.code, 'UPSTREAM_ERROR'); assert.deepEqual(snapshot(f.app), beforeState);
      failed = true; break;
    }
    assert.equal(result.status, 'succeeded'); assert.equal(result.result.hasMore, true);
    if (completedChunks < 2) assert.equal(checkpoint(f.app).nativeCursor, ['A', 'B'][completedChunks]);
    completedChunks++;
  }
  assert.equal(failed, true, 'A repeating native cursor cycle must terminate within bounded continuation jobs.');
});

test('identical ID-less messages on separate native chunks retain distinct source identities', async t => {
  const f = await collectorApp(t, { pages: {
    start: page([{ type: 'agentMessage', text: 'Identical visible content.' }], 'next'),
    next: page([{ type: 'agentMessage', text: 'Identical visible content.' }]),
  } });
  await sync(f.app); await sync(f.app);
  const sources = f.app.store.all('source');
  assert.equal(sources.length, 2); assert.equal(new Set(sources.map(source => source.messageId)).size, 2);
  assert.ok(sources.every(source => source.content === 'Identical visible content.'));
});

test('tool-only intermediate chunks advance while a tool-only final chunk completes the queue', async t => {
  const f = await collectorApp(t, { pages: {
    start: page([hidden('reasoning'), hidden('tool', 'commandExecution')], 'p1'),
    p1: page([user('u'), assistant('a')], 'p2'), p2: page([hidden('final-tool', 'commandExecution')]),
  } });
  const first = await sync(f.app);
  assert.equal(first.result.sourcesCreated, 0); assert.equal(first.result.hasMore, true);
  assert.equal(checkpoint(f.app).nativeCursor, 'p1'); assert.equal(bodies(f.calls).length, 1);
  const second = await sync(f.app);
  assert.equal(second.result.sourcesCreated, 2); assert.equal(second.result.hasMore, true);
  assert.equal(checkpoint(f.app).nativeCursor, 'p2');
  const last = await sync(f.app);
  assert.equal(last.result.sourcesCreated, 0); assert.equal(last.result.hasMore, false);
  assert.equal(checkpoint(f.app).nativeMode, null);
  assert.ok(!progress(f.app).pendingThreads?.length);
  assert.deepEqual(sourceIds(f.app), ['a', 'u']);
});

test('user question context survives a native boundary and an intervening hidden-only chunk', async t => {
  const f = await collectorApp(t, { pages: {
    start: page([user('u', 'Which evidence proves the operation completed?')], 'p1'),
    p1: page([hidden('private')], 'p2'), p2: page([assistant('a', 'Read the persisted operation identity.')]),
  } });
  await sync(f.app); await sync(f.app); await sync(f.app);
  const candidate = f.app.store.all('knowledge')[0];
  assert.equal(candidate.question, 'Which evidence proves the operation completed?');
  assert.equal(candidate.answer, 'Read the persisted operation identity.');
  assert.equal(candidate.sourceRefs.length, 2);
});

test('a complete rescan attaches a new middle answer to its preceding question rather than a future user source', async t => {
  const f = await collectorApp(t, { pages: {
    start: page([user('u0', 'Earlier question')], 'middle'),
    middle: page([assistant('a0', 'Earlier answer')], 'later'),
    later: page([user('u1', 'Future question'), assistant('a1', 'Future answer')]),
  } });
  await sync(f.app); await sync(f.app); assert.equal((await sync(f.app)).result.hasMore, false);
  const earlier = f.app.store.all('source').find(source => source.messageId === 'u0');
  const future = f.app.store.all('source').find(source => source.messageId === 'u1');
  f.state.pages.middle.data.push(assistant('ax', 'Inserted middle answer'));
  await sync(f.app);
  assert.equal(f.app.store.require('source', earlier.id).capturedAt, earlier.capturedAt);
  assert.equal(checkpoint(f.app).nativeUserSourceId, earlier.id);
  const middle = await sync(f.app);
  assert.equal(middle.result.sourcesCreated, 1); assert.equal(middle.result.candidatesCreated, 1);
  const inserted = f.app.store.all('knowledge').find(item => item.sourceRefs.some(ref => ref.messageId === 'ax'));
  assert.equal(inserted.question, 'Earlier question');
  assert.ok(inserted.sourceRefs.some(ref => ref.sourceId === earlier.id));
  assert.ok(!inserted.sourceRefs.some(ref => ref.sourceId === future.id));
  assert.equal((await sync(f.app)).result.hasMore, false);
  assert.equal(checkpoint(f.app).nativeUserSourceId, null);
  assert.deepEqual(sourceIds(f.app), ['a0', 'a1', 'ax', 'u0', 'u1']);
});

test('ID-less identities survive a complete rescan with smaller chunks and rotated opaque cursors', async t => {
  const firstPage = [user('u', 'Question'), { type: 'agentMessage', text: 'First ID-less answer' }, hidden('ordinal-only')];
  const secondPage = [{ type: 'agentMessage', text: 'Repeated ID-less answer' }];
  const thirdPage = [{ type: 'agentMessage', text: 'Repeated ID-less answer' }];
  const f = await collectorApp(t, { maxPages: 2, pages: {
    start: page(firstPage, 'old-cursor-1'), 'old-cursor-1': page(secondPage, 'old-cursor-2'), 'old-cursor-2': page(thirdPage),
  } });
  await sync(f.app); assert.equal((await sync(f.app)).result.hasMore, false);
  const originalSources = f.app.store.all('source').map(source => [source.id, source.messageId]).sort();
  const originalKnowledge = f.app.store.all('knowledge').map(item => item.id).sort();
  assert.equal(originalSources.length, 4); assert.equal(originalKnowledge.length, 3);
  assert.equal(checkpoint(f.app).nativeEntryOffset, 0);
  const options = await ok(f.app, 'GET', '/connections/codex/options');
  await ok(f.app, 'PUT', '/connections/codex/options', { expectedRevision: options.revision, cliPath: options.cliPath,
    days: options.days, maxThreads: options.maxThreads, pageSize: options.pageSize, maxPages: 1 });
  f.state.pages = { start: page(firstPage, 'new-cursor-A'), 'new-cursor-A': page(secondPage, 'new-cursor-B'), 'new-cursor-B': page(thirdPage) };
  for (let index = 0; index < 3; index++) {
    const replay = await sync(f.app);
    assert.equal(replay.result.sourcesCreated, 0); assert.equal(replay.result.candidatesCreated, 0); assert.equal(replay.result.sourcesUpdated, 0);
    assert.equal(replay.result.hasMore, index < 2);
  }
  assert.deepEqual(f.app.store.all('source').map(source => [source.id, source.messageId]).sort(), originalSources);
  assert.deepEqual(f.app.store.all('knowledge').map(item => item.id).sort(), originalKnowledge);
  assert.equal(checkpoint(f.app).nativeEntryOffset, 0);
});

test('SQLite restart retains a partial chunk and operation replay performs no new reads', async t => {
  const root = scratch();
  const f = await collectorApp(t, { root, keep: true, pages: { start: page([user('u'), assistant('a')]) } });
  const body = { operationId: operation(), maxMessages: 1 };
  const first = await ok(f.app, 'POST', '/codex/sync', body, 202); await jobDone(f.app, first);
  assert.equal(checkpoint(f.app).offset, 1); await f.app.close();
  const app = await appFor(t, { root, rpcFactory: f.rpcFactory, collectorOptions: f.options });
  const before = f.calls.length;
  assert.deepEqual(await ok(app, 'POST', '/codex/sync', body, 202), first);
  assert.equal(f.calls.length, before);
  const resumed = await sync(app, { maxMessages: 1 });
  assert.equal(resumed.result.sourcesCreated, 1); assert.equal(resumed.result.candidatesCreated, 1);
  assert.deepEqual(bodies(f.calls.slice(before)).map(call => call.cursor), [null]);
  assert.deepEqual(sourceIds(app), ['a', 'u']);
});

test('changed partial prefixes rescan safely and completed histories detect edits without replacing reviewed answers', async t => {
  const f = await collectorApp(t, { pages: { start: page([user('u0'), assistant('a0', 'Original source answer.'), user('u1'), assistant('a1')]) } });
  await sync(f.app, { maxMessages: 2 });
  let candidate = f.app.store.all('knowledge')[0];
  candidate = await ok(f.app, 'POST', `/knowledge/${candidate.id}/decision`, { expectedRevision: candidate.revision, decision: 'accept' });
  candidate = await ok(f.app, 'PATCH', `/knowledge/${candidate.id}`, { expectedRevision: candidate.revision, answer: 'User reviewed answer.' });
  f.state.pages.start.data[1] = assistant('a0', 'Changed source answer.');
  const replayedPrefix = await sync(f.app, { maxMessages: 1 });
  assert.equal(replayedPrefix.result.sourcesCreated, 0); assert.equal(checkpoint(f.app).offset, 1);
  const changed = await sync(f.app, { maxMessages: 1 });
  assert.equal(changed.result.sourcesUpdated, 1);
  let saved = f.app.store.require('knowledge', candidate.id);
  assert.equal(saved.status, 'needs_recheck'); assert.equal(saved.answer, 'User reviewed answer.');
  await sync(f.app, { maxMessages: 2 });
  assert.equal(checkpoint(f.app).nativeMode, null);
  f.state.pages.start.data[1] = assistant('a0', 'Changed again after complete capture.');
  const rescan = await sync(f.app);
  assert.equal(rescan.result.sourcesCreated, 0); assert.equal(rescan.result.sourcesUpdated, 1);
  saved = f.app.store.require('knowledge', candidate.id);
  assert.equal(saved.status, 'needs_recheck'); assert.equal(saved.answer, 'User reviewed answer.');
  assert.deepEqual(sourceIds(f.app), ['a0', 'a1', 'u0', 'u1']);
});

for (const mode of ['turns', 'legacy']) {
  test(`initial ${mode} fallback binds subsequent continuation to that protocol`, async t => {
    const pages = mode === 'turns' ? { start: page([user('u')], 'turn-next'), 'turn-next': page([assistant('a')]) }
      : { start: page([user('u'), assistant('a')]) };
    const f = await collectorApp(t, { pages, mode });
    await sync(f.app, { maxMessages: 1 });
    assert.equal(checkpoint(f.app).nativeMode, mode);
    assert.equal(checkpoint(f.app).nativeCursor, mode === 'turns' ? 'turn-next' : null);
    const before = f.calls.length;
    const last = await sync(f.app);
    assert.equal(last.result.hasMore, false); assert.deepEqual(sourceIds(f.app), ['a', 'u']);
    const resumed = bodies(f.calls.slice(before));
    assert.deepEqual(resumed.map(call => call.method), [mode === 'turns' ? 'thread/turns/list' : 'thread/read']);
    if (mode === 'turns') assert.equal(resumed[0].cursor, 'turn-next');
    else assert.ok(resumed[0].cursor === null || resumed[0].cursor === undefined);
  });
}

for (const mode of ['items', 'turns', 'legacy']) {
  test(`unsupported resumed ${mode} mode fails without switching protocol or advancing its checkpoint`, async t => {
    const pages = mode === 'legacy' ? { start: page([user('u'), assistant('a')]) }
      : { start: page([user('u')], 'next'), next: page([assistant('a')]) };
    const f = await collectorApp(t, { pages, mode });
    await sync(f.app, { maxMessages: 1 });
    const beforeState = snapshot(f.app); const before = f.calls.length;
    f.state.mode = mode === 'items' ? 'turns' : 'items';
    const failed = await sync(f.app, {}, 'failed');
    assert.equal(failed.error.code, 'CAPABILITY_UNSUPPORTED');
    assert.deepEqual(snapshot(f.app), beforeState);
    assert.deepEqual(bodies(f.calls.slice(before)).map(call => call.method), [{ items: 'thread/items/list', turns: 'thread/turns/list', legacy: 'thread/read' }[mode]]);
    assert.deepEqual(sourceIds(f.app), ['u']);
  });
}

test('a later unsupported page cannot replace an already-started initial chunk with another protocol', async t => {
  const f = await collectorApp(t, { maxPages: 2, pages: { start: page([user('u')], 'next'), next: page([assistant('a')]) } });
  f.state.before = call => { if (call.method === 'thread/items/list' && call.cursor === 'next') throw new RpcError(-32601); };
  const failed = await sync(f.app, {}, 'failed');
  assert.equal(failed.error.code, 'CAPABILITY_UNSUPPORTED');
  assert.deepEqual(bodies(f.calls).map(call => [call.method, call.cursor]), [['thread/items/list', null], ['thread/items/list', 'next']]);
  assert.deepEqual(sourceIds(f.app), []); assert.equal(checkpoint(f.app), undefined);
});

test('retryable native read failures leave committed progress unchanged and later retry resumes that cursor', async t => {
  const f = await collectorApp(t, { pages: { start: page([user('u')], 'next'), next: page([assistant('a')]) } });
  await sync(f.app);
  const beforeState = snapshot(f.app); const before = f.calls.length;
  f.state.before = call => { if (call.method === 'thread/items/list' && call.cursor === 'next') throw new ApiError(502, 'UPSTREAM_ERROR', 'Synthetic temporary failure.', true); };
  const failed = await sync(f.app, {}, 'failed');
  assert.equal(failed.error.code, 'UPSTREAM_ERROR');
  assert.deepEqual(bodies(f.calls.slice(before)).map(call => call.cursor), ['next', 'next']);
  assert.deepEqual(snapshot(f.app), beforeState); assert.deepEqual(sourceIds(f.app), ['u']);
  f.state.before = null;
  const recovered = await sync(f.app);
  assert.equal(recovered.result.sourcesCreated, 1); assert.equal(recovered.result.hasMore, false);
  assert.deepEqual(sourceIds(f.app), ['a', 'u']);
});

test('scope revocation during a continuation read purges pending progress without ingesting the response', async t => {
  const f = await collectorApp(t, { pages: { start: page([user('u')], 'next'), next: page([assistant('a')]) } });
  await sync(f.app);
  const before = f.calls.length;
  f.state.before = async call => { if (call.method === 'thread/items/list') await scope(f.app, { enabled: false }); };
  const failed = await sync(f.app, {}, 'failed');
  assert.equal(failed.error.code, 'SCOPE_FORBIDDEN');
  assert.equal(bodies(f.calls.slice(before)).length, 1);
  assert.deepEqual(sourceIds(f.app), ['u']);
  assert.equal(f.app.store.all('collector-cursor').length, 0);
  assert.ok(f.app.store.all('collector-thread').every(record => record.scopeRevision === undefined));
});

for (const [label, pages, maxPages] of [
  ['empty cursor', { start: page([user('u')], '') }, 1],
  ['numeric cursor', { start: page([user('u')], 7) }, 1],
  ['object cursor', { start: page([user('u')], { page: 2 }) }, 1],
  ['repeated cursor', { start: page([user('u')], 'p1'), p1: page([assistant('a')], 'p1') }, 2],
  ['multi-page cursor cycle', { start: page([user('u')], 'p1'), p1: page([assistant('a')], 'p2'), p2: page([user('u2')], 'p1') }, 3],
]) {
  test(`${label} fails before any partial chunk is captured`, async t => {
    const f = await collectorApp(t, { pages, maxPages });
    const failed = await sync(f.app, {}, 'failed');
    assert.equal(failed.error.code, 'UPSTREAM_ERROR'); assert.deepEqual(sourceIds(f.app), []);
    assert.equal(checkpoint(f.app), undefined);
    assert.ok(bodies(f.calls).length <= maxPages);
  });
}

test('native continuation retains the frozen thread queue while the live list reorders', async t => {
  const f = await collectorApp(t, { threads: [metadata('A', 'A original'), metadata('B', 'B original')], pages: {
    A: { start: page([user('uA')], 'next'), next: page([assistant('aA')]) },
    B: { start: page([user('uB'), assistant('aB')]) },
  } });
  await sync(f.app, { maxThreads: 1 });
  const frozen = progress(f.app).pendingThreads;
  assert.deepEqual(frozen.map(thread => thread.id), ['A', 'B']);
  f.state.threads = [metadata('HOT'), metadata('A', 'A changed title')];
  const before = f.calls.length;
  await sync(f.app, { maxThreads: 1 }); await sync(f.app, { maxThreads: 1 });
  assert.ok(!f.calls.slice(before).some(call => call.method === 'thread/list'));
  assert.deepEqual(bodies(f.calls.slice(before)).map(call => [call.threadId, call.cursor]), [['A', 'next'], ['B', null]]);
  assert.deepEqual(sourceIds(f.app), ['aA', 'aB', 'uA', 'uB']);
  assert.ok(f.app.store.all('source').every(source => source.title === `${source.threadId} original`));
});

test('partial continuation checkpoints contain only metadata, cursors and digests with no frozen bodies or known secrets', async t => {
  const secret = 'synthetic-collector-secret-abcdef123456';
  const rawBody = 'RAW-BODY-SENTINEL';
  const f = await collectorApp(t, { threads: [metadata('A', `A ${secret}`)], pages: {
    start: page([user('u', `${rawBody} ${secret}`), hidden('REASONING-SENTINEL'), hidden('TOOL-SENTINEL', 'commandExecution'), assistant('a')], 'next'),
    next: page([assistant('a2')]),
  } });
  f.app.secrets.set('model.apiKey', secret);
  await sync(f.app, { maxMessages: 1 });
  const state = checkpoint(f.app);
  const allowed = new Set(['id', 'ownerId', 'revision', 'createdAt', 'updatedAt', 'offset', 'lastSyncedAt', 'scopeRevision', 'lastMessageId', 'digest', 'prefixDigest', 'nativeCursor', 'nativeMode', 'nativeCursorCheck', 'nativeEntryOffset', 'nativeUserSourceId']);
  assert.ok(Object.keys(state).every(key => allowed.has(key)));
  assert.equal(state.offset, 1); assert.equal(state.nativeCursor, null); assert.equal(state.nativeMode, 'items');
  assert.equal(state.nativeEntryOffset, 0); assert.equal(state.nativeUserSourceId, null);
  assert.match(state.prefixDigest, /^[a-f0-9]{64}$/); assert.match(state.digest, /^[a-f0-9]{64}$/);
  const queued = progress(f.app).pendingThreads[0];
  assert.deepEqual(Object.keys(queued).sort(), ['archived', 'cwd', 'id', 'title', 'updatedAt']);
  const stored = JSON.stringify(snapshot(f.app));
  for (const forbidden of [rawBody, secret, 'PRIVATE-REASONING-SENTINEL', 'PRIVATE-TOOL-SENTINEL']) assert.ok(!stored.includes(forbidden));
  const sources = JSON.stringify(f.app.store.all('source'));
  assert.ok(sources.includes('[REDACTED]')); assert.ok(!sources.includes(secret));
  assert.ok(!sources.includes('PRIVATE-REASONING-SENTINEL')); assert.ok(!sources.includes('PRIVATE-TOOL-SENTINEL'));
});
