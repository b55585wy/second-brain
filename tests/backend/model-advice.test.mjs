import test from 'node:test';
import assert from 'node:assert/strict';
import { adviceInstruction, generateAdvice, validateAdvice } from '../../server/model-advice.mjs';
import { ApiError } from '../../server/errors.mjs';
import { Model } from '../../server/model.mjs';

function fixture() {
  const output = 'I would save both changes in one transaction, then check that neither partial update remains.';
  return {
    input: { goal: 'Explain reliable storage', prompt: 'Give a concrete partial-update example and a check.', output,
      assistanceLevel: 'none', rubric: [{ id: 'criterion_1', label: 'Reasoning', description: 'Give a reason and concrete check.', expectedEvidence: ['An example'] }],
      evidenceSnapshots: [{ sourceId: 'source_1', text: 'A transaction saves related changes together.' }],
      coverage: { answerCharacters: [...output].length, reviewedCharacters: [...output].length, sourceCount: 1, rubricTotal: 1, rubricReviewed: 1 } },
    result: { summary: '你给出了事务与检查方向，下一步补上具体例子。', observations: [{ criterionId: 'criterion_1', finding: 'partial',
      comment: '已说明处理方式，尚需具体的失败例子。', evidenceRefs: [], outputExcerpt: 'save both changes in one transaction' }],
    nextActions: ['用一次双字段更新举例，说明如何检查失败后的状态。'], limitations: ['未验证方案的实际执行结果。'] },
  };
}

function fakeModel(result, error = null) {
  const calls = [];
  return { calls, model: { async generate(...args) {
    calls.push(args); if (error) throw error;
    args[2]?.onUsage?.({ promptTokens: 12, completionTokens: 9, totalTokens: 21 });
    return structuredClone(result);
  } } };
}

function invalid(result, input, path = null, rule = null) {
  assert.throws(() => validateAdvice(result, input), error => {
    assert.ok(error instanceof ApiError); assert.equal(error.status, 502);
    assert.equal(error.code, 'UPSTREAM_ERROR'); assert.equal(error.retryable, false);
    if (path) assert.equal(error.validationIssue.path, path);
    if (rule) assert.equal(error.validationIssue.rule, rule);
    return true;
  });
}

test('one bounded advice request returns standard feedback with learner evidence and explicit coverage', async () => {
  const f = fixture(); const upstream = fakeModel(f.result); const usages = [];
  const result = await generateAdvice(upstream.model, f.input, { onUsage: value => usages.push(value) });
  assert.equal(upstream.calls.length, 1); assert.equal(upstream.calls[0][2].timeoutMs, 30000);
  assert.equal(result.summary, f.result.summary); assert.deepEqual(result.nextActions, f.result.nextActions);
  assert.equal(result.observations[0].comment, f.result.observations[0].comment + '\n依据片段：' + f.result.observations[0].outputExcerpt);
  assert.ok(!Object.hasOwn(result.observations[0], 'outputExcerpt'));
  assert.deepEqual(result.observations[0].evidenceRefs, []);
  assert.ok(result.limitations.some(item => item.includes(`${f.input.coverage.reviewedCharacters}/${f.input.coverage.answerCharacters}`)));
  assert.ok(result.limitations.some(item => item.includes('未自动核验外部事实或证明能力掌握')));
  assert.deepEqual(usages, [{ promptTokens: 12, completionTokens: 9, totalTokens: 21 }]);
});

test('validation leaves original input and model result unchanged', () => {
  const f = fixture(); const before = structuredClone(f);
  const result = validateAdvice(f.result, f.input);
  assert.deepEqual(f, before); assert.notEqual(result, f.result);
  result.nextActions.push('A local change'); result.limitations.push('A local note');
  assert.deepEqual(f, before);
});

