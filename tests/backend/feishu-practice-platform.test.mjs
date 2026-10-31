import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPracticeCard } from '../../server/feishu-cards.mjs';

const SELECT_STATIC_FIELDS = new Set([
  'tag',
  'element_id',
  'margin',
  'type',
  'name',
  'required',
  'disabled',
  'initial_option',
  'initial_index',
  'placeholder',
  'width',
  'behaviors',
  'options',
  'confirm',
]);

function walk(value, visit) {
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit));
    return;
  }
  if (!value || typeof value !== 'object') return;
  visit(value);
  Object.values(value).forEach((item) => walk(item, visit));
}

function elements(card, tag) {
  const found = [];
  walk(card, (node) => {
    if (node.tag === tag) found.push(node);
  });
  return found;
}

test('practice select uses only documented fields with adjacent label and exact unique provenance options', () => {
  const card = renderPracticeCard({ prompt: '回答', token: 'schema-token' });
  const form = elements(card, 'form')[0];
  const select = elements(form, 'select_static')[0];
  for (const field of Object.keys(select)) {
    assert.ok(SELECT_STATIC_FIELDS.has(field), `unsupported select_static field: ${field}`);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(select, 'label'), false);

  const selectIndex = form.elements.indexOf(select);
  assert.deepEqual(form.elements[selectIndex - 1], {
    tag: 'markdown',
    content: '完成方式（可选）',
  });
  assert.equal(select.name, 'assistance');
  assert.equal(select.initial_option, 'unknown');
  assert.deepEqual(select.options.map((option) => option.value), [
    'unknown', 'none', 'hint', 'partial', 'full',
  ]);
  assert.equal(new Set(select.options.map((option) => option.value)).size, select.options.length);
  assert.deepEqual(select.options.map((option) => option.text), [
    { tag: 'plain_text', content: '未说明' },
    { tag: 'plain_text', content: '独立完成' },
    { tag: 'plain_text', content: '借助提示' },
    { tag: 'plain_text', content: '部分由AI完成' },
    { tag: 'plain_text', content: '主要由AI完成' },
  ]);
});

test('practice form preserves global names, supported input label, and exact special submit shape', () => {
  const card = renderPracticeCard({ prompt: '回答', token: 'form-token' });
  const rootForms = card.body.elements.filter((element) => element.tag === 'form');
  assert.equal(rootForms.length, 1);
  assert.equal(elements(card, 'form').length, 1);
  assert.equal(rootForms[0].name, 'practice_form');

  const names = [];
  walk(card, (node) => {
    if (node.name) names.push(node.name);
  });
  assert.equal(new Set(names).size, names.length);

  const input = elements(rootForms[0], 'input')[0];
  assert.deepEqual(input.label, { tag: 'plain_text', content: '你的回答' });
  assert.equal(input.rows, 4);
  assert.equal(input.max_length, 1000);

  const submits = elements(rootForms[0], 'button')
    .filter((button) => button.form_action_type === 'submit');
  assert.equal(submits.length, 1);
  assert.deepEqual(submits[0], {
    tag: 'button',
    name: 'submit_form-token',
    text: { tag: 'plain_text', content: '提交回答' },
    type: 'primary_filled',
    form_action_type: 'submit',
    width: 'fill',
  });
  assert.equal(submits[0].behaviors, undefined);
  assert.equal(submits[0].value, undefined);
});

test('submitted practice removes editable form and submit controls while retaining status callbacks', () => {
  const card = renderPracticeCard({
    prompt: '回答',
    token: 'submitted-token',
    canSubmit: false,
    answerStatus: '已收到本次文字回答',
  });
  assert.equal(elements(card, 'form').length, 0);
  assert.equal(elements(card, 'input').length, 0);
  assert.equal(elements(card, 'select_static').length, 0);
  assert.equal(elements(card, 'button').some((button) => button.form_action_type), false);
  assert.match(JSON.stringify(card), /已收到本次文字回答/);
  assert.deepEqual(
    elements(card, 'button').map((button) => button.behaviors[0].value.a),
    ['flashcards', 'view_advice'],
  );
});
