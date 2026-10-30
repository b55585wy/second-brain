const ALLOWED_ACTIONS = new Set([
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
]);

const ESCAPES = {
  '&': '&#38;',
  '<': '&#60;',
  '>': '&#62;',
  '*': '&#42;',
  '~': '&#126;',
  '[': '&#91;',
  ']': '&#93;',
  '(': '&#40;',
  ')': '&#41;',
  '#': '&#35;',
  ':': '&#58;',
  _: '&#95;',
  '`': '&#96;',
  '!': '&#33;',
  '|': '&#124;',
  '\\': '&#92;',
};

function utf8Length(value) {
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return length;
}

function sourceText(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
    ? String(value).trim()
    : '';
}

function limitedText(value, fallback, maxCharacters, maxBytes, escape = false) {
  const source = sourceText(value);
  if (!source) return fallback;

  let result = '';
  let bytes = 0;
  let characters = 0;
  let truncated = false;

  for (const character of source) {
    if (characters >= maxCharacters) {
      truncated = true;
      break;
    }
    const rendered = escape ? ESCAPES[character] ?? character : character;
    const renderedBytes = utf8Length(rendered);
    if (bytes + renderedBytes > maxBytes) {
      truncated = true;
      break;
    }
    result += rendered;
    bytes += renderedBytes;
    characters += 1;
  }

  return result + (truncated ? '…' : '');
}

function markdown(value, fallback, maxCharacters = 600, maxBytes = 2400) {
  return limitedText(value, fallback, maxCharacters, maxBytes, true);
}

function plain(value, fallback, maxCharacters = 200, maxBytes = 600) {
  return limitedText(value, fallback, maxCharacters, maxBytes);
}

function tokenText(token) {
  return limitedText(token, '', 256, 1024);
}

function textElement(content, options = {}) {
  return {
    tag: 'markdown',
    content: options.secondary ? `<font color='grey'>${content}</font>` : content,
    ...(options.secondary ? { text_size: 'notation' } : {}),
  };
}

function block(elements, background = 'grey-50') {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        background_style: background,
        padding: '12px',
        vertical_spacing: '4px',
        elements,
      },
    ],
  };
}

function callbackButton(token, action, label, { primary = false, disabled = false } = {}) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: primary ? 'primary_filled' : 'default',
    disabled: Boolean(disabled),
    behaviors: [{ type: 'callback', value: { v: 1, t: token, a: action } }],
  };
}

function actionRow(buttons) {
  if (buttons.length === 1) {
    return { ...buttons[0], width: 'fill' };
  }
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: buttons.map((button) => ({
      tag: 'column',
      width: 'auto',
      elements: [button],
    })),
  };
}

function baseCard(title, subtitle, elements) {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      enable_forward: false,
      width_mode: 'default',
      style: {
        color: {
          'cus-muted': {
            light_mode: 'rgba(100,106,115,1)',
            dark_mode: 'rgba(150,155,163,1)',
          },
        },
      },
    },
    header: {
      title: { tag: 'plain_text', content: title },
      ...(subtitle ? { subtitle: { tag: 'plain_text', content: subtitle } } : {}),
      template: 'blue',
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      padding: '12px 12px 20px 12px',
      elements,
    },
  };
}

export function renderPracticeCard({
  goal,
  prompt,
  minutes,
  token,
  answerStatus,
  canSubmit = true,
} = {}) {
  const safeToken = tokenText(token);
  const safeGoal = plain(goal, '今日练习', 200, 600);
  const time = sourceText(minutes)
    ? `预计 ${plain(minutes, '适量', 30, 90)} 分钟`
    : '按自己的节奏完成';
  const elements = [
    block([
      textElement(`**${markdown(prompt, '请根据本次学习重点完成练习。', 4000, 20000)}**`),
    ], 'blue-50'),
  ];

  if (canSubmit) {
    elements.push({
      tag: 'form',
      name: 'practice_form',
      direction: 'vertical',
      vertical_spacing: '8px',
      elements: [
        {
          tag: 'input',
          name: 'answer_text',
          label: { tag: 'plain_text', content: '你的回答' },
          placeholder: { tag: 'plain_text', content: '在这里输入回答（最多1000字）' },
          required: true,
          input_type: 'multiline_text',
          rows: 4,
          max_length: 1000,
          width: 'fill',
        },
        {
          tag: 'select_static',
          name: 'assistance',
          label: { tag: 'plain_text', content: '完成方式（可选）' },
          initial_option: 'unknown',
          options: [
            ['unknown', '未说明'],
            ['none', '独立完成'],
            ['hint', '借助提示'],
            ['partial', '部分由AI完成'],
            ['full', '主要由AI完成'],
          ].map(([value, label]) => ({
            text: { tag: 'plain_text', content: label },
            value,
          })),
        },
        textElement('较长回答也可作为普通聊天文字发送。', { secondary: true }),
        {
          tag: 'button',
          name: `submit_${safeToken}`,
          text: { tag: 'plain_text', content: '提交回答' },
          type: 'primary_filled',
          form_action_type: 'submit',
          width: 'fill',
        },
      ],
    });
  } else {
    elements.push(block([
      textElement('**回答状态**'),
      textElement(markdown(answerStatus, '当前不可编辑回答。', 300, 1200)),
    ]));
  }

  elements.push(actionRow([
    callbackButton(safeToken, 'flashcards', '记忆闪卡'),
    callbackButton(safeToken, 'view_advice', '查看建议'),
  ]));

  return baseCard('今日学习', `${safeGoal} · ${time}`, elements);
}

