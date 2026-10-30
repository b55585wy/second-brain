import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuChat } from '../../server/feishu-chat.mjs';
import { FeishuCardActions } from '../../server/feishu-card-actions.mjs';
import { appFor, profile, fakeSiyuan, configureSiyuan, syncedKnowledge, jobDone } from './helpers.mjs';

async function fixture(t, { bind = true, native = false } = {}) {
  const app = await appFor(t); const clock = { value: new Date('2026-10-30T01:00:00Z') };
  app.automation.clock = () => clock.value;
  await profile(app, { goals: ['解释可靠存储'], dailyBudgetMinutes: 15 });
  const settings = app.settings.raw();
  app.store.put('config', { ...settings, feishu: { ...settings.feishu, enabled: true, appId: 'cli_card_fixture' } }, 'settings');
  const secrets = { get: key => key === 'feishu.appSecret' ? 'synthetic-card-secret' : null };
  const adviceStates = new Map(); let modelCalls = 0; let adviceRequests = 0;
  const advice = { public: id => adviceStates.get(id) ?? { attemptId: id, status: 'off', message: '自动点评已关闭。', canRetry: false, canRequest: false, feedback: null },
    schedule: (id, options) => { adviceRequests++; return advice.public(id); } };
  app.learning.onAttempt = null; app.learning.advice = advice;
  app.model.generate = async () => { modelCalls++; throw new Error('Real model calls forbidden in card tests.'); };
  const chat = new FeishuChat(app.store, app.settings, secrets, app.domain, app.automation, app.learning, { clock: () => clock.value });
  const cards = new FeishuCardActions(app.store, chat, advice, app.learning, app.domain, app.reviews, app.siyuan, app.jobs, { clock: () => clock.value });
  chat.cards = cards; app.jobs.register('feishu_card_action', (payload, job) => cards.run(payload, job));
  const source = app.sources.capture({ kind: 'manual', externalId: 'card-source', title: '重放检查', content: '同一操作重放不能增加记录。' });
  const refs = [app.sources.ref(source)];
  const practice = app.learning.createPractice({ projectId: null, kind: 'new_scenario', goal: app.domain.profile().goals[0], skill: '',
    prompt: '提出一次重放检查并写明预期结果。', estimatedMinutes: 5, sourceRefs: refs,
    rubric: [{ label: '依据', description: '说明可观察的结果。', expectedEvidence: ['重放后记录数不增加'] }] }, app.learning.provenance('template', refs));
  const context = app.automation.context();
  app.store.put('focus-artifact', { date: app.automation.date(), timeZone: app.domain.profile().timeZone,
    profileRevision: context.profileRevision, scopeRevision: context.scopeRevision, modelConfigKey: context.modelKey,
    highlights: [{ id: 'fixture-highlight', title: '重放去重', summary: '同一身份的操作只保存一次。', goal: practice.goal,
      whyRelevant: '用具体结果验证可靠存储。', sourceRefs: refs }], sourceDigests: [{ sourceId: source.id, contentDigest: source.contentDigest }],
    practiceId: practice.id, provenance: app.learning.provenance('template', refs), generatedAt: clock.value.toISOString() }, 'fixture-focus');
  chat.update({ enabled: true, cardsEnabled: true });
  const sent = []; let sequence = 0;
  const send = async input => { sent.push(input); return { messageId: input.updateMessageId ?? `om_card_${sent.length}` }; };
  const message = content => ({ messageId: `om_in_${++sequence}`, chatId: 'oc_card_self', senderId: 'ou_card_self', chatType: 'p2p', senderType: 'user', content, createTime: +clock.value });
  const pair = chat.pair(); chat.receive(message(`绑定 ${pair.code}`));
  if (bind) await chat.drain(send);
  const initialCardId = app.store.all('feishu-card').find(card => card.practiceId === practice.id && card.section === 'practice')?.id;
  const initial = () => cards.state(initialCardId);
  const token = id => {
    const state = cards.state(id); const item = app.store.all('feishu-chat-outbox').find(row => row.cardId === id && row.cardVersion === state.version);
    const serialized = JSON.stringify(item.card);
    return /submit_([a-f0-9]{24})/.exec(serialized)?.[1] ?? /"t":"([a-f0-9]{24})"/.exec(serialized)?.[1];
  };
  const event = (name, values = {}) => {
    const card = cards.state(values.cardId ?? initial().id); const currentToken = values.token ?? token(card.id);
    const base = { messageId: card.messageId, chatId: 'oc_card_self', operator: { openId: 'ou_card_self' },
      action: { value: { v: 1, t: currentToken, a: name } }, raw: { token: `callback_${++sequence}` } };
    return { ...base, ...values };
  };
  const form = (answer = '我会重放同一个操作，并检查记录总数没有增加。', assistance = 'none', values = {}) => {
    const value = event('submit_answer', values); const cardId = values.cardId ?? initial().id;
    return { ...value, action: { name: `submit_${values.token ?? token(cardId)}` },
      raw: { token: value.raw.token, action: { form_value: { answer_text: answer, assistance } } } };
  };
  const perform = async (incoming, expected = 'succeeded') => {
    const reply = cards.receive(incoming, chat.identity()); assert.notEqual(reply.toast.type, 'error', reply.toast.content);
    const queued = app.store.all('job').find(job => job.kind === 'feishu_card_action' && ['queued', 'running'].includes(job.status));
    if (queued) await jobDone(app, { jobId: queued.id }, expected);
    await cards.flush(); await chat.drain(send); return reply;
  };
  const prepareAdvice = async () => {
    const attempt = app.learning.attempt(practice.id, { output: '我会重放并对比记录数。', assistanceLevel: 'none', evidenceRefs: [] });
    const feedback = app.learning.saveFeedback(attempt.id, 'model', { summary: '已有可检查的思路。',
      observations: [{ criterionId: practice.rubric[0].id, finding: 'partial', comment: '补上预期的数值变化。', evidenceRefs: [] }],
      nextActions: ['写明重放前后的记录数。'], limitations: ['这是本次回答的建议，尚未核验领域事实。'] }).feedback;
    adviceStates.set(attempt.id, { attemptId: attempt.id, status: 'ready', feedback, message: '建议已准备好。', canRequest: false, canRetry: false });
    const inbox = { id: 'advice_fixture', attemptId: attempt.id, practiceId: practice.id, practiceContext: chat.context(app.automation.today()) };
    const outbox = chat.queue('advice_fixture', '本次回答建议。', { purpose: 'advice', attemptId: attempt.id, practiceId: practice.id, practiceContext: inbox.practiceContext });
    const decorated = cards.decorateAdvice(outbox, inbox, advice.public(attempt.id));
    await chat.drain(send); return { attempt, feedback, cardId: decorated.cardId };
  };
  const upstream = native ? await fakeSiyuan(t) : null;
  if (upstream) await configureSiyuan(app, upstream);
  return { app, clock, chat, cards, sent, send, message, source, practice, adviceStates, initial, token, event, form, perform, prepareAdvice,
    upstream, modelCalls: () => modelCalls, adviceRequests: () => adviceRequests };
}

