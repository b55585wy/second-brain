import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { appFor, scratch, ok, request, knowledge, configureSiyuan, fakeSiyuan, jobDone, operation } from './helpers.mjs';

async function configure(app, values) {
  return request(app, 'PUT', '/connections/siyuan', { expectedRevision: app.store.get('config', 'siyuan').revision,
    useRuntimeConnection: false, notebookTitle: 'synthetic notebook', baseUrl: null, ...values });
}

async function sync(app, knowledgeId) {
  const record = await ok(app, 'GET', `/knowledge/${knowledgeId}`);
  await jobDone(app, await ok(app, 'POST', `/knowledge/${knowledgeId}/sync`, { expectedRevision: record.revision }, 202));
  return ok(app, 'GET', `/knowledge/${knowledgeId}`);
}

async function accepted(app) {
  let item = await knowledge(app, { question: 'Preserve the accepted question', answer: 'Preserve the accepted answer',
    sourceRefs: [{ kind: 'manual', title: 'synthetic evidence', url: null, excerpt: 'Actual synthetic evidence' }] });
  item = await ok(app, 'PATCH', `/knowledge/${item.id}`, { expectedRevision: item.revision,
    validation: { status: 'supported', method: 'source_check', notes: 'manually checked',
      evidenceRefs: [{ kind: 'source', id: item.sourceRefs[0].sourceId, url: null, label: 'actual source evidence' }] } });
  return ok(app, 'POST', `/knowledge/${item.id}/decision`, { expectedRevision: item.revision, decision: 'accept' });
}

async function presented(app) {
  const session = await ok(app, 'POST', '/review-sessions', { projectId: null, limit: 2 }, 201);
  const next = await ok(app, 'GET', `/review-sessions/${session.id}/next`);
  const identity = { presentationId: next.card.presentationId, cardId: next.card.cardId };
  await ok(app, 'POST', `/review-sessions/${session.id}/reveal`, identity);
  return { session, identity, rating: { ...identity, rating: 'good', elapsedMs: 1 } };
}

function runtimeFiles(root) {
  const directory = resolve(root, 'runtime'); mkdirSync(directory, { recursive: true });
  const manifest = resolve(directory, 'connection.json'); const token = resolve(directory, 'token.txt');
  return { manifest, token, save(baseUrl, marker = {}, value = 'synthetic-runtime-token') {
    writeFileSync(token, value); writeFileSync(manifest, JSON.stringify({ baseUrl, tokenFile: 'token.txt', ...marker }));
  } };
}

function assertNoOldTargets(calls, upstream) {
  const ids = new Set([...upstream.state.notebooks, ...upstream.state.decks, ...upstream.state.docs].flatMap(item => [item.id, ...(item.children ?? []).map(child => child.id)]));
  for (const card of upstream.state.cards) for (const key of ['cardID', 'blockID', 'deckID']) ids.add(card[key]);
  for (const call of calls) {
    const { markdown, data, ...targets } = call.body;
    const serialized = JSON.stringify(targets);
    for (const id of ids) assert.ok(!serialized.includes(id), `old destination ID in ${call.path}`);
  }
}

function gate() {
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  return { entered: entered.promise, release: release.resolve, async wait() { entered.resolve(); await release.promise; } };
}

