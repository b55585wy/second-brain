import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../../server/errors.mjs';
import { digest } from '../../server/validation.mjs';
import { appFor, profile, request, operation, jobDone } from './helpers.mjs';

// Requirements: recover only an actual confirmed menu click with a definite failed latest
// practice patch; preserve closed events/failed/unknown rows; idempotent local API operation;
// current binding/source/date/answer guards; bind answers only after native patch confirmation;
// user-initiated terminal practice updates receive one nonrecursive text status notice.
async function fixture(t, { uncertain = false, advance = false } = {}) {
  const app = await appFor(t); app.learning.onAttempt = null;
  const clock = { value: new Date('2026-10-31T01:00:00.000Z') }; app.automation.clock = () => clock.value;
  await profile(app, { goals: ['Reliable storage'], dailyBudgetMinutes: 15, timeZone: 'Asia/Shanghai' });
  const settings = app.settings.raw(); app.store.put('config', { ...settings, feishu: { ...settings.feishu, enabled: true, appId: 'cli_recovery' } }, 'settings');
  const chat = app.feishuChat; const cards = app.feishuCards; chat.clock = () => clock.value; cards.clock = () => clock.value;
  chat.secrets = { get: key => key === 'feishu.appSecret' ? 'synthetic-recovery-secret' : null };
  chat.update({ enabled: true, cardsEnabled: true }); let sequence = 0; const sent = []; let modelCalls = 0;
  app.model.generate = async () => { modelCalls++; throw new Error('Recovery cannot use a model.'); };
  const message = content => ({ messageId: `om_user_${++sequence}`, chatId: 'oc_recovery', senderId: 'ou_recovery',
    chatType: 'p2p', senderType: 'user', createTime: +clock.value, content });
  const send = async value => { sent.push(value); return { messageId: value.updateMessageId ?? `om_sent_${sent.length}` }; };
  const pair = chat.pair(); chat.receive(message(`绑定 ${pair.code}`)); await chat.drain(send);
  const source = app.sources.capture({ kind: 'manual', externalId: 'recovery-source', title: 'Replay', content: 'One identity must retain one saved result.' });
  const refs = [app.sources.ref(source)]; const context = app.automation.context();
  const practice = app.learning.createPractice({ projectId: null, kind: 'explanation', goal: 'Reliable storage', skill: '',
    prompt: 'Describe one observable replay check.', estimatedMinutes: 5, sourceRefs: refs,
    rubric: [{ label: 'Evidence', description: 'Give a count.', expectedEvidence: ['One record'] }] }, app.learning.provenance('template', refs));
  app.store.put('focus-artifact', { date: app.automation.date(), timeZone: app.domain.profile().timeZone,
    profileRevision: context.profileRevision, scopeRevision: context.scopeRevision, modelConfigKey: context.modelKey, practiceId: practice.id,
    highlights: [{ id: 'recovery-highlight', title: 'Replay', summary: 'Retain one result.', goal: practice.goal, whyRelevant: 'Verify storage.', sourceRefs: refs }],
    sourceDigests: [{ sourceId: source.id, contentDigest: source.contentDigest }], provenance: app.learning.provenance('template', refs), generatedAt: clock.value.toISOString() }, 'recovery-focus');
  for (const id of ['old_unknown_one', 'old_unknown_two']) app.store.put('feishu-chat-outbox', {
    purpose: 'legacy', status: 'uncertain', attempts: 1, uuid: `closed_${id}`, messageId: null, text: 'Existing closed intent.' }, id);
  chat.receive(message('菜单')); await chat.drain(send);
  const menu = app.store.all('feishu-chat-outbox').find(row => row.purpose === 'menu'); const cardId = menu.cardId;
  const initialToken = /"t":"([a-f0-9]{24})"/.exec(JSON.stringify(menu.card))[1];
  const click = () => ({ messageId: menu.messageId, chatId: 'oc_recovery', operator: { openId: 'ou_recovery' },
    action: { value: { v: 1, t: initialToken, a: 'menu_today' } }, raw: { token: `real_test_click_${++sequence}` } });
  const rejectPatch = async value => {
    if (!value.card) return send(value);
    const error = new ApiError(400, 'FEISHU_REQUEST_REJECTED', 'A bounded synthetic rejection.');
    error.uncertain = uncertain; error.providerCode = 230099; throw error;
  };
  const failCurrentClick = async () => {
    const incoming = click(); assert.notEqual(cards.receive(incoming, chat.identity()).toast.type, 'error');
    await jobDone(app, { jobId: cards.state(cardId).actionJobId }); await cards.flush();
    const patch = app.store.all('feishu-chat-outbox').find(row => row.cardId === cardId && row.cardVersion === cards.state(cardId).version);
    await chat.deliver(patch, rejectPatch); return incoming;
  };
  const originalClick = await failCurrentClick(); if (advance) await failCurrentClick();
  const failed = app.store.all('feishu-chat-outbox').find(row => row.cardId === cardId && row.cardVersion === cards.state(cardId).version);
  const events = app.store.all('feishu-card-event');
  const unknown = app.store.all('feishu-chat-outbox').filter(row => row.status === 'uncertain');
  return { app, chat, cards, clock, source, practice, cardId, menu, failed, events, unknown, originalClick, send, sent,
    modelCalls: () => modelCalls, refresh: (values = {}) => cards.refreshKnownFailedMenu(cardId, {
      expectedVersion: cards.state(cardId).version, operationId: operation(), ...values }) };
}

