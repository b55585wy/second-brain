import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { connectionItems } from '../support/connections.mjs';
import { createSyntheticRpcFactory, READ_ONLY_RPC_METHODS, SYNTHETIC_THREAD_ID, SYNTHETIC_TURN_ID, SYNTHETIC_USER_ID, SYNTHETIC_AGENT_ID } from '../scripts/synthetic-rpc-fixture.mjs';
import { ARTIFACTS_DIR, DATA_ROOT, EMPTY_ROOT, FRONTEND_DIR, buildIsolatedOptions, validateWorkerRequest, workerPaths } from '../support/isolation.mjs';

const env = { BASE_URL: 'http://127.0.0.1:18998', SECOND_BRAIN_E2E_ISOLATED: '1', SECOND_BRAIN_E2E_PARENT_READY: 'BOTH-READY' };
const isCode = code => error => error.rpcCode === code;

test('SAFE-04: inspect Page items before any array fallback', () => {
  const siyuan = { kind: 'siyuan', configured: false, status: 'not_configured' };
  assert.deepEqual(connectionItems({ items: [siyuan], total: 1 }), [siyuan]);
  assert.deepEqual(connectionItems([siyuan]), [siyuan]);
  const mixed = [{ kind: 'wrong-array-record' }];
  mixed.items = [siyuan];
  assert.deepEqual(connectionItems(mixed), [siyuan]);
  assert.deepEqual(connectionItems({ items: [], total: 0 }), []);
});

test('SAFE-04: malformed Page items and invalid connection records fail closed', () => {
  for (const value of [null, {}, { items: null }, { items: 'invalid' }, { items: [null] }, { items: [[]] }]) {
    assert.throws(() => connectionItems(value), /Connections|Connection records/);
  }
  const mixed = [{ kind: 'siyuan' }];
  mixed.items = null;
  assert.throws(() => connectionItems(mixed), /items array/);
});

test('RPC-01: fixture implements only synthetic initialization and read protocol shapes', async () => {
  const client = createSyntheticRpcFactory()();
  assert.equal(await client.start(), client);
  assert.equal(client.negotiated.synthetic, true);
  assert.equal(client.negotiated.readOnly, true);
  assert.equal((await client.request('initialize')).synthetic, true);
  const threads = await client.request('thread/list');
  assert.equal(threads.data.length, 1);
  assert.equal(threads.data[0].id, SYNTHETIC_THREAD_ID);
  const params = { threadId: SYNTHETIC_THREAD_ID };
  const items = await client.request('thread/items/list', params);
  assert.deepEqual(items.data.map(item => item.type), ['userMessage', 'agentMessage']);
  assert.deepEqual(items.data[0].content, [{ type: 'text', text: items.data[0].content[0].text }]);
  assert.deepEqual(items.data.map(item => item.id), [SYNTHETIC_USER_ID, SYNTHETIC_AGENT_ID]);
  assert.match(items.data[0].content[0].text, /^E2E-SB-/);
  assert.match(items.data[1].text, /^E2E-SB-/);
  const turns = await client.request('thread/turns/list', params);
  assert.deepEqual(turns.data[0].items, items.data);
  assert.equal(turns.data[0].id, SYNTHETIC_TURN_ID);
  for (const id of [SYNTHETIC_THREAD_ID, SYNTHETIC_TURN_ID, SYNTHETIC_USER_ID, SYNTHETIC_AGENT_ID]) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  assert.match(threads.data[0].title, /^E2E-SB-synthetic-/);
  const read = await client.request('thread/read', { ...params, includeTurns: true });
  assert.deepEqual(read.thread.turns, turns.data);
  assert.deepEqual((await client.request('thread/read', { ...params, includeTurns: false })).thread.turns, []);
  assert.equal(READ_ONLY_RPC_METHODS.length, 5);
  await client.close();
});

test('RPC-02: bounded pagination, empty reads and independent responses', async () => {
  const factory = createSyntheticRpcFactory();
  const client = await factory().start();
  const params = { threadId: SYNTHETIC_THREAD_ID, limit: 1 };
  const first = await client.request('thread/items/list', params);
  assert.equal(first.data[0].type, 'userMessage');
  const second = await client.request('thread/items/list', { ...params, cursor: first.nextCursor });
  assert.equal(second.data[0].type, 'agentMessage');
  assert.equal(second.nextCursor, null);
  assert.deepEqual((await client.request('thread/items/list', { ...params, cursor: 'E2E-SB-cursor-2' })).data, []);
  assert.deepEqual((await client.request('thread/list', { archived: true })).data, []);
  assert.deepEqual((await client.request('thread/list', { excludedThreadIds: [SYNTHETIC_THREAD_ID] })).data, []);
  first.data[0].content[0].text = 'changed by caller';
  assert.match((await client.request('thread/items/list', params)).data[0].content[0].text, /^E2E-SB-/);
  const other = await factory().start();
  assert.match((await other.request('thread/items/list', params)).data[0].content[0].text, /^E2E-SB-/);
  await client.close();
  await other.close();
});

