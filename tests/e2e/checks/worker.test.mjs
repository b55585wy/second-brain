import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { assertFreshStorage, validateMainDatabase, validatePhysicalPath, workerPaths } from '../support/isolation.mjs';
import { permitsSyntheticListing, useAndClose, withIsolatedWorker } from '../support/isolated-worker.mjs';

const origin = 'http://127.0.0.1:18998';
const paths = workerPaths('worker-offline-validation-only');

test('WORKER-01: rejected execution gate never reaches preflight or yield', async () => {
  let reached = false;
  const unreachable = async () => { reached = true; };
  await assert.rejects(withIsolatedWorker({}, {}, unreachable, unreachable), /BOTH-READY/);
  await assert.rejects(withIsolatedWorker({}, {
    BASE_URL: 'http://127.0.0.1:18997', SECOND_BRAIN_E2E_PARENT_READY: 'BOTH-READY', SECOND_BRAIN_E2E_ISOLATED: '1',
  }, unreachable, unreachable), /BASE_URL/);
  assert.equal(reached, false);
});

test('WORKER-03: physical snapshots reject junctions, redirects and wrong file kinds', () => {
  const snapshot = { actual: paths.dataDir, symbolicLink: false, kind: 'directory' };
  assert.equal(validatePhysicalPath(paths.dataDir, snapshot), paths.dataDir);
  for (const change of [
    { symbolicLink: true }, { actual: `${paths.dataDir}-sibling` }, { actual: join(paths.root, 'data') },
    { actual: 'relative/path' }, { kind: 'file' }, { kind: 'other' },
  ]) assert.throws(() => validatePhysicalPath(paths.dataDir, { ...snapshot, ...change }), /Physical/);
  assert.equal(validatePhysicalPath(paths.dbPath, { actual: paths.dbPath, symbolicLink: false, kind: 'file' }, 'file'), paths.dbPath);
  assert.throws(() => validatePhysicalPath(paths.dbPath, { actual: paths.dbPath, symbolicLink: true, kind: 'file' }, 'file'), /Physical/);
});

test('WORKER-03: empty storage only; existing DB, secrets, runtime or sidecars reject reuse', () => {
  assert.doesNotThrow(() => assertFreshStorage([], []));
  for (const entry of ['second-brain.sqlite', 'second-brain.sqlite-wal', 'secrets', 'runtime', 'connection.json']) {
    assert.throws(() => assertFreshStorage([entry], []), /fresh and empty/);
    assert.throws(() => assertFreshStorage([], [entry]), /fresh and empty/);
  }
  assert.throws(() => assertFreshStorage(null, []), /fresh and empty/);
});

test('WORKER-04: PRAGMA main file must exactly match the owned DB before listen', () => {
  const main = { seq: 0, name: 'main', file: paths.dbPath };
  assert.equal(validateMainDatabase([main], paths.dbPath), paths.dbPath);
  assert.equal(validateMainDatabase([main, { seq: 1, name: 'temp', file: '' }], paths.dbPath), paths.dbPath);
  for (const rows of [null, [], [{ ...main, name: 'other' }], [main, main], [{ ...main, file: '' }],
    [{ ...main, file: ':memory:' }], [{ ...main, file: 'relative.sqlite' }],
    [{ ...main, file: join(paths.root, 'second-brain.sqlite') }], [{ ...main, file: `${paths.dbPath}-other` }]]) {
    assert.throws(() => validateMainDatabase(rows, paths.dbPath), /PRAGMA database_list/);
  }
});

test('WORKER-05: normal yield waits for app.close and preserves the work result', async () => {
  const events = [];
  let finishClose;
  let settled = false;
  const closing = new Promise(resolve => { finishClose = resolve; });
  const teardown = {};
  const app = { async close() { events.push('closing'); await closing; events.push('closed'); } };
  const run = useAndClose(app, async () => { events.push('yield'); return 'result'; }, teardown).then(value => { settled = true; return value; });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ['yield', 'closing']);
  assert.equal(settled, false);
  finishClose();
  assert.equal(await run, 'result');
  assert.deepEqual(events, ['yield', 'closing', 'closed']);
  assert.deepEqual(teardown, { attempted: true, status: 'closed' });
});

for (const stage of ['database validation', 'listen conflict EADDRINUSE', 'preflight readiness', 'yield/test failure']) {
  test(`WORKER-05: ${stage} failure still awaits owned app.close`, async () => {
    const error = new Error(stage);
    const events = [];
    const teardown = {};
    const app = { async close() { await Promise.resolve(); events.push('closed'); } };
    await assert.rejects(useAndClose(app, async () => { events.push(stage); throw error; }, teardown), value => value === error);
    assert.deepEqual(events, [stage, 'closed']);
    assert.deepEqual(teardown, { attempted: true, status: 'closed' });
  });
}

test('WORKER-05: synchronous setup errors close, and teardown errors are surfaced', async () => {
  let closed = 0;
  await assert.rejects(useAndClose({ async close() { closed += 1; } }, () => { throw new Error('setup'); }), /setup/);
  assert.equal(closed, 1);
  const teardown = {};
  await assert.rejects(useAndClose({ async close() { throw new Error('close failed'); } }, async () => {}, teardown), /close failed/);
  assert.deepEqual(teardown, { attempted: true, status: 'failed', error: 'close failed' });
});

test('WORKER-06: no environment value or forged object is an owned-instance attestation', () => {
  for (const value of [undefined, null, true, 'BOTH-READY', {}, Object.freeze({ origin, verified: true }),
    { BASE_URL: origin, SECOND_BRAIN_E2E_ISOLATED: '1', SECOND_BRAIN_E2E_PARENT_READY: 'BOTH-READY' }]) {
    assert.equal(permitsSyntheticListing(value, origin), false);
    assert.equal(permitsSyntheticListing(value, 'http://127.0.0.1:18997'), false);
  }
});
