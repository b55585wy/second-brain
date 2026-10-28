import test from 'node:test';
import assert from 'node:assert/strict';
import { appFor, ok, request, fakeSiyuan, syncedKnowledge, jobDone, operation, configureSiyuan } from './helpers.mjs';
import { RIFF_RATINGS } from '../../server/siyuan.mjs';

test('Riff version mapping is pinned and unavailable/incompatible connectors never invent a queue', async t => {
  const app = await appFor(t);
  assert.equal((await request(app, 'POST', '/review-sessions', { projectId: null })).status, 503);
  assert.deepEqual([RIFF_RATINGS.forgot, RIFF_RATINGS.again, RIFF_RATINGS.hard, RIFF_RATINGS.good, RIFF_RATINGS.easy], [1, 1, 2, 3, 4]);
  const upstream = await fakeSiyuan(t, { version: '3.8.7' });
  await configureSiyuan(app, upstream);
  assert.equal((await request(app, 'POST', '/review-sessions', { projectId: null })).error.code, 'RIFF_INCOMPATIBLE');
  assert.equal(upstream.state.cards.length, 0);
});

test('prompt-only next, persistent reveal and operation/presentation dedup keep grading safe', async t => {
  const upstream = await fakeSiyuan(t);
  const app = await appFor(t);
  await syncedKnowledge(app, upstream, { answer: 'hidden-answer-sentinel' });
  const session = await ok(app, 'POST', '/review-sessions', { projectId: null, limit: 2 }, 201);
  const next = await ok(app, 'GET', `/review-sessions/${session.id}/next`);
  assert.equal(next.state, 'question'); assert.equal(next.card.revealed, false);
  assert.ok(!JSON.stringify(next).includes('hidden-answer-sentinel')); assert.equal(next.card.sourceRefs, undefined); assert.equal(next.card.validation, undefined);
  assert.deepEqual(await ok(app, 'GET', `/review-sessions/${session.id}/next`), next);
  const grade = { presentationId: next.card.presentationId, cardId: next.card.cardId, rating: 'good', elapsedMs: 1000 };
  assert.equal((await request(app, 'POST', `/review-sessions/${session.id}/responses`, grade)).status, 409);
  const reveal = await ok(app, 'POST', `/review-sessions/${session.id}/reveal`, { presentationId: next.card.presentationId, cardId: next.card.cardId });
  assert.equal(reveal.answer, 'hidden-answer-sentinel');
  const hidden = await ok(app, 'GET', `/review-sessions/${session.id}/next`); assert.equal(hidden.card.revealed, true); assert.ok(!JSON.stringify(hidden).includes('hidden-answer-sentinel'));
  const op = operation();
  const ack = await ok(app, 'POST', `/review-sessions/${session.id}/responses`, { ...grade, operationId: op }, 202);
  const job = await jobDone(app, ack); assert.equal(job.commitState, 'confirmed'); assert.equal(job.result.response.rating, 'good');
  assert.deepEqual(await ok(app, 'POST', `/review-sessions/${session.id}/responses`, { ...grade, operationId: op }, 202), ack);
  assert.equal((await ok(app, 'POST', `/review-sessions/${session.id}/responses`, grade, 202)).jobId, ack.jobId);
  assert.equal((await request(app, 'POST', `/review-sessions/${session.id}/responses`, { ...grade, rating: 'easy' })).status, 409);
  assert.equal(upstream.state.grades.length, 1);
  const again = await ok(app, 'GET', `/review-sessions/${session.id}/next`);
  assert.equal(again.card.cardId, next.card.cardId); assert.notEqual(again.card.presentationId, next.card.presentationId);
  await ok(app, 'POST', `/review-sessions/${session.id}/reveal`, { presentationId: again.card.presentationId, cardId: again.card.cardId });
  await jobDone(app, await ok(app, 'POST', `/review-sessions/${session.id}/responses`, { presentationId: again.card.presentationId, cardId: again.card.cardId, rating: 'forgot', elapsedMs: 0 }, 202));
  assert.equal(upstream.state.grades[1].rating, 1); assert.equal((await ok(app, 'GET', `/review-sessions/${session.id}/next`)).state, 'empty');
});