test('A to B resets active destinations, preserves accepted evidence and history, and syncs fresh valid B IDs', async t => {
  const a = await fakeSiyuan(t, { namespace: 'aaa' }); const b = await fakeSiyuan(t, { namespace: 'bbb' }); const app = await appFor(t);
  await configureSiyuan(app, a); const item = await accepted(app); const synced = await sync(app, item.id);
  const review = await presented(app);
  await jobDone(app, await ok(app, 'POST', `/review-sessions/${review.session.id}/responses`, review.rating, 202));
  const practice = await ok(app, 'POST', '/practices', { projectId: null, kind: 'artifact', goal: 'preserve evidence', skill: '', prompt: 'Submit actual evidence', estimatedMinutes: 1,
    rubric: [{ label: 'Evidence', description: 'Actual output', expectedEvidence: [] }], sourceRefs: [] }, 201);
  await ok(app, 'POST', `/practices/${practice.id}/attempts`, { output: 'past attempt remains', assistanceLevel: 'none', evidenceRefs: [] }, 201);
  const prior = { responses: app.store.all('review-response'), attempts: app.store.all('attempt'), jobs: app.store.all('job') };
  const oldRemote = JSON.stringify(a.state); const oldIdentity = app.store.get('config', 'siyuan-owned').identity;
  // An old-name collision must never cause reuse on B.
  b.state.notebooks.push({ id: '20261027090000-bbbzzzz', name: a.state.notebooks[0].name });
  await configureSiyuan(app, b);
  const reset = await ok(app, 'GET', `/knowledge/${item.id}`);
  for (const key of ['question', 'answer', 'status', 'sourceRefs', 'validation', 'lastDecision']) assert.deepEqual(reset[key], synced[key]);
  assert.equal(reset.siyuanBlockId, null); assert.equal(reset.sync.status, 'not_synced');
  assert.equal(app.store.get('config', 'siyuan-owned'), null); assert.equal(app.store.all('sync-target').length, 0);
  assert.deepEqual(app.store.all('review-response'), prior.responses); assert.deepEqual(app.store.all('attempt'), prior.attempts);
  for (const job of prior.jobs) assert.deepEqual(app.store.require('job', job.id), job);
  const archive = app.store.all('siyuan-binding-archive')[0]; assert.equal(archive.owned.identity, oldIdentity);
  assert.ok(!JSON.stringify(archive).includes('test-siyuan-token'));
  const fresh = await sync(app, item.id); assert.match(fresh.siyuanBlockId, /^\d{14}-bbb[a-z0-9]{4}$/);
  assert.notEqual(app.store.get('config', 'siyuan-owned').identity, oldIdentity);
  assert.equal(b.state.notebooks.length, 2); assert.equal(b.state.decks.length, 1); assert.equal(b.state.docs.length, 1); assert.equal(b.state.cards.length, 1);
  assert.equal(JSON.stringify(a.state), oldRemote); assertNoOldTargets(b.calls, a);
});

test('normalized repeat save, token rotation, auth mode swaps, manifest version/title and restart preserve one binding', async t => {
  const a = await fakeSiyuan(t, { namespace: 'aaa' }); const root = scratch(); const files = runtimeFiles(root);
  files.save(a.origin, { workspaceId: 'stable-workspace-a', version: '3.8.8' });
  let app = await appFor(t, { root, keep: true }); const item = await accepted(app); await sync(app, item.id);
  const epoch = app.siyuan.epoch(); const owned = app.store.get('config', 'siyuan-owned'); const block = app.store.require('knowledge', item.id).siyuanBlockId;
  for (const token of ['synthetic-manual-a', 'synthetic-manual-rotated']) {
    assert.equal((await configure(app, { baseUrl: a.origin + '/', token })).status, 200); await sync(app, item.id);
    assert.equal(app.siyuan.epoch(), epoch);
  }
  files.save(a.origin, { workspaceId: 'stable-workspace-a', version: '99.0', title: 'display changed' }, 'synthetic-runtime-rotated');
  assert.equal((await configure(app, { useRuntimeConnection: true })).status, 200); await sync(app, item.id);
  assert.equal(app.siyuan.epoch(), epoch); assert.equal(app.store.get('config', 'siyuan-owned').deckId, owned.deckId);
  await app.close(); app = await appFor(t, { root }); await sync(app, item.id);
  assert.equal(app.siyuan.epoch(), epoch); assert.equal(app.store.require('knowledge', item.id).siyuanBlockId, block);
  assert.equal(a.state.notebooks.length, 1); assert.equal(a.state.decks.length, 1); assert.equal(a.state.docs.length, 1); assert.equal(a.state.cards.length, 1);
  assert.equal(app.store.all('siyuan-binding-archive').length, 0);
  assert.equal(a.calls.at(-1).headers.authorization, 'Token synthetic-runtime-rotated');
});

