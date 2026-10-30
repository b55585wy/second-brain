import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../../server/errors.mjs';
import { digest } from '../../server/validation.mjs';
import { appFor, profile, request, operation, jobDone } from './helpers.mjs';

// Requirements: no-practice menu and fallback; auth/nonce/duplicate boundaries; existing-only
// advice; local factual status; native review reuse; same-message practice navigation after
// confirmed patch; old uncertain operations stay closed; bounded nonrecursive delivery notices.
async function fixture(t, { practice = false, cards = true, bound = true } = {}) {
  const app = await appFor(t); app.learning.onAttempt = null;
  const clock = { value: new Date('2026-10-31T01:00:00.000Z') }; app.automation.clock = () => clock.value;
  await profile(app, { goals: ['Reliable storage'], dailyBudgetMinutes: 15, timeZone: 'Asia/Shanghai' });
  const config = app.settings.raw(); app.store.put('config', { ...config, feishu: { ...config.feishu, enabled: true, appId: 'cli_menu' } }, 'settings');
  const chat = app.feishuChat; const controller = app.feishuCards;
  chat.secrets = { get: key => key === 'feishu.appSecret' ? 'synthetic-menu-secret' : null };
  chat.clock = () => clock.value; controller.clock = () => clock.value;
  chat.update({ enabled: true, cardsEnabled: cards });
  let sequence = 0; const sent = []; let modelCalls = 0; let schedules = 0;
  app.model.generate = async () => { modelCalls++; throw new Error('A menu must not call a model.'); };
  const originalSchedule = app.advice.schedule.bind(app.advice);
  app.advice.schedule = (...args) => { schedules++; return originalSchedule(...args); };
  const message = (content, extra = {}) => ({ messageId: `om_user_${++sequence}`, chatId: 'oc_menu', senderId: 'ou_menu',
    chatType: 'p2p', senderType: 'user', createTime: +clock.value, content, ...extra });
  const send = async value => { sent.push(value); return { messageId: value.updateMessageId ?? `om_sent_${sent.length}` }; };
  if (bound) { const pair = chat.pair(); chat.receive(message(`绑定 ${pair.code}`)); await chat.drain(send); }
  const source = app.sources.capture({ kind: 'manual', externalId: 'menu-source', title: 'Replay source', content: 'PRIVATE_SOURCE_MARKER: retain one result for a repeated identity.' });
  const refs = [app.sources.ref(source)];
  function setPractice() {
    const current = app.automation.context();
    const value = app.learning.createPractice({ projectId: null, kind: 'explanation', goal: 'Reliable storage', skill: '',
      prompt: 'Give one observable replay check.', estimatedMinutes: 5, sourceRefs: refs,
      rubric: [{ label: 'Evidence', description: 'Use an observable count.', expectedEvidence: ['Record count'] }] }, app.learning.provenance('template', refs));
    app.store.put('focus-artifact', { date: app.automation.date(), timeZone: app.domain.profile().timeZone, profileRevision: current.profileRevision,
      scopeRevision: current.scopeRevision, modelConfigKey: current.modelKey, practiceId: value.id,
      highlights: [{ id: 'menu-highlight', title: 'Replay', summary: 'Retain one result.', goal: value.goal, whyRelevant: 'Check storage.', sourceRefs: refs }],
      sourceDigests: [{ sourceId: source.id, contentDigest: source.contentDigest }], provenance: app.learning.provenance('template', refs), generatedAt: clock.value.toISOString() }, 'menu-focus');
    return value;
  }
  const currentPractice = practice ? setPractice() : null;
  const open = async (command = '菜单') => {
    const incoming = message(command); chat.receive(incoming); await chat.drain(send);
    const outbox = app.store.all('feishu-chat-outbox').find(row => row.purpose === 'menu' && row.requestedInboxId === digest([chat.identity(), incoming.messageId]));
    return { incoming, outbox, cardId: outbox?.cardId };
  };
  const token = cardId => {
    const state = controller.state(cardId); const outbox = app.store.all('feishu-chat-outbox').find(row => row.cardId === cardId && row.cardVersion === state.version);
    const raw = JSON.stringify(outbox.card);
    return /"t":"([a-f0-9]{24})"/.exec(raw)?.[1] ?? /submit_([a-f0-9]{24})/.exec(raw)?.[1];
  };
  const event = (cardId, action, extra = {}) => ({ messageId: controller.state(cardId).messageId, chatId: 'oc_menu', operator: { openId: 'ou_menu' },
    action: { value: { v: 1, t: token(cardId), a: action } }, raw: { token: `menu_callback_${++sequence}` }, ...extra });
  const form = cardId => ({ ...event(cardId, 'submit_answer'), action: { name: `submit_${token(cardId)}` },
    raw: { token: `menu_form_${++sequence}`, action: { form_value: { answer_text: 'Replay the identity and expect one record.', assistance: 'none' } } } });
  const act = async (cardId, action, { deliver = true, flush = true } = {}) => {
    const incoming = event(cardId, action); const result = controller.receive(incoming, chat.identity()); assert.notEqual(result.toast.type, 'error', result.toast.content);
    const jobId = controller.state(cardId).actionJobId; if (jobId) await jobDone(app, { jobId });
    if (flush) await controller.flush(); if (deliver) await chat.drain(send); return incoming;
  };
  const patch = cardId => app.store.all('feishu-chat-outbox').find(row => row.cardId === cardId && row.cardVersion === controller.state(cardId).version);
  return { app, chat, controller, clock, source, practice: currentPractice, message, sent, send, open, event, form, act, patch,
    modelCalls: () => modelCalls, schedules: () => schedules };
}