test('practice decoration issues one stable scoped nonce and waits for confirmed message identity', async t => {
  const f = await fixture(t); const state = f.initial(); const outbox = f.app.store.require('feishu-chat-outbox', state.id);
  assert.equal(state.messageId, 'om_card_1'); assert.equal(state.version, 1);
  assert.equal(f.cards.decoratePractice(outbox, f.app.automation.today()).cardId, state.id);
  assert.equal(f.app.store.all('feishu-card').length, 1); assert.equal(f.app.store.all('feishu-card-nonce').length, 1);
  assert.ok(!JSON.stringify(state).includes(f.token(state.id))); assert.equal(f.modelCalls(), 0);
});

test('callbacks before send confirmation cannot submit an answer', async t => {
  const f = await fixture(t, { bind: false });
  assert.equal(f.cards.receive(f.form(), f.chat.identity()).toast.type, 'error');
  assert.equal(f.app.store.all('attempt').length, 0);
});

for (const invalid of ['operator', 'chat', 'message', 'nonce', 'app', 'binding', 'disabled', 'connection disabled', 'source']) {
  test(`a ${invalid} mismatch rejects the callback without saving or queueing an action`, async t => {
    const f = await fixture(t); let event = f.form(); let identity = f.chat.identity();
    if (invalid === 'operator') event.operator = { openId: 'ou_other' };
    if (invalid === 'chat') event.chatId = 'oc_other';
    if (invalid === 'message') event.messageId = 'om_other';
    if (invalid === 'nonce') event.action.name = 'submit_' + '0'.repeat(24);
    if (invalid === 'app') identity = 'different-app-identity';
    if (invalid === 'binding') f.chat.pair();
    if (invalid === 'disabled') f.chat.update({ cardsEnabled: false });
    if (invalid === 'connection disabled') {
      const config = f.app.settings.raw();
      f.app.store.put('config', { ...config, feishu: { ...config.feishu, enabled: false } }, 'settings');
    }
    if (invalid === 'source') f.app.sources.capture({ ...f.source, content: '材料已更新。' });
    assert.equal(f.cards.receive(event, identity).toast.type, 'error');
    assert.equal(f.app.store.all('attempt').length, 0);
    assert.equal(f.app.store.all('job').filter(job => job.kind === 'feishu_card_action').length, 0);
    assert.equal(f.chat.public().lastCardActionAt, null);
  });
}