for (const change of ['url', 'workspaceId', 'instanceId']) {
  test(`runtime ${change} change uses the current binding reset and fresh destination identity`, async t => {
    const a = await fakeSiyuan(t, { namespace: 'aaa' }); const b = await fakeSiyuan(t, { namespace: 'bbb' });
    const root = scratch(); const files = runtimeFiles(root); const marker = change === 'url' ? {} : { [change]: 'stable-a' }; files.save(a.origin, marker);
    const app = await appFor(t, { root }); const item = await accepted(app); await sync(app, item.id);
    const oldEpoch = app.siyuan.epoch(); const oldOwned = app.store.get('config', 'siyuan-owned'); const before = a.calls.length;
    files.save(change === 'url' ? b.origin : a.origin, change === 'url' ? {} : { [change]: 'stable-b' }, 'synthetic-next-token');
    assert.notEqual(app.settings.siyuan().connectionEpoch, oldEpoch);
    assert.equal(app.store.require('knowledge', item.id).siyuanBlockId, null); assert.equal(app.store.get('config', 'siyuan-owned'), null);
    await sync(app, item.id); assert.notEqual(app.store.get('config', 'siyuan-owned').identity, oldOwned.identity);
    if (change === 'url') { assert.equal(a.calls.length, before); assertNoOldTargets(b.calls, a); }
    else { assert.equal(a.state.notebooks.length, 2); assert.equal(a.state.decks.length, 2); assert.equal(a.state.cards.length, 2); }
  });
}

test('unmarked same-URL workspace replacement cannot be inferred from token, mtime, version or title', async t => {
  const a = await fakeSiyuan(t); const root = scratch(); const files = runtimeFiles(root); files.save(a.origin);
  const app = await appFor(t, { root }); const item = await accepted(app); await sync(app, item.id);
  const epoch = app.siyuan.epoch(); const owned = app.store.get('config', 'siyuan-owned');
  files.save(a.origin, { version: 'different', title: 'new native workspace display' }, 'synthetic-new-auth');
  assert.equal(app.settings.siyuan().connectionEpoch, epoch); assert.deepEqual(app.store.get('config', 'siyuan-owned'), owned);
  assert.equal(app.store.all('siyuan-binding-archive').length, 0);
});

test('queued old sync, rating and both SiYuan imports cancel without calls; old presentation rejects and stale restart dispatch stays canceled', async t => {
  const a = await fakeSiyuan(t, { namespace: 'aaa' }); const b = await fakeSiyuan(t, { namespace: 'bbb' }); const root = scratch();
  let app = await appFor(t, { root, keep: true }); await configureSiyuan(app, a); const item = await accepted(app); await sync(app, item.id);
  const review = await presented(app); await app.jobs.stop();
  const acks = [await ok(app, 'POST', `/review-sessions/${review.session.id}/responses`, review.rating, 202),
    await ok(app, 'POST', `/knowledge/${item.id}/sync`, { expectedRevision: app.store.require('knowledge', item.id).revision }, 202)];
  for (const kind of ['siyuan_block', 'siyuan_document']) acks.push(await ok(app, 'POST', '/sources/import', { kind, projectId: null, [kind === 'siyuan_block' ? 'blockId' : 'documentId']: a.state.originalId }, 202));
  const stale = acks.map(ack => app.store.require('job', ack.jobId)); const before = a.calls.length;
  await configureSiyuan(app, b);
  for (const ack of acks) assert.equal(app.store.require('job', ack.jobId).status, 'cancelled');
  assert.equal(a.calls.length, before); assert.equal(b.calls.length, 0); assert.equal(app.store.all('review-write')[0].state, 'cancelled');
  assert.equal((await request(app, 'POST', `/review-sessions/${review.session.id}/responses`, review.rating)).status, 409);
  assert.equal((await request(app, 'POST', `/review-sessions/${review.session.id}/reveal`, review.identity)).status, 409);
  assert.equal((await ok(app, 'GET', `/review-sessions/${review.session.id}/next`)).reason, 'connection_changed');
  // Simulate a stale persisted queued snapshot being delivered after the reset.
  for (const job of stale) app.store.put('job', job);
  await app.close(); app = await appFor(t, { root });
  for (const ack of acks) await jobDone(app, ack, 'cancelled');
  assert.equal(a.calls.length, before); assert.equal(b.calls.length, 0); assert.equal(app.store.require('knowledge', item.id).sync.status, 'not_synced');
  assert.equal(app.store.all('source').filter(source => source.kind === 'siyuan').length, 0); assert.equal(a.state.grades.length, 0);
});

