import { digest, integer, onlyFields, operationId as checkOperation, text, truncate } from './validation.mjs';
import { fail, publicError, requireValue } from './errors.mjs';
import { buildDiscussionInput, generateDiscussion } from './model-discussion.mjs';

const ACKS = ['好', '好的', 'OK', 'ok', '收到', '谢谢'];
const content = value => structuredClone({ summary: value.summary, observations: value.observations, nextActions: value.nextActions, limitations: value.limitations });
const versionId = (feedbackId, version) => `dv_${digest([feedbackId, version]).slice(0, 48)}`;
const messageFor = status => ({ ready: '可继续讨论；确认后点击保存当前版本。', queued: '讨论已接收，正在等待生成。', running: '正在结合你的回复修改建议。',
  uncertain: '上次请求结果未确认，未自动重发；请明确重试或核对。', failed: '本轮讨论未完成，之前的版本仍保留。',
  stale: '题目、材料或授权已变化，本轮结果未发布。', off: 'AI 点评已关闭，已有建议仍保留。', limited: '今日点评与讨论的共用额度已用完。', unavailable: '模型尚未就绪。' })[status];

export class AdviceDiscussion {
  constructor(store, advice, learning, jobs, { clock = () => new Date() } = {}) {
    Object.assign(this, { store, advice, learning, jobs, clock });
  }

  state(feedbackId) { return this.store.get('advice-discussion', feedbackId); }
  feedback(feedbackId) { return this.store.require('feedback', feedbackId); }
  version(feedbackId, version) {
    const saved = this.store.get('advice-discussion-version', versionId(feedbackId, version));
    if (saved) return saved;
    requireValue(version === 0, '讨论版本不存在。');
    const feedback = this.feedback(feedbackId); const selection = this.store.get('advice-selection', feedbackId);
    return { feedbackId, attemptId: feedback.attemptId, version: 0, candidate: content(feedback), reply: null, turnId: null,
      outputId: selection?.outputId ?? null, decision: selection?.state ?? null, selectedAt: selection?.selectedAt ?? null };
  }
  ensure(feedbackId) {
    const feedback = this.feedback(feedbackId);
    if (!this.state(feedbackId)) this.store.put('advice-discussion', { feedbackId, attemptId: feedback.attemptId, currentVersion: 0,
      lastTurnId: null, pendingTurnId: null, status: 'ready', lastError: null }, feedbackId);
    if (!this.store.get('advice-discussion-version', versionId(feedbackId, 0))) this.store.put('advice-discussion-version', this.version(feedbackId, 0), versionId(feedbackId, 0));
    return this.state(feedbackId);
  }
  update(feedbackId, fields) { return this.store.put('advice-discussion', { ...this.state(feedbackId), ...fields }, feedbackId); }
  public(feedbackId) {
    const feedback = this.feedback(feedbackId); const state = this.state(feedbackId); const version = state?.currentVersion ?? 0;
    const draft = this.version(feedbackId, version); const turn = state?.lastTurnId ? this.store.get('advice-discussion-turn', state.lastTurnId) : null;
    let valid = true; try { this.advice.material(feedback.attemptId); } catch { valid = false; }
    const pending = !!state?.pendingTurnId; const settings = this.advice.settingsPublic();
    const available = valid && settings.enabled && settings.modelConfigured && settings.remainingToday > 0;
    const status = !valid ? 'stale' : state?.status ?? 'ready';
    return { feedbackId, attemptId: feedback.attemptId, version, candidate: content(draft.candidate), lastUserMessage: turn?.message ?? null,
      reply: draft.reply, status, message: status === 'ready' && !available ? messageFor(!settings.enabled ? 'off' : !settings.modelConfigured ? 'unavailable' : 'limited') : messageFor(status), pendingTurnId: state?.pendingTurnId ?? null,
      canReply: available && !pending, canSave: valid && !pending && draft.decision !== 'saved',
      canRetry: available && !!turn && ['failed', 'uncertain', 'stale', 'off', 'unavailable', 'limited'].includes(turn.status),
      saved: draft.decision === 'saved', dismissed: draft.decision === 'dismissed' };
  }