test('form submission stores the existing answer once and never persists the raw callback token or form', async t => {
  const f = await fixture(t); const answer = '唯一的本次回答片段，检查重放后的记录数。';
  const incoming = f.form(answer, 'hint'); incoming.raw.token = 'PRIVATE_CALLBACK_TOKEN_MARKER';
  await f.perform(incoming);
  const attempts = f.app.store.all('attempt'); assert.equal(attempts.length, 1);
  assert.equal(attempts[0].output, answer); assert.equal(attempts[0].assistanceLevel, 'hint');
  const events = JSON.stringify(f.app.store.all('feishu-card-event'));
  assert.ok(!events.includes(answer)); assert.ok(!events.includes(incoming.raw.token));
  assert.ok(!JSON.stringify(f.app.store.all('job')).includes(answer)); assert.equal(f.modelCalls(), 0);
});

test('same callback and distinct duplicate callback deliveries cannot repeat answer processing', async t => {
  const f = await fixture(t); await f.app.jobs.stop(); const incoming = f.form();
  assert.equal(f.cards.receive(incoming, f.chat.identity()).toast.type, 'success');
  assert.notEqual(f.cards.receive(incoming, f.chat.identity()).toast.type, 'error');
  const repeat = structuredClone(incoming); repeat.raw.token = 'another_sdk_delivery';
  assert.notEqual(f.cards.receive(repeat, f.chat.identity()).toast.type, 'error');
  assert.equal(f.app.store.all('attempt').length, 1);
  assert.equal(f.app.store.all('job').filter(job => job.kind === 'feishu_card_action').length, 1);
  f.app.jobs.start();
});

for (const [label, answer, assistance] of [['empty', '  ', 'none'], ['too long', '答'.repeat(1001), 'none'],
  ['invalid assistance', '一次回答', 'spoofed'], ['non-text assistance', '一次回答', ['none']]]) {
  test(`${label} form input produces no saved answer or action job`, async t => {
    const f = await fixture(t);
    assert.equal(f.cards.receive(f.form(answer, assistance), f.chat.identity()).toast.type, 'error');
    assert.equal(f.app.store.all('attempt').length, 0);
  });
}

test('form input accepts the platform maximum and records unknown assistance truthfully', async t => {
  const f = await fixture(t); await f.perform(f.form('答'.repeat(1000), 'unknown'));
  assert.equal([...f.app.store.all('attempt')[0].output].length, 1000);
  assert.equal(f.app.store.all('attempt')[0].assistanceLevel, 'unknown');
});

