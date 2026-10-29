import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { FeishuRegistration } from '../../server/feishu-registration.mjs';

const URL = 'https://accounts.feishu.cn/page/launcher?user_code=A%2FB&from=sdk&tag=one&tag=two';
const CREDENTIALS = { client_id: 'cli_new_app', client_secret: 'private-new-app-secret', user_info: { open_id: 'ou_private_owner', tenant_brand: 'feishu' } };

function deferred() {
  let resolve, reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function setup(t, options = {}) {
  const values = new Map([['feishu.appSecret', 'existing-private-secret']]);
  const secrets = { get: key => values.get(key) ?? '', set: (key, value) => values.set(key, value) };
  let saved = {
    revision: 1,
    model: { enabled: false, provider: 'openai-compatible', endpoint: null, model: null, allowExternalProcessing: false },
    feishu: { enabled: false, appId: null, apiBase: 'https://open.feishu.cn' },
    scheduler: { enabled: false, dailyPlanEnabled: false, dailyPlanLocalTime: '09:00' },
  };
  const writes = [];
  const settings = {
    raw: () => structuredClone(saved),
    update(body) {
      if (settings.saveError) throw settings.saveError;
      writes.push(structuredClone(body));
      const { appSecret, ...feishu } = body.feishu;
      secrets.set('feishu.appSecret', appSecret);
      saved = { revision: saved.revision + 1, model: body.model, scheduler: body.scheduler, feishu };
    },
  };
  const requests = [];
  const results = [];
  const factory = request => {
    requests.push(request);
    const result = deferred();
    results.push(result);
    return result.promise;
  };
  const registration = new FeishuRegistration(settings, secrets, { registerAppFactory: factory, ...options });
  t.after(() => registration.stop());
  return { registration, settings, secrets, writes, requests, results, change: update => { saved = update(saved); } };
}

async function start(fixture) {
  const snapshot = fixture.registration.start();
  await nextTurn();
  return snapshot;
}

async function qr(fixture, url = URL, expireIn = 600) {
  await fixture.requests.at(-1).onQRCodeReady({ url, expireIn });
  return fixture.registration.public();
}

function assertNoSensitive(value) {
  assert.doesNotMatch(JSON.stringify(value), /private-new-app-secret|existing-private-secret|ou_private_owner|private-error-token/);
}

// Requirement scenarios: normal registration, duplicates, exact QR URL, official domains,
// invalid inputs, SDK/save/callback failures, expiry, cancellation, late local edits,
// superseded sessions, non-blocking shutdown, runtime-only restart, and public redaction.
test('registration saves credentials while preserving the latest model and scheduler', async t => {
  let configured = 0;
  const f = setup(t, { onConfigured: () => { configured++; } });
  assert.equal((await start(f)).state, 'starting');
  const waiting = await qr(f);
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.url, URL);
  assert.match(waiting.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(Date.parse(waiting.expiresAt) > Date.now(), true);
  assertNoSensitive(waiting);
  const request = f.requests[0];
  assert.equal(request.createOnly, true);
  assert.deepEqual(request.appPreset, { name: '知行学习', desc: '个人目标学习与练习' });
  assert.deepEqual(request.addons, { preset: false, scopes: { tenant: ['im:message.p2p_msg:readonly', 'im:message:send_as_bot'] }, events: { items: { tenant: ['im.message.receive_v1'] } } });
  f.change(current => ({ ...current, model: { ...current.model, model: 'latest-model' }, scheduler: { ...current.scheduler, dailyPlanLocalTime: '11:30' } }));
  f.results[0].resolve(CREDENTIALS);
  await nextTurn();
  assert.equal(f.registration.public().state, 'complete');
  assert.equal(configured, 1);
  assert.equal(f.settings.raw().model.model, 'latest-model');
  assert.equal(f.settings.raw().scheduler.dailyPlanLocalTime, '11:30');
  assert.deepEqual(f.settings.raw().feishu, { enabled: true, appId: 'cli_new_app', apiBase: 'https://open.feishu.cn' });
  assert.equal(f.secrets.get('feishu.appSecret'), CREDENTIALS.client_secret);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(Object.keys(f.registration.public()).sort(), ['error', 'expiresAt', 'message', 'qrDataUrl', 'state', 'url']);
  assert.equal(f.registration.public().url, null);
  assert.equal(f.registration.public().qrDataUrl, null);
  assert.equal(f.registration.public().expiresAt, null);
  assertNoSensitive(f.registration.public());
});

test('official Open Platform launcher URLs from the registration service remain unchanged', async t => {
  for (const host of ['open.feishu.cn', 'open.larksuite.com']) {
    const f = setup(t); await start(f);
    const url = `https://${host}/page/launcher?user_code=FIXTURE&from=cli&createOnly=true`;
    await f.requests[0].onQRCodeReady({ url, expireIn: 600 });
    assert.equal(f.registration.public().url, url);
    assert.ok(f.registration.public().qrDataUrl.startsWith('data:image/png;base64,'));
    await f.registration.stop();
  }
});

test('duplicate starts share a pending registration before and after QR generation', async t => {
  const f = setup(t);
  f.registration.start(); f.registration.start();
  await nextTurn();
  assert.equal(f.requests.length, 1);
  await qr(f);
  assert.equal(f.registration.start().state, 'waiting');
  assert.equal(f.requests.length, 1);
});

test('Lark official QR URLs are accepted and use the corresponding API domain', async t => {
  const f = setup(t);
  await start(f);
  const url = 'https://accounts.larksuite.com/page/launcher?code=x%2Fy';
  assert.equal((await qr(f, url)).url, url);
  f.results[0].resolve({ ...CREDENTIALS, user_info: { tenant_brand: 'lark' } });
  await nextTurn();
  assert.equal(f.settings.raw().feishu.apiBase, 'https://open.larksuite.com');
});

test('QR validation rejects non-official hosts, insecure protocols, credentials and ports', async t => {
  for (const url of ['http://accounts.feishu.cn/page', 'https://accounts.feishu.cn.evil.test/page', 'https://evil.test/page', 'https://user:secret@accounts.feishu.cn/page', 'https://accounts.feishu.cn:8443/page', '//accounts.feishu.cn/page', `${URL}\n`]) {
    const f = setup(t);
    await start(f);
    const state = await qr(f, url);
    assert.equal(state.error.code, 'REGISTRATION_URL_INVALID');
    assert.equal(state.url, null);
    assert.equal(state.qrDataUrl, null);
    assert.equal(f.requests[0].signal.aborted, true);
    assert.equal(f.writes.length, 0);
  }
});

test('SDK failures have fixed friendly errors and clear all QR state', async t => {
  const scenarios = [['access_denied', 'REGISTRATION_DENIED'], ['expired_token', 'REGISTRATION_EXPIRED'], ['abort', 'REGISTRATION_CANCELLED'], ['ECONNRESET', 'REGISTRATION_NETWORK'], ['private-error-token', 'REGISTRATION_FAILED']];
  for (const [code, expected] of scenarios) {
    const f = setup(t);
    await start(f); await qr(f);
    f.results[0].reject(Object.assign(new Error('private-error-token'), { code, description: CREDENTIALS.client_secret }));
    await nextTurn();
    const state = f.registration.public();
    assert.equal(state.state, 'error');
    assert.equal(state.error.code, expected);
    assert.equal(state.error.retryable, true);
    assert.equal(state.url, null);
    assert.equal(state.qrDataUrl, null);
    assert.equal(state.expiresAt, null);
    assertNoSensitive(state);
    assert.equal(f.writes.length, 0);
  }
});

test('expiry aborts polling and refuses a late successful registration', async t => {
  let now = Date.parse('2026-10-29T00:00:00.000Z');
  const f = setup(t, { clock: () => now });
  await start(f); await qr(f, URL, 1);
  now += 1000;
  assert.equal(f.registration.public().error.code, 'REGISTRATION_EXPIRED');
  assert.equal(f.requests[0].signal.aborted, true);
  f.results[0].resolve(CREDENTIALS);
  await nextTurn();
  assert.equal(f.writes.length, 0);
  assert.equal(f.registration.public().qrDataUrl, null);
});

test('preparing the first QR times out after 30 seconds and allows a fresh attempt', async t => {
  let now = Date.parse('2026-10-29T00:00:00.000Z');
  const f = setup(t, { clock: () => now });
  await start(f);
  now += 29999;
  assert.equal(f.registration.public().state, 'starting');
  now++;
  const timedOut = f.registration.public();
  assert.equal(timedOut.state, 'error');
  assert.equal(timedOut.error.code, 'REGISTRATION_NETWORK');
  assert.equal(timedOut.error.retryable, true);
  assert.equal(timedOut.url, null);
  assert.equal(timedOut.qrDataUrl, null);
  assert.equal(timedOut.expiresAt, null);
  assert.equal(f.requests[0].signal.aborted, true);
  assertNoSensitive(timedOut);
  await start(f);
  assert.equal(f.requests.length, 2);
  await f.requests[0].onQRCodeReady({ url: URL, expireIn: 600 });
  f.results[0].resolve(CREDENTIALS);
  await nextTurn();
  assert.equal(f.registration.public().state, 'starting');
  assert.equal(f.writes.length, 0);
  await qr(f);
  now += 30000;
  assert.equal(f.registration.public().state, 'waiting');
});

test('a late first QR cannot revive preparation after its deadline without a status poll', async t => {
  let now = Date.parse('2026-10-29T00:00:00.000Z');
  const f = setup(t, { clock: () => now });
  await start(f);
  now += 30000;
  const state = await qr(f);
  assert.equal(state.state, 'error');
  assert.equal(state.error.code, 'REGISTRATION_NETWORK');
  assert.equal(state.qrDataUrl, null);
  assert.equal(f.requests[0].signal.aborted, true);
  f.results[0].resolve(CREDENTIALS);
  await nextTurn();
  assert.equal(f.writes.length, 0);
});

test('invalid expiration never publishes a QR or saves credentials', async t => {
  for (const expireIn of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const f = setup(t);
    await start(f);
    assert.equal((await qr(f, URL, expireIn)).error.code, 'REGISTRATION_EXPIRED');
    f.results[0].resolve(CREDENTIALS);
    await nextTurn();
    assert.equal(f.writes.length, 0);
  }
});

test('cancellation rejects late QR callbacks and credentials without touching existing config', async t => {
  const f = setup(t);
  const before = f.settings.raw();
  await start(f); await qr(f);
  const cancelled = f.registration.cancel();
  assert.equal(cancelled.state, 'idle');
  assert.equal(cancelled.error, null);
  assert.equal(cancelled.url, null);
  assert.equal(f.requests[0].signal.aborted, true);
  await f.requests[0].onQRCodeReady({ url: URL, expireIn: 600 });
  f.results[0].resolve(CREDENTIALS);
  await nextTurn();
  assert.deepEqual(f.settings.raw(), before);
  assert.equal(f.secrets.get('feishu.appSecret'), 'existing-private-secret');
  assert.equal(f.writes.length, 0);
  assert.equal(f.registration.public().state, 'idle');
});

test('changes to either local Feishu settings or secret reject late credentials', async t => {
  for (const change of ['config', 'secret']) {
    const f = setup(t);
    await start(f); await qr(f);
    if (change === 'config') f.change(current => ({ ...current, feishu: { ...current.feishu, appId: 'cli_manual' } }));
    else f.secrets.set('feishu.appSecret', 'new-manual-secret');
    const before = f.settings.raw();
    f.results[0].resolve(CREDENTIALS);
    await nextTurn();
    assert.equal(f.registration.public().error.code, 'REGISTRATION_CONFIG_CHANGED');
    assert.deepEqual(f.settings.raw(), before);
    assert.equal(f.writes.length, 0);
    assert.equal(f.secrets.get('feishu.appSecret'), change === 'secret' ? 'new-manual-secret' : 'existing-private-secret');
  }
});

test('an old cancelled session cannot replace a newly started session', async t => {
  const f = setup(t);
  await start(f); await qr(f);
  f.registration.cancel();
  await start(f); await qr(f);
  f.results[0].resolve({ ...CREDENTIALS, client_id: 'cli_obsolete' });
  await nextTurn();
  assert.equal(f.registration.public().state, 'waiting');
  assert.equal(f.writes.length, 0);
  f.results[1].resolve(CREDENTIALS);
  await nextTurn();
  assert.equal(f.settings.raw().feishu.appId, CREDENTIALS.client_id);
});

test('stop completes even when the SDK factory ignores abort forever', { timeout: 1000 }, async t => {
  const f = setup(t);
  await start(f);
  await f.registration.stop();
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.registration.public().state, 'idle');
});