const locks = ['running-sync', 'running-review', 'uncertain-sync', 'uncertain-review', 'failed-may-have-committed',
  'inflight-review', 'uncertain-write', 'orphan-queued-review', 'notebook-pending', 'deck-pending', 'document-pending'];

function seedLock(app, lock) {
  const epoch = app.siyuan.epoch();
  app.store.put('config', { identity: 'synthetic-owned', notebookId: '20261027090000-aaa0001', deckId: '20261027090000-aaa0002',
    notebookCreationPending: lock === 'notebook-pending', deckCreationPending: lock === 'deck-pending' }, 'siyuan-owned');
  if (['running-sync', 'running-review', 'uncertain-sync', 'uncertain-review', 'failed-may-have-committed'].includes(lock)) {
    app.store.put('job', { kind: lock.endsWith('-review') ? 'review_response' : 'knowledge_sync',
      payload: { connectionEpoch: epoch, knowledgeId: 'synthetic-knowledge', sessionId: 'synthetic-session' }, operationId: operation(), scope: 'synthetic-lock',
      status: lock.startsWith('running') ? 'running' : lock.startsWith('uncertain') ? 'uncertain' : 'failed',
      commitState: lock.startsWith('running') ? 'not_started' : 'may_have_committed', leaseOwner: 'prior-worker', leaseUntil: Date.now() + 60000, progress: { completed: 0, total: 1 } });
  }
  if (['inflight-review', 'uncertain-write', 'orphan-queued-review'].includes(lock)) app.store.put('review-write', {
    state: lock === 'inflight-review' ? 'inflight' : lock === 'uncertain-write' ? 'uncertain' : 'queued', connectionEpoch: epoch, deckId: '20261027090000-aaa0002', jobId: 'missing-job' });
  if (lock === 'document-pending') app.store.put('sync-target', { creationPending: true, knowledgeId: 'synthetic-knowledge' }, 'synthetic-knowledge');
}

for (const mode of ['manual', 'runtime']) {
  for (const lock of locks) {
    test(`${mode} switching rejects durable ${lock} without changing config, credentials or evidence`, async t => {
      const a = await fakeSiyuan(t); const b = await fakeSiyuan(t); const root = scratch(); const files = runtimeFiles(root);
      if (mode === 'runtime') files.save(a.origin, { workspaceId: 'workspace-a' });
      let app = await appFor(t, { root, keep: true });
      if (mode === 'manual') await configureSiyuan(app, a, 'synthetic-original-token');
      await app.jobs.stop(); seedLock(app, lock); await app.close();
      app = await appFor(t, { root }); await app.jobs.stop();
      const snapshot = JSON.stringify(app.store.db.prepare('SELECT * FROM records ORDER BY kind,id').all());
      const credentials = readFileSync(app.secrets.filename, 'utf8');
      if (mode === 'runtime') {
        files.save(b.origin, { workspaceId: 'workspace-b' }, 'synthetic-different-token');
        assert.throws(() => app.settings.siyuan(), error => error.status === 409 && error.code === 'RECONCILIATION_REQUIRED');
      } else {
        const result = await configure(app, { baseUrl: b.origin, token: 'synthetic-different-token' });
        assert.equal(result.status, 409); assert.equal(result.error.code, 'RECONCILIATION_REQUIRED');
      }
      assert.equal(JSON.stringify(app.store.db.prepare('SELECT * FROM records ORDER BY kind,id').all()), snapshot);
      assert.equal(readFileSync(app.secrets.filename, 'utf8'), credentials); assert.equal(a.calls.length, 0); assert.equal(b.calls.length, 0);
    });
  }
}

