import test from 'node:test';
import assert from 'node:assert/strict';
import { appFor, ok, request, profile, settings, fakeServer } from './helpers.mjs';

async function fixture(t, { enabled = true, limit = 3 } = {}) {
  const clock = { value: new Date('2026-10-30T05:00:00.000Z') };
  const state = { malformed: false };
  const upstream = await fakeServer(t, (_req, body) => {
    const input = JSON.parse(body.messages[1].content);
    const result = { summary: '已经说明重放思路，可补充失败检查。',
      observations: input.rubric.map(criterion => ({ criterionId: criterion.id, finding: 'partial', comment: '补充重复事件下的执行依据。',
        evidenceRefs: [], outputExcerpt: input.output.slice(0, 5) })), nextActions: ['写出重复投递两次时记录应保持一条的检查。'], limitations: [] };
    if (state.malformed) result.untrustedExtra = 'Private synthetic marker';
    return { usage: { prompt_tokens: 80, completion_tokens: 60, total_tokens: 140 },
      choices: [{ message: { content: JSON.stringify(result) } }] };
  });
  const app = await appFor(t, { automationClock: () => clock.value, adviceOptions: { clock: () => clock.value } });
  app.feishuChat.clock = () => clock.value;
  await profile(app, { goals: ['验证事务和重放'], dailyBudgetMinutes: 15 });
  await settings(app, { model: { enabled: true, endpoint: upstream.origin + '/v1', model: 'synthetic-advice' },
    feishu: { enabled: true, appId: 'cli_advice_fixture', appSecret: 'synthetic-advice-fixture-secret' } });
  const source = app.sources.capture({ kind: 'manual', externalId: 'advice-fixture', title: '事务依据', content: '事务保存消息身份与输出，重放不重复记账。' });
  const refs = [app.sources.ref(source)]; const context = app.automation.context();
  const practice = app.learning.createPractice({ projectId: null, kind: 'new_scenario', goal: app.domain.profile().goals[0], skill: '',
    prompt: '说明如何验证消息重放不重复记账。', estimatedMinutes: 5, sourceRefs: refs,
    rubric: [{ label: '检查', description: '给出重复投递的验证方式', expectedEvidence: ['重放检查'] }] }, app.learning.provenance('template', refs));
  app.store.put('focus-artifact', { date: app.automation.date(), timeZone: app.domain.profile().timeZone,
    profileRevision: context.profileRevision, scopeRevision: context.scopeRevision, modelConfigKey: context.modelKey,
    highlights: [{ id: 'advice_integration_focus', title: '事务与重放', summary: '一起保存消息身份和输出。', goal: practice.goal,
      whyRelevant: '对应验证目标', sourceRefs: refs }], sourceDigests: [{ sourceId: source.id, contentDigest: source.contentDigest }],
    practiceId: practice.id, provenance: app.learning.provenance('template', refs), generatedAt: clock.value.toISOString() });
  app.feishuChat.update({ enabled: true });
  app.advice.update({ enabled, dailyCallLimit: limit });
  const sent = []; let sequence = 0;
  const send = async message => { sent.push(message); return { messageId: 'om_advice_' + sent.length }; };
  const message = content => ({ messageId: 'om_input_' + ++sequence, chatId: 'oc_advice_self', senderId: 'ou_advice_self',
    chatType: 'p2p', senderType: 'user', content, createTime: +clock.value });
  const pair = app.feishuChat.pair(); app.feishuChat.receive(message('绑定 ' + pair.code)); await app.feishuChat.drain(send);
  return { app, clock, state, upstream, practice, source, sent, send, message };
}

async function waitAdvice(f, attemptId) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const state = f.app.advice.public(attemptId);
    if (!['queued', 'running'].includes(state.status)) return state;
    if (Date.now() > deadline) assert.fail('Synthetic advice did not finish.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('Feishu saves once, acknowledges before advice, and shares the same model feedback with today', async t => {
  const f = await fixture(t); await f.app.jobs.stop();
  const incoming = f.message('独立：把消息身份与输出一起保存，再重放事件。');
  const saved = f.app.feishuChat.receive(incoming);
  assert.equal(f.app.feishuChat.receive(incoming).duplicate, true);
  await f.app.feishuChat.drain(f.send);
  assert.equal(f.app.store.all('attempt').length, 1); assert.equal(f.upstream.calls.length, 0);
  assert.ok(f.sent.at(-1).text.includes('正在准备 AI 建议'));
  f.app.jobs.start(); const advice = await waitAdvice(f, saved.attemptId);
  assert.equal(advice.status, 'ready'); await f.app.feishuChat.drain(f.send);
  const today = await ok(f.app, 'GET', '/today');
  assert.equal(today.advice.feedback.id, today.attempt.feedback.id); assert.equal(today.attempt.feedback.mode, 'model');
  assert.equal(today.attempt.output, '把消息身份与输出一起保存，再重放事件。');
  for (const label of ['已做到', '待改进', '下一步', '点评范围：']) assert.ok(f.sent.at(-1).text.includes(label));
  assert.equal(f.upstream.calls.length, 1);
  assert.deepEqual(f.app.store.all('advice-call')[0].usage, { prompt_tokens: 80, completion_tokens: 60, total_tokens: 140 });
  await f.app.feishuChat.drain(f.send); const sentCount = f.sent.length;
  assert.equal(f.sent.length, sentCount);
  f.app.feishuChat.receive(f.message('点评')); await f.app.feishuChat.drain(f.send);
  assert.equal(f.upstream.calls.length, 1); assert.ok(f.sent.at(-1).text.includes('AI 建议'));
});