test('explicit recovery patches the same confirmed message and binds answers only after success', async t => {
  const f = await fixture(t); const version = f.cards.state(f.cardId).version; const originalInbox = f.app.store.all('feishu-chat-inbox');
  const op = operation(); await f.app.jobs.stop(); const ack = f.refresh({ operationId: op });
  assert.deepEqual(f.refresh({ expectedVersion: version, operationId: op }), ack);
  const queued = f.app.store.require('job', ack.jobId); assert.equal(queued.kind, 'feishu_card_action'); assert.equal(queued.payload.action, 'resync');
  assert.notEqual(queued.operationId, op); assert.equal(f.cards.state(f.cardId).requiredPracticeVersion, version + 1);
  f.app.jobs.start(); await jobDone(f.app, ack); await f.cards.flush();
  const patch = f.app.store.all('feishu-chat-outbox').find(row => row.cardId === f.cardId && row.cardVersion === version + 1);
  assert.equal(patch.updateMessageId, f.menu.messageId); assert.equal(patch.requestedInboxId, ack.operationId);
  const deliveryId = digest([f.chat.identity(), f.menu.messageId]); assert.equal(f.app.store.get('feishu-chat-delivery', deliveryId), null);
  let release;
  const accepted = new Promise(resolve => { release = resolve; });
  const pending = f.chat.deliver(patch, async value => { await accepted; return f.send(value); });
  assert.equal(f.app.store.get('feishu-chat-delivery', deliveryId), null); assert.equal(f.app.store.all('attempt').length, 0);
  release(); await pending;
  assert.equal(f.cards.state(f.cardId).confirmedVersion, version + 1); assert.ok(f.app.store.get('feishu-chat-delivery', deliveryId));
  assert.deepEqual(f.app.store.require('feishu-chat-outbox', f.failed.id), f.failed);
  assert.deepEqual(f.app.store.require('feishu-chat-outbox', f.menu.id), f.menu);
  for (const unknown of f.unknown) assert.deepEqual(f.app.store.require('feishu-chat-outbox', unknown.id), unknown);
  assert.deepEqual(f.app.store.all('feishu-card-event'), f.events); assert.deepEqual(f.app.store.all('feishu-chat-inbox'), originalInbox);
  const jobs = f.app.store.all('job').length;
  assert.notEqual(f.cards.receive(f.originalClick, f.chat.identity()).toast.type, 'error');
  assert.equal(f.app.store.all('job').length, jobs); assert.equal(f.app.store.all('attempt').length, 0); assert.equal(f.app.store.all('output').length, 0); assert.equal(f.modelCalls(), 0);
});

test('recovery uses the fresh expected version after more than one definite failed patch', async t => {
  const f = await fixture(t, { advance: true }); const version = f.cards.state(f.cardId).version; assert.ok(version > 2);
  const ack = f.refresh(); assert.equal(ack.expectedVersion, version); assert.equal(ack.targetVersion, version + 1);
  await jobDone(f.app, ack); await f.cards.flush();
  assert.equal(f.cards.state(f.cardId).version, version + 1); assert.deepEqual(f.app.store.require('feishu-chat-outbox', f.failed.id), f.failed);
});

