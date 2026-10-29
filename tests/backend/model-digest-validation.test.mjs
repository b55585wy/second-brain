import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDigest } from '../../server/model-digest.mjs';
import { ApiError } from '../../server/errors.mjs';

const rules = new Set(['object_fields', 'text', 'integer_range', 'array_length', 'quote_mismatch', 'exercise_required', 'exercise_forbidden']);

function fixture() {
  const quote = 'A transaction saves related changes together.';
  return {
    input: { profile: { goals: ['Explain reliable systems'] }, budgetMinutes: 10,
      segments: [{ sourceId: 'src_allowed', text: quote }] },
    result: { highlights: [{ title: 'Atomic changes', summary: 'Save related changes together.', goalIndex: 0,
      whyRelevant: 'Supports explaining reliable systems.', evidence: [{ sourceId: 'src_allowed', quote }] }],
    exercise: { kind: 'new_scenario', prompt: 'Describe a new failure and a checkable remedy.', estimatedMinutes: 5,
      highlightIndex: 0, rubric: [{ label: 'Reasoning', description: 'Explain the failure and remedy.', expectedEvidence: ['A concrete example'] }] } },
  };
}

function setPath(result, path, value) {
  const keys = path.match(/[^.[\]]+/g);
  const parent = keys.slice(0, -1).reduce((item, key) => item[key], result);
  parent[keys.at(-1)] = value;
}

function invalid(result, input, path, rule) {
  let caught;
  assert.throws(() => validateDigest(result, input), error => {
    caught = error;
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 502);
    assert.equal(error.code, 'UPSTREAM_ERROR');
    assert.equal(error.retryable, false);
    assert.deepEqual(Object.keys(error.validationIssue).sort(), ['path', 'rule']);
    assert.equal(typeof error.validationIssue.path, 'string');
    assert.ok(rules.has(error.validationIssue.rule));
    if (path) assert.equal(error.validationIssue.path, path);
    if (rule) assert.equal(error.validationIssue.rule, rule);
    return true;
  });
  return caught;
}

test('valid digest validation returns the same object without changing output or input', () => {
  const f = fixture(); const before = structuredClone(f);
  assert.equal(validateDigest(f.result, f.input), f.result);
  assert.deepEqual(f, before);
});

const textLimits = [
  ['highlights[0].title', 200],
  ['highlights[0].summary', 200],
  ['highlights[0].whyRelevant', 500],
  ['highlights[0].evidence[0].sourceId', 128],
  ['highlights[0].evidence[0].quote', 1000],
  ['exercise.prompt', 10000],
  ['exercise.rubric[0].label', 200],
  ['exercise.rubric[0].description', 2000],
  ['exercise.rubric[0].expectedEvidence[0]', 500],
];

function replaceText(f, path, value) {
  setPath(f.result, path, value);
  if (path.endsWith('.sourceId')) f.input.segments[0].sourceId = value;
  if (path.endsWith('.quote')) f.input.segments[0].text = value;
}

for (const [path, max] of textLimits) {
  test(`${path} accepts exactly ${max} Unicode characters`, () => {
    const f = fixture(); replaceText(f, path, '🧠'.repeat(max));
    assert.equal(validateDigest(f.result, f.input), f.result);
  });
  test(`${path} rejects ${max + 1} Unicode characters without changing the result`, () => {
    const f = fixture(); replaceText(f, path, '🧠'.repeat(max + 1)); const before = structuredClone(f);
    invalid(f.result, f.input, path, 'text'); assert.deepEqual(f, before);
  });
  for (const [label, value] of [['blank', '  \n '], ['non-text', 42]]) {
    test(`${path} rejects ${label} values`, () => {
      const f = fixture(); replaceText(f, path, value);
      invalid(f.result, f.input, path, 'text');
    });
  }
}

for (const [path, min, max, sample] of [
  ['highlights', 0, 3, () => fixture().result.highlights[0]],
  ['highlights[0].evidence', 1, 3, () => fixture().result.highlights[0].evidence[0]],
  ['exercise.rubric', 1, 3, () => fixture().result.exercise.rubric[0]],
  ['exercise.rubric[0].expectedEvidence', 0, 10, () => 'A concrete example'],
]) {
  for (const count of new Set([min, 1, max])) {
    test(`${path} accepts ${count} entries`, () => {
      const f = fixture(); setPath(f.result, path, Array.from({ length: count }, sample));
      if (path === 'highlights' && count === 0) f.result.exercise = null;
      assert.equal(validateDigest(f.result, f.input), f.result);
    });
  }
  for (const count of new Set([...(min ? [0] : []), max + 1])) {
    test(`${path} rejects ${count} entries`, () => {
      const f = fixture(); setPath(f.result, path, Array.from({ length: count }, sample));
      invalid(f.result, f.input, path, 'array_length');
    });
  }
  test(`${path} rejects a non-array`, () => {
    const f = fixture(); setPath(f.result, path, null);
    invalid(f.result, f.input, path, 'array_length');
  });
}

