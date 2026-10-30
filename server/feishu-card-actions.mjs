import { randomBytes } from 'node:crypto';
import { digest, truncate } from './validation.mjs';
import { fail, publicError } from './errors.mjs';
import { renderPracticeCard, renderAdviceCard, renderFlashcardCard, renderStatusCard } from './feishu-cards.mjs';

const ACTIONS = new Set(['submit_answer', 'view_advice', 'retry_advice', 'save_advice', 'dismiss_advice',
  'flashcards', 'create_flashcard', 'reveal_card', 'rate_again', 'rate_hard', 'rate_good', 'rate_easy', 'refresh']);
const RATINGS = { rate_again: 'again', rate_hard: 'hard', rate_good: 'good', rate_easy: 'easy' };
const PREFIXES = { none: '独立：', hint: '提示：', partial: '部分代写：', full: 'AI代写：', unknown: '' };
const PENDING = ['queued', 'running'];
const action = (a, label, primary = false) => ({ a, label, primary });
const toast = (content, type = 'info') => ({ toast: { type, content } });
const refsInput = refs => refs.map(ref => ({ sourceId: ref.sourceId }));

export class FeishuCardActions {
  constructor(store, chat, advice, learning, domain, reviews, siyuan, jobs, { clock = () => new Date() } = {}) {
    Object.assign(this, { store, chat, advice, learning, domain, reviews, siyuan, jobs, clock });
    this.flushing = false;
  }

  state(id) { return this.store.get('feishu-card', id); }
  save(id, fields) { return this.store.put('feishu-card', { ...this.state(id), ...fields }, id); }
  today() { return this.chat.automation.today(); }

  current(state) {
    const binding = this.chat.binding(); const today = this.today();
    return !!(state && this.chat.config().enabled && this.chat.configured() && this.chat.config().cardsEnabled && binding
      && state.appIdentity === this.chat.identity() && state.bindingEpoch === binding.epoch
      && state.userId === binding.userId && state.chatId === binding.chatId
      && state.practiceId === today.practice?.id && state.context === this.chat.context(today)
      && (state.section !== 'advice' && state.view !== 'advice' || state.attemptId === today.attempt?.id)
      && (!state.reviewEpoch || state.reviewEpoch === this.siyuan.epoch()));
  }

  issue(id, version) {
    const token = randomBytes(12).toString('hex'); const nonceHash = digest(token);
    this.store.put('feishu-card-nonce', { cardId: id, version }, nonceHash);
    return { token, nonceHash };
  }

  decorate(outbox, fields) {
    if (!this.chat.config().cardsEnabled || outbox.status !== 'pending' || outbox.card) return outbox;
    const binding = this.chat.binding(); if (!binding) return outbox;
    return this.store.transaction(() => {
      const issued = this.issue(outbox.id, 1);
      const state = this.store.put('feishu-card', { ...fields, version: 1, nonceHash: issued.nonceHash,
        appIdentity: this.chat.identity(), bindingEpoch: binding.epoch, userId: binding.userId, chatId: binding.chatId,
        messageId: null, dirty: false, actionJobId: null }, outbox.id);
      return this.store.put('feishu-chat-outbox', { ...outbox, card: this.render(state, issued.token), cardId: state.id, cardVersion: state.version }, outbox.id);
    });
  }

  decoratePractice(outbox, today) {
    return this.decorate(outbox, { view: 'practice', section: 'practice', phase: 'question', practiceId: today.practice.id,
      context: this.chat.context(today), attemptId: today.attempt?.id ?? null });
  }

  decorateAdvice(outbox, inbox, advice) {
    return this.decorate(outbox, { view: 'advice', section: 'advice', phase: 'advice_ready', practiceId: inbox.practiceId,
      context: inbox.practiceContext, attemptId: inbox.attemptId, feedbackId: advice.feedback.id });
  }

  confirm(item, messageId) {
    const state = this.state(item.cardId);
    if (!state || state.version !== item.cardVersion || !this.current(state)) return;
    if (item.updateMessageId) this.save(state.id, { confirmedVersion: item.cardVersion });
    else if (!state.messageId) this.save(state.id, { messageId, confirmedVersion: item.cardVersion });
  }

  decode(event) {
    const value = event.action?.value;
    if (value && typeof value === 'object' && value.v === 1) return { token: value.t, name: value.a };
    const name = event.action?.name ?? event.raw?.action?.name ?? event.raw?.event?.action?.name;
    return typeof name === 'string' && /^submit_[a-f0-9]{24}$/.test(name)
      ? { token: name.slice(7), name: 'submit_answer' } : null;
  }