  assertChannel(channel) {
    if (channel && (!this.channelGuard || !this.channelGuard(channel))) fail(409, 'DISCUSSION_CHANNEL_CHANGED', '飞书连接或私聊绑定已变化，请重新打开建议。');
  }
  assertVersion(feedbackId, expectedVersion) {
    integer(expectedVersion, 'expectedVersion', 0, Number.MAX_SAFE_INTEGER);
    if ((this.state(feedbackId)?.currentVersion ?? 0) !== expectedVersion) fail(409, 'DISCUSSION_VERSION_CHANGED', '建议已有新版本，请查看当前版本后再操作。');
  }
  history(feedbackId) {
    return this.store.all('advice-discussion-turn').filter(turn => turn.feedbackId === feedbackId && turn.status === 'ready')
      .sort((a, b) => a.resultVersion - b.resultVersion).map(turn => ({ user: turn.message, assistant: turn.reply }));
  }
  input(feedbackId, material, message, version) {
    return buildDiscussionInput({ base: this.advice.input(material), originalFeedback: content(this.feedback(feedbackId)),
      currentCandidate: content(this.version(feedbackId, version).candidate), turns: this.history(feedbackId), message });
  }
  submit(feedbackId, options) {
    onlyFields(options, ['message', 'expectedVersion', 'operationId', 'channel']);
    const message = text(options.message, 'message', 1000); checkOperation(options.operationId);
    if (ACKS.includes(message)) { this.assertVersion(feedbackId, options.expectedVersion); this.assertChannel(options.channel); return this.public(feedbackId); }
    return this.queue(feedbackId, { ...options, message }, null);
  }
  retry(feedbackId, options) {
    onlyFields(options, ['turnId', 'expectedVersion', 'operationId', 'channel']); checkOperation(options.operationId);
    const turn = this.store.require('advice-discussion-turn', text(options.turnId, 'turnId', 128));
    requireValue(turn.feedbackId === feedbackId && ['failed', 'uncertain', 'stale', 'off', 'unavailable', 'limited'].includes(turn.status), '只能明确重试本次失败或未确认的讨论。');
    requireValue(this.state(feedbackId)?.lastTurnId === turn.id && turn.baseVersion === options.expectedVersion, '请重试当前失败的讨论版本。');
    return this.queue(feedbackId, { ...options, message: turn.message }, turn.id);
  }
  queue(feedbackId, options, retryOfTurnId) {
    const turnId = `dt_${digest([feedbackId, options.operationId]).slice(0, 48)}`;
    if (this.store.get('advice-discussion-turn', turnId)) return this.public(feedbackId);
    this.assertVersion(feedbackId, options.expectedVersion); this.assertChannel(options.channel); this.advice.assertEnabled();
    const material = this.advice.material(this.feedback(feedbackId).attemptId);
    this.input(feedbackId, material, options.message, options.expectedVersion);
    return this.store.transaction(() => {
      const state = this.ensure(feedbackId); this.assertVersion(feedbackId, options.expectedVersion);
      if (state.pendingTurnId && state.pendingTurnId !== retryOfTurnId) fail(409, 'DISCUSSION_PENDING', '本轮讨论尚未结束，请等待结果。');
      if (this.advice.calls().length >= this.advice.config().dailyCallLimit) fail(429, 'ADVICE_LIMIT', messageFor('limited'));
      const ack = this.jobs.enqueue('advice_discussion', { feedbackId, turnId, context: material.context, channel: options.channel ?? null,
        feedbackDigest: digest(content(this.feedback(feedbackId))), candidateDigest: digest(this.version(feedbackId, options.expectedVersion).candidate), trigger: 'user' },
      `discussion_job_${digest([feedbackId, options.operationId]).slice(0, 48)}`, `discussion:${feedbackId}`);
      this.store.put('advice-discussion-turn', { feedbackId, attemptId: material.attempt.id, baseVersion: options.expectedVersion,
        operationId: options.operationId, retryOfTurnId, message: options.message, status: 'queued', jobId: ack.jobId, reply: null, resultVersion: null, lastError: null }, turnId);
      this.update(feedbackId, { status: 'queued', lastTurnId: turnId, pendingTurnId: turnId, lastError: null });
      return this.public(feedbackId);
    });
  }

  select(feedbackId, options, decision) {
    onlyFields(options, ['expectedVersion', 'operationId']); checkOperation(options.operationId);
    return this.store.transaction(() => {
      const state = this.ensure(feedbackId); this.assertVersion(feedbackId, options.expectedVersion);
      if (state.pendingTurnId) fail(409, 'DISCUSSION_PENDING', '讨论正在生成或结果待确认，暂不能保存或采纳旧版本。');
      const material = this.advice.material(state.attemptId); const draft = this.version(feedbackId, options.expectedVersion);
      let outputId = draft.outputId;
      if (decision === 'saved' && !outputId) {
        const candidate = draft.candidate;
        const explanation = draft.reply ? ['本轮讲解（AI参考）', draft.reply] : [];
        const output = this.learning.output({ projectId: material.practice.projectId, practiceId: material.practice.id,
          title: truncate(`回答建议｜${material.practice.goal} · v${draft.version}`, 200),
          content: [...explanation, candidate.summary, ...candidate.observations.map(item => item.comment), '下一步：', ...candidate.nextActions, ...candidate.limitations].join('\n\n'),
          goal: material.practice.goal, status: 'final', sourceRefs: material.practice.sourceRefs.map(ref => ({ sourceId: ref.sourceId })), evidenceRefs: [] });
        outputId = output.id;
      }
      const selectedAt = this.clock().toISOString();
      this.store.put('advice-discussion-version', { ...draft, outputId, decision, selectedAt }, versionId(feedbackId, draft.version));
      const historicalOutputId = outputId ?? this.store.get('advice-selection', feedbackId)?.outputId ?? null;
      this.store.put('advice-selection', { feedbackId, attemptId: state.attemptId, state: decision, outputId: historicalOutputId, selectedAt }, feedbackId);
      this.store.put('advice-selection-event', { feedbackId, state: decision, outputId, at: selectedAt }, options.operationId);
      return this.public(feedbackId);
    });
  }
  save(feedbackId, options) { return this.select(feedbackId, options, 'saved'); }
  dismiss(feedbackId, options) { return this.select(feedbackId, options, 'dismissed'); }

