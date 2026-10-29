import test from 'node:test';
import assert from 'node:assert/strict';
import { appFor, profile, settings } from './helpers.mjs';
import { FeishuChat } from '../../server/feishu-chat.mjs';

async function fixture(t, { practice = true } = {}) {
  const app = await appFor(t); const clock = { value: new Date('2026-10-29T01:00:00Z') };
  app.automation.clock = () => clock.value;
  await profile(app, { goals: ['解释并验证事务边界'], dailyBudgetMinutes: 15 });
  await settings(app, { feishu: { enabled: true, appId: 'cli_fixture', appSecret: 'fixture-feishu-secret' } });
  let modelCalls = 0;
  app.model.feedback = async () => { modelCalls++; throw new Error('Paid model must not be used'); };
  app.model.digest = async () => { modelCalls++; throw new Error('Paid model must not be used'); };
  const make = () => new FeishuChat(app.store, app.settings, app.secrets, app.domain, app.automation, app.learning, { clock: () => clock.value });
  const chat = make(); const sent = []; let sequence = 0;
  const send = async message => { sent.push(message); return { messageId: `om_sent_${sent.length}` }; };
  const message = (content, fields = {}) => ({ messageId: `om_in_${++sequence}`, chatId: 'oc_self', senderId: 'ou_self', chatType: 'p2p', senderType: 'user', content, createTime: +clock.value, ...fields });
  function setPractice() {
    const context = app.automation.context();
    const source = app.sources.capture({ kind: 'manual', externalId: 'chat-fixture', title: '事务材料', content: '事务同时保存输出和消息身份。' });
    const refs = [app.sources.ref(source)];
    const saved = app.learning.createPractice({ projectId: null, kind: 'new_scenario', goal: app.domain.profile().goals[0], skill: '',
      prompt: '给出重复消息不会重复记账的检查方案。', estimatedMinutes: 5, sourceRefs: refs,
      rubric: [{ label: '验证', description: '给出可执行检查', expectedEvidence: ['重放检查'] }] }, app.learning.provenance('template', refs));
    app.store.put('focus-artifact', { date: app.automation.date(), timeZone: app.domain.profile().timeZone,
      profileRevision: context.profileRevision, scopeRevision: context.scopeRevision, modelConfigKey: context.modelKey,
      highlights: [{ id: 'focus_fixture_highlight', title: '事务与重放', summary: '一起保存身份和输出。', goal: saved.goal, whyRelevant: '直接对应验证目标', sourceRefs: refs }],
      sourceDigests: [{ sourceId: source.id, contentDigest: source.contentDigest }], practiceId: saved.id,
      provenance: app.learning.provenance('template', refs), generatedAt: clock.value.toISOString() });
    return saved;
  }
  const currentPractice = practice ? setPractice() : null;
  chat.update({ enabled: true });
  async function bind() { const pair = chat.pair(); const result = chat.receive(message(`绑定 ${pair.code}`)); assert.equal(result.bound, true); await chat.drain(send); return pair; }
  return { app, clock, chat, make, message, send, sent, bind, setPractice, practice: currentPractice, modelCalls: () => modelCalls };
}

test('configuration is separate, defaults off, validates time and never exposes identifiers or pair codes', async t => {
  const f = await fixture(t); const fresh = f.chat.config();
  assert.equal(fresh.remindersEnabled, true);
  f.chat.update({ enabled: false }); assert.equal(f.chat.public().state, 'off');
  assert.throws(() => f.chat.update({ reminderLocalTime: '24:00' }));
  assert.throws(() => f.chat.update({ enabled: 'yes' }));
  assert.throws(() => f.chat.update({ allowUserId: 'ou_intruder' }));
  f.chat.update({ enabled: true }); const pair = f.chat.pair();
  const publicJson = JSON.stringify(f.chat.public());
  assert.ok(!publicJson.includes(pair.code)); assert.ok(!publicJson.includes('fixture-feishu-secret'));
  assert.equal(f.chat.public().configured, true); assert.equal(f.chat.public().bound, false);
});

test('a local expiring pair code binds only a direct human message and is stored only as a digest', async t => {
  const f = await fixture(t); const pair = f.chat.pair();
  const record = f.app.store.get('feishu-chat-pair', 'main');
  assert.ok(!JSON.stringify(record).includes(pair.code));
  assert.equal(f.chat.receive(f.message(`绑定 ${pair.code}`, { chatType: 'group' })).ignored, true);
  assert.equal(f.chat.receive(f.message(`绑定 ${pair.code}`, { senderType: 'bot' })).ignored, true);
  assert.equal(f.chat.public().bound, false);
  const incoming = f.message(`绑定 ${pair.code}`);
  assert.equal(f.chat.receive(incoming).bound, true);
  assert.equal(f.chat.receive(incoming).duplicate, true);
  assert.equal(f.app.store.get('feishu-chat-pair', 'main'), null);
  assert.equal(f.chat.public().bound, true);
});

