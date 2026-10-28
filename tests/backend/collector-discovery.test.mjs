import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApiError } from '../../server/errors.mjs';
import { RpcError } from '../../server/codex-rpc.mjs';
import { appFor, ok, request, scope } from './helpers.mjs';

const thread = (id, extra = {}) => ({ id, title: 'Title ' + id, updatedAt: Date.now(), createdAt: Date.now() - 1000, ...extra });
const page = (data, nextCursor = null) => ({ data, nextCursor });
const snapshot = app => JSON.stringify({ records: app.store.db.prepare('SELECT body FROM records ORDER BY body').all(), operations: app.store.db.prepare('SELECT body FROM operations ORDER BY body').all() });

async function discoveryApp(t, options = {}) {
  const calls = []; const state = { starts: 0, requests: 0, closes: 0 }; let app;
  const rpcFactory = () => {
    const client = {
      verifiedStateDbOnly: Object.hasOwn(options, 'verified') ? options.verified : true,
      negotiated: { readOnly: options.readOnly ?? true },
      async start() { state.starts++; await options.start?.(app, state); },
      async close() { state.closes++; await options.close?.(app, state); },
      async request(method, params) {
        calls.push({ method, params }); state.requests++;
        assert.equal(method, 'thread/list'); assert.equal(params.useStateDbOnly, true);
        return options.handler ? options.handler(params, app, state) : page([thread('A'), thread('B')]);
      },
    };
    state.client = client; return client;
  };
  app = await appFor(t, { rpcFactory });
  return { app, calls, state };
}

for (const enabled of [false, true]) {
  test('discovery browses metadata with empty positive scope, enabled=' + enabled + ', without changing persisted state', async t => {
    const f = await discoveryApp(t); await scope(f.app, { enabled });
    f.app.store.put('collector-cursor', { scopeRevision: f.app.collector.scope().revision, cursor: 'untouched' }, 'synthetic-existing');
    const before = snapshot(f.app);
    const result = await ok(f.app, 'GET', '/codex/discovery');
    assert.deepEqual(result.items.map(item => [item.id, item.allowed]), [['A', false], ['B', false]]);
    assert.equal(result.total, 2); assert.equal(f.calls[0].params.limit, 20);
    assert.deepEqual(await ok(f.app, 'GET', '/codex/threads'), { items: [], total: 0 });
    assert.equal((await request(f.app, 'POST', '/codex/sync', {})).error.code, 'SCOPE_FORBIDDEN');
    assert.equal(snapshot(f.app), before); assert.equal(f.state.closes, 1); assert.equal(f.app.collector.clients.size, 0);
  });
}

test('metadata selection flags reflect saved permissions and exclusions even when browsing disabled', async t => {
  const f = await discoveryApp(t, { handler: () => page(['A', 'B', 'C'].map(id => thread(id))) });
  await scope(f.app, { allowedThreadIds: ['A'], excludedThreadIds: ['C'] });
  assert.deepEqual((await ok(f.app, 'GET', '/codex/discovery')).items.map(item => [item.id, item.allowed]), [['A', false], ['B', false]]);
  await scope(f.app, { enabled: true });
  const before = snapshot(f.app);
  assert.deepEqual((await ok(f.app, 'GET', '/codex/discovery')).items.map(item => [item.id, item.allowed]), [['A', true], ['B', false]]);
  assert.equal(snapshot(f.app), before);
});

test('canonical excluded project subtrees remain hidden without positive scope and project permissions stay exact', async t => {
  let rows = []; const f = await discoveryApp(t, { handler: () => page(rows) });
  const project = resolve(f.app.collector.root, 'project'); const blocked = resolve(project, 'blocked'); const nested = resolve(blocked, 'nested'); const sibling = blocked + '-sibling';
  for (const path of [nested, sibling]) mkdirSync(path, { recursive: true });
  rows = [thread('A', { cwd: project }), thread('B', { cwd: nested }), thread('C', { cwd: sibling }), thread('D', { cwd: null })];
  await scope(f.app, { excludedProjectPaths: [blocked] });
  assert.deepEqual((await ok(f.app, 'GET', '/codex/discovery')).items.map(item => item.id), ['A', 'C']);
  await scope(f.app, { enabled: true, allowedProjectPaths: [project] });
  assert.ok((await ok(f.app, 'GET', '/codex/discovery')).items.every(item => item.allowed === true));
});