test('timeout after native commit remains uncertain, reconciles read-only and never repeats grading', async t => {
  const upstream = await fakeSiyuan(t);
  const app = await appFor(t, { transport: { timeoutMs: 50 } });
  await syncedKnowledge(app, upstream);
  upstream.state.gradeDelay = 180;
  const session = await ok(app, 'POST', '/review-sessions', { projectId: null }, 201);
  const next = await ok(app, 'GET', `/review-sessions/${session.id}/next`);
  const identity = { presentationId: next.card.presentationId, cardId: next.card.cardId };
  await ok(app, 'POST', `/review-sessions/${session.id}/reveal`, identity);
  const ack = await ok(app, 'POST', `/review-sessions/${session.id}/responses`, { ...identity, rating: 'hard', elapsedMs: 300 }, 202);
  const job = await jobDone(app, ack, 'uncertain'); assert.equal(job.commitState, 'may_have_committed'); assert.equal(upstream.state.cards[0].reps, 1);
  const pending = await ok(app, 'GET', `/review-sessions/${session.id}/next`); assert.equal(pending.state, 'uncertain'); assert.equal(pending.card, undefined);
  const knowledge = await ok(app, 'GET', `/knowledge/${next.card.knowledgeId}`);
  await ok(app, 'PATCH', `/knowledge/${knowledge.id}`, { expectedRevision: knowledge.revision, answer: 'changed while the grade is uncertain' });
  assert.equal((await ok(app, 'GET', `/review-sessions/${session.id}/next`)).state, 'uncertain');
  assert.equal((await ok(app, 'POST', '/review-sessions', { projectId: null })).id, session.id);
  assert.equal((await ok(app, 'POST', `/review-sessions/${session.id}/responses`, { ...identity, rating: 'hard', elapsedMs: 300 }, 202)).jobId, ack.jobId);
  assert.equal((await request(app, 'POST', `/review-sessions/${session.id}/responses`, { ...identity, rating: 'easy', elapsedMs: 300 })).status, 409);
  const check = await jobDone(app, await ok(app, 'POST', `/jobs/${ack.jobId}/reconcile`, {}, 202));
  assert.equal(check.result.resolution, 'still_uncertain'); assert.equal((await ok(app, 'GET', `/jobs/${ack.jobId}`)).status, 'uncertain');
  assert.equal(upstream.state.grades.length, 1);
});

test('connected but empty app-owned deck is a real empty state without creating remote resources', async t => {
  const upstream = await fakeSiyuan(t);
  const app = await appFor(t); await configureSiyuan(app, upstream);
  const session = await ok(app, 'POST', '/review-sessions', { projectId: null, limit: 1 }, 201);
  assert.equal((await ok(app, 'GET', `/review-sessions/${session.id}/next`)).reason, 'no_due_cards');
  assert.equal(upstream.state.notebooks.length, 0); assert.equal(upstream.state.decks.length, 0);
});

test('a knowledge change blocks an old presentation and a fresh session can follow explicit recheck/sync', async t => {
  const upstream = await fakeSiyuan(t); const app = await appFor(t);
  let item = await syncedKnowledge(app, upstream);
  const session = await ok(app, 'POST', '/review-sessions', { projectId: null }, 201);
  const old = await ok(app, 'GET', `/review-sessions/${session.id}/next`);
  item = await ok(app, 'PATCH', `/knowledge/${item.id}`, { expectedRevision: item.revision, answer: '用户明确修改的新答案' });
  assert.equal((await ok(app, 'GET', `/review-sessions/${session.id}/next`)).state, 'blocked');
  item = await ok(app, 'POST', `/knowledge/${item.id}/decision`, { expectedRevision: item.revision, decision: 'accept' });
  await jobDone(app, await ok(app, 'POST', `/knowledge/${item.id}/sync`, { expectedRevision: item.revision }, 202));
  const fresh = await ok(app, 'POST', '/review-sessions', { projectId: null }, 201); assert.notEqual(fresh.id, session.id);
  const next = await ok(app, 'GET', `/review-sessions/${fresh.id}/next`); assert.notEqual(next.card.presentationId, old.card.presentationId); assert.equal(next.card.revealed, false);
  const revealed = await ok(app, 'POST', `/review-sessions/${fresh.id}/reveal`, { presentationId: next.card.presentationId, cardId: next.card.cardId });
  assert.equal(revealed.answer, '用户明确修改的新答案'); assert.equal(upstream.state.grades.length, 0);
});

