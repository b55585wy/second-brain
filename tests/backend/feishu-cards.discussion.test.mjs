import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderPracticeCard,
  renderAdviceCard,
  renderFlashcardCard,
  renderStatusCard,
} from '../../server/feishu-cards.mjs';
import {
  renderPracticeCard as legacyPracticeCard,
  renderAdviceCard as legacyAdviceCard,
  renderFlashcardCard as legacyFlashcardCard,
  renderStatusCard as legacyStatusCard,
} from '../fixtures/feishu-cards.legacy.mjs';

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

function callbackButtons(card) {
  return buttons(card).filter((button) => !button.form_action_type);
}

function callbackActions(card) {
  return callbackButtons(card).map((button) => button.behaviors[0].value.a);
}

function actionMap(card) {
  return Object.fromEntries(callbackButtons(card).map((button) => [button.behaviors[0].value.a, button]));
}

function taggedCount(card) {
  let count = 0;
  walk(card, (node) => {
    if (node.tag) count += 1;
  });
  return count;
}

const baseAdvice = {
  summary: '当前候选摘要',
  strengths: ['当前亮点'],
  improvements: ['当前改进'],
  nextAction: '当前下一步',
  limitations: ['当前限制'],
  token: 'discussion-token',
};

test('absent and undefined discussion are deeply identical to legacy for several base inputs', () => {
  const inputs = [
    {},
    baseAdvice,
    { ...baseAdvice, saved: true, dismissed: true },
    {
      summary: '<at id=all></at>**摘要**',
      strengths: ['一', '二', '三'],
      improvements: ['甲', '乙', '丙'],
      nextAction: '[下一步](https://evil.test)',
      limitations: ['一', '二', '三', '四'],
      token: '🔐'.repeat(20),
    },
  ];
  for (const input of inputs) {
    assert.deepEqual(renderAdviceCard(input), legacyAdviceCard(input));
    assert.deepEqual(
      renderAdviceCard({ ...input, discussion: undefined }),
      legacyAdviceCard(input),
    );
  }
});

test('all other renderers remain deeply identical to the immutable reference', () => {
  const cases = [
    [renderPracticeCard, legacyPracticeCard, { goal: '代数', prompt: '问题', minutes: 10, token: 'p' }],
    [renderPracticeCard, legacyPracticeCard, { prompt: '问题', canSubmit: false, answerStatus: '已提交', token: 'p' }],
    [renderFlashcardCard, legacyFlashcardCard, { question: '问题', answer: '答案', token: 'f' }],
    [renderFlashcardCard, legacyFlashcardCard, { question: '问题', answer: '答案', revealed: true, token: 'f' }],
    [renderStatusCard, legacyStatusCard, {
      title: '状态',
      message: '消息',
      token: 's',
      actions: [
        { a: 'refresh', label: '刷新', primary: true },
        { a: 'retry_discussion', label: '不应扩散到状态卡' },
        { a: 'open_url', label: '链接' },
      ],
    }],
  ];
  for (const [render, legacy, input] of cases) {
    assert.deepEqual(render(input), legacy(input));
  }
});

test('idle and ready expose one exact blank root discussion form and neutral special submit', () => {
  for (const status of ['idle', 'ready']) {
    const card = renderAdviceCard({
      ...baseAdvice,
      discussion: { status, canReply: true, canSave: true },
    });
    const rootForms = card.body.elements.filter((element) => element.tag === 'form');
    assert.equal(rootForms.length, 1);
    assert.equal(elements(card, 'form').length, 1);
    const input = elements(rootForms[0], 'input')[0];
    assert.deepEqual(input, {
      tag: 'input',
      name: 'advice_reply',
      label: { tag: 'plain_text', content: '继续讨论' },
      placeholder: { tag: 'plain_text', content: '哪里不清楚，或希望调整什么？' },
      required: true,
      input_type: 'multiline_text',
      rows: 3,
      max_length: 1000,
      width: 'fill',
    });
    assert.equal(input.default_value, undefined);
    const submit = buttons(rootForms[0]).filter((button) => button.form_action_type === 'submit');
    assert.equal(submit.length, 1);
    assert.equal(submit[0].name, 'discuss_discussion-token');
    assert.equal(submit[0].text.content, '发送补充');
    assert.equal(submit[0].type, 'default');
    assert.equal(submit[0].behaviors, undefined);
    assert.equal(submit[0].value, undefined);
    assert.equal(JSON.stringify(submit[0]).includes('discuss_advice'), false);
    assert.deepEqual(buttons(card).filter((button) => button.type === 'primary_filled').map((button) => button.behaviors[0].value.a), ['save_advice']);
  }
});

