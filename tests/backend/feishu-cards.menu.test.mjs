import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { renderMenuCard, renderStatusCard } from '../../server/feishu-cards.mjs';

const ACTIONS = ['menu_today', 'menu_review', 'menu_advice', 'menu_status'];
const LABELS = ['今日练习', '记忆闪卡', '查看已有建议', '当前状态'];
const DEFAULT_MESSAGE = '选择接下来要做的事。';

function visit(value, callback) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) callback(value);
  for (const child of Object.values(value)) visit(child, callback);
}

function buttons(card) {
  const result = [];
  visit(card, (node) => {
    if (node.tag === 'button') result.push(node);
  });
  return result;
}

function markdownContents(card) {
  const result = [];
  visit(card, (node) => {
    if (node.tag === 'markdown') result.push(node.content);
  });
  return result;
}

function buttonActions(card) {
  return buttons(card).map((button) => button.behaviors[0].value.a);
}

function assertFixedButtons(card) {
  const menuButtons = buttons(card);
  assert.equal(menuButtons.length, 4);
  assert.deepEqual(menuButtons.map((button) => button.text.content), LABELS);
  assert.deepEqual(buttonActions(card), ACTIONS);
  return menuButtons;
}

test('1. no arguments or practice data renders the useful default menu', () => {
  const card = renderMenuCard();
  const emptyCard = renderMenuCard({});

  assertFixedButtons(card);
  assert.deepEqual(emptyCard, card);
  assert.ok(markdownContents(card).some((content) => content.includes(DEFAULT_MESSAGE)));
  assert.equal(JSON.stringify(card).includes('undefined'), false);
  assert.equal(JSON.stringify(card).includes('null'), false);
});

test('2. four fixed entries retain contract order in two responsive rows', () => {
  const card = renderMenuCard({ token: 'nonce' });
  assertFixedButtons(card);

  const rows = card.body.elements.slice(-2);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.tag, 'column_set');
    assert.equal(row.flex_mode, 'flow');
    assert.equal(row.horizontal_spacing, '8px');
    assert.equal(row.columns.length, 2);
    assert.ok(row.columns.every((column) => column.width === 'auto'));
  }
});

test('3. today is the sole primary action', () => {
  const menuButtons = assertFixedButtons(renderMenuCard());
  assert.deepEqual(menuButtons.map((button) => button.type), [
    'primary_filled',
    'default',
    'default',
    'default',
  ]);
  assert.equal(menuButtons.filter((button) => button.type === 'primary_filled').length, 1);
});

test('4. callbacks have the exact shape and never expose the nonce visibly', () => {
  const token = 'nonce_VISIBLE_ONLY_IN_CALLBACK_7f29';
  const card = renderMenuCard({ token, message: '继续学习' });
  const menuButtons = assertFixedButtons(card);

  menuButtons.forEach((button, index) => {
    assert.deepEqual(button.behaviors, [{
      type: 'callback',
      value: { v: 1, t: token, a: ACTIONS[index] },
    }]);
  });
  const visibleJson = JSON.stringify(card, (key, value) => (
    key === 'behaviors' ? undefined : value
  ));
  assert.equal(visibleJson.includes(token), false);
});

test('5. missing empty and invalid tokens preserve four bounded callbacks', () => {
  for (const token of [undefined, null, '', '   ', {}, [], false]) {
    const card = renderMenuCard({ token });
    const menuButtons = assertFixedButtons(card);
    for (const button of menuButtons) {
      assert.equal(button.behaviors[0].value.t, '');
      assert.deepEqual(Object.keys(button.behaviors[0].value), ['v', 't', 'a']);
    }
  }
});

test('6. root schema configuration header and visual groups match the contract', () => {
  const card = renderMenuCard();

  assert.equal(card.schema, '2.0');
  assert.equal(card.config.update_multi, true);
  assert.equal(card.config.enable_forward, false);
  assert.equal(card.config.width_mode, 'default');
  assert.deepEqual(card.header.title, { tag: 'plain_text', content: '学习菜单' });
  assert.equal(card.header.template, 'blue');
  assert.ok(card.body.elements.length >= 2 && card.body.elements.length <= 4);
  assert.equal(card.body.elements[0].columns[0].background_style, 'blue-50');
  assert.equal(card.body.elements[1].columns[0].background_style, 'grey-50');
});