test('invalid credentials and storage failures are reported without exposing sensitive data', async t => {
  for (const scenario of ['invalid', 'storage']) {
    const f = setup(t);
    await start(f); await qr(f);
    if (scenario === 'storage') f.settings.saveError = new Error('private-error-token');
    f.results[0].resolve(scenario === 'invalid' ? { client_id: '', client_secret: CREDENTIALS.client_secret } : CREDENTIALS);
    await nextTurn();
    const state = f.registration.public();
    assert.equal(state.error.code, scenario === 'invalid' ? 'REGISTRATION_RESPONSE_INVALID' : 'REGISTRATION_SAVE_FAILED');
    assert.equal(f.writes.length, 0);
    assertNoSensitive(state);
  }
});

test('connection callback failures do not invalidate credentials already saved', async t => {
  const f = setup(t, { onConfigured: async () => { throw new Error('private-error-token'); } });
  await start(f); await qr(f);
  f.results[0].resolve(CREDENTIALS);
  await nextTurn();
  assert.equal(f.registration.public().state, 'complete');
  assert.equal(f.writes.length, 1);
  assertNoSensitive(f.registration.public());
});

test('new instances start idle and public snapshots cannot alter runtime state', async t => {
  const f = setup(t);
  await start(f); await qr(f);
  const snapshot = f.registration.public();
  snapshot.url = 'https://evil.test'; snapshot.state = 'complete';
  assert.equal(f.registration.public().state, 'waiting');
  assert.equal(f.registration.public().url, URL);
  const restarted = new FeishuRegistration(f.settings, f.secrets, { registerAppFactory: () => new Promise(() => {}) });
  assert.equal(restarted.public().state, 'idle');
  assert.equal(restarted.public().qrDataUrl, null);
  assertNoSensitive(restarted.public());
  await restarted.stop();
});