for (const corruption of ['missing', 'invalid']) {
  test(`${corruption} runtime manifest clears endpoint/token/check and preserves uncertain native evidence`, async t => {
    const a = await fakeSiyuan(t); const b = await fakeSiyuan(t); const root = scratch(); const files = runtimeFiles(root); files.save(a.origin, { instanceId: 'stable-a' });
    const app = await appFor(t, { root }); await app.siyuan.check(); await app.jobs.stop(); seedLock(app, 'uncertain-sync');
    const job = app.store.all('job')[0]; const owned = app.store.get('config', 'siyuan-owned');
    if (corruption === 'missing') unlinkSync(files.manifest); else writeFileSync(files.manifest, '{invalid');
    assert.equal(app.settings.siyuan().baseUrl, null); assert.equal(app.settings.siyuanToken(), ''); assert.equal(app.secrets.get('siyuan.runtimeToken'), '');
    assert.equal(app.store.get('config', 'siyuan-check'), null); assert.deepEqual(app.store.require('job', job.id), job); assert.deepEqual(app.store.get('config', 'siyuan-owned'), owned);
    files.save(b.origin, { instanceId: 'stable-b' }, 'synthetic-new-token');
    assert.throws(() => app.settings.siyuan(), error => error.code === 'RECONCILIATION_REQUIRED');
    assert.equal(app.secrets.get('siyuan.runtimeToken'), ''); assert.equal(app.store.get('config', 'siyuan').baseUrl, null);
    files.save(a.origin, { instanceId: 'stable-a' });
    assert.equal(app.settings.siyuan().baseUrl, a.origin); assert.deepEqual(app.store.require('job', job.id), job);
    assert.deepEqual(app.store.get('config', 'siyuan-owned'), owned); assert.equal(b.calls.length, 0);
  });
}

test('runtime stable marker switch rejection is propagated rather than treated as invalid manifest', async t => {
  const a = await fakeSiyuan(t); const root = scratch(); const files = runtimeFiles(root); files.save(a.origin, { workspaceId: 'stable-a' });
  const app = await appFor(t, { root }); await app.jobs.stop(); seedLock(app, 'deck-pending');
  const snapshot = app.store.get('config', 'siyuan'); const token = app.secrets.get('siyuan.runtimeToken');
  files.save(a.origin, { workspaceId: 'stable-b' }, 'synthetic-replacement-token');
  assert.throws(() => app.settings.siyuan(), error => error.code === 'RECONCILIATION_REQUIRED');
  assert.deepEqual(app.store.get('config', 'siyuan'), snapshot); assert.equal(app.secrets.get('siyuan.runtimeToken'), token);
});

test('controlled delayed old check cannot persist status for the new connection', async t => {
  const a = await fakeSiyuan(t); const b = await fakeSiyuan(t); const app = await appFor(t); await configureSiyuan(app, a);
  const responseGate = gate(); a.state.gates = { '/api/system/version': () => responseGate.wait() };
  const pending = request(app, 'POST', '/connections/siyuan/check', {});
  try { await responseGate.entered; await configureSiyuan(app, b); } finally { responseGate.release(); }
  const result = await pending; assert.equal(result.status, 409); assert.equal(app.store.get('config', 'siyuan-check'), null);
  assert.equal(app.settings.connectionStatus().siyuan.status, 'unchecked'); assert.equal(b.calls.length, 0);
  await ok(app, 'POST', '/connections/siyuan/check', {}); assert.equal(app.settings.connectionStatus().siyuan.status, 'connected');
});

