import test from 'node:test';
import assert from 'node:assert/strict';
import { Advice } from '../../server/advice.mjs';
import { AdviceDiscussion } from '../../server/advice-discussion.mjs';
import { FeishuChat } from '../../server/feishu-chat.mjs';
import { FeishuCardActions } from '../../server/feishu-card-actions.mjs';
import { appFor, profile, settings, jobDone } from './helpers.mjs';

// Requirements: confirmed own quoted and implicit discussion; acknowledgments are not consent;
// new practice routing; duplicate ingress; historical authorization; binding changes; card forms,
// version/nonce protection; pending-save refusal; original evaluations and outputs are preserved.
async function fixture(t) {
  const app = await appFor(t); app.learning.onAttempt = null;
  const clock = { value: new Date('2026-10-31T01:00:00.000Z') }; app.automation.clock = () => clock.value;
  await profile(app, { goals: ['Reliable storage'], timeZone: 'Asia/Shanghai', dailyBudgetMinutes: 15 });
  await settings(app, { model: { enabled: true, endpoint: 'http://127.0.0.1:1234/v1', model: 'synthetic' } });
  const config = app.settings.raw(); app.store.put('config', { ...config, feishu: { ...config.feishu, enabled: true, appId: 'cli_discussion' } }, 'settings');
  const secrets = { get: key => key === 'feishu.appSecret' ? 'synthetic-feishu-secret' : null };
  const advice = new Advice(app.store, app.settings, app.domain, app.collector, app.learning, app.model, app.jobs, { clock: () => clock.value });
  advice.update({ enabled: true, dailyCallLimit: 20 }); app.learning.advice = advice;
  const discussion = new AdviceDiscussion(app.store, advice, app.learning, app.jobs, { clock: () => clock.value });
  const chat = new FeishuChat(app.store, app.settings, secrets, app.domain, app.automation, app.learning, { clock: () => clock.value });
  const cards = new FeishuCardActions(app.store, chat, advice, app.learning, app.domain, app.reviews, app.siyuan, app.jobs, { clock: () => clock.value });
  chat.cards = cards; chat.discussion = discussion; cards.discussion = discussion; app.learning.discussion = discussion;
  discussion.channelGuard = channel => chat.discussionChannelCurrent(channel);
  app.jobs.register('advice_discussion', (payload, job) => discussion.run(payload, job));
  app.jobs.register('feishu_card_action', (payload, job) => cards.run(payload, job));
  const provider = { calls: 0, inputs: [], before: null };
  app.model.generate = async (_instruction, input) => {
    provider.calls++; provider.inputs.push(structuredClone(input)); await provider.before?.();
    return { reply: 'Compare one expected count with the observed count.', candidate: { summary: `Candidate ${provider.calls}.`,
      observations: input.base.rubric.map(item => ({ criterionId: item.id, finding: 'not_assessed', comment: 'Make the result observable.', evidenceRefs: [], outputExcerpt: '' })),
      nextActions: ['Write one expected result.'], limitations: ['The original answer remains unchanged.'] } };
  };
  const source = app.sources.capture({ kind: 'manual', externalId: 'feishu-discussion', title: 'Replay', content: 'Retain one result when replaying the same operation.' });
  const refs = [app.sources.ref(source)];
  const newPractice = () => {
    const practice = app.learning.createPractice({ projectId: null, kind: 'explanation', goal: 'Reliable storage', skill: '',
      prompt: 'Describe an observable replay check.', estimatedMinutes: 5, sourceRefs: refs,
      rubric: [{ label: 'Evidence', description: 'Use an observable count.', expectedEvidence: ['Record count'] }] }, app.learning.provenance('template', refs));
    const current = app.automation.context();
    app.store.put('focus-artifact', { date: app.automation.date(), timeZone: app.domain.profile().timeZone,
      profileRevision: current.profileRevision, scopeRevision: current.scopeRevision, modelConfigKey: current.modelKey,
      highlights: [{ id: 'discussion-highlight', title: 'Replay', summary: 'Retain one result.', goal: practice.goal, whyRelevant: 'Verify storage.', sourceRefs: refs }],
      sourceDigests: [{ sourceId: source.id, contentDigest: source.contentDigest }], practiceId: practice.id,
      provenance: app.learning.provenance('template', refs), generatedAt: clock.value.toISOString() }, 'discussion-focus');
    return practice;
  };
  const practice = newPractice();
  const attempt = app.learning.attempt(practice.id, { output: 'Replay once and compare the record count.', assistanceLevel: 'none', evidenceRefs: [] });
  const { feedback } = app.learning.saveFeedback(attempt.id, 'model', { summary: 'Add the expected count.',
    observations: [{ criterionId: practice.rubric[0].id, finding: 'not_assessed', comment: 'Explain an expected result.', evidenceRefs: [] }],
    nextActions: ['State one expected count.'], limitations: ['No mastery assessment.'] });
  chat.update({ enabled: true, cardsEnabled: true }); let sequence = 0; const sent = [];
  const message = (content, extra = {}) => ({ messageId: `om_user_${++sequence}`, chatId: 'oc_self', senderId: 'ou_self', chatType: 'p2p', senderType: 'user', content, createTime: +clock.value, ...extra });
  const send = async value => { sent.push(value); return { messageId: value.updateMessageId ?? `om_bot_${sent.length}` }; };
  const pair = chat.pair(); chat.receive(message(`绑定 ${pair.code}`)); await chat.drain(send);
  const inbox = { id: 'initial-advice', attemptId: attempt.id, practiceId: practice.id, practiceContext: chat.context(app.automation.today()) };
  const outbox = chat.queue('initial-advice', 'Original advice.', { purpose: 'advice', feedbackId: feedback.id,
    attemptId: attempt.id, practiceId: practice.id, practiceContext: inbox.practiceContext });
  const card = cards.decorateAdvice(outbox, inbox, { feedback }); await chat.drain(send);
  const token = id => {
    const state = cards.state(id); const item = app.store.all('feishu-chat-outbox').find(row => row.cardId === id && row.cardVersion === state.version);
    return /"t":"([a-f0-9]{24})"/.exec(JSON.stringify(item.card))?.[1] ?? /discuss_([a-f0-9]{24})/.exec(JSON.stringify(item.card))?.[1];
  };
  const event = (action, values = {}) => ({ messageId: cards.state(card.cardId).messageId, chatId: 'oc_self', operator: { openId: 'ou_self' },
    action: { value: { v: 1, t: values.token ?? token(card.cardId), a: action } }, raw: { token: `callback_${++sequence}` }, ...values });
  const form = (text = 'Why does an expected count help?', values = {}) => {
    const incoming = event('discuss_advice', values);
    return { ...incoming, action: { name: `discuss_${values.token ?? token(card.cardId)}` }, raw: { token: incoming.raw.token, action: { form_value: { advice_reply: text } } } };
  };
  const wait = async (expected = 'succeeded') => {
    const latest = discussion.state(feedback.id)?.lastTurnId;
    if (latest) await jobDone(app, { jobId: app.store.require('advice-discussion-turn', latest).jobId }, expected);
    for (const job of app.store.all('job').filter(row => row.kind === 'feishu_card_action' && ['queued', 'running'].includes(row.status))) await jobDone(app, { jobId: job.id });
    await chat.drain(send); return discussion.public(feedback.id);
  };
  return { app, advice, discussion, chat, cards, clock, provider, source, practice, attempt, feedback, card, sent, send, message, event, form, token, wait, newPractice };
}