test('all negative thread exclusions apply locally even beyond the server exclusion parameter limit', async t => {
  const excludedThreadIds = Array.from({ length: 101 }, (_, index) => 'excluded-' + index);
  const f = await discoveryApp(t, { handler: () => page([thread(excludedThreadIds.at(-1)), thread('visible')]) });
  await scope(f.app, { excludedThreadIds });
  assert.deepEqual((await ok(f.app, 'GET', '/codex/discovery')).items.map(item => item.id), ['visible']);
  assert.equal(f.calls[0].params.excludedThreadIds.length, 100);
});

test('archive setting applies independently of enabled/positive scope and archived branch rows are forced archived', async t => {
  const f = await discoveryApp(t, { handler: params => params.archived ? page([thread('ARCH', { archived: false })]) : page([thread('LIVE'), thread('HIDDEN', { archived: true })]) });
  assert.deepEqual((await ok(f.app, 'GET', '/codex/discovery')).items.map(item => item.id), ['LIVE']);
  await scope(f.app, { includeArchived: true });
  const result = await ok(f.app, 'GET', '/codex/discovery');
  assert.deepEqual(result.items.map(item => item.id), ['LIVE', 'HIDDEN', 'ARCH']);
  assert.equal(result.items.at(-1).archived, true); assert.ok(result.items.every(item => item.allowed === false));
  assert.deepEqual(f.calls.map(call => call.params.archived), [false, false, true]);
});

for (const display of ['name', 'title', 'preview']) {
  test('discovery redacts and bounds ' + display + ' fallback while omitting raw preview and message fields', async t => {
    const sentinel = 'sk-discoverySyntheticCredential123456789'; const body = 'PRIVATE-BODY-DO-NOT-RETURN';
    const f = await discoveryApp(t, { handler: () => page([thread('A', { title: undefined, [display]: 'api_key=' + sentinel + ' ' + '字'.repeat(250),
      preview: display === 'preview' ? 'api_key=' + sentinel + ' ' + '字'.repeat(250) : body, turns: [{ content: body }], messages: [body], items: [body], unused: sentinel })]) });
    const before = snapshot(f.app); const result = await ok(f.app, 'GET', '/codex/discovery');
    assert.ok([...result.items[0].title].length <= 200); assert.match(result.items[0].title, /REDACTED/);
    assert.ok(!JSON.stringify(result).includes(sentinel)); assert.ok(!JSON.stringify(result).includes(body));
    assert.deepEqual(Object.keys(result.items[0]).sort(), ['allowed', 'ancestryVerified', 'archived', 'createdAt', 'id', 'lastSyncedAt', 'parentThreadId', 'projectPath', 'title', 'updatedAt']);
    assert.equal(snapshot(f.app), before); assert.equal(f.state.requests, 1);
  });
}

test('days window skips unknown dates, honors recent bounds, and stops paging at the cutoff', async t => {
  const f = await discoveryApp(t, { handler: () => page([thread('RECENT'), thread('TWO-DAYS', { updatedAt: Date.now() - 2 * 86400000 }), thread('OLD', { updatedAt: Date.now() - 31 * 86400000 }), thread('UNKNOWN', { updatedAt: null })], 'must-not-read') });
  assert.deepEqual((await ok(f.app, 'GET', '/codex/discovery?days=1')).items.map(item => item.id), ['RECENT']);
  assert.equal(f.state.requests, 1);
  assert.deepEqual((await ok(f.app, 'GET', '/codex/discovery?days=30')).items.map(item => item.id), ['RECENT', 'TWO-DAYS']);
  assert.equal(f.state.requests, 2);
});