test('controlled delayed old import cannot capture source content or dispatch its old block to the new connection', async t => {
  const a = await fakeSiyuan(t, { namespace: 'aaa', originalId: '20261027080000-aaasrc1', sourceText: 'old-epoch-source-sentinel' });
  const b = await fakeSiyuan(t, { namespace: 'bbb', originalId: '20261027080000-bbbsrc1', sourceText: 'new-epoch-source' });
  const app = await appFor(t); await configureSiyuan(app, a); const responseGate = gate();
  a.state.gates = { '/api/block/getBlockKramdown': () => responseGate.wait() };
  const ack = await ok(app, 'POST', '/sources/import', { kind: 'siyuan_block', projectId: null, blockId: a.state.originalId }, 202);
  try { await responseGate.entered; await configureSiyuan(app, b); } finally { responseGate.release(); }
  const failed = await jobDone(app, ack, 'failed'); assert.equal(failed.error.code, 'INVALID_STATE');
  assert.equal(app.store.all('source').length, 0); assert.equal(app.store.all('knowledge').length, 0); assert.equal(b.calls.length, 0);
  await jobDone(app, await ok(app, 'POST', '/sources/import', { kind: 'siyuan_block', projectId: null, blockId: b.state.originalId }, 202));
  assert.equal(app.store.all('source')[0].content, 'new-epoch-source'); assert.ok(!JSON.stringify(b.calls).includes(a.state.originalId));
});

test('controlled delayed old due-card read cannot create a new presentation after switching', async t => {
  const a = await fakeSiyuan(t, { namespace: 'aaa' }); const b = await fakeSiyuan(t, { namespace: 'bbb' }); const app = await appFor(t);
  await configureSiyuan(app, a); const item = await accepted(app); await sync(app, item.id);
  const session = await ok(app, 'POST', '/review-sessions', { projectId: null }, 201); const responseGate = gate();
  a.state.gates = { '/api/riff/getRiffDueCards': () => responseGate.wait() };
  const pending = request(app, 'GET', `/review-sessions/${session.id}/next`);
  try { await responseGate.entered; await configureSiyuan(app, b); } finally { responseGate.release(); }
  assert.equal((await pending).status, 409); assert.equal(app.store.all('review-presentation').length, 0);
  assert.equal(app.store.require('review-session', session.id).status, 'completed'); assert.equal(b.calls.length, 0);
});

test('credential persistence failure rolls back the binding reset transaction', async t => {
  const a = await fakeSiyuan(t); const b = await fakeSiyuan(t); const app = await appFor(t); await configureSiyuan(app, a);
  const item = await accepted(app); await sync(app, item.id); const snapshot = JSON.stringify(app.store.db.prepare('SELECT * FROM records ORDER BY kind,id').all());
  const previous = app.secrets.get('siyuan.token'); const set = app.secrets.set.bind(app.secrets);
  app.secrets.set = () => { throw new Error('controlled credential failure'); };
  const result = await configure(app, { baseUrl: b.origin, token: 'synthetic-new-token' }); app.secrets.set = set;
  assert.equal(result.status, 500); assert.equal(app.secrets.get('siyuan.token'), previous);
  assert.equal(JSON.stringify(app.store.db.prepare('SELECT * FROM records ORDER BY kind,id').all()), snapshot);
});

