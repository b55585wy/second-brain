import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexRpc, READ_ONLY_METHODS } from '../../server/codex-rpc.mjs';
import { appFor, ok, scope, jobDone, scratch, removeScratch } from './helpers.mjs';

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-codex.mjs');
const userAgent = version => `second_brain/${version} (Windows 10.0.22631; x86_64) Tabby (second_brain; 0.0.0)`;

function fakeEnvironment(root, initialization) {
  const values = { SECOND_BRAIN_FAKE_RPC_MODE: 'modern', SECOND_BRAIN_FAKE_RPC_LOG: resolve(root, 'rpc.log'),
    SECOND_BRAIN_FAKE_PROJECT: root, SECOND_BRAIN_FAKE_INITIALIZE: JSON.stringify(initialization) };
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  return {
    log: () => readFileSync(values.SECOND_BRAIN_FAKE_RPC_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    restore() {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

const cases = [
  ['actual 0.164.0 agent', { userAgent: userAgent('0.164.0') }, true],
  ['actual 0.165.0 agent', { userAgent: userAgent('0.165.0') }, true],
  ['legacy 0.164.0 agent', { userAgent: 'codex-cli 0.164.0' }, true],
  ['bare 0.164.0 serverInfo fallback', { serverInfo: { version: '0.164.0' } }, true],
  ['bare 0.165.0 serverInfo fallback', { serverInfo: { version: '0.165.0' } }, true],
  ['unknown 0.166.0 agent', { userAgent: userAgent('0.166.0') }, false],
  ['unknown 9.9.9 agent', { userAgent: userAgent('9.9.9') }, false],
  ['extra version component', { userAgent: userAgent('0.165.0.1') }, false],
  ['build suffix', { userAgent: userAgent('0.165.0+build') }, false],
  ['prerelease suffix', { userAgent: userAgent('0.165.0-beta') }, false],
  ['legacy prerelease suffix', { userAgent: 'codex-cli 0.164.0-beta' }, false],
  ['lookalike major version', { userAgent: userAgent('10.165.0') }, false],
  ['lookalike version prefix', { userAgent: userAgent('x0.165.0') }, false],
  ['lookalike version suffix', { userAgent: userAgent('0.165.0evil') }, false],
  ['supported version only in trailing client token', { userAgent: 'second_brain/9.9.9 (Windows) Tabby (second_brain; 0.165.0)' }, false],
  ['supported legacy version only in trailing client token', { userAgent: 'second_brain/0.166.0 (Windows) Tabby (second_brain; 0.164.0)' }, false],
  ['unknown agent cannot use another serverInfo version', { userAgent: userAgent('9.9.9'), serverInfo: { version: '0.165.0' } }, false],
  ['explicit boolean capability on unknown release', { userAgent: userAgent('9.9.9'), capabilities: { useStateDbOnly: true } }, true],
  ['false capability on unknown release', { userAgent: userAgent('9.9.9'), capabilities: { useStateDbOnly: false } }, false],
  ['string true capability on unknown release', { userAgent: userAgent('9.9.9'), capabilities: { useStateDbOnly: 'true' } }, false],
];

for (const [label, initialization, verified] of cases) {
  test(`initialization-only state-DB capability gate: ${label}`, async t => {
    const root = scratch();
    const environment = fakeEnvironment(root, initialization);
    const rpc = new CodexRpc({ cliPath: fixture, root });
    t.after(async () => {
      try { await rpc.close(); }
      finally { environment.restore(); removeScratch(root); }
    });
    await rpc.start();
    assert.equal(rpc.verifiedStateDbOnly, verified);
    await rpc.close();
    const entries = environment.log();
    const methods = entries.filter(entry => entry.method).map(entry => entry.method);
    assert.equal(methods.filter(method => method === 'initialize').length, 1);
    assert.ok(methods.every(method => ['initialize', 'initialized'].includes(method)));
    assert.deepEqual(entries.filter(entry => entry.startupArgs).map(entry => entry.startupArgs), [['app-server', '-c', 'mcp_servers={}', '--listen', 'stdio://']]);
  });
}

test('actual 0.165.0 agent supports metadata discovery and saved selected-thread sync only', async t => {
  const root = scratch();
  const environment = fakeEnvironment(root, { userAgent: userAgent('0.165.0'), capabilities: {} });
  t.after(() => environment.restore());
  const app = await appFor(t, { root, collectorOptions: { cliPath: fixture, days: 7, maxThreads: 20, pageSize: 20, maxPages: 20 } });
  const discovery = await ok(app, 'GET', '/codex/discovery');
  assert.deepEqual(discovery.items.map(item => [item.id, item.allowed]), [['thread-one', false], ['thread-two', false], ['thread-three', false]]);
  assert.ok(environment.log().every(entry => !['thread/items/list', 'thread/turns/list', 'thread/read'].includes(entry.method)));
  await scope(app, { enabled: true, allowedThreadIds: ['thread-one'] });
  const result = await jobDone(app, await ok(app, 'POST', '/codex/sync', { threadIds: ['thread-one'] }, 202));
  assert.equal(result.result.sourcesCreated, 2);
  const entries = environment.log();
  const lists = entries.filter(entry => entry.method === 'thread/list');
  assert.ok(lists.length > 0); assert.ok(lists.every(entry => entry.params.useStateDbOnly === true));
  assert.ok(entries.filter(entry => entry.method).every(entry => READ_ONLY_METHODS.has(entry.method) || entry.method === 'initialized'));
  const bodyReads = entries.filter(entry => ['thread/items/list', 'thread/turns/list', 'thread/read'].includes(entry.method));
  assert.ok(bodyReads.length > 0); assert.ok(bodyReads.every(entry => entry.params.threadId === 'thread-one'));
  assert.deepEqual([...new Set(app.store.all('source').map(source => source.threadId))], ['thread-one']);
});