test('ready shows latest pair, current candidate version, decisions, and collapsed original excerpt', () => {
  const card = renderAdviceCard({
    ...baseAdvice,
    saved: true,
    discussion: {
      status: 'ready',
      lastUserMessage: '请调整练习难度',
      reply: '已根据补充修订候选建议',
      version: 2,
      canReply: true,
      canSave: true,
      saved: false,
      dismissed: false,
      originalSummary: '原始反馈摘录',
    },
  });
  const serialized = JSON.stringify(card);
  for (const text of [
    '你的补充',
    '请调整练习难度',
    '最新回复',
    '已根据补充修订候选建议',
    '当前建议 · 第2次修改',
    '未保存',
    '已做到',
    '待改进',
    '下一步',
    '原始点评',
    '原始反馈摘录',
    '当前候选摘要',
  ]) {
    assert.ok(serialized.includes(text), text);
  }
  assert.equal(card.body.elements.length, 4);
  const original = elements(card, 'collapsible_panel').find((panel) => panel.header.title.content === '原始点评');
  assert.equal(original.expanded, false);
  assert.equal(original.elements[0].content, '原始反馈摘录');
  assert.equal(actionMap(card).save_advice.disabled, false);
});

test('queued and running retain prior content and suppress submission, retry, save, and dismiss despite conflicts', () => {
  for (const status of ['queued', 'running']) {
    const card = renderAdviceCard({
      ...baseAdvice,
      discussion: {
        status,
        reply: '上一次已有回复',
        version: 1,
        canReply: true,
        canSave: true,
        canRetry: true,
        saved: false,
        dismissed: false,
      },
    });
    const serialized = JSON.stringify(card);
    assert.match(serialized, /正在根据补充更新建议/);
    assert.match(serialized, /上一版 · 第1次修改/);
    assert.match(serialized, /当前候选摘要/);
    assert.match(serialized, /上次回复/);
    assert.doesNotMatch(serialized, /最新回复/);
    assert.equal(elements(card, 'form').length, 0);
    assert.equal(callbackActions(card).includes('retry_discussion'), false);
    assert.equal(actionMap(card).save_advice.disabled, true);
    assert.equal(actionMap(card).dismiss_advice.disabled, true);
  }
});

test('failed and uncertain retain old content with explicit retry and distinct save permissions', () => {
  for (const status of ['failed', 'uncertain']) {
    for (const canSave of [true, false]) {
      const card = renderAdviceCard({
        ...baseAdvice,
        discussion: {
          status,
          message: `${status} 的可见错误说明`,
          reply: '保留下来的回复',
          canReply: true,
          canSave,
          canRetry: true,
        },
      });
      const serialized = JSON.stringify(card);
      assert.match(serialized, /上一版 · 原建议/);
      assert.match(serialized, /上次回复/);
      assert.match(serialized, /可见错误说明/);
      assert.doesNotMatch(serialized, /最新回复/);
      assert.equal(actionMap(card).save_advice.disabled, !canSave);
      assert.equal(actionMap(card).retry_discussion.text.content, '重新请求');
      assert.equal(actionMap(card).retry_discussion.type, 'default');
    }
  }
});

test('limited unavailable and stale show truthful retained states without fabricated replies', () => {
  for (const [status, canRetry] of [['limited', true], ['unavailable', false], ['stale', false]]) {
    const card = renderAdviceCard({
      ...baseAdvice,
      discussion: {
        status,
        message: `状态说明-${status}`,
        reply: '旧回复',
        canSave: true,
        canRetry,
      },
    });
    const serialized = JSON.stringify(card);
    assert.match(serialized, /上一版 · 原建议/);
    assert.ok(serialized.includes(`状态说明-${status}`));
    assert.match(serialized, /上次回复/);
    assert.doesNotMatch(serialized, /最新回复/);
    assert.equal(callbackActions(card).includes('retry_discussion'), canRetry);
    assert.equal(actionMap(card).save_advice.disabled, false);
  }
});

