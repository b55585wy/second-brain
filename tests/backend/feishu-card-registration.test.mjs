import test from 'node:test';
import assert from 'node:assert/strict';
import { appFor, ok, profile, settings } from './helpers.mjs';

async function fixture(t) {
  const state = { options: null, resolve: null, calls: 0 };
  const app = await appFor(t, { feishuCardRegistrationOptions: { registerAppFactory: async options => {
    state.calls++; state.options = options;
    await options.onQRCodeReady({ url: 'https://open.feishu.cn/page/launcher?user_code=SYNTHETIC_CARDS', expireIn: 600 });
    return new Promise(resolve => { state.resolve = resolve; });
  } } });
  await settings(app, { feishu: { enabled: true, appId: 'cli_current_cards', appSecret: 'synthetic-existing-card-secret' } });
  app.feishuChat.update({ enabled: true, reminderLocalTime: '12:00' });
  return { app, state };
}

async function waitState(f, expected) {
  const end = Date.now() + 5000;
  for (;;) {
    const view = await ok(f.app, 'GET', '/feishu-chat/cards/registration');
    if (view.state === expected) return view;
    if (Date.now() > end) assert.fail('Synthetic card authorization did not reach ' + expected);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const receipt = () => ({ client_id: 'cli_current_cards', client_secret: 'synthetic-existing-card-secret' });

test('card authorization is an explicit existing-app QR upgrade and preserves credentials, scope and reminders', async t => {
  const f = await fixture(t); const settingsBefore = f.app.settings.raw(); const scope = f.app.collector.publicScope();
  await ok(f.app, 'GET', '/feishu-chat/cards/registration'); assert.equal(f.state.calls, 0);
  await ok(f.app, 'POST', '/feishu-chat/cards/registration', {});
  const waiting = await waitState(f, 'waiting');
  assert.ok(waiting.qrDataUrl.startsWith('data:image/png;base64,'));
  assert.equal(f.state.options.appId, 'cli_current_cards'); assert.equal(f.state.options.createOnly, undefined);
  assert.deepEqual(f.state.options.addons.callbacks, { items: ['card.action.trigger'] });
  assert.deepEqual(f.state.options.addons.scopes.tenant, ['im:message.p2p_msg:readonly', 'im:message:send_as_bot']);
  const pair = f.app.feishuChat.pair();
  f.app.feishuChat.receive({ messageId: 'om_pair_before_cards', chatId: 'oc_owner', senderId: 'ou_owner', chatType: 'p2p',
    senderType: 'user', content: '绑定 ' + pair.code });
  const binding = f.app.store.get('feishu-chat-binding', 'main');
  f.state.resolve(receipt()); await waitState(f, 'complete');
  assert.deepEqual(f.app.settings.raw(), settingsBefore); assert.deepEqual(f.app.collector.publicScope(), scope);
  assert.deepEqual(f.app.store.get('feishu-chat-binding', 'main'), binding);
  assert.equal(f.app.feishuChat.config().cardsEnabled, true); assert.equal(f.app.feishuChat.config().reminderLocalTime, '12:00');
  assert.equal(f.app.feishuChat.public().lastCardActionAt, null);
});

for (const [label, mutate, code] of [
  ['another app', value => { value.client_id = 'cli_other_app'; }, 'REGISTRATION_RESPONSE_INVALID'],
  ['changed secret', value => { value.client_secret = 'synthetic-rotated-secret'; }, 'REGISTRATION_SECRET_CHANGED'],
]) {
  test(`${label} authorization receipt is rejected without changing the active bot`, async t => {
    const f = await fixture(t); const before = f.app.settings.raw();
    await ok(f.app, 'POST', '/feishu-chat/cards/registration', {}); await waitState(f, 'waiting');
    const result = receipt(); mutate(result); f.state.resolve(result);
    const failed = await waitState(f, 'error'); assert.equal(failed.error.code, code);
    assert.deepEqual(f.app.settings.raw(), before); assert.equal(f.app.feishuChat.config().cardsEnabled, false);
    assert.ok(!JSON.stringify(failed).includes('synthetic-rotated-secret'));
  });
}

test('card authorization never creates a new application when no bot is configured', async t => {
  let calls = 0;
  const app = await appFor(t, { feishuCardRegistrationOptions: { registerAppFactory: async () => { calls++; throw new Error('Must not create an app'); } } });
  const result = await ok(app, 'POST', '/feishu-chat/cards/registration', {});
  assert.equal(result.state, 'error'); assert.equal(result.error.code, 'REGISTRATION_APP_REQUIRED'); assert.equal(calls, 0);
});

test('explicitly disabling cards during QR authorization wins over the late successful receipt', async t => {
  const f = await fixture(t); await ok(f.app, 'POST', '/feishu-chat/cards/registration', {}); await waitState(f, 'waiting');
  const chat = await ok(f.app, 'GET', '/feishu-chat');
  await ok(f.app, 'PUT', '/feishu-chat', { enabled: true, remindersEnabled: true, reminderLocalTime: '12:00', cardsEnabled: false, expectedRevision: chat.revision });
  f.state.resolve(receipt()); await waitState(f, 'complete'); assert.equal(f.app.feishuChat.config().cardsEnabled, false);
});

test('changing reminder time during card authorization preserves the new time and still enables the requested cards', async t => {
  const f = await fixture(t); await ok(f.app, 'POST', '/feishu-chat/cards/registration', {}); await waitState(f, 'waiting');
  const chat = await ok(f.app, 'GET', '/feishu-chat');
  await ok(f.app, 'PUT', '/feishu-chat', { enabled: true, remindersEnabled: true, reminderLocalTime: '18:00', expectedRevision: chat.revision });
  f.state.resolve(receipt()); await waitState(f, 'complete');
  assert.equal(f.app.feishuChat.config().cardsEnabled, true); assert.equal(f.app.feishuChat.config().reminderLocalTime, '18:00');
});

test('cancelling a QR flow rejects its late receipt and never enables cards', async t => {
  const f = await fixture(t); await profile(f.app, { goals: ['Synthetic card goal'] });
  await ok(f.app, 'POST', '/feishu-chat/cards/registration', {}); await waitState(f, 'waiting');
  await ok(f.app, 'POST', '/feishu-chat/cards/registration/cancel', {});
  f.state.resolve(receipt()); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.app.feishuCardRegistration.public().state, 'idle'); assert.equal(f.app.feishuChat.config().cardsEnabled, false);
});
