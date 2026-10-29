import test from 'node:test';
import assert from 'node:assert/strict';
import { appFor, ok, profile, request } from './helpers.mjs';
import { digest } from '../../server/validation.mjs';

async function sourceApp(t) {
  const app = await appFor(t); await profile(app, { goals: ['Reliable storage'] });
  const source = app.sources.capture({ kind: 'codex', externalId: 'A:u', threadId: 'A', messageId: 'u', role: 'user', title: 'Synthetic source', content: 'Save related changes together.' });
  const refs = [app.sources.ref(source)]; const values = app.domain.profile();
  const practice = app.learning.createPractice({ projectId: null, kind: 'explanation', goal: values.goals[0], skill: '', prompt: 'Explain the idea independently.',
    estimatedMinutes: 5, rubric: [{ label: 'Evidence', description: 'Give a concrete check.', expectedEvidence: ['An example'] }], sourceRefs: refs }, app.learning.provenance('template', refs));
  app.store.put('focus-artifact', { date: '2026-10-28', timeZone: values.timeZone, profileRevision: values.revision, scopeRevision: 1,
    modelConfigKey: digest({}), highlights: [{ id: 'highlight_synthetic', title: 'Atomic updates', summary: 'Keep changes together.', goal: values.goals[0], whyRelevant: 'Supports reliable storage.', sourceRefs: refs }],
    practiceId: practice.id, sourceDigests: [{ sourceId: source.id, contentDigest: source.contentDigest }], provenance: app.learning.provenance('template', refs), generatedAt: new Date().toISOString() }, 'focus_synthetic');
  await app.jobs.stop(); app.jobs.enqueue('learning_automation', { context: app.automation.context(), collect: true }, 'synthetic_auto_backup');
  return app;
}

async function document(app) { return JSON.parse((await ok(app, 'POST', '/exports', { scope: 'all', projectIds: [], includeSourceContent: true })).content); }

test('focus artifacts and automatic job history round-trip with source and practice dependencies', async t => {
  const source = await sourceApp(t); const backup = await document(source); const target = await appFor(t);
  assert.equal(backup.data.focusArtifacts.length, 1); assert.ok(backup.data.jobHistory.some(job => job.type === 'learning_automation'));
  const before = await ok(target, 'GET', '/learning-profile');
  const report = await ok(target, 'POST', '/imports', { document: backup, mode: 'merge', applyProfile: true, expectedProfileRevision: before.revision });
  assert.equal(report.counts.focusArtifacts.inserted, 1); assert.equal(report.conflictTotal, 0);
  const focus = target.store.all('focus-artifact')[0];
  assert.ok(target.store.get('practice', focus.practiceId)); assert.ok(target.store.get('source', focus.sourceDigests[0].sourceId));
  assert.equal(focus.scopeRevision, null); assert.equal(focus.modelConfigKey, null);
  assert.equal((await ok(target, 'GET', '/automation')).enabled, false);
  assert.equal((await ok(target, 'GET', '/settings')).model.enabled, false);
  assert.equal((await ok(target, 'GET', '/connections/codex/scope')).enabled, false);
  assert.equal(target.store.all('job').length, 0);
});

test('old v1 documents without focusArtifacts remain importable', async t => {
  const source = await appFor(t); const backup = await document(source); delete backup.data.focusArtifacts;
  const target = await appFor(t); const report = await ok(target, 'POST', '/imports', { document: backup, mode: 'merge' });
  assert.equal(report.counts.focusArtifacts.inserted, 0); assert.equal(report.conflictTotal, 0);
});

test('a successful import disables an already enabled automatic workflow', async t => {
  const source = await appFor(t); const backup = await document(source); const target = await appFor(t);
  const initial = await ok(target, 'GET', '/automation');
  await ok(target, 'PUT', '/automation', { enabled: true, expectedRevision: initial.revision });
  await ok(target, 'POST', '/imports', { document: backup, mode: 'merge' });
  assert.equal((await ok(target, 'GET', '/automation')).enabled, false);
});

test('invalid focus collections and fabricated nested fields are rejected atomically', async t => {
  const source = await sourceApp(t); const backup = await document(source); const target = await appFor(t);
  const invalid = structuredClone(backup); invalid.data.focusArtifacts = null;
  assert.equal((await request(target, 'POST', '/imports', { document: invalid, mode: 'merge' })).status, 422);
  const invented = structuredClone(backup); invented.data.focusArtifacts[0].highlights[0].mastery = 100;
  assert.equal((await request(target, 'POST', '/imports', { document: invented, mode: 'merge' })).status, 422);
  assert.equal(target.store.all('source').length, 0); assert.equal(target.store.all('focus-artifact').length, 0);
});
