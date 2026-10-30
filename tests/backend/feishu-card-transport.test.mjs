import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuChannel, createFeishuTransport } from '../../server/feishu-channel.mjs';

async function transportFixture(overrides = {}) {
  const handlers = {}; const calls = []; let options;
  const channel = { on: (name, callback) => { handlers[name] = callback; }, connect: async () => {}, disconnect: async () => {},
    rawClient: { im: { v1: { message: {
      create: async value => { calls.push({ method: 'create', value }); return { code: 0, data: { message_id: 'om_card_created' } }; },
      patch: async value => { calls.push({ method: 'patch', value }); return { code: 0 }; }, ...overrides,
    } } } } };
  const actions = [];
  const transport = await createFeishuTransport({ appId: 'cli_synthetic', appSecret: 'synthetic-secret', apiBase: 'https://open.feishu.cn',
    onMessage() {}, onCardAction: event => { actions.push(event); return { toast: { type: 'success', content: 'Saved' } }; },
    onState() {}, onError() {}, loadSdk: async () => ({ Domain: { Feishu: 'feishu', Lark: 'lark' },
      createLarkChannel: value => { options = value; return channel; } }) });
  return { transport, calls, handlers, actions, options };
}

test('interactive creation preserves a stable UUID and explicit raw callback input', async () => {
  const f = await transportFixture();
  const card = { schema: '2.0', body: { elements: [] } };
  const result = await f.transport.send({ chatId: 'oc_self', card, text: 'fallback', uuid: 'synthetic-stable-id' });
  assert.equal(result.messageId, 'om_card_created'); assert.equal(f.options.includeRawEvent, true);
  assert.equal(f.calls[0].value.data.msg_type, 'interactive');
  assert.equal(f.calls[0].value.data.uuid, 'synthetic-stable-id'); assert.deepEqual(JSON.parse(f.calls[0].value.data.content), card);
  const event = { messageId: result.messageId, raw: { action: { form_value: { answer_text: 'Synthetic answer.' } } } };
  assert.equal(f.handlers.cardAction(event), undefined); assert.deepEqual(f.actions, [event]);
});

test('card updates patch the confirmed original message instead of creating another one', async () => {
  const f = await transportFixture(); const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'Saved' }] } };
  const result = await f.transport.send({ chatId: 'oc_self', card, updateMessageId: 'om_original', uuid: 'unused-for-patch' });
  assert.equal(result.messageId, 'om_original'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'patch');
  assert.deepEqual(f.calls[0].value, { path: { message_id: 'om_original' }, data: { content: JSON.stringify(card) } });
});

test('a rejected card update is a known failure and is never reported as saved', async () => {
  let calls = 0;
  const f = await transportFixture({ patch: async () => { calls++; return { code: 99991400 }; } });
  await assert.rejects(f.transport.send({ card: { schema: '2.0' }, updateMessageId: 'om_original' }),
    error => error.uncertain === false && error.code === 'RATE_LIMITED');
  assert.equal(calls, 1);
});

test('an interrupted update exposes no provider payload and does not perform an implicit retry', async () => {
  let calls = 0;
  const f = await transportFixture({ patch: async () => { calls++; throw new Error('PRIVATE_PROVIDER_PAYLOAD'); } });
  await assert.rejects(f.transport.send({ card: { schema: '2.0' }, updateMessageId: 'om_original' }),
    error => error.code === 'CONNECTION_UNAVAILABLE' && !error.message.includes('PRIVATE_PROVIDER_PAYLOAD'));
  assert.equal(calls, 1);
});

test('reconnected clients accept current card callbacks and reject late callbacks from the prior generation', async t => {
  const callbacks = []; const received = []; const errors = [];
  const chat = { config: () => ({ enabled: true }), public: () => ({ configured: true }), identity: () => 'same-identity',
    cards: { receive: (event, identity) => received.push({ event, identity }) }, tick() {}, drain: async () => {}, error: (...args) => errors.push(args) };
  const channel = new FeishuChannel(chat, { raw: () => ({ feishu: { appId: 'cli_synthetic', apiBase: 'https://open.feishu.cn' } }) },
    { get: () => 'synthetic-secret' }, { factory: async options => {
      callbacks.push(options); return { connect: async () => {}, disconnect: async () => {}, send: async () => ({ messageId: 'om_unused' }) };
    } });
  t.after(() => channel.stop()); channel.start(); await channel.wake();
  callbacks[0].onCardAction({ action: 'first' }); assert.equal(received.length, 1);
  await channel.reconnect(); assert.equal(callbacks.length, 2);
  callbacks[0].onCardAction({ action: 'late' }); assert.equal(received.length, 1);
  callbacks[1].onCardAction({ action: 'current' }); assert.equal(received.length, 2);
  assert.equal(errors.length, 0);
});