test('wrong, expired and stale pair messages cannot bind, and guesses are bounded', async t => {
  const f = await fixture(t); let pair = f.chat.pair();
  for (let i = 0; i < 5; i++) assert.equal(f.chat.receive(f.message('绑定 0000-0000-0000')).ignored, true);
  assert.equal(f.chat.receive(f.message(`绑定 ${pair.code}`)).ignored, true);
  pair = f.chat.pair(); f.clock.value = new Date(+f.clock.value + 10 * 60000);
  assert.equal(f.chat.receive(f.message(`绑定 ${pair.code}`)).ignored, true);
  pair = f.chat.pair();
  assert.equal(f.chat.receive(f.message(`绑定 ${pair.code}`, { createTime: +f.clock.value - 60000 })).ignored, true);
  assert.equal(f.chat.public().bound, false);
});

test('pairing, repeated ticks and send-today share one practice delivery and one stable UUID', async t => {
  const f = await fixture(t); await f.bind();
  f.chat.tick(); f.chat.tick(); const again = f.chat.sendToday(); await f.chat.drain(f.send);
  assert.equal(again.alreadySent, true); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(f.sent[0].text.includes(f.practice.prompt)); assert.equal(f.modelCalls(), 0);
});

test('an unbound or disabled channel cannot send and strangers receive no learning content', async t => {
  const f = await fixture(t);
  assert.throws(() => f.chat.sendToday()); await f.bind(); const before = f.sent.length;
  assert.equal(f.chat.receive(f.message('今日练习', { senderId: 'ou_other' })).ignored, true);
  assert.equal(f.chat.receive(f.message('回答：我的答案', { chatId: 'oc_other' })).ignored, true);
  f.chat.update({ enabled: false }); assert.equal(f.chat.receive(f.message('今日练习')).ignored, true);
  assert.throws(() => f.chat.sendToday()); await f.chat.drain(f.send);
  assert.equal(f.sent.length, before); assert.equal(f.app.store.all('attempt').length, 0);
});

test('direct reply saves the original web practice once, with unknown assistance and local feedback', async t => {
  const f = await fixture(t); await f.bind();
  const incoming = f.message('把消息身份与输出放在同一个事务中。', { replyToMessageId: 'om_sent_1' });
  const saved = f.chat.receive(incoming); assert.equal(saved.practiceId, f.practice.id);
  assert.equal(f.chat.receive(incoming).duplicate, true);
  const beforeFeedback = f.app.automation.today().attempt;
  assert.equal(beforeFeedback.assistanceLevel, 'unknown'); assert.equal(beforeFeedback.output, incoming.content);
  await f.chat.drain(f.send);
  const today = f.app.automation.today();
  assert.equal(today.attempt.id, saved.attemptId); assert.equal(today.attempt.feedback.mode, 'template');
  assert.ok(today.attempt.feedback.observations.every(item => item.finding === 'not_assessed'));
  assert.equal(f.app.store.all('attempt').length, 1); assert.equal(f.modelCalls(), 0);
});

test('a distinct second answer does not overwrite or duplicate the already saved output', async t => {
  const f = await fixture(t); await f.bind();
  f.chat.receive(f.message('独立：先写业务记录，再检查重放。'));
  f.chat.receive(f.message('第二份不同答案', { replyToMessageId: 'om_sent_1' }));
  await f.chat.drain(f.send);
  assert.equal(f.app.store.all('attempt').length, 1);
  assert.equal(f.app.automation.today().attempt.assistanceLevel, 'none');
  assert.ok(!f.app.automation.today().attempt.output.includes('独立：'));
});

test('explicit assistance prefixes are recorded without inferring correctness', async t => {
  const f = await fixture(t); await f.bind(); f.chat.receive(f.message('提示：检查唯一事件标识。'));
  await f.chat.drain(f.send);
  const attempt = f.app.automation.today().attempt;
  assert.equal(attempt.assistanceLevel, 'hint'); assert.equal(attempt.output, '检查唯一事件标识。');
  assert.ok(attempt.feedback.summary.includes('尚未评估'));
});