test('RPC-02 / RPC-03: reject invalid params, identities, limits and cursors', async () => {
  const client = await createSyntheticRpcFactory()().start();
  await assert.rejects(client.request('thread/list', null), isCode(-32602));
  await assert.rejects(client.request('thread/read', { threadId: 'real-or-unknown-thread' }), isCode(-32602));
  for (const limit of [0, 101, 1.5, '1']) await assert.rejects(client.request('thread/list', { limit }), isCode(-32602));
  for (const cursor of ['unknown', 'E2E-SB-cursor-99', -1]) await assert.rejects(client.request('thread/list', { cursor }), isCode(-32602));
  await client.close();
});

test('RPC-03: reject execution/write methods and all reads after close', async () => {
  const client = createSyntheticRpcFactory()();
  await assert.rejects(client.request('thread/list'), isCode(-32000));
  await client.start();
  await client.start();
  for (const method of ['thread/start', 'thread/resume', 'thread/fork', 'thread/archive', 'turn/start', 'command/exec', 'exec', 'unknown']) {
    await assert.rejects(client.request(method), isCode(-32601));
  }
  await client.close();
  await client.close();
  await assert.rejects(client.start(), isCode(-32000));
  await assert.rejects(client.request('thread/list'), isCode(-32000));
});

test('WORKER-01: future execution requires BOTH-READY and exactly the owned origin', () => {
  assert.equal(validateWorkerRequest(env), env.BASE_URL);
  for (const value of [undefined, '', 'READY', 'both-ready']) assert.throws(() => validateWorkerRequest({ ...env, SECOND_BRAIN_E2E_PARENT_READY: value }), /BOTH-READY/);
  for (const BASE_URL of [undefined, '', 'http://127.0.0.1:18998/', 'http://127.0.0.1:18997', 'http://127.0.0.1:5173', 'http://127.0.0.1:4173', 'http://127.0.0.1:18999', 'https://127.0.0.1:19443', 'http://localhost:18998', 'http://[::1]:18998', 'https://e2e.invalid:18998']) {
    assert.throws(() => validateWorkerRequest({ ...env, BASE_URL }));
  }
  for (const value of [undefined, '0', 'true']) assert.throws(() => validateWorkerRequest({ ...env, SECOND_BRAIN_E2E_ISOLATED: value }));
});

test('WORKER-02: pure options use separate owned storage/root, real frontend and disabled providers', async () => {
  // Pure options only: never allocate directories, createApp or listen in offline checks.
  const paths = workerPaths('worker-E2E-SB-offline-check');
  const options = buildIsolatedOptions(paths, env);
  assert.equal(options.root, join(EMPTY_ROOT, paths.runId));
  assert.equal(options.dataDir, join(DATA_ROOT, paths.runId));
  assert.equal(options.dbPath, join(paths.dataDir, 'second-brain.sqlite'));
  assert.equal(options.secretsPath, join(paths.dataDir, 'secrets', 'credentials.json'));
  assert.equal(options.frontendDir, FRONTEND_DIR);
  assert.match(FRONTEND_DIR.replaceAll('\\', '/'), /\/second-brain\/frontend\/dist$/);
  assert.equal(options.scheduler, false);
  assert.equal(options.origin, env.BASE_URL);
  assert.equal(options.port, 18998);
  assert.notEqual(options.root, options.dataDir);
  assert.equal(relative(ARTIFACTS_DIR, options.root).startsWith('..'), false);
  const rpc = await options.rpcFactory({ cliPath: 'must-never-execute' }).start();
  assert.equal((await rpc.request('thread/list')).data[0].id, SYNTHETIC_THREAD_ID);
  await rpc.close();
  await assert.rejects(options.transport.fetch('https://e2e.invalid/provider'), /provider transport is disabled/);
  await assert.rejects(options.transport.fetch('http://127.0.0.1:6806/api'), /no upstream request was sent/);
});

test('WORKER-02: refuse roots, siblings, traversal and forged storage paths', () => {
  for (const run of [undefined, '', 'worker-..', 'worker-a/b', 'worker-a\\b', 'worker-a:stream', `worker-${'x'.repeat(113)}`, ARTIFACTS_DIR]) {
    assert.throws(() => workerPaths(run), /Worker run ID/);
  }
  const paths = workerPaths('worker-offline');
  for (const key of ['root', 'dataDir', 'dbPath', 'secretsPath', 'evidenceDir']) {
    for (const outside of [ARTIFACTS_DIR, `${ARTIFACTS_DIR}-sibling`, join(ARTIFACTS_DIR, '..', '..', '..', 'data'), join(paths.root, 'runtime')]) {
      assert.throws(() => buildIsolatedOptions({ ...paths, [key]: outside }, env), /owned artifact path/);
    }
  }
});
