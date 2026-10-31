import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderPracticeCard,
  renderAdviceCard,
  renderFlashcardCard,
  renderStatusCard,
} from '../../server/feishu-cards.mjs';

const ALLOWED_ACTIONS = [
  'submit_answer',
  'view_advice',
  'retry_advice',
  'save_advice',
  'dismiss_advice',
  'flashcards',
  'create_flashcard',
  'reveal_card',
  'rate_again',
  'rate_hard',
  'rate_good',
  'rate_easy',
  'refresh',
];

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

function buttons(card) {
  return elements(card, 'button');
}

function callbackActions(card) {
  return buttons(card)
    .filter((button) => !button.form_action_type)
    .map((button) => button.behaviors[0].value.a);
}

function sampleCards() {
  return [
    renderPracticeCard({ goal: '代数', prompt: '解方程', minutes: 10, token: 'practice-token' }),
    renderAdviceCard({ summary: '摘要', strengths: ['步骤完整'], token: 'advice-token' }),
    renderFlashcardCard({ question: '问题', answer: '答案', token: 'flash-token' }),
    renderStatusCard({ title: '状态', message: '消息', token: 'status-token' }),
  ];
}

test('exports four pure renderers returning serializable Card 2.0 objects with exact root config and headers', () => {
  const cards = sampleCards();
  assert.deepEqual(cards.map((card) => card.header.title.content), [
    '今日学习',
    '回答建议',
    '记忆闪卡',
    '状态',
  ]);
  for (const card of cards) {
    assert.equal(card.schema, '2.0');
    assert.equal(card.config.update_multi, true);
    assert.equal(card.config.enable_forward, false);
    assert.equal(card.config.width_mode, 'default');
    assert.equal(card.header.template, 'blue');
    assert.equal(card.header.icon, undefined);
    assert.equal(card.card_link, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(card)), card);
    assert.ok(card.body.elements.length >= 2 && card.body.elements.length <= 5);
  }
});

test('practice card presents the prompt as its focal block and exact secondary learning callbacks', () => {
  const card = renderPracticeCard({
    goal: '学习目标',
    prompt: '重点问题',
    minutes: 15,
    token: 'nonce-p',
  });
  assert.match(card.header.subtitle.content, /学习目标/);
  assert.match(card.header.subtitle.content, /15 分钟/);
  assert.match(card.body.elements[0].columns[0].elements[0].content, /\*\*重点问题\*\*/);
  assert.deepEqual(callbackActions(card), ['flashcards', 'view_advice']);
  for (const button of buttons(card).filter((item) => !item.form_action_type)) {
    assert.equal(button.type, 'default');
    assert.deepEqual(button.behaviors, [
      { type: 'callback', value: { v: 1, t: 'nonce-p', a: button.behaviors[0].value.a } },
    ]);
  }
});

test('practice card has one root form with unique names, required capped input, assistance default, and special submit', () => {
  const card = renderPracticeCard({ prompt: '回答', token: 'form-token' });
  const rootForms = card.body.elements.filter((element) => element.tag === 'form');
  assert.equal(rootForms.length, 1);
  assert.equal(elements(card, 'form').length, 1);
  const form = rootForms[0];
  const names = [];
  walk(form, (node) => {
    if (node.name) names.push(node.name);
  });
  assert.equal(new Set(names).size, names.length);

  const input = elements(form, 'input')[0];
  assert.equal(input.name, 'answer_text');
  assert.deepEqual(input.label, { tag: 'plain_text', content: '你的回答' });
  assert.equal(input.input_type, 'multiline_text');
  assert.equal(input.rows, 4);
  assert.equal(input.max_length, 1000);
  assert.equal(input.required, true);

  const select = elements(form, 'select_static')[0];
  assert.equal(Object.prototype.hasOwnProperty.call(select, 'label'), false);
  assert.deepEqual(form.elements[form.elements.indexOf(select) - 1], {
    tag: 'markdown',
    content: '完成方式（可选）',
  });
  assert.equal(select.name, 'assistance');
  assert.equal(select.initial_option, 'unknown');
  assert.deepEqual(select.options.map((option) => option.value), ['unknown', 'none', 'hint', 'partial', 'full']);
  assert.deepEqual(select.options.map((option) => option.text.content), [
    '未说明', '独立完成', '借助提示', '部分由AI完成', '主要由AI完成',
  ]);

  const submit = buttons(form).filter((button) => button.form_action_type === 'submit');
  assert.equal(submit.length, 1);
  assert.equal(submit[0].name, 'submit_form-token');
  assert.equal(submit[0].behaviors, undefined);
  assert.equal(submit[0].value, undefined);
  assert.match(JSON.stringify(form), /普通聊天文字/);
});

