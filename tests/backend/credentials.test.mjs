import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { appFor, scratch, removeScratch, ok, request, fakeSiyuan, settings } from './helpers.mjs';

const childFixture = fileURLToPath(new URL('./fixtures/credential-child.mjs', import.meta.url));
const windowsOnly = { skip: process.platform !== 'win32' };

for (const mode of ['default-path', 'git-path', 'poisoned-path', 'missing-tool', 'owner-error', 'acl-error', 'verify-error', 'acl-error-temp', 'verify-error-temp']) {
  test(`Windows credentials use real trusted tools and fail closed: ${mode}`, windowsOnly, t => {
    const root = scratch(); t.after(() => removeScratch(root));
    const env = { ...process.env };
    if (mode === 'git-path') {
      const git = [resolve(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin'), 'C:/Program Files/Git/mingw64/bin'].find(path => existsSync(path));
      assert.ok(git, 'Git PATH fixture requires an installed Git tool directory.');
      env.PATH = git + delimiter + env.PATH;
    }
    if (mode === 'poisoned-path') {
      const poison = resolve(root, 'poison'); mkdirSync(poison);
      for (const tool of ['whoami', 'icacls', 'powershell']) {
        writeFileSync(resolve(poison, tool + '.exe'), 'poisoned executable must never be selected');
        writeFileSync(resolve(poison, tool + '.cmd'), '@echo poison > "' + resolve(root, 'poison-invoked') + '"\r\nexit /b 1\r\n');
      }
      env.PATH = poison + delimiter + env.PATH;
    }
    const result = JSON.parse(execFileSync(process.execPath, [childFixture, root, mode], { env, encoding: 'utf8', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.equal(result.status, result.shouldFail ? 500 : 200);
    for (const key of ['memoryRetained', 'diskRetained', 'noEcho', 'onlyTrustedTools', 'realSeedCalls', 'realAclWrites', 'temporaryRemoved', 'poisonMarkerAbsent']) assert.equal(result[key], true, key);
  });
}

async function configure(app, values) {
  const current = (await ok(app, 'GET', '/connections')).items.find(item => item.kind === 'siyuan');
  return ok(app, 'PUT', '/connections/siyuan', { expectedRevision: current.revision, useRuntimeConnection: false,
    baseUrl: 'http://127.0.0.1:6806', notebookTitle: 'mode test', ...values });
}

test('runtime and manual endpoints select only their own tokens, including identical URLs and omitted/null/empty credentials', async t => {
  const upstream = await fakeSiyuan(t); const other = await fakeSiyuan(t);
  const root = scratch(); const runtime = resolve(root, 'runtime'); mkdirSync(runtime);
  const tokenFile = resolve(runtime, 'token.txt'); const manifest = resolve(runtime, 'connection.json');
  writeFileSync(tokenFile, 'synthetic-runtime-token');
  writeFileSync(manifest, JSON.stringify({ baseUrl: upstream.origin, tokenFile: 'token.txt' }));
  const app = await appFor(t, { root });
  const check = async (server, expected) => {
    await ok(app, 'POST', '/connections/siyuan/check', {});
    assert.ok(server.calls.at(-1).headers.authorization === `Token ${expected}`.trim());
  };
  await check(upstream, 'synthetic-runtime-token');
  await configure(app, { baseUrl: upstream.origin, token: 'synthetic-manual-token' });
  await check(upstream, 'synthetic-manual-token');
  await configure(app, { useRuntimeConnection: true, baseUrl: null });
  await check(upstream, 'synthetic-runtime-token');
  await configure(app, { baseUrl: upstream.origin });
  await check(upstream, 'synthetic-manual-token');
  await configure(app, { baseUrl: upstream.origin, token: null });
  await check(upstream, '');
  const connection = (await ok(app, 'GET', '/connections')).items.find(item => item.kind === 'siyuan');
  const invalid = await request(app, 'PUT', '/connections/siyuan', { expectedRevision: connection.revision,
    useRuntimeConnection: false, baseUrl: upstream.origin, notebookTitle: 'mode test', token: '' });
  assert.equal(invalid.status, 422); assert.equal(app.settings.siyuanToken(), '');
  await configure(app, { baseUrl: other.origin, token: 'synthetic-other-manual' });
  await check(other, 'synthetic-other-manual');
  await configure(app, { useRuntimeConnection: true, baseUrl: null });
  await check(upstream, 'synthetic-runtime-token');
  await configure(app, { baseUrl: other.origin });
  await check(other, 'synthetic-other-manual');
  const publicText = JSON.stringify(await ok(app, 'GET', '/connections')) + (await ok(app, 'POST', '/exports', { scope: 'all', projectIds: [] })).content;
  for (const value of ['synthetic-runtime-token', 'synthetic-manual-token', 'synthetic-other-manual', 'token.txt', tokenFile]) assert.ok(!publicText.includes(value));
});

test('missing/invalid runtime manifests and invalid runtime tokens clear the effective endpoint and token before a request', async t => {
  const upstream = await fakeSiyuan(t); const root = scratch(); const runtime = resolve(root, 'runtime'); mkdirSync(runtime);
  const token = resolve(runtime, 'token.txt'); const manifest = resolve(runtime, 'connection.json');
  const restore = () => { writeFileSync(token, 'synthetic-runtime-token'); writeFileSync(manifest, JSON.stringify({ baseUrl: upstream.origin, tokenFile: 'token.txt' })); };
  restore(); const app = await appFor(t, { root });
  app.secrets.set('siyuan.token', 'synthetic-unrelated-manual');
  for (const corrupt of [() => unlinkSync(manifest), () => writeFileSync(manifest, '{invalid'),
    () => writeFileSync(manifest, JSON.stringify({ baseUrl: 'https://untrusted.example', tokenFile: 'token.txt' })), () => writeFileSync(token, '')]) {
    restore(); assert.ok(app.settings.siyuanToken() === 'synthetic-runtime-token');
    corrupt();
    await assert.rejects(app.siyuan.call('/api/system/version'), error => error.code === 'CONNECTION_UNAVAILABLE');
    assert.equal(app.settings.siyuan().baseUrl, null); assert.equal(app.settings.siyuanToken(), '');
    assert.equal(app.secrets.get('siyuan.runtimeToken'), ''); assert.equal(app.settings.siyuan().runtimeBaseUrl, null);
  }
  assert.equal(upstream.calls.length, 0);
});

test('model and Feishu credential updates retain omitted values, remove null, and reject empty strings without echo', async t => {
  const app = await appFor(t);
  await settings(app, { model: { apiKey: 'synthetic-model-key' }, feishu: { appSecret: 'synthetic-feishu-secret' } });
  await settings(app);
  assert.ok(app.secrets.get('model.apiKey') === 'synthetic-model-key'); assert.ok(app.secrets.get('feishu.appSecret') === 'synthetic-feishu-secret');
  for (const [kind, key] of [['model', 'apiKey'], ['feishu', 'appSecret']]) {
    const current = await ok(app, 'GET', '/settings');
    const raw = app.settings.raw();
    const result = await request(app, 'PUT', '/settings', { expectedRevision: current.revision, model: raw.model, feishu: raw.feishu, scheduler: raw.scheduler, [kind]: { ...raw[kind], [key]: '' } });
    assert.equal(result.status, 422);
  }
  await settings(app, { model: { apiKey: null }, feishu: { appSecret: null } });
  assert.equal(app.secrets.get('model.apiKey'), ''); assert.equal(app.secrets.get('feishu.appSecret'), '');
});

test('a SiYuan request uses one runtime endpoint/token snapshot when the manifest changes between reads', async t => {
  const first = await fakeSiyuan(t); const second = await fakeSiyuan(t);
  const root = scratch(); const runtime = resolve(root, 'runtime'); mkdirSync(runtime);
  const manifest = resolve(runtime, 'connection.json');
  writeFileSync(resolve(runtime, 'a.txt'), 'synthetic-runtime-a'); writeFileSync(resolve(runtime, 'b.txt'), 'synthetic-runtime-b');
  writeFileSync(manifest, JSON.stringify({ baseUrl: first.origin, tokenFile: 'a.txt' }));
  const app = await appFor(t, { root });
  const readConnection = app.settings.siyuan.bind(app.settings); let switched = false;
  app.settings.siyuan = () => {
    const snapshot = readConnection();
    if (!switched) { switched = true; writeFileSync(manifest, JSON.stringify({ baseUrl: second.origin, tokenFile: 'b.txt' })); }
    return snapshot;
  };
  await app.siyuan.call('/api/system/version');
  assert.equal(first.calls.length, 1); assert.equal(second.calls.length, 0);
  assert.ok(first.calls[0].headers.authorization === 'Token synthetic-runtime-a');
  app.settings.siyuan = readConnection;
  await app.siyuan.call('/api/system/version');
  assert.ok(second.calls[0].headers.authorization === 'Token synthetic-runtime-b');
});