test('unsolicited, unrelated-reply and pre-delivery messages do not become an answer', async t => {
  const f = await fixture(t); const pair = f.chat.pair(); f.chat.receive(f.message(`绑定 ${pair.code}`));
  f.chat.receive(f.message('尚未收到题目的消息'));
  await f.chat.drain(f.send);
  f.chat.receive(f.message('另一条消息的回复', { replyToMessageId: 'om_unrelated' }));
  f.chat.receive(f.message('过去的消息', { createTime: +f.clock.value - 60000 }));
  assert.equal(f.app.store.all('attempt').length, 0);
});

test('empty and oversized answer inputs are bounded without saving attempts', async t => {
  const f = await fixture(t); await f.bind(); f.chat.receive(f.message('答案：   '));
  assert.throws(() => f.chat.receive(f.message('字'.repeat(100001))));
  assert.throws(() => f.chat.receive(f.message('字', { messageId: '../bad' })));
  assert.equal(f.app.store.all('attempt').length, 0);
});

test('changed profile prevents the previously delivered practice from receiving an answer', async t => {
  const f = await fixture(t); await f.bind();
  await profile(f.app, { goals: ['新的目标'] });
  f.chat.receive(f.message('给旧题的回答', { replyToMessageId: 'om_sent_1' }));
  assert.equal(f.app.store.all('attempt').length, 0);
});

test('changed source invalidates pending delivery and previously delivered practice', async t => {
  const f = await fixture(t); await f.bind();
  f.app.sources.capture({ kind: 'manual', externalId: 'chat-fixture', title: '修改材料', content: '材料已经修改。' });
  f.chat.receive(f.message('旧材料的回答', { replyToMessageId: 'om_sent_1' })); await f.chat.drain(f.send);
  assert.equal(f.app.store.all('attempt').length, 0);
});

test('a queued practice is rechecked before send after profile change or disable', async t => {
  const f = await fixture(t); const pair = f.chat.pair(); f.chat.receive(f.message(`绑定 ${pair.code}`));
  await profile(f.app, { goals: ['新目标'] }); await f.chat.drain(f.send); assert.equal(f.sent.length, 0);
  f.chat.update({ enabled: false }); await f.chat.drain(f.send); assert.equal(f.sent.length, 0);
});

test('credential replacement invalidates the binding, pending writes and an old client callback', async t => {
  const f = await fixture(t); await f.bind(); const previousIdentity = f.chat.identity();
  await settings(f.app, { feishu: { appSecret: 'new-fixture-feishu-secret' } });
  assert.equal(f.chat.public().bound, false);
  assert.equal(f.chat.receive(f.message('答案'), previousIdentity).ignored, true);
  await f.chat.drain(f.send); assert.equal(f.app.store.all('attempt').length, 0);
});

test('re-pair removes the previous recipient and prevents old queued responses crossing bindings', async t => {
  const f = await fixture(t); await f.bind(); f.chat.receive(f.message('帮助'));
  const pair = f.chat.pair(); assert.equal(f.chat.public().bound, false);
  f.chat.receive(f.message(`绑定 ${pair.code}`, { senderId: 'ou_new', chatId: 'oc_new' }));
  const count = f.sent.length; await f.chat.drain(f.send);
  assert.ok(f.sent.slice(count).every(item => item.chatId === 'oc_new'));
  assert.equal(f.chat.receive(f.message('旧账号答案')).ignored, true);
});

test('local attempt and inbox roll back together when attempt persistence fails', async t => {
  const f = await fixture(t); await f.bind(); const original = f.app.learning.attempt.bind(f.app.learning);
  f.app.learning.attempt = (...args) => { original(...args); throw new Error('Synthetic failure after attempt'); };
  const incoming = f.message('需要回滚的回答'); assert.throws(() => f.chat.receive(incoming));
  assert.equal(f.app.store.all('attempt').length, 0);
  f.app.learning.attempt = original; const result = f.chat.receive(incoming);
  assert.ok(result.attemptId); assert.equal(f.app.store.all('attempt').length, 1);
});

test('feedback failure and worker restart resume without repeating the saved attempt', async t => {
  const f = await fixture(t); await f.bind(); const result = f.chat.receive(f.message('保存后等待反馈'));
  const original = f.app.learning.feedback.bind(f.app.learning); f.app.learning.feedback = async () => { throw new Error('Synthetic feedback failure'); };
  await f.chat.drain(f.send); assert.equal(f.app.store.all('attempt').length, 1);
  f.app.learning.feedback = original; const restarted = f.make(); await restarted.drain(f.send);
  assert.equal(f.app.store.all('attempt').length, 1); assert.equal(f.app.automation.today().attempt.id, result.attemptId);
  assert.equal(f.app.automation.today().attempt.feedback.mode, 'template');
  await restarted.drain(f.send); assert.equal(f.app.store.all('feedback').length, 1);
});