test('submitted practice transition removes every editable form control and shows actual answer status', () => {
  const card = renderPracticeCard({
    prompt: '回答',
    token: 'submitted-token',
    canSubmit: false,
    answerStatus: '已收到本次文字回答',
  });
  assert.equal(elements(card, 'form').length, 0);
  assert.equal(elements(card, 'input').length, 0);
  assert.equal(elements(card, 'select_static').length, 0);
  assert.match(JSON.stringify(card), /已收到本次文字回答/);
  assert.deepEqual(callbackActions(card), ['flashcards', 'view_advice']);
});

test('advice card has summary plus three groups, bounded entries, collapsed details, and neutral empty fallbacks', () => {
  const card = renderAdviceCard({
    summary: '',
    strengths: [],
    improvements: [],
    nextAction: '',
    limitations: ['一', '二', '三', '四'],
    token: 'advice-token',
  });
  const serialized = JSON.stringify(card);
  for (const heading of ['已做到', '待改进', '下一步']) {
    assert.ok(serialized.includes(heading));
  }
  assert.match(serialized, /暂无可列出的具体亮点/);
  assert.match(serialized, /暂无单独列出的改进项/);
  assert.match(serialized, /暂无下一步建议/);
  const panels = elements(card, 'collapsible_panel');
  assert.equal(panels.length, 1);
  assert.equal(panels[0].expanded, false);
  assert.equal((panels[0].elements[0].content.match(/•/g) ?? []).length, 3);
  assert.ok(!panels[0].elements[0].content.includes('四'));

  const bounded = renderAdviceCard({
    strengths: ['一', '二', '三'],
    improvements: ['甲', '乙', '丙'],
    token: 't',
  });
  const texts = elements(bounded, 'markdown').map((item) => item.content);
  assert.ok(!texts.some((content) => content.includes('三') || content.includes('丙')));
});

test('advice save and dismiss decisions remain visible and disable only their corresponding repeat actions', () => {
  const saved = renderAdviceCard({ summary: '摘要', token: 't', saved: true });
  const savedButtons = Object.fromEntries(buttons(saved).map((button) => [button.behaviors[0].value.a, button]));
  assert.equal(savedButtons.save_advice.disabled, true);
  assert.equal(savedButtons.save_advice.type, 'primary_filled');
  assert.equal(savedButtons.dismiss_advice.disabled, false);
  assert.match(JSON.stringify(saved), /已保存建议/);

  const both = renderAdviceCard({ summary: '摘要', token: 't', saved: true, dismissed: true });
  const bothButtons = Object.fromEntries(buttons(both).map((button) => [button.behaviors[0].value.a, button]));
  assert.equal(bothButtons.dismiss_advice.disabled, true);
  assert.match(JSON.stringify(both), /已保存建议；已暂不采纳建议/);
});

test('flashcard pre-reveal state completely omits answer data and all rating controls', () => {
  const secret = 'UNIQUE-ANSWER-NOT-FOR-PRE-FLIP';
  const card = renderFlashcardCard({
    question: '先尝试回忆',
    answer: secret,
    revealed: false,
    token: 'flip-token',
    status: '等待你的回忆',
    remaining: 4,
  });
  const serialized = JSON.stringify(card);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes('参考答案'));
  assert.ok(!serialized.includes('rate_'));
  assert.deepEqual(callbackActions(card), ['reveal_card']);
  assert.equal(buttons(card)[0].text.content, '我已尝试，翻面');
  assert.equal(buttons(card)[0].type, 'primary_filled');
});