  authorized(event, decoded, ingressIdentity) {
    if (!decoded || !/^[a-f0-9]{24}$/.test(decoded.token) || !ACTIONS.has(decoded.name)) return null;
    if (ingressIdentity !== this.chat.identity()) return null;
    const nonceHash = digest(decoded.token); const issued = this.store.get('feishu-card-nonce', nonceHash);
    const state = issued ? this.state(issued.cardId) : null;
    if (!this.current(state) || !state.messageId || !Number.isInteger(issued.version) || issued.version < 1 || issued.version > state.version) return null;
    const stale = issued.version < state.version;
    if (!stale && state.nonceHash !== nonceHash) return null;
    const messageId = event.messageId ?? event.raw?.event?.context?.open_message_id;
    const chatId = event.chatId ?? event.raw?.event?.context?.open_chat_id;
    if (state.messageId !== messageId || state.chatId !== chatId || state.userId !== event.operator?.openId) return null;
    return { state, stale };
  }

  form(event) {
    const values = event.raw?.action?.form_value ?? event.raw?.event?.action?.form_value ?? {};
    const answer = values.answer_text; const assistance = values.assistance ?? 'unknown';
    if (typeof answer !== 'string' || !answer.trim() || [...answer].length > 1000
      || typeof assistance !== 'string' || !Object.hasOwn(PREFIXES, assistance)) {
      fail(422, 'VALIDATION_ERROR', '请填写 1–1000 字回答，并选择有效的辅助程度；长回答可直接发私聊文本。');
    }
    return { answer: answer.trim(), assistance };
  }

  assertAction(state, name) {
    if (state.actionJobId && PENDING.includes(this.store.get('job', state.actionJobId)?.status)) fail(409, 'JOB_OVERLAP', '这张卡片正在处理，请稍后刷新。');
    if (name === 'submit_answer' && (state.view !== 'practice' || this.today().attempt)) fail(409, 'INVALID_STATE', '这次回答已经保存，请查看建议或进入记忆闪卡。');
    if (name === 'reveal_card' && (state.view !== 'flashcard' || state.revealed || state.monitorJobId)) fail(409, 'INVALID_STATE', '当前不能再次翻面，请刷新卡片。');
    if (RATINGS[name] && (state.view !== 'flashcard' || !state.revealed || state.monitorJobId)) fail(409, 'INVALID_STATE', '请先独立回忆并翻面，再选择记忆自评。');
    if (['save_advice', 'dismiss_advice'].includes(name) && (!state.feedbackId || state.view !== 'advice')) fail(409, 'INVALID_STATE', '请先查看这次回答的建议。');
    if (name === 'create_flashcard' && state.phase !== 'no_due_cards') fail(409, 'INVALID_STATE', '请先查看记忆闪卡，再按当前状态创建。');
  }

  receive(event, ingressIdentity = this.chat.identity()) {
    try {
      const decoded = this.decode(event); const authorized = this.authorized(event, decoded, ingressIdentity);
      if (!authorized) return toast('这张卡片已失效或不属于当前绑定，请发送“今日练习”重新获取。', 'error');
      const { state, stale } = authorized; const name = stale ? 'resync' : decoded.name;
      const form = !stale && name === 'submit_answer' ? this.form(event) : null;
      const operationId = `card_${digest([state.id, state.nonceHash, name, form, stale ? digest(decoded.token) : null]).slice(0, 48)}`;
      const eventToken = event.raw?.event_id ?? event.raw?.header?.event_id ?? event.raw?.token ?? '';
      const eventId = digest([digest(String(eventToken)), operationId]);
      if (this.store.get('feishu-card-event', eventId) || this.store.all('job').some(job => job.operationId === operationId)) return toast('这次操作已接收，不会重复执行。');
      this.assertAction(state, name);
      return this.store.transaction(() => {
        if (form) this.submit(state, form, operationId);
        const ack = this.jobs.enqueue('feishu_card_action', { cardId: state.id, action: name, operationId,
          appIdentity: state.appIdentity, bindingEpoch: state.bindingEpoch, context: state.context, trigger: 'user' }, operationId, `feishu-card:${state.id}`);
        this.save(state.id, { actionJobId: ack.jobId });
        this.store.put('feishu-card-event', { cardId: state.id, action: name, jobId: ack.jobId,
          eventTokenHash: digest(String(eventToken)), formDigest: digest(form), receivedAt: this.clock().toISOString() }, eventId);
        this.chat.saveState({ lastCardActionAt: this.clock().toISOString(), lastCardAppIdentity: state.appIdentity, lastCardBindingEpoch: state.bindingEpoch });
        return toast(stale ? '正在恢复卡片，请稍后查看当前状态。' : form ? '回答已保存，正在更新卡片。' : '已接收，正在更新卡片。', 'success');
      });
    } catch (error) { return toast(publicError(error).body.error.message, 'error'); }
  }