for (const command of ['菜单', 'menu', '帮助', 'help']) {
  test(`${command} opens a native menu without today's practice and duplicate ingress creates nothing twice`, async t => {
    const f = await fixture(t); const opened = await f.open(command); assert.ok(opened.cardId);
    const serialized = JSON.stringify(opened.outbox.card);
    for (const action of ['menu_today', 'menu_review', 'menu_advice', 'menu_status']) assert.ok(serialized.includes(action));
    assert.ok(!serialized.includes('answer_text')); assert.equal(f.app.store.all('attempt').length, 0);
    const nonceCount = f.app.store.all('feishu-card-nonce').length;
    assert.equal(f.chat.receive(opened.incoming).duplicate, true); await f.chat.drain(f.send);
    assert.equal(f.app.store.all('feishu-chat-outbox').filter(row => row.purpose === 'menu').length, 1);
    assert.equal(f.app.store.all('feishu-card-nonce').length, nonceCount); assert.equal(f.modelCalls(), 0);
  });
}

test('menu/help with cards disabled has useful text commands and never becomes a learner answer', async t => {
  const f = await fixture(t, { practice: true, cards: false }); await f.open('帮助');
  assert.ok(f.sent.at(-1).text.includes('查看已有建议')); assert.ok(f.sent.at(-1).text.includes('当前状态'));
  assert.equal(f.app.store.all('feishu-card').length, 0); assert.equal(f.app.store.all('attempt').length, 0); assert.equal(f.modelCalls(), 0);
});

test('menu command has priority over an active suggestion discussion', async t => {
  const f = await fixture(t); let discussions = 0; f.chat.discussion = { submit() { discussions++; throw new Error('Not discussion text.'); } };
  f.chat.saveState({ activeDiscussion: { ...f.chat.discussionChannel(), feedbackId: 'old_feedback', explicit: true } });
  await f.open(); assert.equal(discussions, 0); assert.equal(f.app.store.all('attempt').length, 0);
});

for (const invalid of ['operator', 'chat', 'message', 'nonce', 'app', 'binding', 'disabled']) {
  test(`a ${invalid} mismatch rejects menu callbacks before work is queued`, async t => {
    const f = await fixture(t); const opened = await f.open(); const incoming = f.event(opened.cardId, 'menu_status'); let identity = f.chat.identity();
    if (invalid === 'operator') incoming.operator.openId = 'ou_foreign';
    if (invalid === 'chat') incoming.chatId = 'oc_foreign';
    if (invalid === 'message') incoming.messageId = 'om_unconfirmed';
    if (invalid === 'nonce') incoming.action.value.t = '0'.repeat(24);
    if (invalid === 'app') identity = 'old_application';
    if (invalid === 'binding') f.chat.pair();
    if (invalid === 'disabled') f.chat.update({ cardsEnabled: false });
    assert.equal(f.controller.receive(incoming, identity).toast.type, 'error');
    assert.equal(f.app.store.all('job').filter(row => row.kind === 'feishu_card_action').length, 0); assert.equal(f.modelCalls(), 0);
  });
}

test('unbound and foreign chat messages cannot open a menu or save a learner answer', async t => {
  const f = await fixture(t, { bound: false }); assert.equal(f.chat.receive(f.message('菜单')).ignored, true);
  assert.throws(() => f.chat.openMenu('explicit_request')); assert.equal(f.app.store.all('feishu-card').length, 0);
});