test('flashcard post-reveal state shows the answer and exactly four self-ratings with good as sole primary', () => {
  const card = renderFlashcardCard({ question: '问题', answer: '实际答案', revealed: true, token: 'rated-token' });
  assert.match(JSON.stringify(card), /实际答案/);
  assert.deepEqual(callbackActions(card), ['rate_again', 'rate_hard', 'rate_good', 'rate_easy']);
  assert.deepEqual(buttons(card).map((button) => button.text.content), ['没记住', '模糊', '记住了', '很轻松']);
  assert.deepEqual(buttons(card).filter((button) => button.type === 'primary_filled').map((button) => button.behaviors[0].value.a), ['rate_good']);
  assert.equal(callbackActions(card).includes('reveal_card'), false);
});

test('status card filters arbitrary actions and URLs, bounds action count, and preserves primary and disabled display', () => {
  const actions = [
    { a: 'create_flashcard', label: '用本次重点制作闪卡' },
    { a: 'open_url', label: '恶意动作', primary: true },
    { a: 'refresh', label: '刷新状态', primary: true, disabled: true },
    { a: 'https://evil.test', label: '链接' },
    ...Array.from({ length: 10 }, (_, index) => ({ a: 'refresh', label: `刷新${index}` })),
  ];
  const card = renderStatusCard({ title: '状态', message: '暂无到期卡片', token: 's', actions });
  assert.deepEqual(callbackActions(card), ['create_flashcard', 'refresh', 'refresh', 'refresh', 'refresh', 'refresh', 'refresh', 'refresh']);
  assert.equal(buttons(card).filter((button) => button.type === 'primary_filled').length, 1);
  assert.equal(buttons(card)[1].disabled, true);
  assert.ok(!JSON.stringify(card).includes('open_url'));
  assert.ok(!JSON.stringify(card).includes('evil.test'));
  assert.equal(card.body.elements.length, 3);
});

test('every allowlisted action uses only the exact versioned callback payload', () => {
  for (const actions of [ALLOWED_ACTIONS.slice(0, 6), ALLOWED_ACTIONS.slice(6)]) {
    const card = renderStatusCard({
      title: '动作',
      message: '检查',
      token: 'exact-token',
      actions: actions.map((a) => ({ a, label: a })),
    });
    assert.deepEqual(callbackActions(card), actions);
    for (const button of buttons(card)) {
      assert.equal(button.behaviors.length, 1);
      assert.equal(button.behaviors[0].type, 'callback');
      assert.deepEqual(Object.keys(button.behaviors[0].value).sort(), ['a', 't', 'v']);
      assert.deepEqual(button.behaviors[0].value, {
        v: 1,
        t: 'exact-token',
        a: button.behaviors[0].value.a,
      });
      assert.equal(button.url, undefined);
      assert.equal(button.value, undefined);
    }
  }
});

test('malicious Markdown, mentions, HTML, and links are escaped rather than interpreted in dynamic rich text', () => {
  const malicious = '<at id=all></at><script>alert(1)</script>[点击](https://evil.test)**伪造**';
  const cards = [
    renderPracticeCard({ prompt: malicious, token: 't' }),
    renderAdviceCard({ summary: malicious, strengths: [malicious], improvements: [malicious], nextAction: malicious, limitations: [malicious], token: 't' }),
    renderFlashcardCard({ question: malicious, answer: malicious, revealed: true, token: 't' }),
    renderStatusCard({ message: malicious, token: 't' }),
  ];
  for (const card of cards) {
    const dynamicText = elements(card, 'markdown').map((item) => item.content).join('\n');
    assert.ok(!dynamicText.includes('<at'));
    assert.ok(!dynamicText.includes('<script>'));
    assert.ok(!dynamicText.includes('https://evil.test'));
    assert.ok(!dynamicText.includes('[点击]'));
    assert.ok(dynamicText.includes('&#60;at id=all&#62;'));
    assert.ok(dynamicText.includes('&#91;点击&#93;'));
  }
});