  submit(state, form, messageId) {
    this.chat.receive({ messageId, chatId: state.chatId, senderId: state.userId, chatType: 'p2p', senderType: 'user',
      content: PREFIXES[form.assistance] + form.answer, replyToMessageId: state.messageId, createTime: +this.clock() }, state.appIdentity);
  }

  adviceParts(feedback) {
    const observations = feedback.observations ?? [];
    return { summary: feedback.summary, strengths: observations.filter(item => item.finding === 'met').slice(0, 2).map(item => item.comment),
      improvements: observations.filter(item => item.finding !== 'met').slice(0, 2).map(item => item.comment),
      nextAction: feedback.nextActions?.[0] ?? '按评价要点补充一个可检查的例子。', limitations: feedback.limitations ?? [] };
  }

  render(state, token) {
    const today = this.today();
    if (state.view === 'practice') return renderPracticeCard({ goal: today.practice.goal, prompt: today.practice.prompt,
      minutes: today.practice.estimatedMinutes, token, canSubmit: !today.attempt, answerStatus: today.attempt ? '回答已保存，可查看建议或进入记忆闪卡。' : '' });
    if (state.view === 'advice') {
      const feedback = this.store.require('feedback', state.feedbackId); const decision = this.store.get('advice-selection', feedback.id);
      return renderAdviceCard({ ...this.adviceParts(feedback), token, saved: decision?.state === 'saved', dismissed: decision?.state === 'dismissed' });
    }
    if (state.view === 'flashcard') return renderFlashcardCard({ question: state.question, answer: state.revealed ? state.answer : undefined,
      revealed: !!state.revealed, token, status: '记忆自评不等于事实核验或长期能力判断。', remaining: state.remaining });
    return renderStatusCard({ title: state.title ?? '学习状态', message: state.message ?? '请刷新查看当前结果。', token, actions: state.actions ?? [action('refresh', '刷新状态')] });
  }

  update(id, fields) { return this.save(id, { ...fields, dirty: true }); }
  status(id, title, message, fields = {}) { return this.update(id, { view: 'status', title, message, ...fields }); }

  showAdvice(state, retry = false) {
    const today = this.today();
    if (!today.attempt) return this.status(state.id, '先完成回答', '回答保存后可以查看具体建议。', { actions: [action('refresh', '返回练习')] });
    const advice = this.advice.schedule(today.attempt.id, { retry });
    if (advice.status === 'ready' && advice.feedback) return this.update(state.id, { view: 'advice', section: 'advice', phase: 'advice_ready',
      attemptId: today.attempt.id, feedbackId: advice.feedback.id, waitingAdviceAttempt: null });
    return this.status(state.id, '回答建议', advice.message, { section: 'advice', attemptId: today.attempt.id,
      waitingAdviceAttempt: PENDING.includes(advice.status) ? today.attempt.id : null,
      actions: [action(advice.canRetry ? 'retry_advice' : 'view_advice', advice.canRetry ? '重试点评' : '查看建议'), action('flashcards', '记忆闪卡')] });
  }

  selectAdvice(state, selection, operationId) {
    const feedback = this.store.require('feedback', state.feedbackId); const attempt = this.store.require('attempt', feedback.attemptId);
    if (attempt.id !== state.attemptId) fail(409, 'INVALID_STATE', '建议与本次回答不匹配。');
    this.store.transaction(() => {
      const prior = this.store.get('advice-selection', feedback.id); let outputId = prior?.outputId ?? null;
      if (selection === 'saved' && !outputId) {
        const practice = this.store.require('practice', attempt.practiceId);
        const content = [feedback.summary, ...feedback.observations.map(item => item.comment), '下一步：', ...feedback.nextActions, ...feedback.limitations].join('\n\n');
        const output = this.learning.output({ projectId: practice.projectId, practiceId: practice.id,
          title: truncate(`回答建议｜${practice.goal}`, 200), content, goal: practice.goal, status: 'final',
          sourceRefs: refsInput(practice.sourceRefs), evidenceRefs: [] }); outputId = output.id;
      }
      this.store.put('advice-selection', { feedbackId: feedback.id, attemptId: attempt.id, state: selection, outputId,
        selectedAt: this.clock().toISOString() }, feedback.id);
      this.store.put('advice-selection-event', { feedbackId: feedback.id, state: selection, outputId, at: this.clock().toISOString() }, operationId);
      this.update(state.id, { phase: selection === 'saved' ? 'advice_saved' : 'advice_dismissed' });
    });
  }