for (const mode of ['manual', 'runtime']) {
  test(`actual in-flight grade rejects ${mode} switch and confirms exactly once on its original service`, async t => {
    const a = await fakeSiyuan(t, { namespace: 'aaa' }); const b = await fakeSiyuan(t, { namespace: 'bbb' });
    const root = scratch(); const files = runtimeFiles(root); if (mode === 'runtime') files.save(a.origin, { instanceId: 'stable-a' });
    const app = await appFor(t, { root }); if (mode === 'manual') await configureSiyuan(app, a);
    const item = await accepted(app); await sync(app, item.id); const review = await presented(app);
    const responseGate = gate(); a.state.gates = { '/api/riff/reviewRiffCard': () => responseGate.wait() };
    const ack = await ok(app, 'POST', `/review-sessions/${review.session.id}/responses`, review.rating, 202);
    try {
      await responseGate.entered;
      assert.equal(app.store.require('review-write', review.identity.presentationId).state, 'inflight');
      const snapshot = app.store.get('config', 'siyuan'); const credentials = readFileSync(app.secrets.filename, 'utf8');
      if (mode === 'runtime') {
        files.save(b.origin, { instanceId: 'stable-b' }, 'synthetic-new-token');
        assert.throws(() => app.settings.siyuan(), error => error.code === 'RECONCILIATION_REQUIRED');
      } else assert.equal((await configure(app, { baseUrl: b.origin, token: 'synthetic-new-token' })).status, 409);
      assert.deepEqual(app.store.get('config', 'siyuan'), snapshot); assert.equal(readFileSync(app.secrets.filename, 'utf8'), credentials);
      assert.equal(app.store.require('review-write', review.identity.presentationId).state, 'inflight');
      if (mode === 'runtime') files.save(a.origin, { instanceId: 'stable-a' });
    } finally { responseGate.release(); }
    await jobDone(app, ack); assert.equal(a.state.grades.length, 1); assert.equal(b.calls.length, 0);
    assert.equal(app.store.require('review-write', review.identity.presentationId).state, 'confirmed');
    assert.equal(app.store.all('review-response').length, 1);
  });
}

test('runtime credential failure rolls back local binding reset and permits recovery with the same manifest', async t => {
  const a = await fakeSiyuan(t); const b = await fakeSiyuan(t); const root = scratch(); const files = runtimeFiles(root); files.save(a.origin);
  const app = await appFor(t, { root }); const item = await accepted(app); await sync(app, item.id);
  const snapshot = JSON.stringify(app.store.db.prepare('SELECT * FROM records ORDER BY kind,id').all()); const set = app.secrets.set.bind(app.secrets);
  files.save(b.origin, {}, 'synthetic-b-token'); app.secrets.set = () => { throw new Error('controlled credential failure'); };
  assert.throws(() => app.settings.siyuan(), /controlled credential failure/); app.secrets.set = set;
  assert.equal(JSON.stringify(app.store.db.prepare('SELECT * FROM records ORDER BY kind,id').all()), snapshot);
  assert.equal(app.settings.siyuan().baseUrl, b.origin); assert.equal(app.store.require('knowledge', item.id).siyuanBlockId, null);
  await sync(app, item.id); assert.equal(b.state.cards.length, 1);
});

test('a stale dispatch marked may_have_committed retains uncertainty and never becomes cancellation or a resend', async t => {
  const a = await fakeSiyuan(t); const app = await appFor(t); await configureSiyuan(app, a); await app.jobs.stop();
  const job = app.store.put('job', { kind: 'knowledge_sync', payload: { connectionEpoch: 'stale-epoch', knowledgeId: 'absent' },
    operationId: operation(), scope: 'stale-write', status: 'queued', commitState: 'may_have_committed', attempts: 1,
    leaseOwner: null, leaseUntil: null, progress: { completed: 0, total: 1 } });
  app.jobs.start(); await jobDone(app, { jobId: job.id }, 'uncertain');
  assert.equal(app.store.require('job', job.id).commitState, 'may_have_committed'); assert.equal(a.calls.length, 0);
});
