import assert from 'node:assert/strict';
import { appFor, fakeServer, ok, profile, settings } from './helpers.mjs';

export async function discussionFixture(t, { enabled = true, limit = 5 } = {}) {
  const clock = { value: new Date('2026-10-31T05:00:00.000Z') };
  const state = { malformed: false, gate: null, inputs: [] };
  const upstream = await fakeServer(t, async (req, body) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(body.model, 'synthetic-discussion-model');
    const input = JSON.parse(body.messages.find(message => message.role === 'user').content);
    state.inputs.push(input);
    if (state.gate) await state.gate;
    const sequence = state.inputs.length;
    const candidate = { summary: `Revised suggestion ${sequence}: specify the expected stored result.`,
      observations: input.base.rubric.map(criterion => ({ criterionId: criterion.id, finding: 'partial',
        comment: `Revision ${sequence}: explain one observable check.`, evidenceRefs: [],
        outputExcerpt: [...input.base.output].slice(0, 20).join('') })),
      nextActions: ['Compare the resulting count after replay.'], limitations: ['Synthetic advice is not verified mastery.'] };
    const result = { reply: `Synthetic explanation ${sequence}: distinguish the action from its stored result.`, candidate };
    if (state.malformed) result.untrustedExtra = 'synthetic-invalid-structure';
    return { usage: { prompt_tokens: 70, completion_tokens: 50, total_tokens: 120 },
      choices: [{ message: { content: JSON.stringify(result) } }] };
  });
  const app = await appFor(t, { automationClock: () => clock.value,
    adviceOptions: { clock: () => clock.value }, discussionOptions: { clock: () => clock.value } });
  app.learning.onAttempt = null;
  await profile(app, { goals: ['Explain reliable replay'], timeZone: 'UTC', dailyBudgetMinutes: 15 });
  await settings(app, { model: { enabled: true, endpoint: upstream.origin + '/v1', model: 'synthetic-discussion-model', allowExternalProcessing: false } });
  app.advice.update({ enabled, dailyCallLimit: limit });
  let sequence = 0;
  const createCase = ({ projectId = null, label = 'primary' } = {}) => {
    const source = app.sources.capture({ kind: 'manual', externalId: `discussion-${label}-${++sequence}`, projectId,
      title: `Synthetic replay evidence ${label}`, content: 'Store a stable event identity with its result; replay must not create another result.' });
    const refs = [app.sources.ref(source)];
    const practice = app.learning.createPractice({ projectId, kind: 'explanation', goal: 'Explain reliable replay', skill: '',
      prompt: 'Explain one observable check that replay stores only one result.', estimatedMinutes: 5, sourceRefs: refs,
      rubric: [{ label: 'Evidence', description: 'State an observable check.', expectedEvidence: ['One stored result'] }] }, app.learning.provenance('template', refs));
    const saved = app.learning.attempt(practice.id, { output: 'Replay the same event and require one saved record.', assistanceLevel: 'none', evidenceRefs: [] });
    const { feedback } = app.learning.saveFeedback(saved.id, 'model', { summary: 'Specify the expected result of replay.',
      observations: [{ criterionId: practice.rubric[0].id, finding: 'partial', comment: 'Include the expected count.', evidenceRefs: [] }],
      nextActions: ['State the expected count after two deliveries.'], limitations: ['Synthetic original feedback is a suggestion.'] });
    return { source, practice, attempt: app.store.require('attempt', saved.id), feedback, path: `/feedback/${feedback.id}/discussion` };
  };
  return { app, clock, state, upstream, createCase, ...createCase() };
}

export const fixture = discussionFixture;

async function waitFor(f, predicate, feedbackId) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await ok(f.app, 'GET', `/feedback/${feedbackId}/discussion`);
    if (predicate(value)) return value;
    if (Date.now() > deadline) assert.fail('Synthetic discussion did not reach the requested state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export function waitReady(f, version = 1, feedbackId = f.feedback.id) {
  return waitFor(f, value => value.status === 'ready' && value.version === version && value.pendingTurnId === null, feedbackId);
}

export function waitForStatus(f, status, feedbackId = f.feedback.id) {
  return waitFor(f, value => value.status === status, feedbackId);
}