test('a native review that advanced the presented card is detected before sending a stale grade', async t => {
  const upstream = await fakeSiyuan(t); const app = await appFor(t); await syncedKnowledge(app, upstream);
  const session = await ok(app, 'POST', '/review-sessions', { projectId: null }, 201);
  const next = await ok(app, 'GET', `/review-sessions/${session.id}/next`);
  const identity = { presentationId: next.card.presentationId, cardId: next.card.cardId };
  await ok(app, 'POST', `/review-sessions/${session.id}/reveal`, identity);
  upstream.state.cards[0].reps++; upstream.state.cards[0].lastReview = Date.now();
  const job = await jobDone(app, await ok(app, 'POST', `/review-sessions/${session.id}/responses`, { ...identity, rating: 'good', elapsedMs: 1 }, 202), 'failed');
  assert.equal(job.error.code, 'INVALID_STATE'); assert.equal(job.commitState, 'not_committed'); assert.equal(upstream.state.grades.length, 0);
  const refreshed = await ok(app, 'GET', `/review-sessions/${session.id}/next`); assert.notEqual(refreshed.card.presentationId, next.card.presentationId);
});

for (const revealFirst of [false, true]) test(`${revealFirst ? 'revealed' : 'presented'} stale knowledge can resume the same session after explicit reaccept and sync`, async t => {
  const upstream = await fakeSiyuan(t); const app = await appFor(t);
  let item = await syncedKnowledge(app, upstream, { answer: 'original-answer-sentinel' });
  const session = await ok(app, 'POST', '/review-sessions', { projectId: null }, 201);
  const first = await ok(app, 'GET', `/review-sessions/${session.id}/next`);
  const oldIdentity = { presentationId: first.card.presentationId, cardId: first.card.cardId };
  if (revealFirst) await ok(app, 'POST', `/review-sessions/${session.id}/reveal`, oldIdentity);
  item = await ok(app, 'PATCH', `/knowledge/${item.id}`, { expectedRevision: item.revision, answer: 'reaccepted-answer-sentinel' });
  assert.equal((await ok(app, 'GET', `/review-sessions/${session.id}/next`)).state, 'blocked');
  assert.equal(app.store.require('review-session', session.id).presentationId, null);
  assert.equal((await request(app, 'POST', `/review-sessions/${session.id}/reveal`, oldIdentity)).status, 409);
  item = await ok(app, 'POST', `/knowledge/${item.id}/decision`, { expectedRevision: item.revision, decision: 'accept' });
  await jobDone(app, await ok(app, 'POST', `/knowledge/${item.id}/sync`, { expectedRevision: item.revision }, 202));
  const next = await ok(app, 'GET', `/review-sessions/${session.id}/next`);
  assert.equal(next.state, 'question'); assert.notEqual(next.card.presentationId, first.card.presentationId);
  assert.ok(!JSON.stringify(next).includes('reaccepted-answer-sentinel')); assert.equal(next.card.revealed, false);
  const identity = { presentationId: next.card.presentationId, cardId: next.card.cardId };
  assert.equal((await request(app, 'POST', `/review-sessions/${session.id}/responses`, { ...identity, rating: 'good', elapsedMs: 0 })).status, 409);
  assert.equal((await ok(app, 'POST', `/review-sessions/${session.id}/reveal`, identity)).answer, 'reaccepted-answer-sentinel');
  assert.equal(upstream.state.grades.length, 0);
});

for (const status of ['active', 'blocked']) test(`an old ${status} fixture retaining an invalid presentation does not poison create()`, async t => {
  const upstream = await fakeSiyuan(t); const app = await appFor(t);
  let item = await syncedKnowledge(app, upstream);
  const old = await ok(app, 'POST', '/review-sessions', { projectId: null }, 201);
  const presented = await ok(app, 'GET', `/review-sessions/${old.id}/next`);
  app.store.put('review-session', { ...app.store.require('review-session', old.id), status });
  item = await ok(app, 'PATCH', `/knowledge/${item.id}`, { expectedRevision: item.revision, answer: 'explicitly revised' });
  item = await ok(app, 'POST', `/knowledge/${item.id}/decision`, { expectedRevision: item.revision, decision: 'accept' });
  await jobDone(app, await ok(app, 'POST', `/knowledge/${item.id}/sync`, { expectedRevision: item.revision }, 202));
  const fresh = await ok(app, 'POST', '/review-sessions', { projectId: null }, 201);
  assert.notEqual(fresh.id, old.id);
  assert.equal(app.store.require('review-presentation', presented.card.presentationId).status, 'stale');
  assert.equal((await ok(app, 'GET', `/review-sessions/${fresh.id}/next`)).state, 'question');
});

