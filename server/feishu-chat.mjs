import { randomBytes } from 'node:crypto';
import { boolean, dateInZone, digest, onlyFields, text } from './validation.mjs';
import { fail, publicError, requireValue } from './errors.mjs';
import { adviceMessage } from './advice-message.mjs';

const DEFAULTS = { enabled: false, remindersEnabled: true, reminderLocalTime: '09:00', cardsEnabled: false };
const MINUTE = 60000;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const pairText = value => value.replace(/-/g, '').toUpperCase();
const uuid = value => { const hash = digest(value); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`; };
const at = value => value ? +new Date(value) : 0;
const discussionVersionLabel = version => version === 0 ? '原建议' : `第${version}次修改`;

export class FeishuChat {
  constructor(store, settings, secrets, domain, automation, learning, { clock = () => new Date() } = {}) {
    Object.assign(this, { store, settings, secrets, domain, automation, learning, clock });
    if (!store.get('config', 'feishu-chat')) store.put('config', DEFAULTS, 'feishu-chat');
    this.draining = false;
    for (const item of store.all('feishu-chat-outbox').filter(item => item.status === 'sending')) {
      store.put('feishu-chat-outbox', { ...item, status: 'uncertain' }, item.id);
      this.error('DELIVERY_UNCERTAIN', '上次飞书发送结果未确认，未自动重复发送。', false);
    }
  }

  config() { return { cardsEnabled: false, ...this.store.get('config', 'feishu-chat') }; }
  state() { return this.store.get('feishu-chat-state', 'main') ?? {}; }
  saveState(fields) { return this.store.put('feishu-chat-state', { ...this.state(), ...fields }, 'main'); }
  identity() { const config = this.settings.raw().feishu; return digest([config.apiBase, config.appId, this.secrets.get('feishu.appSecret')]); }
  configured() { const config = this.settings.raw().feishu; return !!(config.enabled && config.appId && this.secrets.get('feishu.appSecret')); }
  binding() { const value = this.store.get('feishu-chat-binding', 'main'); return value?.appIdentity === this.identity() ? value : null; }
  discussionChannel(cardsRequired = false) {
    const binding = this.binding();
    return { appIdentity: this.identity(), bindingEpoch: binding?.epoch, userId: binding?.userId, chatId: binding?.chatId, cardsRequired };
  }
  discussionChannelCurrent(channel) {
    const binding = this.binding();
    return !!(this.config().enabled && this.configured() && binding && channel.appIdentity === this.identity()
      && channel.bindingEpoch === binding.epoch && channel.userId === binding.userId && channel.chatId === binding.chatId
      && (!channel.cardsRequired || this.config().cardsEnabled));
  }
  error(code, message, retryable) { this.saveState({ lastError: { code, message, retryable } }); }

  public() {
    const config = this.config(); const state = this.state(); const configured = this.configured(); const binding = this.binding(); const bound = !!binding;
    const cardActionCurrent = binding && state.lastCardAppIdentity === this.identity() && state.lastCardBindingEpoch === binding.epoch;
    return { enabled: config.enabled, revision: config.revision, remindersEnabled: config.remindersEnabled,
      reminderLocalTime: config.reminderLocalTime, configured, bound,
      state: !config.enabled ? 'off' : !configured ? 'setup' : !bound ? 'unbound' : state.lastError ? 'error' : 'ready',
      lastReceivedAt: state.lastReceivedAt ?? null, lastSentAt: state.lastSentAt ?? null,
      lastError: state.lastError ?? null, snoozedUntil: state.snoozedUntil ?? null,
      cardsEnabled: config.cardsEnabled, lastCardActionAt: cardActionCurrent ? state.lastCardActionAt ?? null : null,
      pendingMessages: this.store.all('feishu-chat-outbox').filter(item => ['pending', 'sending'].includes(item.status)).length };
  }

  update(body) {
    onlyFields(body, Object.keys(DEFAULTS));
    const next = { ...this.config(), ...body };
    boolean(next.enabled, 'enabled'); boolean(next.remindersEnabled, 'remindersEnabled'); boolean(next.cardsEnabled, 'cardsEnabled');
    requireValue(typeof next.reminderLocalTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(next.reminderLocalTime), '提醒时间必须为 HH:mm。');
    this.store.put('config', next, 'feishu-chat');
    if (!next.enabled || !next.remindersEnabled) this.cancelPending(!next.enabled ? 'disabled' : 'paused', !next.enabled);
    return this.public();
  }

  assertEnabled() {
    if (!this.config().enabled) fail(409, 'INVALID_STATE', '请先开启飞书学习入口。');
    if (!this.configured()) fail(503, 'CONNECTION_UNAVAILABLE', '请先配置飞书应用。');
  }

  pair() {
    this.assertEnabled();
    const code = randomBytes(6).toString('hex').toUpperCase().match(/.{4}/g).join('-');
    const expiresAt = new Date(+this.clock() + 10 * MINUTE).toISOString();
    this.store.transaction(() => {
      this.cancelPending('repaired', true);
      this.store.remove('feishu-chat-binding', 'main');
      this.store.put('feishu-chat-pair', { codeHash: digest(pairText(code)), issuedAt: this.clock().toISOString(), expiresAt, attempts: 0, appIdentity: this.identity() }, 'main');
      this.saveState({ pendingPractice: null, snoozedUntil: null, snoozeId: null, lastError: null });
    });
    return { code, expiresAt };
  }

  cancelPending(reason, all = false) {
    for (const item of this.store.all('feishu-chat-outbox').filter(item => item.status === 'pending' && (all || item.purpose === 'practice'))) {
      this.store.put('feishu-chat-outbox', { ...item, status: 'cancelled', cancelReason: reason }, item.id);
    }
  }

  normalize(message) {
    requireValue(message && typeof message === 'object', '飞书消息格式无效。');
    requireValue(['messageId', 'chatId', 'senderId'].every(key => identifier(message[key])), '飞书消息标识无效。');
    const content = text(message.content, 'message content', 100000, true).trim();
    const replyToMessageId = message.replyToMessageId ?? message.rootId ?? null;
    requireValue(replyToMessageId === null || identifier(replyToMessageId), '飞书回复标识无效。');
    requireValue(message.createTime === undefined || Number.isFinite(message.createTime), '飞书消息时间无效。');
    return { ...message, content, replyToMessageId };
  }

  receive(message, ingressIdentity = this.identity()) {
    if (!this.config().enabled || !this.configured() || ingressIdentity !== this.identity()) return { ignored: true };
    if (message?.chatType !== 'p2p' || message.senderIsBot || message.senderType && message.senderType !== 'user') return { ignored: true };
    const incoming = this.normalize(message); const key = digest([this.identity(), incoming.messageId]);
    if (this.store.get('feishu-chat-inbox', key)) return { duplicate: true };
    const binding = this.binding();
    if (!binding) return this.acceptPair(incoming, key);
    if (binding.userId !== incoming.senderId || binding.chatId !== incoming.chatId) return { ignored: true };
    return this.store.transaction(() => {
      const record = this.store.put('feishu-chat-inbox', { messageId: incoming.messageId, appIdentity: this.identity(), bindingEpoch: binding.epoch,
        contentDigest: digest(incoming.content), status: 'received', receivedAt: this.clock().toISOString() }, key);
      this.saveState({ lastReceivedAt: record.receivedAt });
      return this.process(incoming, record);
    });
  }

  acceptPair(message, key) {
    const code = /^绑定\s+([A-Za-z0-9-]+)$/.exec(message.content)?.[1];
    const pair = this.store.get('feishu-chat-pair', 'main');
    if (!code || !pair || pair.appIdentity !== this.identity() || at(pair.expiresAt) <= +this.clock() || pair.attempts >= 5) return { ignored: true };
    if (message.createTime !== undefined && message.createTime < at(pair.issuedAt) - 5000) return { ignored: true };
    if (pair.codeHash !== digest(pairText(code))) {
      this.store.put('feishu-chat-pair', { ...pair, attempts: pair.attempts + 1 }, 'main'); return { ignored: true };
    }
    return this.store.transaction(() => {
      const epoch = randomBytes(12).toString('hex');
      this.store.put('feishu-chat-binding', { appIdentity: this.identity(), userId: message.senderId, chatId: message.chatId, epoch, boundAt: this.clock().toISOString() }, 'main');
      this.store.remove('feishu-chat-pair', 'main');
      this.store.put('feishu-chat-inbox', { messageId: message.messageId, appIdentity: this.identity(), bindingEpoch: epoch, kind: 'pair', status: 'processed' }, key);
      this.saveState({ lastReceivedAt: this.clock().toISOString(), pendingPractice: null, lastError: null });
      const today = this.automation.today();
      if (today.practice && !today.attempt) this.queuePractice(today, 'daily', '已连接知行。\n');
      else this.queueReply(key, today.attempt ? '已连接知行，今天的输出已经保存。' : '已连接知行。练习准备好后会按设置提醒，也可以发送“今日练习”。');
      return { bound: true };
    });
  }

  complete(inbox, fields = {}) { return this.store.put('feishu-chat-inbox', { ...inbox, ...fields, status: 'processed' }, inbox.id); }

  reply(inbox, value) { this.queueReply(inbox.id, value); this.complete(inbox); return { accepted: true }; }

  process(message, inbox) {
    const command = message.content.replace(/[。！!]+$/, '');
    if (['暂停', '暂停提醒'].includes(command)) {
      this.update({ remindersEnabled: false }); this.saveState({ snoozedUntil: null, snoozeId: null });
      return this.reply(inbox, '已暂停学习提醒。你仍可发送“今日练习”；发送“继续”恢复提醒。');
    }
    if (['继续', '继续提醒', '恢复提醒'].includes(command)) {
      this.update({ remindersEnabled: true }); this.saveState({ snoozedUntil: null, snoozeId: null });
      return this.reply(inbox, '已恢复学习提醒。发送“今日练习”可以直接开始。');
    }
    if (['稍后', '稍后30分钟', '稍后 30 分钟'].includes(command)) {
      this.cancelPending('snoozed');
      this.saveState({ snoozedUntil: new Date(+this.clock() + 30 * MINUTE).toISOString(), snoozeId: inbox.id });
      return this.reply(inbox, '好的，30 分钟后再提醒；发送“暂停”可停止提醒。');
    }
    if (['今日练习', '开始学习', '开始复习', '开始', '复习'].includes(command)) {
      this.saveState({ activeDiscussion: null });
      const interactive = this.config().cardsEnabled && !!this.cards;
      const result = this.sendToday({ interactive }); this.complete(inbox);
      if (!result.queued && !(interactive && result.alreadySent)) this.queueReply(inbox.id, this.sendMessage(result));
      return result;
    }
    if (['点评', '回答建议', '给点建议', 'advice'].includes(command)) return this.requestAdvice(inbox, false);
    if (['重新点评', '重试点评'].includes(command)) return this.requestAdvice(inbox, true);
    if (['帮助', 'help'].includes(command)) return this.reply(inbox, '发送“今日练习”开始；直接回复题目作答。“独立：”“提示：”可注明辅助程度，未注明时记录为未知。发送“点评”查看回答建议；失败后可用“重新点评”。也可以发送“稍后”“暂停”或“继续”。');
    const discussion = this.routeDiscussion(message, inbox);
    return discussion ?? this.answer(message, inbox);
  }

  discussionTarget(message) {
    if (!this.discussion) return null;
    if (!message.replyToMessageId) {
      const active = this.state().activeDiscussion; const today = this.automation.today();
      if (today.practice && !today.attempt && !active?.explicit) { if (active) this.saveState({ activeDiscussion: null }); return null; }
      if (!today.attempt && !active?.explicit) return null;
      return active && this.discussionChannelCurrent(active) ? active : null;
    }
    const card = this.store.all('feishu-card').find(row => row.messageId === message.replyToMessageId && row.feedbackId);
    if (card && card.section !== 'advice') return null;
    const sent = this.store.all('feishu-chat-outbox').find(row => row.messageId === message.replyToMessageId && row.status === 'sent'
      && ['advice', 'advice_discussion'].includes(row.purpose));
    if (!card && !sent) return null;
    const source = card ?? sent;
    const target = { feedbackId: card?.feedbackId ?? sent.feedbackId, appIdentity: source.appIdentity, bindingEpoch: source.bindingEpoch,
      userId: card?.userId ?? this.binding()?.userId, chatId: source.chatId, messageId: message.replyToMessageId, explicit: true };
    if (!target.feedbackId || !this.discussionChannelCurrent(target)) return { invalid: true };
    return target;
  }
  routeDiscussion(message, inbox) {
    const target = this.discussionTarget(message); if (!target) return null;
    if (target.invalid) return this.reply(inbox, '这条建议属于旧连接或绑定，请重新打开建议。');
    try {
      const current = this.discussion.public(target.feedbackId);
      if (['好', '好的', 'OK', 'ok', '收到', '谢谢'].includes(message.content)) return this.reply(inbox,
        current.saved ? '当前版本已经保存；继续讨论不会自动覆盖已保存内容。' : '满意后点击保存建议；当前未自动保存。');
      const result = this.discussion.submit(target.feedbackId, { message: message.content, expectedVersion: current.version,
        operationId: `discussion_text_${digest([this.identity(), message.messageId]).slice(0, 48)}`, channel: this.discussionChannel() });
      const feedback = this.store.require('feedback', target.feedbackId); const attempt = this.store.require('attempt', feedback.attemptId);
      const today = this.automation.today();
      this.store.put('feishu-chat-inbox', { ...inbox, status: 'discussion_pending', feedbackId: target.feedbackId, attemptId: attempt.id,
        practiceId: attempt.practiceId, discussionTurnId: result.pendingTurnId, practiceContext: today.practice?.id === attempt.practiceId && today.attempt?.id === attempt.id
          ? this.context(today) : digest(this.learning.advice.material(attempt.id).context) }, inbox.id);
      this.saveState({ activeDiscussion: { ...target, ...this.discussionChannel(), explicit: !!target.explicit } });
      this.queueReply(inbox.id + ':discussion', `正在讨论${discussionVersionLabel(current.version)}；完成后请明确点击保存，当前未自动保存。`);
      return { accepted: true, discussion: true, feedbackId: target.feedbackId, version: current.version };
    } catch (error) { return this.reply(inbox, publicError(error).body.error.message); }
  }

  requestAdvice(inbox, retry) {
    const today = this.automation.today();
    if (!today.attempt) return this.reply(inbox, '请先回答今日练习，再发送“点评”查看建议。');
    if (!this.learning.advice) return this.reply(inbox, '当前版本提供本地自查提示，AI 点评尚不可用。');
    const state = this.learning.advice.schedule(today.attempt.id, { retry });
    this.store.put('feishu-chat-inbox', { ...inbox, status: 'feedback_pending', attemptId: today.attempt.id,
      practiceContext: this.context(today), practiceId: today.practice.id }, inbox.id);
    return { accepted: true, adviceStatus: state.status, attemptId: today.attempt.id };
  }

  context(today) {
    const current = this.automation.context();
    return digest([today.practice?.id, today.profile.revision, current.scopeRevision, current.modelKey, today.practice?.sourceRefs]);
  }

  sendToday({ interactive = false } = {}) {
    this.assertEnabled();
    if (!this.binding()) fail(409, 'INVALID_STATE', '请先用配对码绑定飞书私聊。');
    const today = this.automation.today();
    const learningCard = interactive && this.config().cardsEnabled && !!this.cards;
    if (!today.practice || (today.attempt && !learningCard)) return { queued: false, alreadySent: false, practiceId: today.practice?.id ?? null, completed: !!today.attempt };
    const item = learningCard ? this.queueLearningCard(today) : this.queuePractice(today, interactive ? 'interactive' : 'daily');
    return { queued: item.status === 'pending' || item.status === 'sending', alreadySent: item.status === 'sent', practiceId: today.practice.id, deliveryState: item.status };
  }

  openDiscussion(feedbackId) {
    this.assertEnabled();
    if (!this.binding()) fail(409, 'INVALID_STATE', '请先绑定飞书私聊。');
    if (!this.config().cardsEnabled || !this.cards || !this.discussion) fail(409, 'INVALID_STATE', '请先启用飞书互动卡片。');
    const feedback = this.store.require('feedback', text(feedbackId, 'feedbackId', 128));
    const material = this.learning.advice.material(feedback.attemptId); const current = this.discussion.public(feedback.id);
    const today = this.automation.today(); const practiceContext = today.practice?.id === material.practice.id && today.attempt?.id === material.attempt.id
      ? this.context(today) : digest(material.context);
    const item = this.queue(`open-discussion:${feedback.id}:v${current.version}`, `回答建议｜${discussionVersionLabel(current.version)}\n${current.candidate.summary}\n\n可继续讨论；满意后点击保存建议，当前不会自动保存。`, {
      purpose: 'advice_discussion', feedbackId: feedback.id, attemptId: material.attempt.id, practiceId: material.practice.id,
      practiceContext, discussionVersion: current.version, explicitDiscussion: true });
    const decorated = this.cards.decorateAdvice(item, { attemptId: material.attempt.id, practiceId: material.practice.id, practiceContext }, { feedback });
    return { queued: ['pending', 'sending'].includes(decorated.status), alreadySent: decorated.status === 'sent',
      feedbackId: feedback.id, version: current.version, practiceId: material.practice.id, deliveryState: decorated.status };
  }

  sendMessage(result) {
    if (result.alreadySent) return '今天的练习已发送，直接回复题目即可作答。';
    if (result.completed) return '今天的输出已经保存，可以在知行网页查看。';
    if (result.deliveryState === 'uncertain') return '上次题目发送结果未确认，请先检查已收到的消息；也可在知行网页继续学习。';
    if (result.practiceId) return '题目暂未送达，可以在知行网页继续学习。';
    return '当前还没有可作答的练习，准备好后会按设置提醒。';
  }

  queuePractice(today, purposeKey = 'daily', prefix = '') {
    const practice = today.practice;
    const value = `${prefix}今日练习｜${practice.goal}\n预计 ${practice.estimatedMinutes} 分钟\n\n${practice.prompt}\n\n直接回复本条消息即可作答。辅助程度未注明时记录为未知；可用“独立：”或“提示：”注明。`;
    const item = this.queue(`practice:${today.date}:${practice.id}:${this.context(today)}:${purposeKey}`, value, {
      purpose: 'practice', practiceId: practice.id, context: this.context(today), date: today.date });
    return this.config().cardsEnabled && this.cards ? this.cards.decoratePractice(item, today) : item;
  }

  queueReply(key, value) { return this.queue(`reply:${key}`, value, { purpose: 'reply' }); }

  queueLearningCard(today) {
    const practice = today.practice; const attemptId = today.attempt?.id ?? null; const context = this.context(today);
    const text = `今日学习｜${practice.goal}\n${practice.prompt}\n\n${attemptId ? '回答已保存，可查看建议或进入记忆闪卡。' : '请在卡片中作答，也可以直接回复本条消息。'}`;
    const item = this.queue(`learning-card:${today.date}:${practice.id}:${context}:${attemptId ?? 'unanswered'}`, text,
      { purpose: 'learning_card', practiceId: practice.id, context, date: today.date, attemptId });
    return this.cards.decoratePractice(item, today);
  }

  queue(key, value, fields) {
    const binding = this.binding();
    requireValue(binding, '飞书私聊尚未绑定。');
    const recordId = digest([this.identity(), binding.epoch, key]);
    const previous = this.store.get('feishu-chat-outbox', recordId);
    if (previous && !(previous.status === 'cancelled' && previous.attempts === 0)) return previous;
    if (this.store.all('feishu-chat-outbox').filter(item => ['pending', 'sending'].includes(item.status)).length >= 100) fail(429, 'RATE_LIMITED', '飞书待发队列已满，请稍后重试。', true);
    return this.store.put('feishu-chat-outbox', { ...fields, text: value, appIdentity: this.identity(), bindingEpoch: binding.epoch,
      configRevision: this.config().revision, chatId: binding.chatId, uuid: previous?.uuid ?? uuid(recordId),
      status: 'pending', attempts: 0, nextAttemptAt: null, messageId: null }, recordId);
  }

  answer(message, inbox) {
    const binding = this.binding(); const today = this.automation.today();
    const delivery = message.replyToMessageId ? this.store.get('feishu-chat-delivery', digest([this.identity(), message.replyToMessageId])) : this.state().pendingPractice;
    if (!delivery || delivery.bindingEpoch !== binding.epoch) return this.reply(inbox, '请先发送“今日练习”，再直接回复收到的题目。');
    if (message.createTime !== undefined && message.createTime < at(delivery.sentAt) - 1000) return this.reply(inbox, '这条消息早于当前题目，请回复今天的练习重新提交。');
    if (!today.practice || delivery.practiceId !== today.practice.id || delivery.context !== this.context(today)) return this.reply(inbox, '这道题的学习目标或材料已更新，请发送“今日练习”获取当前题目。');
    if (today.attempt) return this.reply(inbox, '这道练习的输出已经保存，可以在知行网页查看。');
    const prefix = /^(独立|提示|部分代写|AI代写|回答|答案)[:：]\s*/i.exec(message.content);
    const output = (prefix ? message.content.slice(prefix[0].length) : message.content).trim();
    if (!output) return this.reply(inbox, '请写下你的回答，再发送给我。');
    const assistanceLevel = ({ 独立: 'none', 提示: 'hint', 部分代写: 'partial', ai代写: 'full' })[prefix?.[1].toLowerCase()] ?? 'unknown';
    const attempt = this.learning.attempt(today.practice.id, { output, assistanceLevel, evidenceRefs: [] });
    this.store.put('feishu-chat-inbox', { ...inbox, status: 'feedback_pending', attemptId: attempt.id,
      practiceContext: delivery.context, practiceId: today.practice.id }, inbox.id);
    this.saveState({ pendingPractice: null });
    return { accepted: true, attemptId: attempt.id, practiceId: today.practice.id };
  }

  tick(clock = this.clock()) {
    if (!this.config().enabled || !this.configured() || !this.binding() || !this.config().remindersEnabled) return;
    const state = this.state();
    if (at(state.snoozedUntil) > +clock) return;
    const today = this.automation.today();
    if (!today.practice || today.attempt) return;
    if (state.snoozeId && state.snoozedUntil) {
      this.queuePractice(today, `snooze:${state.snoozeId}`); this.saveState({ snoozedUntil: null, snoozeId: null }); return;
    }
    const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: this.domain.profile().timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(clock);
    if (localTime >= this.config().reminderLocalTime && today.date === dateInZone(clock, this.domain.profile().timeZone)) this.queuePractice(today);
  }

  async finishFeedback() {
    for (const inbox of this.store.all('feishu-chat-inbox').filter(item => item.status === 'feedback_pending')) {
      const attempt = this.store.get('attempt', inbox.attemptId);
      if (!attempt) { this.complete(inbox); continue; }
      const state = this.learning.advice?.public(attempt.id);
      if (state && ['queued', 'running'].includes(state.status)) {
        this.acknowledgeAdvice(inbox); continue;
      }
      if (!attempt.feedback) await this.learning.feedback(attempt.id, { mode: 'template', allowTemplateFallback: true });
      this.store.transaction(() => {
        if (this.config().enabled && this.binding()?.epoch === inbox.bindingEpoch && inbox.appIdentity === this.identity()) this.finishAdviceReply(inbox, state);
        this.complete(inbox);
      });
    }
  }

  finishDiscussions() {
    if (!this.discussion) return;
    for (const inbox of this.store.all('feishu-chat-inbox').filter(row => row.status === 'discussion_pending')) {
      const turn = this.store.get('advice-discussion-turn', inbox.discussionTurnId);
      if (turn && ['queued', 'running'].includes(turn.status)) continue;
      if (!this.discussionChannelCurrent({ ...inbox, userId: this.binding()?.userId })) { this.complete(inbox); continue; }
      const current = this.discussion.public(inbox.feedbackId);
      if (current.status === 'stale') { this.reply(inbox, current.message); continue; }
      const item = this.queue(`discussion:${inbox.id}`, `${discussionVersionLabel(current.version)}\n${current.reply ?? current.message}\n\n${current.candidate.summary}\n\n确认后点击保存建议，当前未自动保存。`, {
        purpose: 'advice_discussion', feedbackId: inbox.feedbackId, attemptId: inbox.attemptId, practiceId: inbox.practiceId,
        practiceContext: inbox.practiceContext, discussionVersion: current.version });
      if (this.config().cardsEnabled && this.cards) this.cards.decorateAdvice(item, inbox, { feedback: this.store.require('feedback', inbox.feedbackId) });
      this.complete(inbox);
    }
  }

  acknowledgeAdvice(inbox) {
    if (inbox.adviceAcknowledged || this.binding()?.epoch !== inbox.bindingEpoch || inbox.appIdentity !== this.identity()) return;
    this.store.transaction(() => {
      this.queueReply(inbox.id + ':saved', '回答已保存，正在准备 AI 建议；稍后会发到这里，网页也能查看。');
      this.store.put('feishu-chat-inbox', { ...inbox, adviceAcknowledged: true }, inbox.id);
    });
  }

  feedbackCurrent(item) {
    const today = this.automation.today();
    return today.attempt?.id === item.attemptId && today.practice?.id === item.practiceId && this.context(today) === item.practiceContext;
  }

  finishAdviceReply(inbox, state) {
    if (inbox.practiceContext && !this.feedbackCurrent(inbox)) {
      this.queueReply(inbox.id, '回答已保存。学习目标或材料已更新，请在网页查看原回答与反馈。'); return;
    }
    if (state?.status === 'ready' && state.feedback?.mode === 'model') {
      const item = this.queue(`advice:${inbox.id}`, adviceMessage(state.feedback), { purpose: 'advice', attemptId: inbox.attemptId,
        feedbackId: state.feedback.id, practiceId: inbox.practiceId, practiceContext: inbox.practiceContext });
      if (this.config().cardsEnabled && this.cards) this.cards.decorateAdvice(item, inbox, state);
      return;
    }
    const reason = state && !['off', 'idle'].includes(state.status) ? `AI 建议暂未完成：${state.message}\n` : '';
    this.queueReply(inbox.id, `${reason}输出已保存，网页也能看到。本地自查提示已准备好；正确性与能力掌握尚未评估。`);
  }

  recipientCurrent(item) {
    const binding = this.binding();
    if (!this.config().enabled || !this.configured() || !binding) return false;
    return item.appIdentity === this.identity() && item.bindingEpoch === binding.epoch && item.chatId === binding.chatId;
  }

  practiceCurrent(item) {
    const today = this.automation.today();
    return !!today.practice && !today.attempt && item.date === today.date && item.practiceId === today.practice.id && item.context === this.context(today);
  }

  learningCardCurrent(item) {
    const today = this.automation.today();
    return !!(this.config().cardsEnabled && this.cards && today.practice && item.date === today.date
      && item.practiceId === today.practice.id && item.context === this.context(today) && item.attemptId === (today.attempt?.id ?? null));
  }

  deliverable(item) {
    if (!this.recipientCurrent(item)) return false;
    if (item.purpose === 'card_update') return this.config().cardsEnabled && !!this.cards?.deliverable(item);
    if (item.purpose === 'learning_card') return this.learningCardCurrent(item) && this.cards.deliverable(item);
    if (item.purpose === 'advice_discussion') {
      try { const current = this.discussion?.public(item.feedbackId); return !!current && current.status !== 'stale'
        && current.version === item.discussionVersion && (!item.cardId || this.cards.deliverable(item)); } catch { return false; }
    }
    if (item.configRevision !== this.config().revision) return false;
    if (item.purpose === 'advice') return this.feedbackCurrent(item);
    return item.purpose !== 'practice' || this.practiceCurrent(item);
  }

  async drain(send) {
    if (this.draining || !this.config().enabled || !this.configured() || !this.binding()) return;
    this.draining = true;
    try {
      await this.finishFeedback();
      this.finishDiscussions();
      await this.cards?.flush();
      const queue = this.store.all('feishu-chat-outbox').filter(item => item.status === 'pending' && at(item.nextAttemptAt) <= +this.clock()).reverse().slice(0, 25);
      for (const item of queue) await this.deliver(item, send);
    } catch { this.error('INTERNAL_ERROR', '飞书学习记录正在等待本地恢复，请稍后再试。', true); }
    finally { this.draining = false; }
  }

  claim(recordId) {
    return this.store.transaction(() => {
      const item = this.store.get('feishu-chat-outbox', recordId);
      if (!item || item.status !== 'pending' || at(item.nextAttemptAt) > +this.clock()) return null;
      if (!this.deliverable(item)) { this.store.put('feishu-chat-outbox', { ...item, status: 'cancelled', cancelReason: 'context_changed' }, item.id); return null; }
      return this.store.put('feishu-chat-outbox', { ...item, status: 'sending', attempts: item.attempts + 1, startedAt: this.clock().toISOString() }, item.id);
    });
  }

  async deliver(item, send) {
    const sending = this.claim(item.id);
    if (!sending) return;
    try {
      const result = await send({ chatId: sending.chatId, text: sending.text, uuid: sending.uuid,
        ...(sending.card ? { card: sending.card } : {}), ...(sending.updateMessageId ? { updateMessageId: sending.updateMessageId } : {}) });
      if (!identifier(result?.messageId)) throw new Error('Unconfirmed delivery');
      this.store.transaction(() => this.confirm(sending, result.messageId));
    } catch (error) {
      const uncertain = error.uncertain !== false;
      const retry = !uncertain && error.retryable && sending.attempts < 3;
      this.store.put('feishu-chat-outbox', { ...sending, status: uncertain ? 'uncertain' : retry ? 'pending' : 'failed', nextAttemptAt: retry ? new Date(+this.clock() + MINUTE).toISOString() : null }, item.id);
      this.error(uncertain ? 'DELIVERY_UNCERTAIN' : 'CONNECTION_UNAVAILABLE', uncertain ? '飞书发送结果未确认，未自动重复发送。' : '飞书消息暂未送达，已保留学习记录。', !!retry);
    }
  }

  confirm(item, messageId) {
    const sentAt = this.clock().toISOString();
    this.store.put('feishu-chat-outbox', { ...item, status: 'sent', messageId, sentAt }, item.id);
    this.saveState({ lastSentAt: sentAt, lastError: null });
    if (item.cardId) this.cards?.confirm(item, messageId);
    const card = item.cardId ? this.store.get('feishu-card', item.cardId) : null;
    const feedbackId = card?.section === 'advice' ? card.feedbackId : ['advice', 'advice_discussion'].includes(item.purpose) ? item.feedbackId : null;
    if (feedbackId && this.discussion && this.recipientCurrent(item)) {
      const previous = this.state().activeDiscussion;
      this.saveState({ activeDiscussion: { ...this.discussionChannel(), feedbackId, messageId,
        explicit: !!item.explicitDiscussion || previous?.feedbackId === feedbackId && !!previous.explicit } });
    }
    if (!['practice', 'learning_card'].includes(item.purpose) || !this.recipientCurrent(item) || !this.practiceCurrent(item)) return;
    if (this.state().activeDiscussion && !this.state().activeDiscussion.explicit) this.saveState({ activeDiscussion: null });
    const delivery = { outboxId: item.id, practiceId: item.practiceId, context: item.context, bindingEpoch: item.bindingEpoch, messageId, sentAt };
    this.store.put('feishu-chat-delivery', delivery, digest([this.identity(), messageId]));
    this.saveState({ pendingPractice: delivery });
  }
}