test('pending delivery survives restart and concurrent drains send only once', async t => {
  const f = await fixture(t); const pair = f.chat.pair(); f.chat.receive(f.message(`绑定 ${pair.code}`));
  const storedUuid = f.app.store.all('feishu-chat-outbox')[0].uuid; const restarted = f.make();
  let unblock; const gate = new Promise(resolve => { unblock = resolve; }); let calls = 0;
  const pending = restarted.drain(async item => { calls++; assert.equal(item.uuid, storedUuid); await gate; return { messageId: 'om_restart' }; });
  await new Promise(resolve => setImmediate(resolve)); await restarted.drain(f.send); unblock(); await pending;
  assert.equal(calls, 1); assert.equal(f.sent.length, 0); assert.equal(restarted.sendToday().alreadySent, true);
});

test('changing reminder time during delivery retains the confirmed message answer association', async t => {
  const f = await fixture(t); const pair = f.chat.pair(); f.chat.receive(f.message(`绑定 ${pair.code}`));
  let release; let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const sending = f.chat.drain(async () => { entered(); await gate; return { messageId: 'om_reminder_race' }; });
  await started; f.chat.update({ reminderLocalTime: '10:15' }); release(); await sending;
  assert.equal(f.chat.sendToday().alreadySent, true);
  const incoming = f.message('修改提醒时间后仍可提交给原题。', { replyToMessageId: 'om_reminder_race' });
  const result = f.chat.receive(incoming); assert.equal(result.practiceId, f.practice.id);
  assert.equal(f.chat.receive(incoming).duplicate, true); await f.chat.drain(f.send);
  assert.equal(f.app.store.all('attempt').length, 1); assert.equal(f.app.automation.today().attempt.id, result.attemptId);
});

test('disabled, rebound, changed-app and changed-source contexts reject a late confirmed old delivery', async t => {
  const changes = {
    disabled: async f => { f.chat.update({ enabled: false }); },
    rebound: async f => { const pair = f.chat.pair(); f.chat.receive(f.message(`绑定 ${pair.code}`, { senderId: 'ou_new', chatId: 'oc_new' })); },
    changedApp: async f => { await settings(f.app, { feishu: { appSecret: 'changed-during-send-secret' } }); },
    changedSource: async f => { f.app.sources.capture({ kind: 'manual', externalId: 'chat-fixture', title: '新材料', content: '此材料已发生改变。' }); },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async sub => {
    const f = await fixture(sub); const pair = f.chat.pair(); f.chat.receive(f.message(`绑定 ${pair.code}`));
    let release; let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const sending = f.chat.drain(async () => { entered(); await gate; return { messageId: 'om_old_delivery' }; });
    await started; await change(f); release(); await sending;
    const sender = name === 'rebound' ? { senderId: 'ou_new', chatId: 'oc_new' } : {};
    f.chat.receive(f.message('旧题回答必须被拒绝。', { ...sender, replyToMessageId: 'om_old_delivery' }));
    assert.equal(f.app.store.all('attempt').length, 0);
    if (name === 'disabled') {
      f.chat.update({ enabled: true });
      f.chat.receive(f.message('重新开启后不自动接受关闭期间才确认的旧题。', { replyToMessageId: 'om_old_delivery' }));
      assert.equal(f.app.store.all('attempt').length, 0);
    }
  });
});

test('an interrupted sending record becomes uncertain and is never silently resent', async t => {
  const f = await fixture(t); const pair = f.chat.pair(); f.chat.receive(f.message(`绑定 ${pair.code}`));
  const item = f.app.store.all('feishu-chat-outbox')[0]; f.app.store.put('feishu-chat-outbox', { ...item, status: 'sending', attempts: 1 }, item.id);
  const restarted = f.make(); await restarted.drain(f.send);
  assert.equal(f.sent.length, 0); assert.equal(restarted.public().lastError.code, 'DELIVERY_UNCERTAIN');
});

test('two worker queue snapshots cannot claim the same delivery twice', async t => {
  const f = await fixture(t); const pair = f.chat.pair(); f.chat.receive(f.message(`绑定 ${pair.code}`));
  f.chat.receive(f.message('帮助')); f.chat.receive(f.message('help'));
  const first = f.make(); const second = f.make(); const seen = [];
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  const send = async item => { seen.push(item.uuid); const messageId = `om_worker_${seen.length}`; if (seen.length === 1) await gate; return { messageId }; };
  const draining = first.drain(send); await new Promise(resolve => setImmediate(resolve));
  await second.drain(send); unblock(); await draining;
  assert.equal(seen.length, 3); assert.equal(new Set(seen).size, 3);
});