  async startReview(state) {
    const created = await this.reviews.create({ projectId: null, limit: 10 });
    this.save(state.id, { section: 'flashcards', reviewSessionId: created.session.id, reviewEpoch: this.siyuan.epoch() });
    return this.nextReview(this.state(state.id));
  }

  async nextReview(state) {
    const next = await this.reviews.next(state.reviewSessionId);
    if (next.state === 'question') {
      const fields = { view: 'flashcard', phase: 'review_question', question: next.card.question, answer: null, revealed: false,
        presentationId: next.card.presentationId, reviewCardId: next.card.cardId, reviewStartedAt: this.clock().toISOString(),
        monitorJobId: null, monitorKind: null, remaining: Math.max(0, next.session.limit - next.session.reviewedCount) };
      this.update(state.id, fields);
      if (next.card.revealed) this.reveal(this.state(state.id));
      return;
    }
    if (['rating_pending', 'uncertain'].includes(next.state)) return this.status(state.id, '评分待确认', '评分任务尚未完成，未重复发送；可以稍后刷新。', {
      phase: 'rating_pending', monitorJobId: next.jobId, monitorKind: 'grade', actions: [action('refresh', '刷新状态')] });
    const empty = next.state === 'empty';
    return this.status(state.id, empty ? '暂无到期闪卡' : '闪卡暂不可用', empty ? '可以用本次学习重点制作一张记忆闪卡，接受保留不代表事实已核验。'
      : '请在网页检查当前知识与思源连接；已有记录保留。', { phase: empty ? 'no_due_cards' : 'review_blocked', monitorJobId: null,
      actions: empty ? [action('create_flashcard', '用本次重点制作闪卡', true), action('refresh', '刷新状态')] : [action('refresh', '刷新状态')] });
  }

  reveal(state) {
    const result = this.reviews.reveal(state.reviewSessionId, { presentationId: state.presentationId, cardId: state.reviewCardId });
    return this.update(state.id, { view: 'flashcard', phase: 'review_revealed', question: result.question, answer: result.answer, revealed: true });
  }

  rate(state, name, operationId) {
    const elapsedMs = Math.max(0, Math.min(3600000, +this.clock() - +new Date(state.reviewStartedAt)));
    const ratingOperationId = `card_rate_${digest(operationId).slice(0, 48)}`;
    const ack = this.reviews.queueResponse(state.reviewSessionId, { presentationId: state.presentationId, cardId: state.reviewCardId,
      rating: RATINGS[name], elapsedMs }, ratingOperationId);
    return this.status(state.id, '正在保存记忆自评', '已记录本次选择，等待思源确认；不会重复评分。', {
      phase: 'rating_pending', monitorJobId: ack.jobId, monitorKind: 'grade', monitorSeen: null, actions: [action('refresh', '刷新状态')] });
  }

  createFlashcard(state) {
    const highlight = this.today().highlights[0];
    if (!highlight?.sourceRefs?.length) fail(409, 'INVALID_STATE', '当前没有带来源的学习重点，未创建闪卡。');
    const key = digest([highlight.goal, highlight.title, highlight.summary, highlight.sourceRefs.map(ref => [ref.sourceId, ref.contentDigest])]);
    return this.store.transaction(() => {
      let mapping = this.store.get('feishu-flashcard', key);
      if (!mapping) {
        const knowledge = this.domain.createKnowledge({ projectId: null, question: `请回忆「${highlight.title}」的关键要点。`,
          answer: `${highlight.summary}\n\n关联目标：${highlight.goal}\n关联理由：${highlight.whyRelevant}`, sourceRefs: refsInput(highlight.sourceRefs) });
        const accepted = this.domain.decide(knowledge.id, { decision: 'accept', operationId: `card_accept_${key.slice(0, 48)}` });
        const ack = this.jobs.enqueue('knowledge_sync', { knowledgeId: accepted.id, knowledgeRevision: accepted.revision }, `card_sync_${key.slice(0, 48)}`, `knowledge:${accepted.id}`);
        mapping = this.store.put('feishu-flashcard', { knowledgeId: accepted.id, syncJobId: ack.jobId, createdAt: this.clock().toISOString() }, key);
      }
      return this.status(state.id, '正在准备记忆闪卡', '已按你的选择保留知识，等待思源同步；内容仍标为未核验。', {
        section: 'flashcards', phase: 'sync_pending', monitorJobId: mapping.syncJobId, monitorKind: 'sync', monitorSeen: null,
        actions: [action('refresh', '刷新状态')] });
    });
  }