test('plain-text titles and labels cannot create actions or links, and nonce never appears in visible content', () => {
  const token = 'SECRET-NONCE-ONLY-FOR-CALLBACK';
  const card = renderStatusCard({
    title: '<at id=all></at>[标题](https://evil.test)',
    message: '状态',
    token,
    actions: [{ a: 'refresh', label: '<script>alert(1)</script>' }],
  });
  assert.equal(card.header.title.tag, 'plain_text');
  assert.equal(buttons(card)[0].text.tag, 'plain_text');
  assert.deepEqual(callbackActions(card), ['refresh']);
  const visible = [
    ...elements(card, 'markdown').map((item) => item.content),
    ...elements(card, 'plain_text').map((item) => item.content),
  ].join('\n');
  assert.ok(!visible.includes(token));
});

test('empty optional fields produce useful neutral content without praise or mastery claims', () => {
  const practice = renderPracticeCard({ token: 't' });
  const advice = renderAdviceCard({ token: 't' });
  const flashcard = renderFlashcardCard({ revealed: true, token: 't' });
  const status = renderStatusCard({ token: 't' });
  assert.match(JSON.stringify(practice), /请根据本次学习重点完成练习/);
  assert.match(JSON.stringify(advice), /暂无建议摘要/);
  assert.match(JSON.stringify(advice), /暂无可列出的具体亮点/);
  assert.match(JSON.stringify(flashcard), /暂无问题内容/);
  assert.match(JSON.stringify(flashcard), /暂无参考答案/);
  assert.match(JSON.stringify(status), /暂无更多状态说明/);
  assert.doesNotMatch(JSON.stringify([practice, advice, flashcard, status]), /已掌握|完全正确|优秀回答/);
});

test('worst-case Unicode and escaping stay below 30KB and 200 tagged elements with bounded text and entries', () => {
  const hostile = '<at id=all>[x](https://evil.test)👩‍👩‍👧‍👦'.repeat(3000);
  const longToken = '🔐'.repeat(1000);
  const cards = [
    renderPracticeCard({ goal: hostile, prompt: hostile, minutes: hostile, token: longToken }),
    renderPracticeCard({ goal: hostile, prompt: hostile, answerStatus: hostile, token: longToken, canSubmit: false }),
    renderAdviceCard({
      summary: hostile,
      strengths: [hostile, hostile, hostile],
      improvements: [hostile, hostile, hostile],
      nextAction: hostile,
      limitations: [hostile, hostile, hostile, hostile],
      token: longToken,
      saved: true,
      dismissed: true,
    }),
    renderFlashcardCard({ question: hostile, answer: hostile, revealed: true, status: hostile, remaining: hostile, token: longToken }),
    renderStatusCard({
      title: hostile,
      message: hostile,
      token: longToken,
      actions: Array.from({ length: 30 }, () => ({ a: 'refresh', label: hostile })),
    }),
  ];
  for (const card of cards) {
    const serialized = JSON.stringify(card);
    assert.ok(Buffer.byteLength(serialized, 'utf8') < 30 * 1024, `card has ${Buffer.byteLength(serialized, 'utf8')} bytes`);
    let count = 0;
    walk(card, (node) => {
      if (node.tag) count += 1;
    });
    assert.ok(count < 200, `card has ${count} tagged elements`);
  }
});

test('renderers are deterministic and do not mutate caller-owned inputs', () => {
  const input = {
    summary: '摘要',
    strengths: ['一', '二'],
    improvements: ['甲'],
    nextAction: '下一步',
    limitations: ['限制'],
    token: 'pure-token',
    saved: false,
    dismissed: false,
  };
  const snapshot = structuredClone(input);
  const first = renderAdviceCard(input);
  const second = renderAdviceCard(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first.body.elements, second.body.elements);
});