test('quoted confirmed advice discusses the original answer and creates no new attempt or saved output', async t => {
  const f = await fixture(t); const original = f.app.store.require('attempt', f.attempt.id);
  const incoming = f.message('Why is the expected count needed?', { replyToMessageId: f.cards.state(f.card.cardId).messageId });
  assert.equal(f.chat.receive(incoming).discussion, true); assert.equal(f.chat.receive(incoming).duplicate, true);
  assert.equal((await f.wait()).version, 1); assert.equal(f.provider.calls, 1); assert.equal(f.app.store.all('attempt').length, 1);
  assert.deepEqual(f.app.store.require('attempt', f.attempt.id), original); assert.equal(f.app.store.all('output').length, 0);
  assert.equal(f.provider.inputs[0].base.output, original.output);
});

test('unquoted continuation uses the latest confirmed advice, while OK is a local acknowledgment only', async t => {
  const f = await fixture(t); const before = f.app.store.all('job').length;
  f.chat.receive(f.message('OK')); await f.chat.drain(f.send);
  assert.equal(f.provider.calls, 0); assert.equal(f.app.store.all('output').length, 0); assert.equal(f.app.store.all('job').length, before);
  assert.ok(f.sent.some(item => item.text.includes('当前未自动保存')));
  assert.equal(f.chat.receive(f.message('Explain the expected count.')).discussion, true); assert.equal((await f.wait()).version, 1);
});