  async run(payload, job) {
    let state = this.state(payload.cardId);
    if (!state || state.actionJobId !== job.id) return { superseded: true };
    try {
      if (!this.current(state) || payload.appIdentity !== state.appIdentity || payload.bindingEpoch !== state.bindingEpoch || payload.context !== state.context) fail(409, 'INVALID_STATE', '卡片的绑定、题目或来源已变化。');
      const name = payload.action;
      if (name === 'submit_answer') this.update(state.id, { view: 'practice', attemptId: this.today().attempt?.id ?? null, phase: 'answer_saved' });
      else if (name === 'view_advice' || name === 'retry_advice') this.showAdvice(state, name === 'retry_advice');
      else if (name === 'save_advice' || name === 'dismiss_advice') this.selectAdvice(state, name === 'save_advice' ? 'saved' : 'dismissed', payload.operationId);
      else if (name === 'flashcards') await this.startReview(state);
      else if (name === 'create_flashcard') this.createFlashcard(state);
      else if (name === 'reveal_card') this.reveal(state);
      else if (RATINGS[name]) this.rate(state, name, payload.operationId);
      else if (name === 'resync') this.update(state.id, {});
      else if (name === 'refresh') await this.refresh(state);
      else fail(422, 'VALIDATION_ERROR', '不支持的卡片动作。');
      return { cardId: state.id };
    } catch (error) {
      this.status(state.id, '操作未完成', publicError(error).body.error.message, { phase: 'failed', actions: [action('refresh', '刷新状态')] });
      throw error;
    } finally { this.save(state.id, { actionJobId: null }); }
  }

  async refresh(state) {
    if (state.monitorJobId) return this.update(state.id, {});
    if (state.section === 'flashcards') return state.reviewSessionId ? this.nextReview(state) : this.startReview(state);
    if (state.section === 'advice') return this.showAdvice(state);
    return this.update(state.id, { view: 'practice' });
  }

  async monitor(state) {
    const job = this.store.get('job', state.monitorJobId);
    if (!job || PENDING.includes(job.status) || state.monitorSeen === job.status) return;
    this.save(state.id, { monitorSeen: job.status });
    if (job.status === 'succeeded') {
      this.save(state.id, { monitorJobId: null, monitorKind: null });
      return state.monitorKind === 'sync' ? this.startReview(this.state(state.id)) : this.nextReview(this.state(state.id));
    }
    return this.status(state.id, job.status === 'uncertain' ? '结果待确认' : '操作未完成',
      job.status === 'uncertain' ? '上次写入结果尚未确认，未自动重发。请在网页或思源核对。' : '本次同步或评分没有完成，已有回答与知识保留。请在网页检查。',
      { phase: 'native_failed', actions: [action('refresh', '刷新状态')] });
  }

  patch(state) {
    if (!state.messageId || !state.dirty || !this.current(state)) return;
    this.store.transaction(() => {
      const version = state.version + 1; const issued = this.issue(state.id, version);
      const updated = this.save(state.id, { version, nonceHash: issued.nonceHash, dirty: false });
      this.chat.queue(`card-update:${state.id}:${version}`, '学习卡片已更新，请查看卡片中的当前状态。', {
        purpose: 'card_update', card: this.render(updated, issued.token), updateMessageId: state.messageId,
        cardId: state.id, cardVersion: version, practiceId: state.practiceId, context: state.context });
    });
  }

  deliverable(item) {
    const state = this.state(item.cardId);
    return !!(this.current(state) && state.version === item.cardVersion
      && (item.updateMessageId ? state.messageId === item.updateMessageId : state.id === item.id && !state.messageId));
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const original of this.store.all('feishu-card')) {
        if (!original.messageId || !this.current(original)) continue;
        try {
          if (original.monitorJobId) await this.monitor(original);
          let state = this.state(original.id);
          if (state.waitingAdviceAttempt && !PENDING.includes(this.advice.public(state.waitingAdviceAttempt).status)) this.showAdvice(state);
          state = this.state(original.id);
          const attemptId = this.today().attempt?.id ?? null;
          if (state.view === 'practice' && state.attemptId !== attemptId) this.update(state.id, { attemptId });
          this.patch(this.state(original.id));
        } catch (error) {
          this.status(original.id, '状态暂不可用', publicError(error).body.error.message, { phase: 'failed', actions: [action('refresh', '刷新状态')] });
          this.patch(this.state(original.id));
        }
      }
    } finally { this.flushing = false; }
  }
}