  assertCurrent(payload, turn) {
    this.assertChannel(payload.channel); const material = this.advice.assertCurrent(turn.attemptId, payload.context);
    const state = this.state(turn.feedbackId);
    if (state?.pendingTurnId !== turn.id || state.currentVersion !== turn.baseVersion
      || digest(content(this.feedback(turn.feedbackId))) !== payload.feedbackDigest
      || digest(this.version(turn.feedbackId, turn.baseVersion).candidate) !== payload.candidateDigest) {
      fail(409, 'DISCUSSION_VERSION_CHANGED', '讨论上下文已有变化，本次结果未发布。');
    }
    return material;
  }
  finishTurn(turn, status, lastError) {
    this.store.put('advice-discussion-turn', { ...this.store.require('advice-discussion-turn', turn.id), status, lastError }, turn.id);
    if (this.state(turn.feedbackId)?.pendingTurnId === turn.id) this.update(turn.feedbackId,
      { status, pendingTurnId: ['queued', 'running', 'uncertain'].includes(status) ? turn.id : null, lastError });
  }
  async run(payload, job) {
    const turn = this.store.require('advice-discussion-turn', payload.turnId);
    if (turn.jobId !== job.id || turn.status === 'ready') return { resumedWithoutResend: true, turnId: turn.id };
    const prior = this.store.get('advice-call', job.id);
    if (prior) {
      const status = prior.status === 'failed' ? 'failed' : 'uncertain';
      if (prior.status === 'reserved') this.store.put('advice-call', { ...prior, status: 'uncertain' }, job.id);
      this.finishTurn(turn, status, status === 'failed' ? turn.lastError : { code: 'RECONCILIATION_REQUIRED', message: messageFor('uncertain'), retryable: false });
      return { resumedWithoutResend: true, turnId: turn.id };
    }
    try {
      const material = this.assertCurrent(payload, turn); const input = this.input(turn.feedbackId, material, turn.message, turn.baseVersion);
      this.store.transaction(() => {
        this.assertCurrent(payload, turn);
        if (this.advice.calls().length >= this.advice.config().dailyCallLimit) fail(429, 'ADVICE_LIMIT', messageFor('limited'));
        this.store.put('advice-call', { attemptId: turn.attemptId, feedbackId: turn.feedbackId, turnId: turn.id, date: this.advice.date(),
          attemptedAt: this.clock().toISOString(), status: 'reserved', context: payload.context, coverage: input.base.coverage, usage: null }, job.id);
        this.finishTurn(turn, 'running', null);
      });
      const result = await generateDiscussion(this.advice.model, input, { onUsage: usage => this.advice.recordUsage(job.id, usage) });
      return this.store.transaction(() => {
        this.assertCurrent(payload, turn); const version = turn.baseVersion + 1;
        this.store.put('advice-discussion-version', { feedbackId: turn.feedbackId, attemptId: turn.attemptId, version,
          candidate: content(this.advice.finishResult(turn.attemptId, result.candidate, material.practice.rubric)), reply: result.reply,
          turnId: turn.id, outputId: null, decision: null, selectedAt: null }, versionId(turn.feedbackId, version));
        this.store.put('advice-discussion-turn', { ...this.store.require('advice-discussion-turn', turn.id), status: 'ready', reply: result.reply, resultVersion: version, lastError: null }, turn.id);
        this.update(turn.feedbackId, { currentVersion: version, pendingTurnId: null, status: 'ready', lastError: null });
        this.store.put('advice-call', { ...this.store.require('advice-call', job.id), status: 'complete', finishedAt: this.clock().toISOString() }, job.id);
        return { feedbackId: turn.feedbackId, turnId: turn.id, version };
      });
    } catch (error) {
      const call = this.store.get('advice-call', job.id);
      if (call?.status === 'reserved') this.store.put('advice-call', { ...call, status: error.uncertain ? 'uncertain' : 'failed', failedAt: this.clock().toISOString(), errorCode: error.code ?? 'INTERNAL_ERROR' }, job.id);
      const status = ['DISCUSSION_CHANNEL_CHANGED', 'DISCUSSION_VERSION_CHANGED'].includes(error.code) ? 'stale' : this.advice.failureStatus(error);
      this.finishTurn(turn, status, { ...publicError(error).body.error, retryable: false }); throw error;
    }
  }
}