test('a foreign message cannot open a menu in the bound chat', async t => {
  const f = await fixture(t); assert.equal(f.chat.receive(f.message('菜单', { senderId: 'ou_foreign' })).ignored, true);
  assert.equal(f.app.store.all('feishu-chat-outbox').filter(row => row.purpose === 'menu').length, 0); assert.equal(f.app.store.all('attempt').length, 0);
});

test('menu status and no-practice navigation report local facts without model calls or mastery claims', async t => {
  const f = await fixture(t); const opened = await f.open();
  await f.act(opened.cardId, 'menu_status'); assert.ok(f.controller.state(opened.cardId).message.includes('尚无练习'));
  assert.ok(f.controller.state(opened.cardId).message.includes('提醒'));
  await f.act(opened.cardId, 'menu_today'); assert.equal(f.controller.state(opened.cardId).view, 'menu');
  assert.ok(f.controller.state(opened.cardId).message.includes('没有准备好的练习'));
  assert.equal(f.modelCalls(), 0); assert.equal(f.app.store.all('attempt').length, 0);
});

test('menu advice inspects existing feedback without scheduling or generating a new suggestion', async t => {
  const f = await fixture(t, { practice: true });
  const attempt = f.app.learning.attempt(f.practice.id, { output: 'Replay and count records.', assistanceLevel: 'none', evidenceRefs: [] });
  const { feedback } = f.app.learning.saveFeedback(attempt.id, 'template', { summary: 'Existing local advice.',
    observations: [{ criterionId: f.practice.rubric[0].id, finding: 'not_assessed', comment: 'Add an expected count.', evidenceRefs: [] }], nextActions: ['State one expected count.'], limitations: ['Not mastery.'] });
  const opened = await f.open(); await f.act(opened.cardId, 'menu_advice');
  assert.ok(f.app.store.all('feishu-chat-outbox').some(row => row.purpose === 'advice_discussion' && row.feedbackId === feedback.id));
  assert.equal(f.schedules(), 0); assert.equal(f.modelCalls(), 0); assert.equal(f.app.store.all('feedback').length, 1); assert.equal(f.app.store.all('output').length, 0);
  f.chat.receive(f.message('点评')); assert.equal(f.schedules(), 1);
});

test('menu advice with no authorized feedback gives a local empty state without a paid request', async t => {
  const f = await fixture(t); const opened = await f.open(); await f.act(opened.cardId, 'menu_advice');
  assert.ok(f.controller.state(opened.cardId).message.includes('没有可查看')); assert.equal(f.schedules(), 0); assert.equal(f.modelCalls(), 0);
});

test('menu review reuses the review workflow without practice and cannot create implicit knowledge', async t => {
  const f = await fixture(t); let creates = 0; let reads = 0; let epoch = 'native_epoch_1';
  f.controller.siyuan = { epoch: () => epoch };
  f.controller.reviews = { create: async () => { creates++; return { session: { id: 'menu_review_session' } }; },
    next: async () => { reads++; return { state: 'empty' }; } };
  const opened = await f.open(); await f.act(opened.cardId, 'menu_review');
  const state = f.controller.state(opened.cardId); assert.equal(state.phase, 'no_due_cards'); assert.equal(creates, 1); assert.equal(reads, 1);
  assert.ok(!state.actions.some(item => item.a === 'create_flashcard')); assert.equal(f.app.store.all('knowledge').length, 0);
  epoch = 'native_epoch_2'; assert.equal(f.controller.receive(f.event(opened.cardId, 'refresh'), f.chat.identity()).toast.type, 'error');
  assert.equal(f.modelCalls(), 0);
});

