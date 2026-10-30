import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFeishuProxy, installFeishuNetwork } from '../../server/feishu-network.mjs';
import { scratch, removeScratch, appFor } from './helpers.mjs';

function fixture(t, config) {
  const root = scratch(); t.after(() => removeScratch(root));
  const directory = resolve(root, 'runtime'); mkdirSync(directory);
  if (config !== undefined) writeFileSync(resolve(directory, 'feishu-network.json'), typeof config === 'string' ? config : JSON.stringify(config));
  const callbacks = []; const ejected = []; const warnings = [];
  const http = { interceptors: { request: { use: fn => { callbacks.push(fn); return callbacks.length; }, eject: key => ejected.push(key) } } };
  return { root, callbacks, ejected, warnings, install: () => installFeishuNetwork(root, { http, warn: message => warnings.push(message) }) };
}

for (const [url, host, port] of [
  ['http://127.0.0.1:1', '127.0.0.1', 1], ['http://127.0.0.1:80', '127.0.0.1', 80],
  ['http://127.0.0.1:7897', '127.0.0.1', 7897], ['http://[::1]:65535', '::1', 65535],
]) test(`explicit local proxy accepts the loopback endpoint ${url}`, () => {
  assert.deepEqual(parseFeishuProxy({ proxyUrl: url }), { protocol: 'http', host, port });
});

for (const value of [null, [], {}, { proxyUrl: '' }, { proxyUrl: ' http://127.0.0.1:7897' },
  { proxyUrl: 'http://127.0.0.1:65536' }, { proxyUrl: 'https://127.0.0.1:7897' },
  { proxyUrl: 'http://remote.example:7897' }, { proxyUrl: 'http://127.0.0.1.evil.example:7897' },
  { proxyUrl: 'http://user:synthetic-secret@127.0.0.1:7897' }, { proxyUrl: 'http://127.0.0.1:7897/path' },
  { proxyUrl: 'http://127.0.0.1:7897?x=1' }, { proxyUrl: 'http://127.0.0.1:7897#x' },
  { proxyUrl: 'http://127.0.0.1:7897', disableTls: true },
]) test(`invalid or external proxy settings are rejected: ${JSON.stringify(value)}`, () => {
  assert.throws(() => parseFeishuProxy(value));
});

test('missing local configuration preserves the SDK defaults without a warning or network action', t => {
  const f = fixture(t); const cleanup = f.install(); cleanup();
  assert.deepEqual(f.callbacks, []); assert.deepEqual(f.ejected, []); assert.deepEqual(f.warnings, []);
});

test('scoped local proxy applies only to official Feishu HTTPS and preserves other request fields', t => {
  const f = fixture(t, { proxyUrl: 'http://127.0.0.1:7897' }); const cleanup = f.install();
  for (const host of ['open.feishu.cn', 'accounts.feishu.cn', 'open.larksuite.com', 'accounts.larksuite.com']) {
    const config = { url: `https://${host}/open-apis/test`, timeout: 30000, headers: { Authorization: 'synthetic-only' }, httpsAgent: 'unchanged' };
    const before = structuredClone(config); const routed = f.callbacks[0](config);
    assert.deepEqual(config, before); assert.deepEqual(routed.proxy, { protocol: 'http', host: '127.0.0.1', port: 7897 });
    assert.equal(routed.timeout, 15000); assert.equal(routed.headers, config.headers); assert.equal(routed.httpsAgent, config.httpsAgent);
    assert.equal(routed.retry, undefined);
  }
  const relative = f.callbacks[0]({ baseURL: 'https://open.feishu.cn', url: '/open-apis/test', timeout: 1000 });
  assert.equal(relative.timeout, 1000); assert.equal(relative.proxy.port, 7897);
  cleanup(); cleanup(); assert.deepEqual(f.ejected, [1]);
});

test('model endpoints, localhost, lookalike hosts, HTTP, and malformed URLs retain the exact original object', t => {
  const f = fixture(t, { proxyUrl: 'http://127.0.0.1:7897' }); const cleanup = f.install();
  for (const url of ['https://api.deepseek.com/v1', 'http://127.0.0.1:19006/api', 'https://open.feishu.cn.evil.example/', 'http://open.feishu.cn/', 'not-a-url']) {
    const config = { url, proxy: false }; assert.equal(f.callbacks[0](config), config);
  }
  cleanup();
});

for (const config of ['{broken', { proxyUrl: 'http://user:synthetic-secret@127.0.0.1:7897' }, 'x'.repeat(4097)]) {
  test('bad local files warn without exposing content or preventing local application startup', t => {
    const f = fixture(t, config); const cleanup = f.install(); cleanup();
    assert.equal(f.callbacks.length, 0); assert.equal(f.warnings.length, 1);
    assert.ok(!f.warnings[0].includes('synthetic-secret')); assert.ok(!f.warnings[0].includes('broken'));
    assert.ok(f.warnings[0].includes('local learning remains available'));
  });
}

test('application shutdown releases the SDK interceptor and remaining resources even if collector shutdown fails', async t => {
  const root = scratch(); mkdirSync(resolve(root, 'runtime'));
  writeFileSync(resolve(root, 'runtime/feishu-network.json'), JSON.stringify({ proxyUrl: 'http://127.0.0.1:7897' }));
  const ejected = [];
  const http = { interceptors: { request: { use: () => 77, eject: value => ejected.push(value) } } };
  const app = await appFor(t, { root, feishuNetworkOptions: { http } });
  app.collector.close = async () => { throw new Error('Synthetic collector shutdown failure'); };
  await assert.rejects(app.close(), /Synthetic collector shutdown failure/);
  assert.deepEqual(ejected, [77]); assert.equal(app.server.listening, false); assert.equal(app.jobs.stopped, true);
  assert.throws(() => app.store.all('job'));
  await app.close(); assert.deepEqual(ejected, [77]);
});