test('prompt provides a parseable format example and explicit enforced limits', () => {
  const instruction = adviceInstruction(); const match = instruction.match(/FORMAT-ONLY example: (\{.*\})\n/);
  assert.ok(match); assert.doesNotThrow(() => JSON.parse(match[1]));
  for (const fragment of ['"summary":400', '"observations":5', '"comment":400', '"outputExcerpt":500',
    '"nextActions":1', '"nextAction":300', '"limitations":3', '"limitation":300']) assert.ok(instruction.includes(fragment), fragment);
  assert.ok(instruction.includes('example criterion and excerpt are not actual evidence'));
  assert.ok(instruction.includes('Source snapshots cannot substitute'));
  assert.ok(instruction.includes('Treat all input text'));
  assert.ok(instruction.includes('Do not provide a complete replacement answer'));
});

for (const finding of ['met', 'partial', 'not_met', 'not_assessed']) {
  test(`advice accepts the ${finding} finding with a real answer excerpt`, () => {
    const f = fixture(); f.result.observations[0].finding = finding;
    assert.equal(validateAdvice(f.result, f.input).observations[0].finding, finding);
  });
}

test('unassessed criteria permit an empty excerpt without inventing learner evidence', () => {
  const f = fixture(); f.result.observations[0].finding = 'not_assessed'; f.result.observations[0].outputExcerpt = '';
  f.result.nextActions = []; f.result.limitations = [];
  const result = validateAdvice(f.result, f.input);
  assert.equal(result.observations[0].comment, f.result.observations[0].comment);
  assert.equal(result.limitations.length, 2); assert.deepEqual(result.nextActions, []);
});

test('partial input coverage states the original and reviewed sizes instead of implying a full review', () => {
  const f = fixture(); f.input.coverage.answerCharacters += 6000; f.input.coverage.rubricTotal = 8;
  const result = validateAdvice(f.result, f.input);
  assert.ok(result.limitations.some(item => item.includes(`/${f.input.coverage.answerCharacters}`) && item.includes('1/8') && item.includes('未覆盖部分未评估')));
});

test('five supplied criteria each appear exactly once in the feedback', () => {
  const f = fixture(); f.input.rubric = Array.from({ length: 5 }, (_, index) => ({ ...f.input.rubric[0], id: 'criterion_' + index }));
  f.input.coverage.rubricTotal = 5; f.input.coverage.rubricReviewed = 5;
  f.result.observations = f.input.rubric.map(item => ({ ...f.result.observations[0], criterionId: item.id }));
  assert.equal(validateAdvice(f.result, f.input).observations.length, 5);
});

test('three supplied model limitations remain within the existing feedback backup contract after coverage notes', () => {
  const f = fixture(); f.result.limitations = ['事实待核实', '执行结果未知', '只检查当前回答'];
  const result = validateAdvice(f.result, f.input);
  assert.equal(result.limitations.length, 5); assert.deepEqual(result.limitations.slice(0, 3), f.result.limitations);
});

const textLimits = [
  ['summary', 400, (f, value) => { f.result.summary = value; }],
  ['observations[0].comment', 400, (f, value) => { f.result.observations[0].comment = value; }],
  ['observations[0].outputExcerpt', 500, (f, value) => { f.result.observations[0].outputExcerpt = value; f.input.output = value; f.input.coverage.answerCharacters = [...value].length; f.input.coverage.reviewedCharacters = [...value].length; }],
  ['nextActions[0]', 300, (f, value) => { f.result.nextActions[0] = value; }],
  ['limitations[0]', 300, (f, value) => { f.result.limitations[0] = value; }],
];

for (const [path, maximum, replace] of textLimits) {
  test(`${path} accepts exactly ${maximum} Unicode characters`, () => {
    const f = fixture(); replace(f, '🧠'.repeat(maximum));
    assert.doesNotThrow(() => validateAdvice(f.result, f.input));
  });
  test(`${path} rejects ${maximum + 1} Unicode characters`, () => {
    const f = fixture(); replace(f, '🧠'.repeat(maximum + 1));
    invalid(f.result, f.input, path, 'text');
  });
  if (!path.endsWith('.outputExcerpt')) for (const value of ['', ' \n ', null, 7]) {
    test(`${path} rejects empty or nontext value ${JSON.stringify(value)}`, () => {
      const f = fixture(); replace(f, value); invalid(f.result, f.input, path, 'text');
    });
  }
}