for (const mode of ['form', 'text']) {
  test(`menu opens the current question on its confirmed message and permits ${mode} answers only after patch confirmation`, async t => {
    const f = await fixture(t, { practice: true }); f.chat.sendToday({ interactive: true });
    let old = f.app.store.all('feishu-chat-outbox').find(row => row.purpose === 'learning_card');
    old = f.app.store.put('feishu-chat-outbox', { ...old, status: 'uncertain', attempts: 1 }, old.id);
    const opened = await f.open(); const menuMessageId = f.controller.state(opened.cardId).messageId;
    const deliveryId = digest([f.chat.identity(), menuMessageId]);
    const click = await f.act(opened.cardId, 'menu_today', { deliver: false, flush: false });
    const beforePatch = f.controller.state(opened.cardId);
    assert.equal(beforePatch.version, beforePatch.confirmedVersion); assert.equal(beforePatch.requiredPracticeVersion, beforePatch.version + 1);
    assert.equal(f.controller.receive(f.form(opened.cardId), f.chat.identity()).toast.type, 'error');
    f.chat.receive(f.message('Before patch queue.', { replyToMessageId: menuMessageId }));
    assert.equal(f.app.store.get('feishu-chat-delivery', deliveryId), null); assert.equal(f.app.store.all('attempt').length, 0);
    await f.controller.flush(); const patch = f.patch(opened.cardId);
    assert.equal(patch.updateMessageId, menuMessageId); assert.equal(f.app.store.get('feishu-chat-delivery', deliveryId), null);
    assert.equal(f.controller.receive(f.form(opened.cardId), f.chat.identity()).toast.type, 'error');
    f.chat.receive(f.message('Not yet accepted.', { replyToMessageId: menuMessageId })); assert.equal(f.app.store.all('attempt').length, 0);
    let releaseSend;
    const accepted = new Promise(resolve => { releaseSend = resolve; });
    const delivery = f.chat.deliver(patch, async value => { await accepted; return f.send(value); });
    assert.equal(f.app.store.require('feishu-chat-outbox', patch.id).status, 'sending');
    assert.equal(f.controller.receive(f.form(opened.cardId), f.chat.identity()).toast.type, 'error');
    f.chat.receive(f.message('While patch is sending.', { replyToMessageId: menuMessageId }));
    assert.equal(f.app.store.get('feishu-chat-delivery', deliveryId), null); assert.equal(f.app.store.all('attempt').length, 0);
    releaseSend(); await delivery; assert.ok(f.app.store.get('feishu-chat-delivery', deliveryId));
    if (mode === 'form') assert.equal(f.controller.receive(f.form(opened.cardId), f.chat.identity()).toast.type, 'success');
    else assert.ok(f.chat.receive(f.message('My observable replay check.', { replyToMessageId: menuMessageId })).attemptId);
    assert.equal(f.app.store.all('attempt').length, 1);
    assert.notEqual(f.controller.receive(click, f.chat.identity()).toast.type, 'error'); assert.equal(f.app.store.all('attempt').length, 1);
    assert.deepEqual(f.app.store.require('feishu-chat-outbox', old.id), old); assert.equal(f.modelCalls(), 0);
  });
}

for (const changed of ['source', 'binding', 'answer']) {
  test(`a ${changed} change cancels a pending menu-practice patch without binding an answer target`, async t => {
    const f = await fixture(t, { practice: true }); const opened = await f.open(); const messageId = f.controller.state(opened.cardId).messageId;
    await f.act(opened.cardId, 'menu_today', { deliver: false }); const patch = f.patch(opened.cardId);
    if (changed === 'source') f.app.sources.capture({ ...f.source, content: 'Changed material.' });
    if (changed === 'binding') f.chat.pair();
    if (changed === 'answer') f.app.learning.attempt(f.practice.id, { output: 'Saved elsewhere.', assistanceLevel: 'none', evidenceRefs: [] });
    assert.equal(f.chat.claim(patch.id), null); assert.equal(f.app.store.require('feishu-chat-outbox', patch.id).status, 'cancelled');
    assert.equal(f.app.store.get('feishu-chat-delivery', digest([patch.appIdentity, messageId])), null); assert.equal(f.app.store.all('attempt').length, changed === 'answer' ? 1 : 0);
  });
}

test('already-sent today requests get an explicit status without a new learning-card operation', async t => {
  const f = await fixture(t, { practice: true }); f.chat.receive(f.message('今日练习')); await f.chat.drain(f.send);
  const old = f.app.store.all('feishu-chat-outbox').find(row => row.purpose === 'learning_card'); const count = f.sent.length;
  f.chat.receive(f.message('今日练习')); await f.chat.drain(f.send);
  assert.equal(f.app.store.all('feishu-chat-outbox').filter(row => row.purpose === 'learning_card').length, 1);
  assert.deepEqual(f.app.store.require('feishu-chat-outbox', old.id), old); assert.ok(f.sent.slice(count).some(row => !row.card && row.text.includes('此前已发送')));
});