test('unsupported actions and malformed callback values cannot invoke business operations', async t => {
  const f = await fixture(t);
  for (const value of [{ v: 2, t: f.token(f.initial().id), a: 'flashcards' }, { v: 1, t: f.token(f.initial().id), a: 'delete_everything' }]) {
    const event = f.event('refresh'); event.action = { value };
    assert.equal(f.cards.receive(event, f.chat.identity()).toast.type, 'error');
  }
  assert.equal(f.app.store.all('feishu-card-event').length, 0);
});

test('saving advice creates exactly one linked output and dismissing never deletes history', async t => {
  const f = await fixture(t); const ready = await f.prepareAdvice();
  const originalAnswer = f.app.store.require('attempt', ready.attempt.id).output;
  await f.perform(f.event('save_advice', { cardId: ready.cardId }));
  const decision = f.app.store.require('advice-selection', ready.feedback.id);
  assert.equal(decision.state, 'saved'); assert.equal(f.app.store.all('output').length, 1);
  assert.equal(f.app.store.require('output', decision.outputId).practiceId, f.practice.id);
  await f.perform(f.event('dismiss_advice', { cardId: ready.cardId }));
  assert.equal(f.app.store.require('advice-selection', ready.feedback.id).state, 'dismissed');
  assert.equal(f.app.store.all('output').length, 1); assert.equal(f.app.store.require('attempt', ready.attempt.id).output, originalAnswer);
  assert.ok(f.app.store.get('feedback', ready.feedback.id));
  await f.perform(f.event('save_advice', { cardId: ready.cardId }));
  assert.equal(f.app.store.require('advice-selection', ready.feedback.id).outputId, decision.outputId);
  assert.equal(f.app.store.all('output').length, 1);
});

test('same save event is durable and cannot create a second output', async t => {
  const f = await fixture(t); const ready = await f.prepareAdvice(); await f.app.jobs.stop();
  const incoming = f.event('save_advice', { cardId: ready.cardId });
  f.cards.receive(incoming, f.chat.identity()); f.cards.receive(incoming, f.chat.identity());
  f.app.jobs.start();
  const queued = f.app.store.all('job').find(job => job.kind === 'feishu_card_action');
  await jobDone(f.app, { jobId: queued.id }); await f.cards.flush(); await f.chat.drain(f.send);
  assert.equal(f.app.store.all('output').length, 1); assert.equal(f.app.store.all('advice-selection-event').length, 1);
});

test('rebinding after a queued save prevents the late action from changing outputs', async t => {
  const f = await fixture(t); const ready = await f.prepareAdvice(); await f.app.jobs.stop();
  const incoming = f.event('save_advice', { cardId: ready.cardId }); f.cards.receive(incoming, f.chat.identity());
  const job = f.app.store.all('job').find(item => item.kind === 'feishu_card_action');
  f.chat.pair(); f.app.jobs.start(); await jobDone(f.app, { jobId: job.id }, 'failed');
  await f.cards.flush(); assert.equal(f.app.store.all('output').length, 0);
});

test('an updated card turns old business actions into resync only and rejects old patch versions', async t => {
  const f = await fixture(t); const id = f.initial().id; const oldToken = f.token(id);
  await f.perform(f.form()); const state = f.cards.state(id);
  assert.ok(state.version > 1); assert.notEqual(f.token(id), oldToken);
  assert.notEqual(f.cards.receive(f.event('flashcards', { token: oldToken }), f.chat.identity()).toast.type, 'error');
  const recovery = f.app.store.require('job', f.cards.state(id).actionJobId);
  assert.equal(recovery.payload.action, 'resync'); assert.equal(f.modelCalls(), 0);
  assert.equal(f.cards.deliverable({ cardId: id, cardVersion: state.version - 1, updateMessageId: state.messageId }), false);
  assert.equal(f.cards.deliverable({ cardId: id, cardVersion: state.version, updateMessageId: state.messageId }), true);
});