test('7. menu rejects dangerous extra controls and configurable action injection', () => {
  const card = renderMenuCard({
    token: 'nonce',
    message: '选择入口',
    actions: [{ a: 'open_url', label: '外部页面', url: 'https://evil.example' }],
    action: 'delete_everything',
    buttons: [{ text: ' injected ' }],
    form: { answer: 'hidden' },
    answer: 'hidden answer',
    url: 'https://evil.example',
  });
  assertFixedButtons(card);

  const forbiddenTags = new Set([
    'form', 'input', 'select_static', 'multi_select_static', 'select_person',
    'multi_select_person', 'date_picker', 'picker_time', 'picker_datetime',
    'overflow', 'img', 'img_combination', 'standard_icon',
  ]);
  const forbiddenKeys = new Set([
    'url', 'default_url', 'pc_url', 'ios_url', 'android_url', 'card_link',
    'form_action_type', 'answer', 'hidden_answer',
  ]);
  visit(card, (node) => {
    assert.equal(forbiddenTags.has(node.tag), false);
    for (const key of Object.keys(node)) assert.equal(forbiddenKeys.has(key), false);
  });
  const serialized = JSON.stringify(card);
  assert.equal(serialized.includes('open_url'), false);
  assert.equal(serialized.includes('https://'), false);
  assert.equal(serialized.includes('http://'), false);
  assert.equal(serialized.includes('hidden answer'), false);
});

test('8. optional messages use fallback only when absent empty or non-string', () => {
  for (const message of [undefined, null, '', '   ', {}, [], false, 42, 42n]) {
    const contents = markdownContents(renderMenuCard({ message }));
    assert.ok(contents.some((content) => content.includes(DEFAULT_MESSAGE)));
  }

  const contents = markdownContents(renderMenuCard({ message: '  今天想先复习。  ' }));
  assert.ok(contents.some((content) => content.includes('今天想先复习。')));
  assert.equal(contents.some((content) => content.includes(DEFAULT_MESSAGE)), false);
});

test('9. malicious Markdown HTML mentions and links are escaped', () => {
  const payload = "**加粗** <at id=all></at> [打开](https://evil.example) <script>alert('x')</script> # 标题";
  const contents = markdownContents(renderMenuCard({ message: payload }));
  const dynamicContent = contents.find((content) => content.includes('加粗'));

  assert.ok(dynamicContent.includes('&#42;&#42;加粗&#42;&#42;'));
  assert.ok(dynamicContent.includes('&#60;at id=all&#62;'));
  assert.ok(dynamicContent.includes('&#91;打开&#93;&#40;https&#58;//evil.example&#41;'));
  assert.ok(dynamicContent.includes('&#60;script&#62;'));
  assert.equal(dynamicContent.includes('<at'), false);
  assert.equal(dynamicContent.includes('<script>'), false);
  assert.equal(dynamicContent.includes('[打开](https://'), false);
  assert.equal(dynamicContent.includes('**加粗**'), false);
});