for (const kind of ['menu', 'today']) for (const uncertain of [false, true]) {
  test(`terminal ${uncertain ? 'uncertain' : 'failed'} ${kind} delivery records a safe error and sends one text notice without replay`, async t => {
    const f = await fixture(t, { practice: kind === 'today' }); f.chat.receive(f.message(kind === 'menu' ? '菜单' : '今日练习'));
    const sends = []; const send = async value => {
      sends.push(value); if (!value.card) return { messageId: 'om_notice' };
      const error = uncertain ? new Error('RAW_SDK_SECRET_MESSAGE') : new ApiError(400, 'FEISHU_REQUEST_REJECTED', 'RAW_SDK_SECRET_MESSAGE');
      error.uncertain = uncertain; error.providerCode = uncertain ? 'private_non_numeric' : 200318; throw error;
    };
    await f.chat.drain(send); const source = f.app.store.all('feishu-chat-outbox').find(row => row.card);
    assert.equal(source.status, uncertain ? 'uncertain' : 'failed'); assert.equal(source.attempts, 1);
    assert.equal(source.lastError.code, uncertain ? 'INTERNAL_ERROR' : 'FEISHU_REQUEST_REJECTED');
    assert.equal(source.lastError.providerCode, uncertain ? undefined : 200318);
    assert.ok(!JSON.stringify(source.lastError).includes('RAW_SDK_SECRET_MESSAGE'));
    const notices = f.app.store.all('feishu-chat-outbox').filter(row => row.purpose === 'delivery_notice'); assert.equal(notices.length, 1); assert.equal(notices[0].status, 'sent');
    assert.ok(!notices[0].text.includes('PRIVATE_SOURCE_MARKER')); assert.equal(sends.filter(row => row.card).length, 1);
    await f.chat.drain(send); assert.equal(sends.length, 2); assert.deepEqual(f.app.store.require('feishu-chat-outbox', source.id), source);
  });
}

test('a failed notice stays closed and never produces a recursive notice or card resend', async t => {
  const f = await fixture(t); f.chat.receive(f.message('菜单')); let sends = 0;
  const failSend = async () => { sends++; throw new Error('Synthetic ambiguous failure.'); };
  await f.chat.drain(failSend); await f.chat.drain(failSend);
  assert.equal(sends, 2); assert.equal(f.app.store.all('feishu-chat-outbox').filter(row => row.purpose === 'delivery_notice').length, 1);
});

test('scheduled cards and pre-existing uncertain rows never generate user-request notices', async t => {
  const f = await fixture(t, { practice: true }); f.chat.tick();
  await f.chat.drain(async () => { throw new Error('Synthetic failure.'); });
  assert.equal(f.app.store.all('feishu-chat-outbox').filter(row => row.purpose === 'delivery_notice').length, 0);
  const old = f.app.store.all('feishu-chat-outbox').find(row => row.card); await f.chat.drain(f.send);
  assert.deepEqual(f.app.store.require('feishu-chat-outbox', old.id), old);
});

for (const change of ['source', 'binding']) {
  test(`terminal delivery after a ${change} change emits no notice to a stale recipient or context`, async t => {
    const f = await fixture(t, { practice: true }); f.chat.receive(f.message('今日练习')); let sends = 0;
    await f.chat.drain(async () => {
      sends++; if (change === 'source') f.app.sources.capture({ ...f.source, content: 'Revoked material.' }); else f.chat.pair();
      throw new Error('Synthetic failure.');
    });
    assert.equal(sends, 1); assert.equal(f.app.store.all('feishu-chat-outbox').filter(row => row.purpose === 'delivery_notice').length, 0);
  });
}

test('open-menu API is an explicit idempotent fresh intent and rejects unbound access', async t => {
  const f = await fixture(t); const op = operation();
  const first = await request(f.app, 'POST', '/feishu-chat/open-menu', { operationId: op }); assert.equal(first.status, 200); assert.equal(first.data.queued, true);
  const repeated = await request(f.app, 'POST', '/feishu-chat/open-menu', { operationId: op }); assert.deepEqual(repeated.data, first.data);
  assert.equal(f.app.store.all('feishu-chat-outbox').filter(row => row.purpose === 'menu').length, 1);
  assert.equal((await request(f.app, 'POST', '/feishu-chat/open-menu', { invented: true })).status, 422);
  f.chat.pair(); assert.equal((await request(f.app, 'POST', '/feishu-chat/open-menu', {})).status, 409);
  assert.equal(f.modelCalls(), 0); assert.equal(f.app.store.all('attempt').length, 0);
});
