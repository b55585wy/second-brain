import test from 'node:test';
import assert from 'node:assert/strict';
import { RIFF_VERSION, RIFF_SUPPORTED_VERSIONS, riffCompatible } from '../../server/siyuan-version.mjs';
import { RIFF_VERSION as legacyVersion, RIFF_RATINGS } from '../../server/siyuan.mjs';
import { appFor, ok, fakeServer, fakeSiyuan, configureSiyuan } from './helpers.mjs';

const card = () => ({ deckID: 'deck_synthetic', cardID: 'card_synthetic', blockID: '20261030120000-card001',
  lapses: 1, reps: 2, state: 2, lastReview: 1793325600000,
  nextDues: { 1: '1 min', 2: '2 min', 3: '3 min', 4: '4 min' } });

test('supported native versions are an immutable exact set and preserve the legacy baseline export', () => {
  assert.equal(RIFF_VERSION, '3.8.8'); assert.equal(legacyVersion, RIFF_VERSION);
  assert.deepEqual(RIFF_SUPPORTED_VERSIONS, ['3.8.8', '3.8.9']); assert.ok(Object.isFrozen(RIFF_SUPPORTED_VERSIONS));
  assert.throws(() => RIFF_SUPPORTED_VERSIONS.push('3.8.10'), TypeError);
  for (const version of RIFF_SUPPORTED_VERSIONS) assert.equal(riffCompatible(version), true);
  for (const version of ['3.8.7', '3.8.10', '3.8.9-rc.1', '3.8.9+build.1', '4.0.0', 'v3.8.9', '', null, 389, {}]) {
    assert.equal(riffCompatible(version), false);
  }
});

for (const version of RIFF_SUPPORTED_VERSIONS) {
  for (const data of [version, { version }]) {
    test(`${version} ${typeof data} version response passes HTTP connection and Riff capability checks`, async t => {
      const upstream = await fakeSiyuan(t, { version: data }); const app = await appFor(t);
      await configureSiyuan(app, upstream, 'synthetic-version-token');
      const result = await ok(app, 'POST', '/connections/siyuan/check', {});
      assert.equal(result.connection.status, 'connected');
      assert.deepEqual(result.checks, { version: 'passed', auth: 'passed', notebooks: 'passed', riff: 'passed' });
      assert.deepEqual(result.notices, []);
      const checked = await app.siyuan.check();
      assert.equal(checked.version, version); assert.equal(checked.riffCompatible, true); assert.equal(checked.supportedVersion, '3.8.8');
      for (const call of upstream.calls) {
        assert.equal(call.method, 'POST'); assert.equal(call.headers.authorization, 'Token synthetic-version-token');
      }
      assert.equal(upstream.state.grades.length, 0); assert.equal(upstream.state.cards.length, 0);
    });
  }

  test(`${version} due-card response retains native identity, scheduler fields and reviewed-card request`, async t => {
    const upstream = await fakeSiyuan(t, { version }); const app = await appFor(t);
    await configureSiyuan(app, upstream);
    const currentCard = card(); upstream.state.cards.push(currentCard);
    app.store.put('config', { deckId: currentCard.deckID }, 'siyuan-owned');
    const reviewedCards = ['already_reviewed']; const result = await app.siyuan.dueCards(reviewedCards);
    assert.deepEqual(result.cards, [currentCard]); assert.equal(result.unreviewedCount, 1);
    assert.equal(result.unreviewedOldCardCount, 1); assert.equal(result.unreviewedNewCardCount, 0);
    const call = upstream.calls.find(item => item.path === '/api/riff/getRiffDueCards');
    assert.deepEqual(call.body, { deckID: currentCard.deckID, reviewedCards });
    assert.equal(upstream.state.grades.length, 0);
  });

  test(`${version} keeps the exact again/forgot/hard/good/easy native rating mapping`, async t => {
    const upstream = await fakeSiyuan(t, { version }); const app = await appFor(t);
    await configureSiyuan(app, upstream); const currentCard = card(); upstream.state.cards.push(currentCard);
    await app.siyuan.compatible();
    for (const rating of ['again', 'forgot', 'hard', 'good', 'easy']) await app.siyuan.grade(currentCard, rating, []);
    assert.deepEqual([RIFF_RATINGS.again, RIFF_RATINGS.forgot, RIFF_RATINGS.hard, RIFF_RATINGS.good, RIFF_RATINGS.easy], [1, 1, 2, 3, 4]);
    assert.deepEqual(upstream.state.grades.map(item => item.rating), [1, 1, 2, 3, 4]);
    assert.equal(upstream.calls.filter(item => item.path === '/api/riff/reviewRiffCard').length, 5);
  });
}