test('10. raw source and encoded representations retain independent bounds', () => {
  const cases = [
    {
      name: 'mixed escape-heavy Unicode',
      message: '😀*<>&[]()#:_`!|\\\uD800'.repeat(1000),
    },
    {
      name: 'pure multibyte Unicode reaches the source limit',
      message: '学😀'.repeat(200),
      expectedSourceCharacters: 300,
    },
    {
      name: 'ampersands reach the encoded byte limit',
      message: '&'.repeat(400),
      expectedSourceCharacters: 240,
      expectedEncodedBytes: 1200,
    },
  ];
  const decodeDecimalReferencesOnce = (encoded) => encoded.replace(
    /&#([0-9]+);/g,
    (reference, digits) => {
      const codePoint = Number(digits);
      assert.ok(Number.isSafeInteger(codePoint));
      assert.ok(codePoint >= 0 && codePoint <= 0x10ffff);
      assert.ok(codePoint < 0xd800 || codePoint > 0xdfff);
      return String.fromCodePoint(codePoint);
    },
  );

  for (const testCase of cases) {
    const card = renderMenuCard({ token: 'nonce', message: testCase.message });
    const dynamicContent = card.body.elements[0].columns[0].elements[0].content;

    assert.ok(dynamicContent.startsWith('**'), testCase.name);
    assert.ok(dynamicContent.endsWith('**'), testCase.name);
    const emphasizedBody = dynamicContent.slice(2, -2);
    assert.ok(emphasizedBody.endsWith('…'), testCase.name);
    const encodedBody = emphasizedBody.slice(0, -1);
    assert.equal(encodedBody.endsWith('…'), false, testCase.name);

    assert.ok(Buffer.byteLength(encodedBody, 'utf8') <= 1200, testCase.name);
    assert.ok(Buffer.byteLength(dynamicContent, 'utf8') <= 1200 + 3 + 4, testCase.name);
    const withoutNumericReferences = encodedBody.replace(/&#([0-9]+);/g, '');
    assert.equal(withoutNumericReferences.includes('&'), false, testCase.name);

    const decodedSourceRepresentation = decodeDecimalReferencesOnce(encodedBody);
    const decodedCharacters = Array.from(decodedSourceRepresentation);
    const sourceCharacters = Array.from(testCase.message.trim());
    assert.ok(decodedCharacters.length <= 300, testCase.name);
    assert.ok(decodedCharacters.length < sourceCharacters.length, testCase.name);
    assert.equal(
      decodedSourceRepresentation,
      sourceCharacters.slice(0, decodedCharacters.length).join(''),
      testCase.name,
    );
    if (testCase.expectedSourceCharacters !== undefined) {
      assert.equal(decodedCharacters.length, testCase.expectedSourceCharacters, testCase.name);
    }
    if (testCase.expectedEncodedBytes !== undefined) {
      assert.equal(Buffer.byteLength(encodedBody, 'utf8'), testCase.expectedEncodedBytes, testCase.name);
    }

    let taggedElements = 0;
    visit(card, (node) => {
      if (typeof node.tag === 'string') taggedElements += 1;
    });
    assert.ok(taggedElements < 200, testCase.name);
    assert.ok(Buffer.byteLength(JSON.stringify(card), 'utf8') < 30 * 1024, testCase.name);
  }
});

test('11. long Unicode tokens retain source bounds and tagged elements stay below 200', () => {
  const token = '😀 nonce-*'.repeat(100);
  const card = renderMenuCard({ token });
  const menuButtons = assertFixedButtons(card);
  const safeToken = menuButtons[0].behaviors[0].value.t;

  assert.ok(menuButtons.every((button) => button.behaviors[0].value.t === safeToken));
  const boundedToken = safeToken.endsWith('…') ? safeToken.slice(0, -1) : safeToken;
  assert.ok(Array.from(boundedToken).length <= 256);
  assert.ok(Buffer.byteLength(boundedToken, 'utf8') <= 1024);
  assert.equal(safeToken.endsWith('…'), true);

  let taggedElements = 0;
  visit(card, (node) => {
    if (typeof node.tag === 'string') taggedElements += 1;
  });
  assert.ok(taggedElements < 200);
  assert.ok(Buffer.byteLength(JSON.stringify(card), 'utf8') < 30 * 1024);
});

test('12. rendering is deterministic for identical input', () => {
  const input = { token: 'stable-token', message: '  保持当前节奏。  ' };
  const first = renderMenuCard(input);
  const second = renderMenuCard(input);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('13. rendering leaves caller input and extra fields immutable', () => {
  const input = {
    token: 'immutable-token',
    message: '  不变的消息  ',
    actions: [{ a: 'open_url', label: '不应采用' }],
    nested: { untouched: ['值'] },
  };
  const snapshot = structuredClone(input);

  renderMenuCard(input);
  assert.deepEqual(input, snapshot);
});

test('14. status renderer accepts exactly the four new menu actions', () => {
  const card = renderStatusCard({
    token: 'status-token',
    message: '当前学习状态',
    actions: ACTIONS.map((a, index) => ({ a, label: LABELS[index] })),
  });

  assert.equal(buttons(card).length, 4);
  assert.deepEqual(buttonActions(card), ACTIONS);
  assert.deepEqual(buttons(card).map((button) => button.text.content), LABELS);
});

test('15. status renderer still filters unsafe and unknown actions', () => {
  const card = renderStatusCard({
    token: 'status-token',
    actions: [
      { a: 'menu_today', label: '今日练习' },
      { a: 'open_url', label: '打开外部页面' },
      null,
      { a: 'menu_review', label: '记忆闪卡' },
      { a: 'delete_everything', label: '删除全部' },
      { a: 'menu_advice', label: '查看已有建议' },
      { a: 'javascript:alert(1)', label: '注入' },
      { a: 'menu_status', label: '当前状态' },
    ],
  });

  assert.deepEqual(buttonActions(card), ACTIONS);
  const unsafeOnly = renderStatusCard({
    actions: [{ a: 'open_url' }, { a: 'delete_everything' }, { a: '__proto__' }],
  });
  assert.equal(buttons(unsafeOnly).length, 0);
});