test('reaching the live cutoff may continue into the separately allowed archive within the same budget', async t => {
  const f = await discoveryApp(t, { handler: params => params.archived ? page([thread('ARCH')]) : page([thread('OLD', { updatedAt: Date.now() - 40 * 86400000 })], 'never-live') });
  await scope(f.app, { includeArchived: true });
  assert.deepEqual((await ok(f.app, 'GET', '/codex/discovery')).items.map(item => item.id), ['ARCH']);
  assert.deepEqual(f.calls.map(call => call.params.archived), [false, true]);
});

for (const limit of [1, 50]) {
  test('discovery accepts and strictly caps output at limit=' + limit, async t => {
    const f = await discoveryApp(t, { handler: params => page(Array.from({ length: params.limit }, (_, index) => thread('T-' + index)), 'unused-next') });
    const result = await ok(f.app, 'GET', '/codex/discovery?limit=' + limit);
    assert.equal(result.items.length, limit); assert.equal(result.total, limit); assert.equal(f.state.requests, 1);
  });
}

test('invalid, duplicate and undeclared discovery queries fail before opening a client', async t => {
  const f = await discoveryApp(t);
  for (const query of ['days=0', 'days=31', 'days=1.5', 'days=', 'days=all', 'days=-1', 'days=1e1', 'limit=0', 'limit=51', 'limit=NaN', 'limit=1.1', 'limit=', 'offset=1', 'q=title', 'days=7&days=8']) {
    assert.ok((await request(f.app, 'GET', '/codex/discovery?' + query)).status >= 400, query);
  }
  assert.equal(f.state.starts, 0);
});

test('discovery deduplicates IDs and bounds all live/archive pages to one shared five-request budget', async t => {
  const f = await discoveryApp(t, { handler: params => {
    if (params.archived) return page([thread('ARCH')], 'more-archive');
    const number = Number(params.cursor || 1);
    return page([thread('T-' + number), thread('T-' + number)], number < 4 ? String(number + 1) : null);
  } });
  await scope(f.app, { includeArchived: true });
  const result = await ok(f.app, 'GET', '/codex/discovery?limit=50');
  assert.deepEqual(result.items.map(item => item.id), ['T-1', 'T-2', 'T-3', 'T-4', 'ARCH']);
  assert.equal(f.state.requests, 5); assert.deepEqual(f.calls.map(call => call.params.archived), [false, false, false, false, true]);
});

test('endless recent live pages cannot expand discovery into all history', async t => {
  const f = await discoveryApp(t, { handler: (_params, _app, state) => page([thread('T-' + state.requests)], 'next-' + state.requests) });
  const result = await ok(f.app, 'GET', '/codex/discovery?limit=50&days=30');
  assert.equal(f.state.requests, 5); assert.equal(result.total, 5);
});

test('cursor cycles, invalid IDs, oversized pages and malformed page shapes fail closed without fallback', async t => {
  for (const handler of [
    params => page([thread('A')], params.cursor === null ? 'one' : params.cursor === 'one' ? 'two' : 'one'),
    () => page([thread('A')], false), () => page([thread('A')], 7),
    ...[undefined, null, 7, '', ' ', 'line\nbreak', 'tab\tbreak', 'x'.repeat(513)].map(id => () => page([thread(id)])),
    () => page([null]), () => ({ data: {} }), () => null,
    () => page(Array.from({ length: 21 }, (_, index) => thread('T-' + index))),
  ]) {
    const f = await discoveryApp(t, { handler }); const before = snapshot(f.app);
    assert.equal((await request(f.app, 'GET', '/codex/discovery')).error.code, 'UPSTREAM_ERROR');
    assert.equal(snapshot(f.app), before); assert.equal(f.state.closes, 1); assert.ok(f.state.requests <= 3);
  }
});