for (const invalid of ['wrong version', 'no evidence', 'failed intent job', 'foreign intent epoch', 'menu not sent', 'message mismatch',
  'uncertain patch', 'pending patch', 'sending patch', 'sent patch', 'source', 'binding', 'cards disabled', 'saved answer', 'new day', 'active job', 'older unknown patch']) {
  test(`recovery rejects ${invalid} without opening another send operation`, async t => {
    const f = await fixture(t); let expectedVersion = f.cards.state(f.cardId).version;
    if (invalid === 'wrong version') expectedVersion--;
    if (invalid === 'no evidence') for (const row of f.events) f.app.store.remove('feishu-card-event', row.id);
    if (invalid === 'failed intent job' || invalid === 'foreign intent epoch') {
      const event = f.events.find(row => row.action === 'menu_today'); const job = f.app.store.require('job', event.jobId);
      f.app.store.put('job', invalid === 'failed intent job' ? { ...job, status: 'failed' } : { ...job, payload: { ...job.payload, bindingEpoch: 'foreign_epoch' } }, job.id);
    }
    if (invalid === 'menu not sent') f.app.store.put('feishu-chat-outbox', { ...f.menu, status: 'uncertain' }, f.menu.id);
    if (invalid === 'message mismatch') f.app.store.put('feishu-chat-outbox', { ...f.failed, updateMessageId: 'om_other' }, f.failed.id);
    const statuses = { 'uncertain patch': 'uncertain', 'pending patch': 'pending', 'sending patch': 'sending', 'sent patch': 'sent' };
    if (statuses[invalid]) f.app.store.put('feishu-chat-outbox', { ...f.failed, status: statuses[invalid] }, f.failed.id);
    if (invalid === 'source') f.app.sources.capture({ ...f.source, content: 'Changed source.' });
    if (invalid === 'binding') f.chat.pair();
    if (invalid === 'cards disabled') f.chat.update({ cardsEnabled: false });
    if (invalid === 'saved answer') f.app.learning.attempt(f.practice.id, { output: 'Saved elsewhere.', assistanceLevel: 'none', evidenceRefs: [] });
    if (invalid === 'new day') f.clock.value = new Date(+f.clock.value + 86400000);
    if (invalid === 'active job') { await f.app.jobs.stop(); f.app.jobs.enqueue('feishu_card_action', { cardId: f.cardId, action: 'resync' }, operation(), `feishu-card:${f.cardId}`); }
    if (invalid === 'older unknown patch') f.app.store.put('feishu-chat-outbox', { ...f.failed, cardVersion: f.failed.cardVersion - 1, status: 'uncertain' }, 'older_unknown_patch');
    const jobs = f.app.store.all('job'); const outbox = f.app.store.all('feishu-chat-outbox'); const state = f.cards.state(f.cardId);
    assert.throws(() => f.refresh({ expectedVersion }));
    assert.deepEqual(f.app.store.all('job'), jobs); assert.deepEqual(f.app.store.all('feishu-chat-outbox'), outbox); assert.deepEqual(f.cards.state(f.cardId), state);
    assert.equal(f.modelCalls(), 0);
  });
}

for (const change of ['source', 'binding', 'answer']) {
  test(`queued recovery rejects a late ${change} change before recovering the failed question`, async t => {
    const f = await fixture(t); await f.app.jobs.stop(); const ack = f.refresh(); const version = f.cards.state(f.cardId).version;
    if (change === 'source') f.app.sources.capture({ ...f.source, content: 'Revoked source.' });
    if (change === 'binding') f.chat.pair();
    if (change === 'answer') f.app.learning.attempt(f.practice.id, { output: 'Saved in web.', assistanceLevel: 'none', evidenceRefs: [] });
    f.app.jobs.start(); await jobDone(f.app, ack, 'failed');
    assert.equal(f.cards.state(f.cardId).version, version);
    assert.deepEqual(f.app.store.require('feishu-chat-outbox', f.failed.id), f.failed);
    assert.equal(f.app.store.all('feishu-chat-outbox').filter(row => row.cardId === f.cardId && row.cardVersion > version).length, 0);
  });
}

for (const uncertain of [false, true]) {
  test(`native menu practice ${uncertain ? 'uncertain' : 'known rejection'} has one notice keyed to the actual user intent`, async t => {
    const f = await fixture(t, { uncertain }); const event = f.events.find(row => row.action === 'menu_today'); const intent = f.app.store.require('job', event.jobId);
    assert.equal(f.failed.requestedInboxId, intent.operationId);
    const notices = f.app.store.all('feishu-chat-outbox').filter(row => row.purpose === 'delivery_notice' && row.noticeFor === f.failed.id);
    assert.equal(notices.length, 1); assert.equal(notices[0].status, 'sent');
    assert.equal(f.failed.status, uncertain ? 'uncertain' : 'failed'); assert.equal(f.failed.lastError.providerCode, 230099);
    await f.chat.drain(f.send); assert.equal(f.app.store.all('feishu-chat-outbox').filter(row => row.noticeFor === f.failed.id).length, 1);
    for (const unknown of f.unknown) assert.deepEqual(f.app.store.require('feishu-chat-outbox', unknown.id), unknown);
    if (uncertain) assert.throws(() => f.refresh());
    assert.equal(f.app.store.all('attempt').length, 0); assert.equal(f.modelCalls(), 0);
  });
}

test('recovery API enforces explicit version and local authorization and reuses one operation', async t => {
  const f = await fixture(t); const path = `/feishu-chat/cards/${f.cardId}/refresh-known-failed`; const op = operation();
  assert.equal((await request(f.app, 'POST', path, { expectedVersion: f.failed.cardVersion - 1 })).status, 409);
  assert.equal((await request(f.app, 'POST', path, { expectedVersion: f.failed.cardVersion, resetUnknown: true })).status, 422);
  assert.equal((await request(f.app, 'POST', path, { expectedVersion: f.failed.cardVersion }, { headers: { Origin: 'https://foreign.example' } })).status, 403);
  const first = await request(f.app, 'POST', path, { expectedVersion: f.failed.cardVersion, operationId: op }); assert.equal(first.status, 202);
  const repeated = await request(f.app, 'POST', path, { expectedVersion: f.failed.cardVersion, operationId: op }); assert.deepEqual(repeated.data, first.data);
  assert.equal(f.app.store.all('job').filter(row => row.operationId.startsWith('menu_refresh_')).length, 1);
  await jobDone(f.app, first.data); assert.deepEqual(f.app.store.require('feishu-chat-outbox', f.failed.id), f.failed);
});
