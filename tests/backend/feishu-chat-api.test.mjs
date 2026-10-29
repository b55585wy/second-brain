import test from 'node:test';
import assert from 'node:assert/strict';
import { appFor, ok, request, profile, settings } from './helpers.mjs';

const until = async predicate => {
  const end = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < end, 'Expected local state transition'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

function practiceFor(app) {
  const context = app.automation.context();
  const source = app.sources.capture({ kind: 'manual', externalId: 'feishu-http-fixture', title: '事务检查材料', content: '把消息标识与回答放在同一事务中。' });
  const refs = [app.sources.ref(source)]; const goal = app.domain.profile().goals[0];
  const practice = app.learning.createPractice({ projectId: null, kind: 'new_scenario', goal, skill: '',
    prompt: '请设计一次重复消息的验证。', estimatedMinutes: 5, sourceRefs: refs,
    rubric: [{ label: '检查', description: '给出可执行检查', expectedEvidence: ['重复投递测试'] }] }, app.learning.provenance('template', refs));
  app.store.put('focus-artifact', { date: app.automation.date(), timeZone: app.domain.profile().timeZone,
    profileRevision: context.profileRevision, scopeRevision: context.scopeRevision, modelConfigKey: context.modelKey,
    highlights: [{ id: 'highlight_http_fixture', title: '重复消息', summary: '一次提交。', goal, whyRelevant: '练习事务验证', sourceRefs: refs }],
    sourceDigests: [{ sourceId: source.id, contentDigest: source.contentDigest }], practiceId: practice.id,
    provenance: app.learning.provenance('template', refs), generatedAt: new Date().toISOString() });
  return practice;
}

test('chat and registration GET are inert and mutation APIs retain origin and revision protection', async t => {
  let registrations = 0; const app = await appFor(t, { feishuRegistrationOptions: { registerAppFactory: () => { registrations++; return new Promise(() => {}); } } });
  const initial = await ok(app, 'GET', '/feishu-chat'); assert.equal(initial.enabled, false); assert.equal(initial.bound, false);
  assert.equal((await ok(app, 'GET', '/feishu-chat/registration')).state, 'idle');
  assert.deepEqual(await ok(app, 'GET', '/feishu-chat/entry'), { url: null, qrDataUrl: null });
  assert.equal(registrations, 0); assert.equal(app.store.all('job').length, 0);
  const current = await ok(app, 'PUT', '/feishu-chat', { expectedRevision: initial.revision, enabled: true, remindersEnabled: false, reminderLocalTime: '10:00' });
  assert.equal(current.enabled, true); assert.equal(current.configured, false);
  assert.equal((await request(app, 'PUT', '/feishu-chat', { expectedRevision: initial.revision, enabled: false })).status, 409);
  assert.equal((await request(app, 'POST', '/feishu-chat/pair', {}, { headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await request(app, 'PUT', '/feishu-chat', { expectedRevision: current.revision, allowUserId: 'ou_other' })).status, 422);
});

test('one private Feishu answer becomes the same cited attempt and local feedback on the web', async t => {
  const sent = []; let factoryOptions;
  const app = await appFor(t, { feishuChannelOptions: { factory: async options => {
    factoryOptions = options; return { connect: async () => {}, disconnect: async () => {}, send: async message => { sent.push(message); return { messageId: `om_sent_${sent.length}` }; } };
  } } });
  await profile(app, { goals: ['验证事务'], dailyBudgetMinutes: 15 });
  await settings(app, { feishu: { enabled: true, appId: 'cli_local_fixture', appSecret: 'fixture-not-real-secret' } });
  const entry = await ok(app, 'GET', '/feishu-chat/entry');
  assert.equal(entry.url, 'https://applink.feishu.cn/client/bot/open?appId=cli_local_fixture');
  assert.ok(entry.qrDataUrl.startsWith('data:image/png;base64,'));
  const practice = practiceFor(app); const initial = await ok(app, 'GET', '/feishu-chat');
  await ok(app, 'PUT', '/feishu-chat', { expectedRevision: initial.revision, enabled: true, remindersEnabled: true, reminderLocalTime: '09:00' });
  const pair = await ok(app, 'POST', '/feishu-chat/pair', {});
  const receive = (messageId, content) => ({ messageId, content, senderId: 'ou_self', chatId: 'oc_self', chatType: 'p2p', senderType: 'user', createTime: Date.now() });
  app.feishuChannel.start(); await app.feishuChannel.wake();
  factoryOptions.onMessage(receive('om_pair', `绑定 ${pair.code}`)); await app.feishuChannel.wake();
  assert.equal(sent.length, 1); assert.ok(sent[0].text.includes(practice.prompt));
  let paidCalls = 0; app.model.feedback = async () => { paidCalls++; throw new Error('No paid processing'); };
  const message = receive('om_answer', '事务提交后重放同一消息，确认只有一条输出。');
  factoryOptions.onMessage(message); await app.feishuChannel.wake();
  factoryOptions.onMessage(message); await app.feishuChannel.wake();
  const today = await ok(app, 'GET', '/today');
  assert.equal(today.practice.id, practice.id); assert.equal(today.attempt.output, message.content);
  assert.equal(today.attempt.assistanceLevel, 'unknown'); assert.equal(today.attempt.feedback.mode, 'template');
  const attempts = await ok(app, 'GET', `/practices/${practice.id}/attempts`); assert.equal(attempts.total, 1); assert.equal(paidCalls, 0);
  const serialized = JSON.stringify(await ok(app, 'GET', '/feishu-chat'));
  assert.ok(!serialized.includes('fixture-not-real-secret')); assert.ok(!serialized.includes('ou_self')); assert.ok(!serialized.includes('oc_self'));
  const document = app.backup.document({ scope: 'all', projectIds: [], includeSourceContent: true });
  assert.equal(document.data.attempts[0].assistanceLevel, 'unknown');
  assert.ok(!JSON.stringify(document).includes('oc_self')); assert.ok(!JSON.stringify(document).includes(pair.code));
  const target = await appFor(t);
  await ok(target, 'POST', '/imports', { document, mode: 'merge', applyProfile: true, expectedProfileRevision: target.domain.profile().revision });
  assert.equal(target.store.all('attempt')[0].assistanceLevel, 'unknown');
});

test('registration requests are explicit, join one pending session and save credentials without returning them', async t => {
  let resolveRegistration; let calls = 0;
  const app = await appFor(t, { feishuRegistrationOptions: { registerAppFactory: options => {
    calls++; options.onQRCodeReady({ url: 'https://accounts.feishu.cn/page/launcher?user_code=fixture', expireIn: 600 });
    return new Promise(resolve => { resolveRegistration = resolve; });
  } } });
  assert.equal((await ok(app, 'GET', '/feishu-chat/registration')).state, 'idle'); assert.equal(calls, 0);
  const first = await ok(app, 'POST', '/feishu-chat/registration', {}); assert.ok(['starting', 'waiting'].includes(first.state));
  await ok(app, 'POST', '/feishu-chat/registration', {}); assert.equal(calls, 1);
  await until(() => app.feishuRegistration.public().qrDataUrl);
  const waiting = await ok(app, 'GET', '/feishu-chat/registration'); assert.ok(waiting.qrDataUrl.startsWith('data:image/png;base64,'));
  resolveRegistration({ client_id: 'cli_registered_fixture', client_secret: 'registered-fixture-secret' });
  await until(() => app.feishuRegistration.public().state === 'complete');
  const complete = await ok(app, 'GET', '/feishu-chat/registration');
  assert.equal(complete.url, null); assert.equal(complete.qrDataUrl, null);
  assert.ok(!JSON.stringify(complete).includes('registered-fixture-secret'));
  const chat = await ok(app, 'GET', '/feishu-chat'); assert.equal(chat.configured, true); assert.equal(chat.enabled, true);
});

test('explicitly disabling chat during registration is respected after successful authorization', async t => {
  let resolveRegistration;
  const app = await appFor(t, { feishuRegistrationOptions: { registerAppFactory: () => new Promise(resolve => { resolveRegistration = resolve; }) } });
  await ok(app, 'POST', '/feishu-chat/registration', {});
  await until(() => !!resolveRegistration);
  const chat = await ok(app, 'GET', '/feishu-chat');
  await ok(app, 'PUT', '/feishu-chat', { expectedRevision: chat.revision, enabled: false });
  resolveRegistration({ client_id: 'cli_registered_fixture', client_secret: 'registered-fixture-secret' });
  await until(() => app.feishuRegistration.public().state === 'complete');
  assert.equal((await ok(app, 'GET', '/feishu-chat')).enabled, false);
});

test('local cancellation refuses a late registration receipt and does not alter saved settings', async t => {
  let resolveRegistration;
  const app = await appFor(t, { feishuRegistrationOptions: { registerAppFactory: () => new Promise(resolve => { resolveRegistration = resolve; }) } });
  const initial = app.settings.public(); await ok(app, 'POST', '/feishu-chat/registration', {});
  await until(() => !!resolveRegistration); await ok(app, 'POST', '/feishu-chat/registration/cancel', {});
  resolveRegistration({ client_id: 'cli_late_fixture', client_secret: 'late-secret' }); await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(app.settings.public(), initial); assert.equal(!!app.secrets.get('feishu.appSecret'), false);
});