for (const verified of [false, undefined, null]) {
  test('unverified state-only capability stops before listing: ' + String(verified), async t => {
    const f = await discoveryApp(t, { verified }); const before = snapshot(f.app);
    assert.equal((await request(f.app, 'GET', '/codex/discovery')).error.code, 'CAPABILITY_UNSUPPORTED');
    assert.equal(f.state.requests, 0); assert.equal(f.state.closes, 1); assert.equal(snapshot(f.app), before);
  });
}

test('explicitly non-readonly negotiation is rejected before listing', async t => {
  const f = await discoveryApp(t, { readOnly: false });
  assert.equal((await request(f.app, 'GET', '/codex/discovery')).error.code, 'CAPABILITY_UNSUPPORTED'); assert.equal(f.state.requests, 0);
});

for (const code of [-32601, -32602]) {
  test('unsupported list capability ' + code + ' has no parameter or body fallback', async t => {
    const f = await discoveryApp(t, { handler: () => { throw new RpcError(code); } }); const before = snapshot(f.app);
    assert.equal((await request(f.app, 'GET', '/codex/discovery')).error.code, 'CAPABILITY_UNSUPPORTED');
    assert.equal(f.state.requests, 1); assert.equal(f.state.closes, 1); assert.equal(snapshot(f.app), before);
  });
}

test('transient page errors retry once, preserve safety flags, and count against the five-request budget', async t => {
  const f = await discoveryApp(t, { handler: (_params, _app, state) => {
    if (state.requests === 1) throw new ApiError(502, 'UPSTREAM_ERROR', 'temporary', true);
    return page([thread('T-' + state.requests)], 'next-' + state.requests);
  } });
  const before = snapshot(f.app); const result = await ok(f.app, 'GET', '/codex/discovery?limit=50');
  assert.equal(result.total, 4); assert.equal(f.state.requests, 5); assert.equal(snapshot(f.app), before);
  assert.deepEqual(f.calls[0].params, f.calls[1].params);
});

test('persistent transient errors retry only once and permission failures never retry', async t => {
  for (const retryable of [false, true]) {
    const f = await discoveryApp(t, { handler: () => { throw new ApiError(retryable ? 502 : 403, 'UPSTREAM_ERROR', 'synthetic failure', retryable); } });
    assert.equal((await request(f.app, 'GET', '/codex/discovery')).error.code, 'UPSTREAM_ERROR');
    assert.equal(f.state.requests, retryable ? 2 : 1); assert.equal(f.state.closes, 1);
  }
});

for (const boundary of ['initialize', 'page', 'retry', 'close']) {
  test('scope revision change during ' + boundary + ' rejects stale metadata and prevents later requests', async t => {
    const change = app => scope(app, { includeArchived: true });
    const f = await discoveryApp(t, {
      start: boundary === 'initialize' ? change : undefined,
      close: boundary === 'close' ? change : undefined,
      handler: async (_params, app) => {
        if (boundary !== 'close') await change(app);
        if (boundary === 'retry') throw new ApiError(502, 'UPSTREAM_ERROR', 'temporary', true);
        return page([thread('A')], boundary === 'close' ? null : 'next');
      },
    });
    assert.equal((await request(f.app, 'GET', '/codex/discovery')).error.code, 'SCOPE_FORBIDDEN');
    assert.equal(f.state.requests, boundary === 'initialize' ? 0 : 1);
    assert.equal(f.state.closes, 1); assert.equal(f.app.collector.clients.size, 0);
    for (const kind of ['source', 'knowledge', 'collector-cursor', 'collector-thread']) assert.equal(f.app.store.all(kind).length, 0);
  });
}

test('initialization and close failures always remove the client without persisting browse state', async t => {
  for (const phase of ['start', 'close']) {
    const f = await discoveryApp(t, { [phase]: async () => { throw new ApiError(503, 'CONNECTION_UNAVAILABLE', 'synthetic ' + phase); } });
    const before = snapshot(f.app);
    assert.equal((await request(f.app, 'GET', '/codex/discovery')).error.code, 'CONNECTION_UNAVAILABLE');
    assert.equal(f.state.closes, 1); assert.equal(f.app.collector.clients.size, 0); assert.equal(snapshot(f.app), before);
  }
});