for (const status of ['failed', 'uncertain']) {
  test(`an old visible card can recover a ${status} update without executing its stale save action`, async t => {
    const f = await fixture(t); const ready = await f.prepareAdvice(); const oldToken = f.token(ready.cardId);
    f.cards.update(ready.cardId, {}); await f.cards.flush();
    const failedPatch = f.app.store.all('feishu-chat-outbox').find(item => item.cardId === ready.cardId
      && item.cardVersion === f.cards.state(ready.cardId).version);
    f.app.store.put('feishu-chat-outbox', { ...failedPatch, status, attempts: 1 }, failedPatch.id);
    const recovery = f.event('save_advice', { cardId: ready.cardId, token: oldToken });
    await f.perform(recovery);
    assert.equal(f.app.store.all('output').length, 0); assert.equal(f.app.store.all('advice-selection').length, 0);
    assert.equal(f.app.store.require('feishu-chat-outbox', failedPatch.id).status, status);
    assert.equal(f.modelCalls(), 0); assert.notEqual(f.token(ready.cardId), oldToken);
    await f.perform(f.event('save_advice', { cardId: ready.cardId }));
    assert.equal(f.app.store.all('output').length, 1);
  });
}

test('a newer answer to the same practice invalidates the older answer advice card', async t => {
  const f = await fixture(t); const ready = await f.prepareAdvice();
  const originalContext = f.cards.state(ready.cardId).context;
  const newer = f.app.learning.attempt(f.practice.id, { output: '这是后来更新的回答。', assistanceLevel: 'none', evidenceRefs: [] });
  f.app.store.put('attempt', { ...newer, submittedAt: new Date(+new Date(ready.attempt.submittedAt) + 1000).toISOString() }, newer.id);
  assert.equal(f.chat.context(f.app.automation.today()), originalContext);
  assert.equal(f.cards.receive(f.event('save_advice', { cardId: ready.cardId }), f.chat.identity()).toast.type, 'error');
  assert.equal(f.app.store.all('output').length, 0); assert.ok(f.app.store.get('feedback', ready.feedback.id));
  f.cards.save(ready.cardId, { view: 'status', section: 'advice' });
  assert.equal(f.cards.receive(f.event('retry_advice', { cardId: ready.cardId }), f.chat.identity()).toast.type, 'error');
});

test('no due flashcards offers explicit creation without a model or implicit native write', async t => {
  const f = await fixture(t, { native: true });
  const before = f.upstream.calls.length;
  await f.perform(f.event('flashcards'));
  const state = f.cards.state(f.initial().id);
  assert.equal(state.phase, 'no_due_cards');
  assert.ok(state.actions.some(item => item.a === 'create_flashcard'));
  const paths = f.upstream.calls.slice(before).map(call => call.path);
  assert.ok(!paths.includes('/api/riff/createRiffDeck')); assert.ok(!paths.includes('/api/riff/reviewRiffCard'));
  assert.equal(f.app.store.all('knowledge').length, 0); assert.equal(f.modelCalls(), 0);
});

test('explicit creation preserves unverified knowledge and uses one standard sync job', async t => {
  const f = await fixture(t, { native: true }); await f.perform(f.event('flashcards'));
  await f.perform(f.event('create_flashcard'));
  let state = f.cards.state(f.initial().id);
  if (state.monitorJobId) await jobDone(f.app, { jobId: state.monitorJobId });
  await f.cards.flush(); await f.chat.drain(f.send);
  state = f.cards.state(state.id); assert.equal(state.view, 'flashcard'); assert.equal(state.revealed, false);
  const knowledge = f.app.store.all('knowledge'); assert.equal(knowledge.length, 1);
  assert.equal(knowledge[0].status, 'accepted'); assert.equal(knowledge[0].validation.status, 'unverified');
  assert.equal(knowledge[0].question, '请回忆「重放去重」的关键要点。');
  assert.equal(f.app.store.all('job').filter(job => job.kind === 'knowledge_sync').length, 1);
  assert.equal(f.upstream.state.cards.length, 1); assert.equal(f.modelCalls(), 0);
});