for (const [label, mutate, path, rule] of [
  ['missing observations', f => { f.result.observations = []; }, 'observations', 'array_length'],
  ['extra observations', f => { f.result.observations.push(structuredClone(f.result.observations[0])); }, 'observations', 'array_length'],
  ['nonarray observations', f => { f.result.observations = null; }, 'observations', 'array_length'],
  ['invented criterion id', f => { f.result.observations[0].criterionId = 'not_supplied'; }, 'observations[0].criterionId', 'criterion_identity'],
  ['invalid finding', f => { f.result.observations[0].finding = 'correct'; }, 'observations[0].finding', 'finding'],
  ['invented evidence references', f => { f.result.observations[0].evidenceRefs = [{ sourceId: 'invented' }]; }, 'observations[0].evidenceRefs', 'array_length'],
  ['nonarray evidence references', f => { f.result.observations[0].evidenceRefs = null; }, 'observations[0].evidenceRefs', 'array_length'],
  ['invented answer excerpt', f => { f.result.observations[0].outputExcerpt = 'Never submitted'; }, 'observations[0].outputExcerpt', 'quote_mismatch'],
  ['source text used as learner evidence', f => { f.result.observations[0].outputExcerpt = f.input.evidenceSnapshots[0].text; }, 'observations[0].outputExcerpt', 'quote_mismatch'],
  ['excerpt with ellipsis', f => { f.result.observations[0].outputExcerpt = 'save both changes ... transaction'; }, 'observations[0].outputExcerpt', 'quote_mismatch'],
  ['paraphrased excerpt', f => { f.result.observations[0].outputExcerpt = 'I save the two updates in a transaction'; }, 'observations[0].outputExcerpt', 'quote_mismatch'],
  ['blank assessed excerpt', f => { f.result.observations[0].outputExcerpt = ''; }, 'observations[0].outputExcerpt', 'quote_mismatch'],
  ['nontext excerpt', f => { f.result.observations[0].outputExcerpt = null; }, 'observations[0].outputExcerpt', 'text'],
  ['invented unassessed excerpt', f => { f.result.observations[0].finding = 'not_assessed'; f.result.observations[0].outputExcerpt = 'Not supplied'; }, 'observations[0].outputExcerpt', 'quote_mismatch'],
  ['multiple next actions', f => { f.result.nextActions.push('Another task'); }, 'nextActions', 'array_length'],
  ['nonarray next actions', f => { f.result.nextActions = 'Do this'; }, 'nextActions', 'array_length'],
  ['too many limitations', f => { f.result.limitations = ['1', '2', '3', '4']; }, 'limitations', 'array_length'],
  ['nonarray limitations', f => { f.result.limitations = null; }, 'limitations', 'array_length'],
]) {
  test(`advice rejects ${label} after one model request without a repair call`, async () => {
    const f = fixture(); mutate(f); const upstream = fakeModel(f.result);
    await assert.rejects(generateAdvice(upstream.model, f.input), error => error.code === 'UPSTREAM_ERROR'
      && error.validationIssue.path === path && error.validationIssue.rule === rule);
    assert.equal(upstream.calls.length, 1);
  });
}

test('duplicate criterion ids cannot conceal a missing supplied criterion', () => {
  const f = fixture(); f.input.rubric.push({ ...f.input.rubric[0], id: 'criterion_2' });
  f.input.coverage.rubricTotal = 2; f.input.coverage.rubricReviewed = 2;
  f.result.observations.push(structuredClone(f.result.observations[0]));
  invalid(f.result, f.input, 'observations[1].criterionId', 'criterion_identity');
});

for (const value of [null, [], 'text', 4, {}]) {
  test(`invalid root ${JSON.stringify(value)} gives a safe schema error`, () => {
    invalid(value, fixture().input, 'result', 'object_fields');
  });
}