test('a queued native grade stays locked when its knowledge changes', async t => {
  const upstream = await fakeSiyuan(t); const app = await appFor(t);
  let item = await syncedKnowledge(app, upstream);
  const session = await ok(app, 'POST', '/review-sessions', { projectId: null }, 201);
  const next = await ok(app, 'GET', `/review-sessions/${session.id}/next`);
  const identity = { presentationId: next.card.presentationId, cardId: next.card.cardId };
  await ok(app, 'POST', `/review-sessions/${session.id}/reveal`, identity);
  await app.jobs.stop();
  const ack = await ok(app, 'POST', `/review-sessions/${session.id}/responses`, { ...identity, rating: 'good', elapsedMs: 0 }, 202);
  item = await ok(app, 'PATCH', `/knowledge/${item.id}`, { expectedRevision: item.revision, answer: 'changed after queuing' });
  assert.equal((await ok(app, 'GET', `/review-sessions/${session.id}/next`)).state, 'rating_pending');
  assert.equal((await ok(app, 'POST', '/review-sessions', { projectId: null })).id, session.id);
  assert.equal(app.store.require('review-presentation', identity.presentationId).jobId, ack.jobId);
  assert.equal(app.store.require('review-write', identity.presentationId).state, 'queued'); assert.equal(upstream.state.grades.length, 0);
});

test('an in-flight grade stays locked through a knowledge edit and commits exactly once', async t => {
  const upstream = await fakeSiyuan(t); const app = await appFor(t);
  let item = await syncedKnowledge(app, upstream);
  const session = await ok(app, 'POST', '/review-sessions', { projectId: null }, 201);
  const next = await ok(app, 'GET', `/review-sessions/${session.id}/next`);
  const identity = { presentationId: next.card.presentationId, cardId: next.card.cardId };
  await ok(app, 'POST', `/review-sessions/${session.id}/reveal`, identity);
  let release; upstream.state.gradeGate = new Promise(resolveGate => { release = resolveGate; });
  const body = { ...identity, rating: 'good', elapsedMs: 0 };
  const ack = await ok(app, 'POST', `/review-sessions/${session.id}/responses`, body, 202);
  try {
    const deadline = Date.now() + 3000;
    while (!upstream.state.grades.length && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 5));
    assert.equal(upstream.state.grades.length, 1);
    item = await ok(app, 'PATCH', `/knowledge/${item.id}`, { expectedRevision: item.revision, answer: 'edited after sending native grade' });
    assert.equal(app.store.require('review-write', identity.presentationId).state, 'inflight');
    assert.equal((await ok(app, 'GET', `/review-sessions/${session.id}/next`)).state, 'rating_pending');
    assert.equal((await ok(app, 'POST', '/review-sessions', { projectId: null })).id, session.id);
  } finally { release(); }
  await jobDone(app, ack);
  assert.equal((await ok(app, 'POST', `/review-sessions/${session.id}/responses`, body, 202)).jobId, ack.jobId);
  assert.equal(upstream.state.grades.length, 1);
});

test('a legacy blocked session with a current unsubmitted presentation can reveal again', async t => {
  const upstream = await fakeSiyuan(t); const app = await appFor(t); await syncedKnowledge(app, upstream);
  const session = await ok(app, 'POST', '/review-sessions', { projectId: null }, 201);
  const first = await ok(app, 'GET', `/review-sessions/${session.id}/next`);
  app.store.put('review-session', { ...app.store.require('review-session', session.id), status: 'blocked' });
  const next = await ok(app, 'GET', `/review-sessions/${session.id}/next`);
  assert.equal(next.state, 'question'); assert.equal(next.session.status, 'active');
  assert.equal(next.card.presentationId, first.card.presentationId);
  await ok(app, 'POST', `/review-sessions/${session.id}/reveal`, { presentationId: next.card.presentationId, cardId: next.card.cardId });
});