test('native flashcards require reveal and delegate a single rating to the existing review worker', async t => {
  const f = await fixture(t, { native: true });
  await syncedKnowledge(f.app, f.upstream, { question: '记忆问题', answer: '独立回忆之后才能看到的答案' });
  await f.perform(f.event('flashcards')); const id = f.initial().id;
  assert.equal(f.cards.state(id).revealed, false);
  const pendingCard = f.app.store.all('feishu-chat-outbox').find(item => item.cardId === id && item.cardVersion === f.cards.state(id).version);
  assert.ok(!JSON.stringify(pendingCard.card).includes('独立回忆之后才能看到的答案'));
  assert.equal(f.cards.receive(f.event('rate_good'), f.chat.identity()).toast.type, 'error');
  await f.perform(f.event('reveal_card')); assert.equal(f.cards.state(id).revealed, true);
  const rating = f.event('rate_good'); await f.app.jobs.stop();
  const before = f.upstream.state.grades.length;
  assert.equal(f.cards.receive(rating, f.chat.identity()).toast.type, 'success');
  assert.equal(f.upstream.state.grades.length, before);
  assert.notEqual(f.cards.receive(rating, f.chat.identity()).toast.type, 'error');
  f.app.jobs.start();
  const generic = f.app.store.all('job').find(job => job.kind === 'feishu_card_action' && job.status === 'queued');
  await jobDone(f.app, { jobId: generic.id });
  const state = f.cards.state(id); assert.ok(state.monitorJobId);
  const ratingJob = f.app.store.require('job', state.monitorJobId);
  assert.equal(ratingJob.kind, 'review_response'); assert.notEqual(ratingJob.id, generic.id);
  assert.notEqual(ratingJob.operationId, generic.operationId);
  await jobDone(f.app, { jobId: state.monitorJobId }); await f.cards.flush(); await f.chat.drain(f.send);
  assert.equal(f.upstream.state.grades.length, before + 1); assert.equal(f.upstream.state.grades.at(-1).rating, 3);
  assert.equal(f.app.store.all('review-response').length, 1);
  assert.equal(f.app.store.all('job').filter(job => job.kind === 'review_response').length, 1);
});

test('only an accepted callback records the current binding confirmation time and duplicates retain it', async t => {
  const f = await fixture(t); await f.app.jobs.stop();
  assert.equal(f.chat.public().lastCardActionAt, null);
  const incoming = f.event('refresh'); assert.equal(f.cards.receive(incoming, f.chat.identity()).toast.type, 'success');
  const confirmedAt = f.clock.value.toISOString(); assert.equal(f.chat.public().lastCardActionAt, confirmedAt);
  const state = f.chat.state(); assert.equal(state.lastCardAppIdentity, f.chat.identity());
  assert.equal(state.lastCardBindingEpoch, f.chat.binding().epoch);
  f.clock.value = new Date(+f.clock.value + 1000);
  assert.notEqual(f.cards.receive(incoming, f.chat.identity()).toast.type, 'error');
  assert.equal(f.chat.public().lastCardActionAt, confirmedAt);
});

test('failed local acceptance cannot set the card callback confirmation marker', async t => {
  const f = await fixture(t); f.cards.jobs = { enqueue() { throw new Error('Synthetic queue failure'); } };
  assert.equal(f.cards.receive(f.event('refresh'), f.chat.identity()).toast.type, 'error');
  assert.equal(f.chat.public().lastCardActionAt, null); assert.equal(f.app.store.all('feishu-card-event').length, 0);
});