for (const version of ['3.8.7', '3.8.10', '3.8.9-rc.1', '4.0.0']) {
  test(`unverified ${version} remains incompatible and cannot read a native review queue`, async t => {
    const upstream = await fakeSiyuan(t, { version }); const app = await appFor(t);
    await configureSiyuan(app, upstream);
    const checked = await app.siyuan.check();
    assert.equal(checked.status, 'incompatible'); assert.equal(checked.riffCompatible, false);
    await assert.rejects(app.siyuan.dueCards(), error => error.code === 'RIFF_INCOMPATIBLE'
      && error.message.includes('3.8.8') && error.message.includes('3.8.9'));
    assert.equal(upstream.calls.filter(item => item.path === '/api/riff/getRiffDueCards').length, 0);
    assert.equal(upstream.state.grades.length, 0);
  });
}

test('3.8.9 HTTP-200 nonzero native errors remain failures without implicit grading retries', async t => {
  const upstream = await fakeSiyuan(t, { version: '3.8.9', codes: { '/api/riff/getRiffDueCards': -1, '/api/riff/reviewRiffCard': -1 } });
  const app = await appFor(t); await configureSiyuan(app, upstream);
  app.store.put('config', { deckId: card().deckID }, 'siyuan-owned');
  await assert.rejects(app.siyuan.dueCards(), error => error.code === 'UPSTREAM_ERROR');
  await assert.rejects(app.siyuan.grade(card(), 'good', []), error => error.code === 'UPSTREAM_ERROR' && !error.retryable);
  assert.equal(upstream.calls.filter(item => item.path === '/api/riff/getRiffDueCards').length, 1);
  assert.equal(upstream.calls.filter(item => item.path === '/api/riff/reviewRiffCard').length, 1);
  assert.equal(upstream.state.grades.length, 0);
});

test('3.8.9 rejects malformed due-card scheduler fields rather than fabricating a queue', async t => {
  const malformed = { ...card(), reps: '2' };
  const upstream = await fakeServer(t, req => req.url === '/api/system/version'
    ? { code: 0, data: '3.8.9' } : { code: 0, data: { cards: [malformed], unreviewedCount: 1 } });
  const app = await appFor(t); await configureSiyuan(app, upstream);
  app.store.put('config', { deckId: malformed.deckID }, 'siyuan-owned');
  await assert.rejects(app.siyuan.dueCards(), error => error.code === 'UPSTREAM_ERROR');
  assert.equal(upstream.calls.filter(item => item.path === '/api/riff/getRiffDueCards').length, 1);
});

test('a timed-out 3.8.9 grade remains uncertain and sends exactly one native request', async t => {
  let nativeCommits = 0;
  const upstream = await fakeServer(t, async req => {
    if (req.url === '/api/system/version') return { code: 0, data: '3.8.9' };
    if (req.url === '/api/riff/reviewRiffCard') {
      nativeCommits++; await new Promise(resolve => setTimeout(resolve, 90));
      return { code: 0, data: null };
    }
    return { code: 0, data: { notebooks: [] } };
  });
  const app = await appFor(t, { transport: { timeoutMs: 30 } }); await configureSiyuan(app, upstream);
  await app.siyuan.compatible();
  await assert.rejects(app.siyuan.grade(card(), 'hard', []), error => error.code === 'UPSTREAM_TIMEOUT' && error.uncertain && !error.retryable);
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(nativeCommits, 1); assert.equal(upstream.calls.filter(item => item.path === '/api/riff/reviewRiffCard').length, 1);
});