for (const [path, values] of [
  ['highlights[0].goalIndex', ['0', 0.5, -1, 1]],
  ['exercise.highlightIndex', ['0', 0.5, -1, 1]],
  ['exercise.estimatedMinutes', ['5', 1.5, 0, 11]],
]) {
  for (const value of values) {
    test(`${path} rejects ${JSON.stringify(value)}`, () => {
      const f = fixture(); setPath(f.result, path, value);
      invalid(f.result, f.input, path, 'integer_range');
    });
  }
}

test('last valid goal and highlight indexes and maximum budget remain accepted', () => {
  const f = fixture(); f.input.profile.goals.push('Apply reliable systems');
  f.result.highlights = Array.from({ length: 3 }, () => structuredClone(f.result.highlights[0]));
  f.result.highlights[2].goalIndex = 1; f.result.exercise.highlightIndex = 2; f.result.exercise.estimatedMinutes = 10;
  assert.equal(validateDigest(f.result, f.input), f.result);
});

test('one-minute budget accepts a one-minute exercise', () => {
  const f = fixture(); f.input.budgetMinutes = 1; f.result.exercise.estimatedMinutes = 1;
  assert.equal(validateDigest(f.result, f.input), f.result);
});

for (const kind of ['explanation', 'new_scenario', 'artifact']) {
  test(`exercise accepts the ${kind} kind`, () => {
    const f = fixture(); f.result.exercise.kind = kind;
    assert.equal(validateDigest(f.result, f.input), f.result);
  });
}

test('exercise rejects an unrecognized kind', () => {
  const f = fixture(); f.result.exercise.kind = 'answer';
  invalid(f.result, f.input, 'exercise.kind');
});

for (const value of [null, [], 'output', 7]) {
  test(`root rejects ${JSON.stringify(value)} instead of returning an internal error`, () => {
    invalid(value, fixture().input, null, 'object_fields');
  });
}

for (const path of ['highlights[0]', 'highlights[0].evidence[0]', 'exercise', 'exercise.rubric[0]']) {
  for (const value of [null, []]) {
    test(`${path} rejects ${value === null ? 'null' : 'an array'}`, () => {
      const f = fixture(); setPath(f.result, path, value);
      invalid(f.result, f.input, path, path === 'exercise' && value === null ? 'exercise_required' : 'object_fields');
    });
  }
}

test('missing required root fields are rejected', () => {
  invalid({}, fixture().input);
});

for (const [label, quote] of [
  ['invented text', 'This claim was never supplied.'],
  ['ellipsis', 'A transaction ... together.'],
  ['paraphrase', 'Transactions save related modifications together.'],
  ['added whitespace', ' A transaction saves related changes together. '],
]) {
  test(`evidence rejects ${label} rather than rewriting the quote`, () => {
    const f = fixture(); f.result.highlights[0].evidence[0].quote = quote;
    invalid(f.result, f.input, 'highlights[0].evidence[0].quote', 'quote_mismatch');
  });
}

test('evidence rejects a real quote assigned to an invented source', () => {
  const f = fixture(); f.result.highlights[0].evidence[0].sourceId = 'src_invented';
  invalid(f.result, f.input, 'highlights[0].evidence[0].quote', 'quote_mismatch');
});

test('evidence cannot borrow a quote from a different supplied source', () => {
  const f = fixture(); f.input.segments.push({ sourceId: 'src_other', text: 'A different supplied explanation.' });
  f.result.highlights[0].evidence[0].quote = f.input.segments[1].text;
  invalid(f.result, f.input, 'highlights[0].evidence[0].quote', 'quote_mismatch');
});

for (const path of ['', 'highlights[0]', 'highlights[0].evidence[0]', 'exercise', 'exercise.rubric[0]']) {
  test(`unknown fields in ${path || 'root'} are rejected without echoing their names or values`, () => {
    const f = fixture(); const marker = 'PRIVATE_DIAGNOSTIC_MARKER';
    const object = path ? path.match(/[^.[\]]+/g).reduce((item, key) => item[key], f.result) : f.result;
    object['unexpected_' + marker] = 'value_' + marker;
    const error = invalid(f.result, f.input, path || null, 'object_fields');
    assert.ok(!error.message.includes(marker));
    assert.ok(!JSON.stringify(error.validationIssue).includes(marker));
  });
}

test('empty highlights with a null exercise are a valid result', () => {
  const f = fixture(); f.result = { highlights: [], exercise: null };
  assert.equal(validateDigest(f.result, f.input), f.result);
});

test('empty highlights forbid a fabricated exercise', () => {
  const f = fixture(); f.result.highlights = [];
  invalid(f.result, f.input, 'exercise', 'exercise_forbidden');
});

test('zero budget accepts cited highlights with no exercise', () => {
  const f = fixture(); f.input.budgetMinutes = 0; f.result.exercise = null;
  assert.equal(validateDigest(f.result, f.input), f.result);
});

test('zero budget forbids an exercise', () => {
  const f = fixture(); f.input.budgetMinutes = 0;
  invalid(f.result, f.input, 'exercise', 'exercise_forbidden');
});

test('positive budget and highlights require an exercise', () => {
  const f = fixture(); f.result.exercise = null;
  invalid(f.result, f.input, 'exercise', 'exercise_required');
});