test('invalid paid advice preserves the answer and local fallback, then only explicit retry makes a new request', async t => {
  const f = await fixture(t); f.state.malformed = true;
  const saved = f.app.feishuChat.receive(f.message('先保存消息身份与输出。'));
  const failed = await waitAdvice(f, saved.attemptId); assert.equal(failed.status, 'failed');
  await f.app.feishuChat.drain(f.send);
  assert.ok(f.sent.at(-1).text.includes('本地自查提示')); assert.equal(f.upstream.calls.length, 1);
  assert.equal(f.app.store.require('attempt', saved.attemptId).output, '先保存消息身份与输出。');
  f.app.feishuChat.receive(f.message('点评')); await f.app.feishuChat.drain(f.send);
  assert.equal(f.upstream.calls.length, 1);
  f.state.malformed = false; f.app.feishuChat.receive(f.message('重新点评'));
  assert.equal((await waitAdvice(f, saved.attemptId)).status, 'ready'); await f.app.feishuChat.drain(f.send);
  assert.equal(f.upstream.calls.length, 2); assert.ok(f.sent.at(-1).text.includes('AI 建议'));
});

for (const [label, options] of [['disabled', { enabled: false }], ['zero budget', { limit: 0 }]]) {
  test(`${label} keeps the original answer and sends a truthful local self-check without a model call`, async t => {
    const f = await fixture(t, options);
    const saved = f.app.feishuChat.receive(f.message('先记录事件身份。')); await f.app.feishuChat.drain(f.send);
    assert.equal(f.upstream.calls.length, 0); assert.equal(f.app.store.require('attempt', saved.attemptId).feedback.mode, 'template');
    assert.ok(f.sent.at(-1).text.includes('本地自查提示')); assert.ok(!f.sent.at(-1).text.includes('正在准备 AI 建议'));
  });
}

test('queued advice content is cancelled if the source changes before the message is sent', async t => {
  const f = await fixture(t); const saved = f.app.feishuChat.receive(f.message('记录事件身份后重放检查。'));
  assert.equal((await waitAdvice(f, saved.attemptId)).status, 'ready');
  await f.app.feishuChat.finishFeedback();
  const queued = f.app.store.all('feishu-chat-outbox').find(item => item.purpose === 'advice'); assert.ok(queued);
  f.app.sources.capture({ kind: 'manual', externalId: f.source.externalId, title: '修订材料', content: '来源发生变化。' });
  await f.app.feishuChat.drain(f.send);
  assert.equal(f.app.store.require('feishu-chat-outbox', queued.id).status, 'cancelled');
  assert.equal(f.sent.length, 1);
});

test('template requests cannot replace a saved model suggestion and advice history exports with no auto-import permissions', async t => {
  const f = await fixture(t); const saved = f.app.feishuChat.receive(f.message('同一事务保存身份和输出。'));
  const advice = await waitAdvice(f, saved.attemptId); assert.equal(advice.status, 'ready');
  const template = await f.app.learning.feedback(saved.attemptId, { mode: 'template', allowTemplateFallback: true });
  assert.equal(template.feedback.id, advice.feedback.id); assert.equal(template.feedback.mode, 'model');
  const document = JSON.parse((await ok(f.app, 'POST', '/exports', { scope: 'all', projectIds: [], includeSourceContent: true })).content);
  assert.ok(document.data.jobHistory.some(job => job.type === 'answer_advice' && job.trigger === 'automatic'));
  const target = await appFor(t);
  await ok(target, 'POST', '/imports', { document, mode: 'merge' });
  assert.equal(target.store.require('attempt', saved.attemptId).output, '同一事务保存身份和输出。');
  assert.equal(target.store.require('attempt', saved.attemptId).feedback.mode, 'model');
  assert.equal(target.advice.settingsPublic().enabled, false);
  assert.equal(target.store.all('advice-call').length, 0); assert.equal(target.store.all('answer-advice').length, 0);
});

test('advice routes are inert on reads and enforce revisions, operation replay and malformed request handling', async t => {
  const f = await fixture(t, { enabled: false });
  const attempt = await ok(f.app, 'POST', `/practices/${f.practice.id}/attempts`, { output: '一个具体检查。', assistanceLevel: 'none', evidenceRefs: [] }, 201);
  await ok(f.app, 'GET', `/attempts/${attempt.id}/advice`); await ok(f.app, 'GET', '/advice-settings');
  assert.equal(f.upstream.calls.length, 0);
  const current = await ok(f.app, 'GET', '/advice-settings');
  assert.equal((await request(f.app, 'PUT', '/advice-settings', { enabled: true, dailyCallLimit: 3, expectedRevision: current.revision - 1 })).status, 409);
  assert.equal((await request(f.app, 'POST', `/attempts/${attempt.id}/advice`, { retry: 'yes' })).status, 422);
  assert.equal((await request(f.app, 'GET', '/attempts/nonexistent/advice')).status, 404);
  await ok(f.app, 'PUT', '/advice-settings', { enabled: true, dailyCallLimit: 3, expectedRevision: current.revision });
  assert.equal(f.upstream.calls.length, 0);
  const headers = { 'Content-Type': 'application/json', 'X-Second-Brain-Client': 'local-ui' };
  const body = JSON.stringify({ operationId: 'synthetic_advice_operation_replay' });
  const url = f.app.origin + `/api/v1/attempts/${attempt.id}/advice`;
  const first = await (await fetch(url, { method: 'POST', headers, body })).json();
  const second = await (await fetch(url, { method: 'POST', headers, body })).json();
  assert.deepEqual(second, first); await waitAdvice(f, attempt.id); assert.equal(f.upstream.calls.length, 1);
});
