import { randomBytes } from 'node:crypto';
import { boolean, dateInZone, digest, onlyFields, text } from './validation.mjs';
import { fail, requireValue } from './errors.mjs';

const DEFAULTS = { enabled: false, remindersEnabled: true, reminderLocalTime: '09:00' };
const MINUTE = 60000;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const pairText = value => value.replace(/-/g, '').toUpperCase();
const uuid = value => { const hash = digest(value); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`; };
const at = value => value ? +new Date(value) : 0;

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

  config() { return this.store.get('config', 'feishu-chat'); }
  state() { return this.store.get('feishu-chat-state', 'main') ?? {}; }
  saveState(fields) { return this.store.put('feishu-chat-state', { ...this.state(), ...fields }, 'main'); }
  identity() { const config = this.settings.raw().feishu; return digest([config.apiBase, config.appId, this.secrets.get('feishu.appSecret')]); }
  configured() { const config = this.settings.raw().feishu; return !!(config.enabled && config.appId && this.secrets.get('feishu.appSecret')); }
  binding() { const value = this.store.get('feishu-chat-binding', 'main'); return value?.appIdentity === this.identity() ? value : null; }
  error(code, message, retryable) { this.saveState({ lastError: { code, message, retryable } }); }

  public() {
    const config = this.config(); const state = this.state(); const configured = this.configured(); const bound = !!this.binding();
    return { enabled: config.enabled, revision: config.revision, remindersEnabled: config.remindersEnabled,
      reminderLocalTime: config.reminderLocalTime, configured, bound,
      state: !config.enabled ? 'off' : !configured ? 'setup' : !bound ? 'unbound' : state.lastError ? 'error' : 'ready',
      lastReceivedAt: state.lastReceivedAt ?? null, lastSentAt: state.lastSentAt ?? null,
      lastError: state.lastError ?? null, snoozedUntil: state.snoozedUntil ?? null,
      pendingMessages: this.store.all('feishu-chat-outbox').filter(item => ['pending', 'sending'].includes(item.status)).length };
  }

  update(body) {
    onlyFields(body, Object.keys(DEFAULTS));
    const next = { ...this.config(), ...body };
    boolean(next.enabled, 'enabled'); boolean(next.remindersEnabled, 'remindersEnabled');
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
      const result = this.sendToday(); this.complete(inbox);
      if (!result.queued) this.queueReply(inbox.id, this.sendMessage(result));
      return result;
    }
    if (['帮助', 'help'].includes(command)) return this.reply(inbox, '发送“今日练习”开始；直接回复题目作答。“独立：”“提示：”可注明辅助程度，未注明时记录为未知。也可以发送“稍后”“暂停”或“继续”。');
    return this.answer(message, inbox);
  }

  context(today) {
    const current = this.automation.context();
    return digest([today.practice?.id, today.profile.revision, current.scopeRevision, current.modelKey, today.practice?.sourceRefs]);
  }

  sendToday() {
    this.assertEnabled();
    if (!this.binding()) fail(409, 'INVALID_STATE', '请先用配对码绑定飞书私聊。');
    const today = this.automation.today();
    if (!today.practice || today.attempt) return { queued: false, alreadySent: false, practiceId: today.practice?.id ?? null, completed: !!today.attempt };
    const item = this.queuePractice(today);
    return { queued: item.status === 'pending' || item.status === 'sending', alreadySent: item.status === 'sent', practiceId: today.practice.id, deliveryState: item.status };
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
    return this.queue(`practice:${today.date}:${practice.id}:${this.context(today)}:${purposeKey}`, value, {
      purpose: 'practice', practiceId: practice.id, context: this.context(today), date: today.date });
  }

  queueReply(key, value) { return this.queue(`reply:${key}`, value, { purpose: 'reply' }); }

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
    this.store.put('feishu-chat-inbox', { ...inbox, status: 'feedback_pending', attemptId: attempt.id }, inbox.id);
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
      if (!attempt.feedback) await this.learning.feedback(attempt.id, { mode: 'template', allowTemplateFallback: true });
      this.store.transaction(() => {
        if (this.config().enabled && this.binding()?.epoch === inbox.bindingEpoch && inbox.appIdentity === this.identity()) this.queueReply(inbox.id, '输出已保存，网页也能看到。本地自查提示已准备好；正确性与能力掌握尚未评估。');
        this.complete(inbox);
      });
    }
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

  deliverable(item) {
    if (!this.recipientCurrent(item) || item.configRevision !== this.config().revision) return false;
    return item.purpose !== 'practice' || this.practiceCurrent(item);
  }

  async drain(send) {
    if (this.draining || !this.config().enabled || !this.configured() || !this.binding()) return;
    this.draining = true;
    try {
      await this.finishFeedback();
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
      const result = await send({ chatId: sending.chatId, text: sending.text, uuid: sending.uuid });
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
    if (item.purpose !== 'practice' || !this.recipientCurrent(item) || !this.practiceCurrent(item)) return;
    const delivery = { outboxId: item.id, practiceId: item.practiceId, context: item.context, bindingEpoch: item.bindingEpoch, messageId, sentAt };
    this.store.put('feishu-chat-delivery', delivery, digest([this.identity(), messageId]));
    this.saveState({ pendingPractice: delivery });
  }
}