test('rebinding hides the previous callback marker until a new binding accepts a card action', async t => {
  const f = await fixture(t); await f.app.jobs.stop(); f.cards.receive(f.event('refresh'), f.chat.identity());
  const oldEpoch = f.chat.binding().epoch; const oldTime = f.chat.public().lastCardActionAt; assert.ok(oldTime);
  const pair = f.chat.pair(); assert.equal(f.chat.public().lastCardActionAt, null);
  assert.equal(f.chat.receive(f.message(`绑定 ${pair.code}`)).bound, true);
  assert.notEqual(f.chat.binding().epoch, oldEpoch); assert.equal(f.chat.public().lastCardActionAt, null);
  assert.equal(f.chat.state().lastCardActionAt, oldTime);
});

for (const changed of ['app', 'credentials']) {
  test(`changed ${changed} hides the old card callback marker`, async t => {
    const f = await fixture(t); await f.app.jobs.stop(); f.cards.receive(f.event('refresh'), f.chat.identity());
    assert.ok(f.chat.public().lastCardActionAt);
    if (changed === 'app') {
      const config = f.app.settings.raw();
      f.app.store.put('config', { ...config, feishu: { ...config.feishu, appId: 'cli_new_fixture' } }, 'settings');
    } else f.chat.secrets = { get: key => key === 'feishu.appSecret' ? 'changed-synthetic-secret' : null };
    assert.equal(f.chat.public().lastCardActionAt, null); assert.equal(f.chat.public().bound, false);
  });
}

test('explicit interactive entry opens a completed practice with advice and memory actions but no answer form', async t => {
  const f = await fixture(t);
  const attempt = f.app.learning.attempt(f.practice.id, { output: 'My answer is already saved.', assistanceLevel: 'none', evidenceRefs: [] });
  const ack = f.chat.sendToday({ interactive: true }); assert.equal(ack.queued, true);
  const item = f.app.store.all('feishu-chat-outbox').find(row => row.purpose === 'learning_card');
  assert.equal(item.attemptId, attempt.id); assert.equal(f.chat.deliverable(item), true);
  const serialized = JSON.stringify(item.card);
  assert.ok(!serialized.includes('"tag":"form"')); assert.ok(!serialized.includes('"name":"answer_text"'));
  assert.ok(serialized.includes('"a":"flashcards"')); assert.ok(serialized.includes('"a":"view_advice"'));
  await f.chat.drain(f.send);
  assert.equal(f.app.store.require('feishu-chat-outbox', item.id).status, 'sent');
  assert.ok(f.cards.state(item.id).messageId); assert.equal(f.modelCalls(), 0);
});

test('completed practice stays excluded from ordinary reminders and cards-disabled interactive requests', async t => {
  const f = await fixture(t);
  f.app.learning.attempt(f.practice.id, { output: 'Saved already.', assistanceLevel: 'none', evidenceRefs: [] });
  const before = f.app.store.all('feishu-chat-outbox').length;
  assert.equal(f.chat.sendToday().completed, true); f.chat.tick();
  f.chat.update({ cardsEnabled: false });
  assert.equal(f.chat.sendToday({ interactive: true }).completed, true);
  assert.equal(f.app.store.all('feishu-chat-outbox').length, before); assert.equal(f.modelCalls(), 0);
});

test('repeated learning commands acknowledge status while reusing one interactive card without model calls', async t => {
  const f = await fixture(t);
  f.app.learning.attempt(f.practice.id, { output: 'Saved already.', assistanceLevel: 'none', evidenceRefs: [] });
  f.chat.receive(f.message('今日练习')); await f.chat.drain(f.send);
  const item = f.app.store.all('feishu-chat-outbox').find(row => row.purpose === 'learning_card'); assert.ok(item);
  const before = f.sent.length;
  f.chat.receive(f.message('开始学习')); f.chat.receive(f.message('今日练习')); await f.chat.drain(f.send);
  assert.equal(f.app.store.all('feishu-chat-outbox').filter(row => row.purpose === 'learning_card').length, 1);
  const notices = f.sent.slice(before); assert.equal(notices.length, 2);
  assert.ok(notices.every(item => !item.card && typeof item.text === 'string' && item.text.length > 0 && item.text.length <= 500));
  assert.equal(f.chat.sendToday({ interactive: true }).alreadySent, true);
  assert.equal(f.app.store.all('job').filter(job => job.kind === 'feishu_card_action').length, 0);
  assert.equal(f.modelCalls(), 0);
});