test('missing null unknown and empty discussion fields use neutral bounded fallbacks', () => {
  for (const discussion of [{}, null, '', { status: 'mystery', message: '', version: '' }]) {
    const card = renderAdviceCard({ token: 't', discussion });
    const serialized = JSON.stringify(card);
    assert.match(serialized, /以下为当前可用建议|暂无更多状态说明/);
    assert.equal(card.body.elements[1].columns[0].elements[0].content, '**原建议**');
    assert.match(serialized, /未保存/);
    assert.match(serialized, /暂无建议摘要/);
    assert.match(serialized, /暂无新的讨论内容/);
    assert.doesNotMatch(serialized, /mystery/);
    assert.doesNotMatch(serialized, /原始点评/);
    assert.doesNotMatch(serialized, /已掌握|完全正确|优秀回答/);
    assert.equal(elements(card, 'form').length, 0);
    assert.equal(actionMap(card).save_advice.disabled, true);
    assert.equal(card.body.elements.length, 3);
  }

  const initial = renderAdviceCard({
    ...baseAdvice,
    discussion: { status: 'ready', version: 0 },
  });
  assert.equal(initial.body.elements[1].columns[0].elements[0].content, '**原建议**');
  assert.doesNotMatch(JSON.stringify(initial), /第0版|当前建议 · 原建议/);

  const invalidVersions = [
    '1',
    -1,
    1.5,
    Infinity,
    -Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
    '<script>alert(1)</script>',
  ];
  for (const version of invalidVersions) {
    const card = renderAdviceCard({
      ...baseAdvice,
      discussion: { status: 'ready', version },
    });
    const title = card.body.elements[1].columns[0].elements[0].content;
    assert.equal(title, '**原建议**');
    assert.ok(!title.includes(String(version)));
    assert.doesNotMatch(title, /script|function|native code|\[object Object\]/i);
  }
});

test('saved v1 followed by unsaved v2 uses current discussion state rather than stale top-level saved', () => {
  const v1 = renderAdviceCard({
    ...baseAdvice,
    discussion: { status: 'ready', version: 1, saved: true, canSave: true },
  });
  assert.match(JSON.stringify(v1), /当前建议 · 第1次修改/);
  assert.match(JSON.stringify(v1), /已保存/);
  assert.doesNotMatch(JSON.stringify(v1), /未保存/);
  assert.equal(actionMap(v1).save_advice.disabled, true);

  const v2 = renderAdviceCard({
    ...baseAdvice,
    saved: true,
    discussion: { status: 'ready', version: 2, saved: false, canSave: true },
  });
  assert.match(JSON.stringify(v2), /当前建议 · 第2次修改/);
  assert.match(JSON.stringify(v2), /未保存/);
  assert.doesNotMatch(JSON.stringify(v2), /已保存/);
  assert.equal(actionMap(v2).save_advice.disabled, false);
});

test('current dismissed decision is visible and controls only current dismissal', () => {
  const dismissed = renderAdviceCard({
    ...baseAdvice,
    discussion: { status: 'ready', dismissed: true, canSave: true },
  });
  assert.match(JSON.stringify(dismissed), /已暂不采纳/);
  assert.equal(actionMap(dismissed).dismiss_advice.disabled, true);
  assert.equal(actionMap(dismissed).save_advice.disabled, false);
  assert.equal(actionMap(dismissed).flashcards.disabled, false);

  const current = renderAdviceCard({
    ...baseAdvice,
    dismissed: true,
    discussion: { status: 'ready', dismissed: false, canSave: true },
  });
  assert.doesNotMatch(JSON.stringify(current), /已暂不采纳/);
  assert.equal(actionMap(current).dismiss_advice.disabled, false);
});

test('reply save and retry controls require strict server booleans', () => {
  for (const value of [1, 'true', {}, [], 'false']) {
    const card = renderAdviceCard({
      ...baseAdvice,
      discussion: {
        status: 'ready',
        canReply: value,
        canSave: value,
        canRetry: value,
        saved: value,
        dismissed: value,
      },
    });
    assert.equal(elements(card, 'form').length, 0);
    assert.equal(callbackActions(card).includes('retry_discussion'), false);
    assert.equal(actionMap(card).save_advice.disabled, true);
    assert.equal(actionMap(card).dismiss_advice.disabled, false);
    assert.match(JSON.stringify(card), /未保存/);
  }
});

test('untrusted discussion and candidate text is escaped consistently and nonce stays nonvisible', () => {
  const malicious = '<at id=all></at><script>alert(1)</script>[点击](https://evil.test)**伪造**';
  const token = 'SECRET-NONCE-ONLY-FOR-CALLBACK';
  const card = renderAdviceCard({
    summary: malicious,
    strengths: [malicious],
    improvements: [malicious],
    nextAction: malicious,
    limitations: [malicious],
    token,
    discussion: {
      status: 'ready',
      message: malicious,
      lastUserMessage: malicious,
      reply: malicious,
      version: malicious,
      originalSummary: malicious,
      canReply: true,
      canSave: true,
      canRetry: true,
    },
  });
  const dynamicText = elements(card, 'markdown').map((item) => item.content).join('\n');
  assert.ok(!dynamicText.includes('<at'));
  assert.ok(!dynamicText.includes('<script>'));
  assert.ok(!dynamicText.includes('https://evil.test'));
  assert.ok(!dynamicText.includes('[点击]'));
  assert.ok(dynamicText.includes('&#60;at id=all&#62;'));
  assert.ok(dynamicText.includes('&#91;点击&#93;'));
  const visible = [
    ...elements(card, 'markdown').map((item) => item.content),
    ...elements(card, 'plain_text').map((item) => item.content),
  ].join('\n');
  assert.ok(!visible.includes(token));
  for (const button of callbackButtons(card)) {
    assert.deepEqual(button.behaviors, [{
      type: 'callback',
      value: { v: 1, t: token, a: button.behaviors[0].value.a },
    }]);
    assert.equal(button.url, undefined);
    assert.equal(button.value, undefined);
  }
});