export function renderAdviceCard({
  summary,
  strengths = [],
  improvements = [],
  nextAction,
  limitations = [],
  token,
  saved = false,
  dismissed = false,
} = {}) {
  const safeToken = tokenText(token);
  const adviceItems = (items, fallback) => {
    const selected = Array.isArray(items) ? items.filter((item) => sourceText(item)).slice(0, 2) : [];
    return selected.length
      ? selected.map((item) => `• ${markdown(item, '', 600, 1800)}`).join('\n')
      : fallback;
  };
  const detailItems = Array.isArray(limitations)
    ? limitations.filter((item) => sourceText(item)).slice(0, 3)
    : [];
  const summaryElements = [
    textElement(`**${markdown(summary, '暂无建议摘要，请查看下方分组内容。', 600, 2400)}**`),
  ];

  if (saved || dismissed) {
    const decisions = [saved ? '已保存建议' : '', dismissed ? '已暂不采纳建议' : ''].filter(Boolean);
    summaryElements.push(textElement(decisions.join('；'), { secondary: true }));
  }
  if (detailItems.length) {
    summaryElements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: '限制与说明' } },
      background_color: 'grey-50',
      padding: '8px',
      elements: [
        textElement(detailItems.map((item) => `• ${markdown(item, '', 600, 1200)}`).join('\n')),
      ],
    });
  }

  const elements = [
    block(summaryElements, 'blue-50'),
    block([
      textElement('**已做到**'),
      textElement(adviceItems(strengths, '暂无可列出的具体亮点，可结合回答继续复盘。')),
    ]),
    block([
      textElement('**待改进**'),
      textElement(adviceItems(improvements, '暂无单独列出的改进项。')),
    ]),
    block([
      textElement('**下一步**'),
      textElement(markdown(nextAction, '暂无下一步建议，可先保留本次记录。', 600, 1800)),
    ]),
    actionRow([
      callbackButton(safeToken, 'save_advice', '保存建议', { primary: true, disabled: saved }),
      callbackButton(safeToken, 'dismiss_advice', '暂不采纳', { disabled: dismissed }),
      callbackButton(safeToken, 'flashcards', '记忆闪卡'),
    ]),
  ];

  return baseCard('回答建议', '基于本次回答的学习反馈', elements);
}

export function renderFlashcardCard({
  question,
  answer,
  revealed = false,
  token,
  status,
  remaining,
} = {}) {
  const safeToken = tokenText(token);
  const subtitle = sourceText(remaining) ? `剩余 ${plain(remaining, '', 40, 120)} 张` : '先回忆，再查看答案';
  const questionElements = [
    textElement(`**${markdown(question, '暂无问题内容。', 2000, 6000)}**`),
  ];
  if (sourceText(status)) {
    questionElements.push(textElement(markdown(status, '', 300, 1200), { secondary: true }));
  }
  const elements = [block(questionElements, 'blue-50')];

  if (!revealed) {
    elements.push(actionRow([
      callbackButton(safeToken, 'reveal_card', '我已尝试，翻面', { primary: true }),
    ]));
    return baseCard('记忆闪卡', subtitle, elements);
  }

  elements.push(block([
    textElement('**参考答案**'),
    textElement(markdown(answer, '暂无参考答案。', 6000, 14000)),
  ]));
  elements.push(actionRow([
    callbackButton(safeToken, 'rate_again', '没记住'),
    callbackButton(safeToken, 'rate_hard', '模糊'),
  ]));
  elements.push(actionRow([
    callbackButton(safeToken, 'rate_good', '记住了', { primary: true }),
    callbackButton(safeToken, 'rate_easy', '很轻松'),
  ]));

  return baseCard('记忆闪卡', subtitle, elements);
}

export function renderStatusCard({ title, message, token, actions = [] } = {}) {
  const safeToken = tokenText(token);
  const supplied = Array.isArray(actions)
    ? actions.filter((action) => action && ALLOWED_ACTIONS.has(action.a)).slice(0, 8)
    : [];
  const requestedPrimary = supplied.findIndex((action) => action.primary);
  const primaryIndex = requestedPrimary >= 0 ? requestedPrimary : supplied.length ? 0 : -1;
  const buttons = supplied.map((action, index) => callbackButton(
    safeToken,
    action.a,
    plain(action.label, '继续', 100, 300),
    { primary: index === primaryIndex, disabled: action.disabled },
  ));
  const elements = [
    block([
      textElement(`**${markdown(message, '暂无更多状态说明。', 4000, 16000)}**`),
    ], 'blue-50'),
  ];

  if (buttons.length) {
    for (let index = 0; index < buttons.length; index += 4) {
      elements.push(actionRow(buttons.slice(index, index + 4)));
    }
  } else {
    elements.push(block([
      textElement('可等待后续消息，或返回聊天继续学习。', { secondary: true }),
    ]));
  }

  return baseCard(plain(title, '学习状态', 100, 300), '学习卡片状态', elements);
}