test('a new unanswered practice clears implicit discussion and retains legitimate OK answers', async t => {
  const f = await fixture(t); const next = f.newPractice(); f.chat.sendToday({ interactive: true }); await f.chat.drain(f.send);
  const result = f.chat.receive(f.message('OK'));
  assert.ok(result.attemptId); assert.equal(f.app.store.require('attempt', result.attemptId).practiceId, next.id);
  assert.equal(f.app.store.require('attempt', result.attemptId).output, 'OK'); assert.equal(f.provider.calls, 0);
});

test('unquoted text on a new day without an answered practice requires explicit discussion intent', async t => {
  const f = await fixture(t); f.clock.value = new Date(+f.clock.value + 86400000);
  f.chat.receive(f.message('Explain the previous suggestion.'));
  assert.equal(f.provider.calls, 0); assert.equal(f.app.store.all('advice-discussion-turn').length, 0);
});

test('an unknown quoted message cannot fall back to the pending practice or initiate a model call', async t => {
  const f = await fixture(t); f.newPractice(); f.chat.sendToday({ interactive: true }); await f.chat.drain(f.send);
  f.chat.receive(f.message('This is a discussion.', { replyToMessageId: 'om_unknown' }));
  assert.equal(f.app.store.all('attempt').length, 1); assert.equal(f.provider.calls, 0);
});

test('a historical quote explicitly discusses authorized old feedback without answering the new practice', async t => {
  const f = await fixture(t); f.newPractice();
  const result = f.chat.receive(f.message('Explain this earlier suggestion.', { replyToMessageId: f.cards.state(f.card.cardId).messageId }));
  assert.equal(result.discussion, true); assert.equal((await f.wait()).version, 1);
  assert.equal(f.app.store.all('attempt').length, 1); assert.equal(f.provider.inputs[0].base.output, f.attempt.output);
});

test('historical discussion remains available across a date change but its memory shortcut does not call native review', async t => {
  const f = await fixture(t); f.clock.value = new Date(+f.clock.value + 86400000);
  let nativeCalls = 0; f.cards.reviews = { create: async () => { nativeCalls++; throw new Error('Forbidden historical review.'); } };
  assert.equal(f.cards.receive(f.form(), f.chat.identity()).toast.type, 'success'); await f.wait();
  const incoming = f.event('flashcards'); assert.equal(f.cards.receive(incoming, f.chat.identity()).toast.type, 'success'); await f.wait();
  assert.equal(nativeCalls, 0); assert.equal(f.cards.state(f.card.cardId).view, 'status');
});