test('worst-case discussion Unicode and escaping stay below byte and element caps', () => {
  const hostile = '<at id=all>[x](https://evil.test)👩‍👩‍👧‍👦'.repeat(3000);
  const longToken = '🔐'.repeat(1000);
  for (const status of ['ready', 'failed']) {
    const card = renderAdviceCard({
      summary: hostile,
      strengths: [hostile, hostile, hostile],
      improvements: [hostile, hostile, hostile],
      nextAction: hostile,
      limitations: [hostile, hostile, hostile, hostile],
      token: longToken,
      discussion: {
        status,
        message: hostile,
        lastUserMessage: hostile,
        reply: hostile,
        version: hostile,
        canReply: true,
        canSave: true,
        canRetry: true,
        originalSummary: hostile,
      },
    });
    const serialized = JSON.stringify(card);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    assert.ok(bytes < 30 * 1024, `${status} card has ${bytes} bytes`);
    assert.ok(taggedCount(card) < 200, `${status} card has ${taggedCount(card)} tags`);
  }
});

test('discussion rendering is deterministic and preserves caller-owned nested inputs', () => {
  const input = {
    ...baseAdvice,
    saved: true,
    dismissed: true,
    discussion: {
      status: 'ready',
      message: '状态',
      lastUserMessage: '补充',
      reply: '回复',
      version: 2,
      canReply: true,
      canSave: true,
      canRetry: true,
      saved: false,
      dismissed: false,
      originalSummary: '原始摘录',
    },
  };
  const snapshot = structuredClone(input);
  const first = renderAdviceCard(input);
  const second = renderAdviceCard(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first.body.elements, second.body.elements);
});

test('pre-reveal and unsupported discussion fields never leak answers or ratings', () => {
  const secret = 'UNIQUE-ANSWER-NOT-FOR-PRE-FLIP';
  const flashcard = renderFlashcardCard({
    question: '先尝试回忆',
    answer: secret,
    revealed: false,
    token: 'flip-token',
  });
  const flashcardJson = JSON.stringify(flashcard);
  assert.ok(!flashcardJson.includes(secret));
  assert.ok(!flashcardJson.includes('参考答案'));
  assert.ok(!flashcardJson.includes('rate_'));
  assert.deepEqual(callbackActions(flashcard), ['reveal_card']);

  const advice = renderAdviceCard({
    ...baseAdvice,
    discussion: {
      status: 'ready',
      answer: secret,
      originalAnswer: secret,
      mastery: '完全正确',
      rating: 'rate_easy',
    },
  });
  const adviceJson = JSON.stringify(advice);
  assert.ok(!adviceJson.includes(secret));
  assert.ok(!adviceJson.includes('完全正确'));
  assert.ok(!adviceJson.includes('rate_easy'));
});

test('unknown status fallbacks use only own keys and never expose JavaScript internals', () => {
  for (const status of ['constructor', '__proto__', 'toString', 'ordinary-unknown']) {
    const card = renderAdviceCard({
      ...baseAdvice,
      discussion: { status },
    });
    const serialized = JSON.stringify(card);
    const statusContent = card.body.elements[0].columns[0].elements[1].content;
    assert.equal(typeof statusContent, 'string');
    assert.match(statusContent, /以下为当前可用建议。/);
    assert.doesNotMatch(statusContent, /function|native code|\[object Object\]|Object\(\)/i);
    assert.ok(!serialized.includes(status), `raw status leaked: ${status}`);
    for (const item of elements(card, 'markdown')) {
      assert.equal(typeof item.content, 'string');
    }
  }

  const ready = renderAdviceCard({
    ...baseAdvice,
    discussion: { status: 'ready' },
  });
  const readyStatus = ready.body.elements[0].columns[0].elements[1].content;
  assert.equal(typeof readyStatus, 'string');
  assert.match(readyStatus, /当前建议已就绪。/);
  assert.doesNotMatch(readyStatus, /以下为当前可用建议。|function|native code/i);
});
