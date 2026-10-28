import test from 'node:test';
import assert from 'node:assert/strict';
import { appFor, ok, settings, scope, jobDone, operation, scratch, removeScratch } from './helpers.mjs';
import { Store } from '../../server/store.mjs';
import { Jobs } from '../../server/jobs.mjs';
import { resolve } from 'node:path';

test('persistent leases prevent concurrent workers and expired read leases can recover safely', async t => {
  const root = scratch(); const database = resolve(root, 'jobs.sqlite');
  const a = new Store(database); const b = new Store(database);
  const first = new Jobs(a); const second = new Jobs(b);
  let finish; const gate = new Promise(resolveGate => { finish = resolveGate; }); let calls = 0;
  const handler = async () => { calls++; await gate; return { real: true }; };
  first.register('test_read', handler); second.register('test_read', handler);
  const ack = first.enqueue('test_read', {}, operation(), 'same-resource');
  first.start(); second.start();
  await new Promise(resolveWait => setTimeout(resolveWait, 30));
  assert.equal(calls, 1); assert.equal(a.require('job', ack.jobId).status, 'running');
  finish(); await new Promise(resolveWait => setTimeout(resolveWait, 10));
  assert.equal(a.require('job', ack.jobId).status, 'succeeded'); assert.equal(calls, 1);
  await first.stop(); await second.stop(); a.close(); b.close(); removeScratch(root);
});

test('expired external may-have-committed leases become uncertain and are never queued again', async t => {
  const app = await appFor(t); await app.jobs.stop();
  const job = app.store.put('job', { kind: 'review_response', payload: { sessionId: 'none' }, scope: 'riff:deck:card', operationId: operation(), status: 'running', commitState: 'may_have_committed', leaseOwner: 'old-worker', leaseUntil: 0, result: null, error: null, attempts: 1, progress: { completed: 0, total: 1 } });
  app.jobs.recover(); assert.equal(app.store.require('job', job.id).status, 'uncertain');
  assert.throws(() => app.jobs.enqueue('review_response', {}, operation(), 'riff:deck:card'), error => error.code === 'RECONCILIATION_REQUIRED');
  app.jobs.recover(); assert.equal(app.store.require('job', job.id).status, 'uncertain');
});

test('bounded queue deduplicates operations and rejects overlaps and excess work', async t => {
  const app = await appFor(t); await app.jobs.stop();
  const op = operation(); const original = app.jobs.enqueue('test_read', {}, op, 'one');
  assert.deepEqual(app.jobs.enqueue('test_read', {}, op, 'one'), original);
  assert.throws(() => app.jobs.enqueue('test_read', {}, operation(), 'one'), error => error.code === 'JOB_OVERLAP');
  for (let index = 1; index < 100; index++) app.jobs.enqueue('test_read', {}, operation(), 'scope-' + index);
  assert.throws(() => app.jobs.enqueue('test_read', {}, operation(), 'overflow'), error => error.code === 'RATE_LIMITED');
});

test('scheduler is opt-in, persists unique slots, and catches up at most one current period', async t => {
  const app = await appFor(t); await app.jobs.stop();
  app.scheduler.tick(); assert.equal(app.store.all('job').length, 0);
  await settings(app, { scheduler: { enabled: true, dailyPlanEnabled: true, dailyPlanLocalTime: '00:00', catchUpEnabled: true } });
  const date = new Date(); app.scheduler.tick(date); app.scheduler.tick(date);
  assert.equal(app.store.all('job').length, 1); assert.equal(app.store.all('scheduler-slot').length, 1);
  const job = app.store.all('job')[0]; assert.equal(job.kind, 'daily_plan_generate'); assert.equal(job.payload.mode, 'template'); assert.equal(job.trigger, 'scheduler');
  const exported = JSON.parse((await ok(app, 'POST', '/exports', { scope: 'all', projectIds: [] })).content);
  assert.equal(exported.data.jobHistory[0].payload, undefined); assert.equal(exported.data.jobHistory[0].leaseOwner, undefined);
});

test('a persisted confirmed native receipt repairs only the local job state after a crash', async t => {
  const app = await appFor(t); await app.jobs.stop();
  const op = operation();
  const response = app.store.put('review-response', { operationId: op, status: 'confirmed', sessionId: 'session', presentationId: 'presentation', cardId: 'card', knowledgeId: 'knowledge', rating: 'good', elapsedMs: 1, committedAt: new Date().toISOString(), riffEvidence: { method: 'response', externalResponseId: null, checkedAt: new Date().toISOString() } });
  app.store.put('review-write', { state: 'confirmed', responseId: response.id }, 'presentation');
  const job = app.store.put('job', { kind: 'review_response', payload: { presentationId: 'presentation' }, operationId: op, status: 'running', commitState: 'may_have_committed', leaseOwner: 'dead-worker', leaseUntil: 0, progress: { completed: 0, total: 1 } });
  app.jobs.recover(); const recovered = app.jobs.public(job.id);
  assert.equal(recovered.status, 'succeeded'); assert.equal(recovered.commitState, 'confirmed'); assert.equal(recovered.result.response.id, response.id);
  assert.equal(app.store.all('review-response').length, 1);
});
