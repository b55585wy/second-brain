import test from 'node:test';
import assert from 'node:assert/strict';
import { Model } from '../../server/model.mjs';

const profile = { goals: ['Explain reliable systems'], careerDirection: 'Research engineer', skills: ['Evidence'], dailyBudgetMinutes: 15 };
const input = () => ({ profile: structuredClone(profile), budgetMinutes: 10,
  segments: [{ sourceId: 'src_allowed', text: 'A transaction saves related changes together.' }], previousHighlights: [] });
const valid = () => ({ highlights: [{ title: 'Atomic changes', summary: 'Save related changes together.', goalIndex: 0,
  whyRelevant: 'Supports explaining reliable systems.', evidence: [{ sourceId: 'src_allowed', quote: 'A transaction saves related changes together.' }] }],
  exercise: { kind: 'new_scenario', prompt: 'Describe how to prevent a partially saved update in a new example.', estimatedMinutes: 5,
    highlightIndex: 0, rubric: [{ label: 'Reasoning', description: 'Explain the failure and a checkable remedy.', expectedEvidence: ['A concrete example'] }] } });

function modelFor(result, raw) {
  const calls = [];
  const model = new Model({ raw: () => ({ model: { enabled: true, endpoint: 'http://127.0.0.1:1234/v1', model: 'synthetic', allowExternalProcessing: false } }) },
    { get: () => '', clean: value => value }, { async json(url, options) { calls.push({ url, options }); return { choices: [{ message: { content: raw ?? JSON.stringify(result) } }] }; } });
  return { model, calls };
}

test('goal digest returns cited highlights and one unanswered exercise using a thirty-second request', async () => {
  const f = modelFor(valid());
  assert.deepEqual(await f.model.digest(input()), valid());
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.timeoutMs, 30000);
  assert.ok(f.calls[0].options.body.messages[0].content.includes('untrusted data'));
  assert.ok(!Object.hasOwn(f.calls[0].options.body, 'thinking'));
});

test('digest allows no relevant material and forbids a fabricated exercise in that case', async () => {
  assert.deepEqual(await modelFor({ highlights: [], exercise: null }).model.digest(input()), { highlights: [], exercise: null });
  await assert.rejects(modelFor({ highlights: [], exercise: valid().exercise }).model.digest(input()), error => error.code === 'UPSTREAM_ERROR');
});

test('zero learning budget permits highlights but no exercise', async () => {
  const request = input(); request.budgetMinutes = 0;
  const result = valid(); result.exercise = null;
  assert.deepEqual(await modelFor(result).model.digest(request), result);
  await assert.rejects(modelFor(valid()).model.digest(request), error => error.code === 'UPSTREAM_ERROR');
});

for (const [label, mutate] of [
  ['too many highlights', result => { result.highlights = Array.from({ length: 4 }, () => structuredClone(result.highlights[0])); }],
  ['unknown goal', result => { result.highlights[0].goalIndex = 1; }],
  ['invented source', result => { result.highlights[0].evidence[0].sourceId = 'src_not_supplied'; }],
  ['invented quote', result => { result.highlights[0].evidence[0].quote = 'Unsupported assertion'; }],
  ['missing evidence', result => { result.highlights[0].evidence = []; }],
  ['missing positive-budget exercise', result => { result.exercise = null; }],
  ['preprovided answer field', result => { result.exercise.answer = 'The answer'; }],
  ['exercise over budget', result => { result.exercise.estimatedMinutes = 11; }],
  ['unknown exercise highlight', result => { result.exercise.highlightIndex = 4; }],
  ['empty rubric', result => { result.exercise.rubric = []; }],
  ['unexpected field', result => { result.mastery = 100; }],
]) {
  test(`digest rejects ${label} after one model request`, async () => {
    const result = valid(); mutate(result); const f = modelFor(result);
    await assert.rejects(f.model.digest(input()), error => error.code === 'UPSTREAM_ERROR');
    assert.equal(f.calls.length, 1);
  });
}

test('malformed digest JSON stops after one request', async () => {
  const f = modelFor(null, '{');
  await assert.rejects(f.model.digest(input()), error => error.code === 'UPSTREAM_ERROR'); assert.equal(f.calls.length, 1);
});

test('digest accepts an exact two-hundred-character summary', async () => {
  const result = valid(); result.highlights[0].summary = '学'.repeat(200); const f = modelFor(result);
  assert.deepEqual(await f.model.digest(input()), result); assert.equal(f.calls.length, 1);
});

test('digest rejects a two-hundred-and-one-character summary after one request', async () => {
  const result = valid(); result.highlights[0].summary = '学'.repeat(201); const f = modelFor(result);
  await assert.rejects(f.model.digest(input()), error => error.code === 'UPSTREAM_ERROR'); assert.equal(f.calls.length, 1);
});