test('revoked or changed source material prevents historical quoted discussion without paying', async t => {
  const f = await fixture(t); f.app.sources.capture({ ...f.source, content: 'Changed source.' });
  f.chat.receive(f.message('Explain the old material.', { replyToMessageId: f.cards.state(f.card.cardId).messageId }));
  assert.equal(f.provider.calls, 0); assert.equal(f.app.store.all('advice-discussion-turn').length, 0);
});

for (const afterCall of [false, true]) {
  test(`a rebinding ${afterCall ? 'during' : 'before'} a discussion blocks calls or late results`, async t => {
    const f = await fixture(t); if (afterCall) f.provider.before = () => { f.chat.pair(); }; else await f.app.jobs.stop();
    f.chat.receive(f.message('Explain the suggestion.', { replyToMessageId: f.cards.state(f.card.cardId).messageId }));
    if (!afterCall) { f.chat.pair(); f.app.jobs.start(); }
    const view = await f.wait('failed'); assert.equal(view.version, 0); assert.equal(f.provider.calls, afterCall ? 1 : 0);
    assert.equal(f.app.store.all('output').length, 0);
  });
}

test('a card discussion form queues a distinct child model job and saves only the explicit current version', async t => {
  const f = await fixture(t); const oldToken = f.token(f.card.cardId); await f.app.jobs.stop();
  const form = f.form(); assert.equal(f.cards.receive(form, f.chat.identity()).toast.type, 'success');
  const jobs = f.app.store.all('job'); const generic = jobs.find(job => job.kind === 'feishu_card_action'); const child = jobs.find(job => job.kind === 'advice_discussion');
  assert.ok(generic && child); assert.notEqual(child.id, generic.id); assert.notEqual(child.operationId, generic.operationId);
  assert.equal(f.cards.receive(f.event('save_advice'), f.chat.identity()).toast.type, 'error'); assert.equal(f.app.store.all('output').length, 0);
  f.app.jobs.start(); const view = await f.wait(); assert.equal(view.version, 1); assert.equal(view.saved, false);
  const closedJobs = f.app.store.all('job').length; const closedVersion = f.cards.state(f.card.cardId).version;
  assert.notEqual(f.cards.receive(form, f.chat.identity()).toast.type, 'error'); await f.wait();
  assert.equal(f.app.store.all('job').length, closedJobs); assert.equal(f.cards.state(f.card.cardId).version, closedVersion);
  assert.equal(f.cards.receive(f.event('save_advice', { token: oldToken }), f.chat.identity()).toast.type, 'success'); await f.wait();
  assert.equal(f.app.store.all('output').length, 0);
  assert.equal(f.cards.receive(f.event('save_advice'), f.chat.identity()).toast.type, 'success'); await f.wait();
  assert.equal(f.app.store.all('output').length, 1); assert.ok(f.app.store.all('output')[0].content.includes('Candidate 1.'));
  assert.equal(f.app.store.all('attempt').length, 1); assert.equal(f.app.store.all('feedback').length, 1);
});

for (const text of ['', ' ', 'x'.repeat(1001), ['not text']]) {
  test(`invalid card discussion input ${typeof text === 'string' ? text.length : 'array'} saves no turn, answer, or output`, async t => {
    const f = await fixture(t); assert.equal(f.cards.receive(f.form(text), f.chat.identity()).toast.type, 'error');
    assert.equal(f.app.store.all('advice-discussion-turn').length, 0); assert.equal(f.app.store.all('attempt').length, 1); assert.equal(f.app.store.all('output').length, 0);
  });
}

test('card-form OK is not approval and spends no model quota', async t => {
  const f = await fixture(t); assert.equal(f.cards.receive(f.form('OK'), f.chat.identity()).toast.type, 'success'); await f.wait();
  assert.equal(f.provider.calls, 0); assert.equal(f.advice.calls().length, 0); assert.equal(f.app.store.all('output').length, 0);
  assert.equal(f.discussion.public(f.feedback.id).version, 0);
});