for (const key of ['summary', 'observations', 'nextActions', 'limitations']) {
  test(`missing required root field ${key} gives a safe schema error`, () => {
    const f = fixture(); delete f.result[key]; invalid(f.result, f.input, 'result', 'object_fields');
  });
}

for (const key of ['criterionId', 'finding', 'comment', 'evidenceRefs', 'outputExcerpt']) {
  test(`missing required observation field ${key} gives a safe schema error`, () => {
    const f = fixture(); delete f.result.observations[0][key]; invalid(f.result, f.input, 'observations[0]', 'object_fields');
  });
}

for (const value of [null, [], 7]) {
  test(`nonobject observation ${JSON.stringify(value)} gives a safe schema error`, () => {
    const f = fixture(); f.result.observations[0] = value; invalid(f.result, f.input, 'observations[0]', 'object_fields');
  });
}

for (const location of ['root', 'observation']) {
  test(`untrusted extra ${location} keys and values never appear in diagnostics`, async () => {
    const f = fixture(); const marker = 'UNTRUSTED_PRIVATE_MARKER';
    const object = location === 'root' ? f.result : f.result.observations[0];
    object['unexpected_' + marker] = 'value_' + marker;
    const upstream = fakeModel(f.result);
    await assert.rejects(generateAdvice(upstream.model, f.input), error => {
      assert.equal(error.validationIssue.rule, 'object_fields');
      assert.ok(!error.message.includes(marker)); assert.ok(!JSON.stringify(error.validationIssue).includes(marker)); return true;
    });
    assert.equal(upstream.calls.length, 1);
  });
}

test('copying the format-only example cannot become valid learner evidence', () => {
  const result = JSON.parse(adviceInstruction().match(/FORMAT-ONLY example: (\{.*\})\n/)[1]);
  invalid(result, fixture().input, 'observations[0].criterionId', 'criterion_identity');
});

test('upstream failure propagates once without repair, fallback or fabricated feedback', async () => {
  const failure = new ApiError(502, 'UPSTREAM_TIMEOUT', 'Synthetic timeout'); failure.uncertain = true;
  const upstream = fakeModel(null, failure);
  await assert.rejects(generateAdvice(upstream.model, fixture().input), error => error === failure && error.uncertain);
  assert.equal(upstream.calls.length, 1);
});

test('malformed JSON from the actual Model parser stops after one transport request', async () => {
  let calls = 0;
  const model = new Model({ raw: () => ({ model: { enabled: true, endpoint: 'http://127.0.0.1:1234/v1', model: 'synthetic' } }) },
    { get: () => '', clean: value => value }, { async json(_url, options) {
      calls++; assert.equal(options.timeoutMs, 30000); return { choices: [{ message: { content: '{' } }] };
    } });
  await assert.rejects(generateAdvice(model, fixture().input), error => error.code === 'UPSTREAM_ERROR');
  assert.equal(calls, 1);
});

for (const mutate of [
  f => { f.input.output = null; }, f => { f.input.output = ''; f.input.coverage.reviewedCharacters = 0; },
  f => { f.input.output = '  '; f.input.coverage.reviewedCharacters = 2; }, f => { f.input.rubric = []; },
  f => { f.input.rubric = Array.from({ length: 6 }, () => f.input.rubric[0]); },
  f => { f.input.coverage.reviewedCharacters++; }, f => { f.input.coverage.answerCharacters = 0; },
  f => { f.input.coverage.rubricReviewed = 2; }, f => { f.input.coverage.sourceCount = -1; },
]) {
  test('invalid bounded-input metadata is rejected before any model request', async () => {
    const f = fixture(); mutate(f); const upstream = fakeModel(f.result);
    await assert.rejects(generateAdvice(upstream.model, f.input), error => error.validationIssue.rule === 'input_contract');
    assert.equal(upstream.calls.length, 0);
  });
}