test('known noncommitted retry uses the same UUID with bounded delay and attempts', async t => {
  const f = await fixture(t); const pair = f.chat.pair(); f.chat.receive(f.message(`绑定 ${pair.code}`));
  const ids = []; const failed = async item => { ids.push(item.uuid); throw Object.assign(new Error('Known not sent'), { retryable: true, uncertain: false }); };
  await f.chat.drain(failed); await f.chat.drain(failed); assert.equal(ids.length, 1);
  f.clock.value = new Date(+f.clock.value + 60000); await f.chat.drain(failed);
  f.clock.value = new Date(+f.clock.value + 60000); await f.chat.drain(failed);
  f.clock.value = new Date(+f.clock.value + 60000); await f.chat.drain(failed);
  assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 1);
});

test('unknown upstream failure is uncertain and never exposes provider error content', async t => {
  const f = await fixture(t); const pair = f.chat.pair(); f.chat.receive(f.message(`绑定 ${pair.code}`));
  let calls = 0; await f.chat.drain(async () => { calls++; throw new Error('fixture-feishu-secret private provider response'); });
  f.clock.value = new Date(+f.clock.value + 2 * 60000); await f.chat.drain(f.send);
  assert.equal(calls, 1); assert.equal(f.sent.length, 0);
  assert.equal(f.chat.public().lastError.code, 'DELIVERY_UNCERTAIN');
  assert.ok(!JSON.stringify(f.chat.public()).includes('fixture-feishu-secret'));
});

test('pause preserves answers and stops pending practice, continue restores one eligible reminder', async t => {
  const f = await fixture(t); const pair = f.chat.pair(); f.chat.receive(f.message(`绑定 ${pair.code}`));
  f.chat.receive(f.message('暂停')); f.chat.tick(); await f.chat.drain(f.send);
  assert.equal(f.chat.public().remindersEnabled, false); assert.ok(f.sent.every(item => !item.text.includes(f.practice.prompt)));
  f.chat.receive(f.message('继续')); f.chat.tick(); await f.chat.drain(f.send);
  assert.equal(f.chat.public().remindersEnabled, true); assert.equal(f.sent.filter(item => item.text.includes(f.practice.prompt)).length, 1);
});

test('snooze waits 30 minutes and sends one deliberate follow-up without model work', async t => {
  const f = await fixture(t); await f.bind(); f.chat.receive(f.message('稍后')); await f.chat.drain(f.send);
  f.clock.value = new Date(+f.clock.value + 29 * 60000); f.chat.tick(); await f.chat.drain(f.send);
  assert.equal(f.sent.filter(item => item.text.includes(f.practice.prompt)).length, 1);
  f.clock.value = new Date(+f.clock.value + 60000); f.chat.tick(); f.chat.tick(); await f.chat.drain(f.send);
  assert.equal(f.sent.filter(item => item.text.includes(f.practice.prompt)).length, 2); assert.equal(f.modelCalls(), 0);
});

test('scheduled reminder waits for the configured local time and skips completed practice', async t => {
  const f = await fixture(t, { practice: false }); await f.bind(); f.setPractice(); f.chat.update({ reminderLocalTime: '10:00' });
  f.clock.value = new Date('2026-10-29T01:30:00Z'); f.chat.tick(); await f.chat.drain(f.send); assert.equal(f.sent.length, 1);
  f.clock.value = new Date('2026-10-29T02:00:00Z'); f.chat.tick(); await f.chat.drain(f.send); assert.equal(f.sent.length, 2);
  f.chat.receive(f.message('回答：已处理')); await f.chat.drain(f.send); const count = f.sent.length;
  f.chat.tick(); await f.chat.drain(f.send); assert.equal(f.sent.length, count);
});

test('missing practice and missing credentials remain honest setup states', async t => {
  const f = await fixture(t, { practice: false }); await f.bind();
  assert.equal(f.chat.sendToday().practiceId, null); assert.equal(f.app.store.all('attempt').length, 0);
  await settings(f.app, { feishu: { enabled: false } });
  assert.equal(f.chat.public().configured, false); assert.equal(f.chat.public().state, 'setup');
  assert.throws(() => f.chat.pair()); assert.equal(f.modelCalls(), 0);
});