test('foreign card actors and unconfirmed message IDs cannot start a paid discussion', async t => {
  const f = await fixture(t); const foreign = f.form(); foreign.operator = { openId: 'ou_other' };
  assert.equal(f.cards.receive(foreign, f.chat.identity()).toast.type, 'error');
  const unknown = f.form(); unknown.messageId = 'om_not_confirmed'; assert.equal(f.cards.receive(unknown, f.chat.identity()).toast.type, 'error');
  assert.equal(f.provider.calls, 0); assert.equal(f.app.store.all('advice-discussion-turn').length, 0);
});

test('explicitly opening historical advice adds a discussion form without creating a turn, answer, or output', async t => {
  const f = await fixture(t); f.clock.value = new Date(+f.clock.value + 86400000);
  const original = f.app.store.require('attempt', f.attempt.id); const before = f.app.store.all('feishu-chat-inbox').length;
  const opened = f.chat.openDiscussion(f.feedback.id); assert.equal(opened.queued, true); assert.equal(opened.version, 0);
  const item = f.app.store.all('feishu-chat-outbox').find(row => row.purpose === 'advice_discussion');
  assert.ok(JSON.stringify(item.card).includes('"name":"advice_reply"')); assert.equal(f.chat.deliverable(item), true);
  await f.chat.drain(f.send); assert.equal(f.app.store.require('feishu-chat-outbox', item.id).status, 'sent');
  assert.equal(f.chat.state().activeDiscussion.explicit, true);
  assert.equal(f.app.store.all('feishu-chat-inbox').length, before); assert.deepEqual(f.app.store.require('attempt', f.attempt.id), original);
  for (const kind of ['advice-discussion', 'advice-discussion-turn', 'advice-discussion-version', 'output', 'advice-call']) assert.equal(f.app.store.all(kind).length, 0, kind);
  assert.equal(f.provider.calls, 0);
});

test('reopening one version reuses its outbox and nonce and keeps an uncertain delivery closed', async t => {
  const f = await fixture(t); f.chat.openDiscussion(f.feedback.id);
  const item = f.app.store.all('feishu-chat-outbox').find(row => row.purpose === 'advice_discussion');
  const nonceCount = f.app.store.all('feishu-card-nonce').length; f.chat.openDiscussion(f.feedback.id);
  assert.equal(f.app.store.all('feishu-chat-outbox').filter(row => row.purpose === 'advice_discussion').length, 1);
  assert.equal(f.app.store.all('feishu-card-nonce').length, nonceCount);
  f.app.store.put('feishu-chat-outbox', { ...item, status: 'uncertain', attempts: 1 }, item.id);
  const closed = f.chat.openDiscussion(f.feedback.id); assert.equal(closed.queued, false); assert.equal(closed.deliveryState, 'uncertain');
  await f.chat.drain(f.send); assert.equal(f.app.store.require('feishu-chat-outbox', item.id).status, 'uncertain');
  assert.equal(f.app.store.all('feishu-card-nonce').length, nonceCount); assert.equal(f.provider.calls, 0);
});

test('opening advice rejects disabled cards, disabled chat, unbound recipients, and unauthorized material', async t => {
  const f = await fixture(t); const before = f.app.store.all('feishu-chat-outbox').length;
  f.chat.update({ cardsEnabled: false }); assert.throws(() => f.chat.openDiscussion(f.feedback.id));
  f.chat.update({ cardsEnabled: true, enabled: false }); assert.throws(() => f.chat.openDiscussion(f.feedback.id));
  f.chat.update({ enabled: true });
  f.app.sources.capture({ ...f.source, content: 'Material changed.' });
  assert.throws(() => f.chat.openDiscussion(f.feedback.id), error => error.code === 'ADVICE_CONTEXT_CHANGED');
  f.chat.pair(); assert.throws(() => f.chat.openDiscussion(f.feedback.id));
  assert.equal(f.app.store.all('feishu-chat-outbox').length, before); assert.equal(f.provider.calls, 0); assert.equal(f.app.store.all('output').length, 0);
});
