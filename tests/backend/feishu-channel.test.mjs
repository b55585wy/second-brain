import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuChannel, channelError, createFeishuTransport } from '../../server/feishu-channel.mjs';

function fixture({ failure = false } = {}) {
  const config = { enabled: false }; const state = { configured: true, identity: 'first', factoryCalls: 0, connects: 0, disconnects: 0, ticks: 0, received: [], sends: [] };
  const chat = { config: () => config, public: () => state, identity: () => state.identity,
    tick: () => { state.ticks++; }, receive: (...args) => state.received.push(args),
    drain: async send => { if (state.outbound) { const result = await send(state.outbound); state.sends.push(result); state.outbound = null; } } };
  const clients = []; const clock = { now: 0 };
  const driver = new FeishuChannel(chat, { raw: () => ({ feishu: { enabled: true, appId: 'cli_fixture', apiBase: 'https://open.feishu.cn' } }) }, { get: () => 'fixture-secret' }, {
    clock: () => new Date(clock.now), factory: async options => {
      state.factoryCalls++; const client = { options,
        connect: async () => { state.connects++; if (failure) throw new Error('credential=fixture-secret'); },
        disconnect: async () => { state.disconnects++; }, send: async input => ({ messageId: 'om_' + input.uuid }) };
      clients.push(client); return client;
    },
  });
  return { config, state, driver, clients, clock };
}

test('disabled and unconfigured channels do not construct or contact an SDK client', async () => {
  const f = fixture(); f.driver.start(); await f.driver.wake();
  assert.equal(f.driver.public().state, 'off'); assert.equal(f.state.factoryCalls, 0);
  f.config.enabled = true; f.state.configured = false; await f.driver.wake();
  assert.equal(f.driver.public().state, 'setup'); assert.equal(f.state.factoryCalls, 0); await f.driver.stop();
});

test('configured channel receives only its current identity and drains stable send identifiers', async () => {
  const f = fixture(); f.config.enabled = true;
  f.state.outbound = { chatId: 'oc_fixture', text: '今日练习', uuid: 'stable-id' };
  f.driver.start(); await f.driver.wake();
  assert.equal(f.driver.public().state, 'connected'); assert.equal(f.state.factoryCalls, 1);
  assert.deepEqual(f.state.sends, [{ messageId: 'om_stable-id' }]);
  f.clients[0].options.onMessage({ messageId: 'om_receive' }); await f.driver.wake();
  assert.deepEqual(f.state.received[0], [{ messageId: 'om_receive' }, 'first']);
  f.config.enabled = false; f.clients[0].options.onMessage({ messageId: 'om_ignored' }); await f.driver.wake();
  assert.equal(f.state.received.length, 1); assert.equal(f.state.disconnects, 1); await f.driver.stop();
});

test('changed application disconnects its old transport and rejects late events', async () => {
  const f = fixture(); f.config.enabled = true; f.driver.start(); await f.driver.wake();
  f.state.identity = 'second'; await f.driver.wake();
  assert.equal(f.state.factoryCalls, 2); assert.equal(f.state.disconnects, 1);
  f.clients[0].options.onMessage({ messageId: 'om_old' }); f.clients[1].options.onMessage({ messageId: 'om_new' });
  await f.driver.wake(); assert.deepEqual(f.state.received, [[{ messageId: 'om_new' }, 'second']]); await f.driver.stop();
});

test('connection failures expose no upstream details and use a bounded reconnect delay', async () => {
  const f = fixture({ failure: true }); f.config.enabled = true; f.driver.start(); await f.driver.wake();
  assert.equal(f.driver.public().state, 'error'); assert.ok(!JSON.stringify(f.driver.public()).includes('fixture-secret'));
  await f.driver.wake(); assert.equal(f.state.factoryCalls, 1);
  f.clock.now = 60000; await f.driver.wake(); assert.equal(f.state.factoryCalls, 2); await f.driver.stop();
});

test('reconnecting transports defer delivery and concurrent wakes share one operation', async () => {
  const f = fixture(); f.config.enabled = true; f.driver.start(); await f.driver.wake();
  f.clients[0].options.onState('connecting'); f.state.outbound = { uuid: 'later' };
  await Promise.all([f.driver.wake(), f.driver.wake()]); assert.equal(f.state.sends.length, 0);
  f.clients[0].options.onState('connected'); await f.driver.wake(); assert.equal(f.state.sends.length, 1);
  await f.driver.stop(); assert.equal(f.driver.public().state, 'off');
  await f.driver.wake(); assert.equal(f.state.factoryCalls, 1);
});

test('permission, rate-limit and unknown SDK errors have bounded public explanations', () => {
  assert.equal(channelError({ code: 99991679 }).code, 'SCOPE_FORBIDDEN');
  const rate = channelError({ code: 99991400 }); assert.equal(rate.retryable, true); assert.equal(rate.uncertain, false);
  const unknown = channelError(new Error('private payload')); assert.equal(unknown.code, 'CONNECTION_UNAVAILABLE');
  assert.equal(unknown.uncertain, undefined); assert.ok(!unknown.message.includes('private payload'));
});

test('late callbacks from a replaced transport cannot alter a new transport with the same credentials', async () => {
  const f = fixture(); f.config.enabled = true; f.driver.start(); await f.driver.wake();
  f.clients[0].options.onError(new Error('connection lost')); f.clock.now = 60000; await f.driver.wake();
  assert.equal(f.state.factoryCalls, 2); assert.equal(f.driver.public().state, 'connected');
  f.clients[0].options.onState('connecting'); f.clients[0].options.onError(new Error('late error'));
  f.clients[0].options.onMessage({ messageId: 'old_event' });
  assert.equal(f.driver.public().state, 'connected'); assert.equal(f.state.received.length, 0); await f.driver.stop();
});

test('native SDK sending includes the durable UUID and never uses high-level retrying send', async () => {
  const sent = []; const handlers = new Map();
  const native = { connect: async () => {}, disconnect: async () => {}, on: (name, fn) => handlers.set(name, fn),
    send: () => assert.fail('High-level send cannot carry UUID'), rawClient: { im: { v1: { message: { create: async body => { sent.push(body); return { code: 0, data: { message_id: 'om_native' } }; } } } } } };
  const transport = await createFeishuTransport({ appId: 'cli_fixture', appSecret: 'fixture', apiBase: 'https://open.feishu.cn',
    onMessage() {}, onState() {}, onError() {}, loadSdk: async () => ({ Domain: { Feishu: 'feishu', Lark: 'lark' }, createLarkChannel: () => native }) });
  await transport.connect(); const result = await transport.send({ chatId: 'oc_fixture', text: '中文练习', uuid: 'durable-uuid' });
  assert.deepEqual(result, { messageId: 'om_native' });
  assert.deepEqual(sent[0], { params: { receive_id_type: 'chat_id' }, data: { receive_id: 'oc_fixture', msg_type: 'text', content: JSON.stringify({ text: '中文练习' }), uuid: 'durable-uuid' } });
  assert.ok(handlers.has('message')); assert.ok(handlers.has('reconnecting')); await transport.disconnect();
});