for (const changed of ['new answer', 'newer answer', 'source', 'day', 'disabled', 'card version']) {
  test(`a pending interactive card is cancelled after a ${changed} change`, async t => {
    const f = await fixture(t); let original = null;
    if (changed === 'newer answer') original = f.app.learning.attempt(f.practice.id, { output: 'Original answer.', assistanceLevel: 'none', evidenceRefs: [] });
    f.chat.sendToday({ interactive: true });
    const item = f.app.store.all('feishu-chat-outbox').find(row => row.purpose === 'learning_card');
    assert.equal(item.attemptId, original?.id ?? null);
    if (changed.includes('answer')) {
      const newer = f.app.learning.attempt(f.practice.id, { output: 'New saved answer.', assistanceLevel: 'none', evidenceRefs: [] });
      if (original) f.app.store.put('attempt', { ...newer, submittedAt: new Date(+new Date(original.submittedAt) + 1000).toISOString() }, newer.id);
    }
    if (changed === 'source') f.app.sources.capture({ ...f.source, content: 'The source material changed.' });
    if (changed === 'day') f.clock.value = new Date(+f.clock.value + 86400000);
    if (changed === 'disabled') f.chat.update({ cardsEnabled: false });
    if (changed === 'card version') f.cards.save(item.id, { version: 2 });
    assert.equal(f.chat.claim(item.id), null);
    assert.equal(f.app.store.require('feishu-chat-outbox', item.id).status, 'cancelled');
    assert.equal(f.modelCalls(), 0);
  });
}

test('an unanswered interactive card permits long text reply fallback even with reminders paused', async t => {
  const f = await fixture(t); f.chat.sendToday({ interactive: true });
  const item = f.app.store.all('feishu-chat-outbox').find(row => row.purpose === 'learning_card');
  assert.equal(item.attemptId, null); assert.ok(JSON.stringify(item.card).includes('"name":"answer_text"'));
  f.chat.update({ remindersEnabled: false }); assert.equal(f.chat.deliverable(item), true);
  await f.chat.drain(f.send); const sent = f.app.store.require('feishu-chat-outbox', item.id);
  const answer = '答'.repeat(1001); const result = f.chat.receive({ ...f.message(answer), replyToMessageId: sent.messageId });
  assert.ok(result.attemptId); assert.equal(f.app.store.require('attempt', result.attemptId).output, answer);
  assert.equal(f.modelCalls(), 0);
});

test('redelivery of one stale callback stays closed after its resync advances the card version', async t => {
  const f = await fixture(t); const originalToken = f.token(f.initial().id); await f.perform(f.form());
  const incoming = f.event('flashcards', { token: originalToken }); await f.perform(incoming);
  const state = f.initial(); const jobs = f.app.store.all('job').length; const outbox = f.app.store.all('feishu-chat-outbox').length;
  await f.perform(incoming);
  assert.equal(f.initial().version, state.version); assert.equal(f.app.store.all('job').length, jobs);
  assert.equal(f.app.store.all('feishu-chat-outbox').length, outbox); assert.equal(f.modelCalls(), 0);
});

test('redelivered original submission cannot create a resync or another answer after card updates', async t => {
  const f = await fixture(t); const incoming = f.form(); await f.perform(incoming);
  const version = f.initial().version; const jobs = f.app.store.all('job').length; const outbox = f.app.store.all('feishu-chat-outbox').length;
  await f.perform(incoming);
  assert.equal(f.initial().version, version); assert.equal(f.app.store.all('job').length, jobs);
  assert.equal(f.app.store.all('feishu-chat-outbox').length, outbox); assert.equal(f.app.store.all('attempt').length, 1); assert.equal(f.modelCalls(), 0);
});
