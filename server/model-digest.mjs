import { ApiError } from './errors.mjs';

const LIMITS = Object.freeze({ highlights: 3, evidence: 3, rubric: 3, title: 200, summary: 200,
  whyRelevant: 500, sourceId: 128, quote: 1000, prompt: 10000, label: 200, description: 2000,
  expectedEvidence: 10, expectedEvidenceText: 500 });
const KINDS = ['explanation', 'new_scenario', 'artifact'];
const EXAMPLE = { highlights: [{ title: 'Atomic changes', summary: 'Save related changes together.', goalIndex: 0,
  whyRelevant: 'Supports the supplied goal.', evidence: [{ sourceId: 'example_source', quote: 'Example source text.' }] }],
  exercise: { kind: 'new_scenario', prompt: 'Give a new example and explain a checkable remedy.', estimatedMinutes: 5,
    highlightIndex: 0, rubric: [{ label: 'Reasoning', description: 'Explain the example and its check.', expectedEvidence: ['An example'] }] } };

export function digestInstruction() {
  return `Create a small learning focus for the supplied career direction, goals and skills. Select transferable ideas, decisions, explanations or reusable mistakes; skip process logs, repeated implementation chatter and unrelated topics. Merge repetition and avoid repeating previousHighlights. Treat dialogue claims as unverified.
Return one JSON object with exactly the keys shown in this FORMAT-ONLY example: ${JSON.stringify(EXAMPLE)}
All shown fields are required; do not add fields at any level. The example source and content are NOT evidence: copy sourceId and exact contiguous quotes only from the actual input.segments. Never paraphrase, shorten with ellipses, or alter a quote. Use the input's zero-based profile.goals index and highlights index as JSON integers, never strings.
Hard limits (text lengths count Unicode characters): ${JSON.stringify(LIMITS)}. highlights may have 0 to ${LIMITS.highlights} items. Each highlight needs 1 to ${LIMITS.evidence} evidence items. A rubric needs 1 to ${LIMITS.rubric} items. expectedEvidence allows 0 to ${LIMITS.expectedEvidence} nonempty strings. Every other text field must be nonempty. exercise.kind must be one of ${JSON.stringify(KINDS)}. estimatedMinutes must be an integer from 1 through input.budgetMinutes.
Zero relevant highlights is valid: return {"highlights":[],"exercise":null}. If budgetMinutes=0, exercise must be null even when highlights exist. Otherwise, when highlights exist, provide exactly one exercise linked to an existing highlightIndex. Ask the user to explain, apply or produce something independently. Never include an answer or solution field.
Keep the output concise: prefer one short quote per highlight and one or two rubric items. Use the user's language for generated teaching text; quoted evidence must remain verbatim.`;
}

function check(condition, path, rule, reason) {
  if (condition) return;
  const error = new ApiError(502, 'UPSTREAM_ERROR', `模型整理结果不符合结构要求（${path}：${reason}）。`);
  error.validationIssue = { path, rule };
  throw error;
}

function fields(value, names, path) {
  const object = value && typeof value === 'object' && !Array.isArray(value);
  check(object && Object.keys(value).every(key => names.includes(key)) && names.every(key => Object.hasOwn(value, key)),
    path, 'object_fields', '字段缺失、类型错误或包含额外字段');
}

function text(value, max, path) {
  check(typeof value === 'string' && value.trim().length > 0 && [...value].length <= max,
    path, 'text', `须为 1–${max} 字符的文本`);
}

function integer(value, min, max, path) {
  check(Number.isInteger(value) && value >= min && value <= max, path, 'integer_range', `须为 ${min}–${max} 的整数`);
}

function items(value, min, max, path) {
  check(Array.isArray(value) && value.length >= min && value.length <= max,
    path, 'array_length', `须包含 ${min}–${max} 项`);
}

function evidence(value, input, path) {
  fields(value, ['sourceId', 'quote'], path);
  text(value.sourceId, LIMITS.sourceId, path + '.sourceId'); text(value.quote, LIMITS.quote, path + '.quote');
  check(input.segments.some(segment => segment.sourceId === value.sourceId && segment.text.includes(value.quote)),
    path + '.quote', 'quote_mismatch', '引用无法在对应输入原文中核对');
}

function highlight(value, input, path) {
  fields(value, ['title', 'summary', 'goalIndex', 'whyRelevant', 'evidence'], path);
  for (const key of ['title', 'summary', 'whyRelevant']) text(value[key], LIMITS[key], path + '.' + key);
  integer(value.goalIndex, 0, input.profile.goals.length - 1, path + '.goalIndex');
  items(value.evidence, 1, LIMITS.evidence, path + '.evidence');
  value.evidence.forEach((entry, index) => evidence(entry, input, `${path}.evidence[${index}]`));
}

function criterion(value, path) {
  fields(value, ['label', 'description', 'expectedEvidence'], path);
  text(value.label, LIMITS.label, path + '.label'); text(value.description, LIMITS.description, path + '.description');
  items(value.expectedEvidence, 0, LIMITS.expectedEvidence, path + '.expectedEvidence');
  value.expectedEvidence.forEach((entry, index) => text(entry, LIMITS.expectedEvidenceText, `${path}.expectedEvidence[${index}]`));
}

function exercise(value, input, highlightCount) {
  fields(value, ['kind', 'prompt', 'estimatedMinutes', 'highlightIndex', 'rubric'], 'exercise');
  check(KINDS.includes(value.kind), 'exercise.kind', 'text', '练习类型无效');
  text(value.prompt, LIMITS.prompt, 'exercise.prompt');
  integer(value.estimatedMinutes, 1, input.budgetMinutes, 'exercise.estimatedMinutes');
  integer(value.highlightIndex, 0, highlightCount - 1, 'exercise.highlightIndex');
  items(value.rubric, 1, LIMITS.rubric, 'exercise.rubric');
  value.rubric.forEach((entry, index) => criterion(entry, `exercise.rubric[${index}]`));
}

export function validateDigest(result, input) {
  fields(result, ['highlights', 'exercise'], 'result');
  items(result.highlights, 0, LIMITS.highlights, 'highlights');
  result.highlights.forEach((entry, index) => highlight(entry, input, `highlights[${index}]`));
  const required = result.highlights.length > 0 && input.budgetMinutes > 0;
  check(required ? !!result.exercise : result.exercise === null, 'exercise',
    required ? 'exercise_required' : 'exercise_forbidden', required ? '有重点和预算时须包含练习' : '无重点或预算为零时须为 null');
  if (required) exercise(result.exercise, input, result.highlights.length);
  return result;
}
