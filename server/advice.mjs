import { boolean, dateInZone, digest, integer, onlyFields, truncate } from './validation.mjs';
import { fail, publicError } from './errors.mjs';
import { dto } from './dto.mjs';
import { generateAdvice } from './model-advice.mjs';

const DEFAULTS = { enabled: false, dailyCallLimit: 3 };
const ACTIVE = ['queued', 'running'];
const TERMINAL = ['ready', 'failed', 'uncertain', 'stale'];
const MESSAGES = {
  off: '自动点评已关闭，回答和本地自查仍保留。', idle: '可以为这次回答准备一份 AI 点评。',
  queued: '回答已保存，正在等待 AI 点评。', running: '回答已保存，正在准备 AI 点评。',
  ready: 'AI 点评已准备好，网页与飞书共用这份结果。',
  failed: 'AI 点评未完成，回答已保留；不会自动重复调用。',
  uncertain: '上次点评请求的结果未确认，回答已保留，未自动重发。',
  limited: '今天的 AI 点评次数已用完，回答和本地自查仍保留。',
  unavailable: '模型尚未就绪，回答和本地自查仍保留。',
  stale: '点评所需的题目、来源或授权已变化，旧结果未发布。',
};
const length = value => [...value].length;
const attemptIdentity = attempt => digest([attempt.practiceId, attempt.output, attempt.assistanceLevel, attempt.evidenceRefs, attempt.evidenceSnapshots]);
const practiceIdentity = practice => digest([practice.prompt, practice.goal, practice.skill, practice.rubric, practice.sourceRefs]);

export class Advice {
  constructor(store, settings, domain, collector, learning, model, jobs, { clock = () => new Date() } = {}) {
    Object.assign(this, { store, settings, domain, collector, learning, model, jobs, clock });
    if (!store.get('config', 'answer-advice')) store.put('config', DEFAULTS, 'answer-advice');
  }

  config() { return this.store.get('config', 'answer-advice'); }
  date() { return dateInZone(this.clock(), this.domain.profile().timeZone); }
  calls(date = this.date()) { return this.store.all('advice-call').filter(call => call.date === date); }
  modelKey() { return digest([this.settings.raw().model, this.settings.secrets.get('model.apiKey')]); }

  modelConfigured() {
    const model = this.settings.raw().model;
    try {
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(model.endpoint).hostname);
      return !!(model.enabled && model.model && (local || model.allowExternalProcessing && this.settings.secrets.get('model.apiKey')));
    } catch { return false; }
  }

  settingsPublic() {
    const config = this.config(); const callsToday = this.calls().length;
    return { enabled: config.enabled, dailyCallLimit: config.dailyCallLimit, revision: config.revision,
      callsToday, remainingToday: Math.max(0, config.dailyCallLimit - callsToday), modelConfigured: this.modelConfigured() };
  }

  update(body) {
    onlyFields(body, ['enabled', 'dailyCallLimit']);
    const next = { ...this.config(), ...body };
    boolean(next.enabled, 'enabled'); integer(next.dailyCallLimit, 'dailyCallLimit', 0, 20);
    this.store.put('config', next, 'answer-advice');
    return this.settingsPublic();
  }

  state(attemptId) { return this.store.get('answer-advice', attemptId); }
  save(attemptId, fields) { return this.store.put('answer-advice', { ...this.state(attemptId), ...fields, attemptId }, attemptId); }

  public(attemptId) {
    const attempt = this.store.require('attempt', attemptId); const saved = this.state(attemptId);
    const feedback = saved?.feedbackId ? this.store.get('feedback', saved.feedbackId) : attempt.feedback;
    const cached = feedback?.mode === 'model' && (!saved || saved.status === 'ready');
    const configured = this.modelConfigured(); const enabled = this.config().enabled;
    const budget = this.calls().length < this.config().dailyCallLimit;
    const savedStatus = saved?.status;
    const status = cached ? 'ready' : !enabled ? 'off' : [...ACTIVE, ...TERMINAL].includes(savedStatus) ? savedStatus
      : !configured ? 'unavailable' : !budget ? 'limited' : 'idle';
    const pending = ACTIVE.includes(status);
    return { attemptId, status, jobId: saved?.jobId ?? null, feedback: feedback ? dto('feedback', feedback) : null,
      message: MESSAGES[status], canRequest: enabled && configured && budget && !pending && !TERMINAL.includes(status),
      canRetry: enabled && configured && budget && ['failed', 'uncertain', 'stale'].includes(status),
      lastError: saved?.lastError ?? null };
  }

  sourceAllowed(source, scope, receipts) {
    if (source.kind === 'manual_dialogue') return scope.allowManualImports;
    if (source.kind !== 'codex') return true;
    if (!scope.enabled || !source.threadId || scope.excludedThreadIds.includes(source.threadId)) return false;
    if (receipts.has(source.id)) return true;
    return !!this.collector.authorized({ id: source.threadId, cwd: source.projectPath ?? null, archived: !!source.archived }, scope);
  }

  material(attemptId) {
    const attempt = this.store.require('attempt', attemptId); const practice = this.store.require('practice', attempt.practiceId);
    const scope = this.collector.scope();
    const receipts = new Set(this.store.all('automation-receipt').filter(receipt => receipt.scopeRevision === scope.revision
      && this.store.get('source', receipt.sourceId)?.contentDigest === receipt.contentDigest).map(receipt => receipt.sourceId));
    const sources = []; const seen = new Set();
    for (const ref of practice.sourceRefs) {
      const source = this.store.get('source', ref.sourceId);
      if (!source || source.contentDigest !== ref.contentDigest || !this.sourceAllowed(source, scope, receipts)) {
        fail(409, 'ADVICE_CONTEXT_CHANGED', '点评来源已变化或不在当前授权范围。');
      }
      if (!seen.has(source.id)) { sources.push({ source, ref }); seen.add(source.id); }
    }
    return { attempt, practice, sources, context: { configRevision: this.config().revision, modelKey: this.modelKey(),
      scopeRevision: scope.revision, attemptDigest: attemptIdentity(attempt), practiceDigest: practiceIdentity(practice),
      sourceDigests: sources.map(({ source }) => ({ sourceId: source.id, contentDigest: source.contentDigest })) } };
  }

  input(material) {
    const { attempt, practice, sources } = material; let remaining = 2500;
    const evidenceSnapshots = [];
    for (const { source, ref } of sources.slice(0, 4)) {
      const quoted = ref.excerpt && source.content.includes(ref.excerpt) ? ref.excerpt : source.content;
      const text = truncate(quoted, Math.min(1000, remaining)); remaining -= length(text);
      if (text) evidenceSnapshots.push({ sourceId: source.id, text });
    }
    const rubric = practice.rubric.slice(0, 5).map(criterion => ({ id: criterion.id, label: truncate(criterion.label, 80),
      description: truncate(criterion.description, 160), expectedEvidence: criterion.expectedEvidence.slice(0, 3).map(value => truncate(value, 100)) }));
    const input = { goal: truncate(practice.goal, 500), prompt: truncate(practice.prompt, 1500), output: truncate(attempt.output, 6000),
      assistanceLevel: attempt.assistanceLevel, rubric, evidenceSnapshots,
      coverage: { answerCharacters: length(attempt.output), reviewedCharacters: 0, sourceCount: evidenceSnapshots.length,
        rubricTotal: practice.rubric.length, rubricReviewed: rubric.length } };
    for (let pass = 0; pass < 3; pass++) {
      input.coverage.reviewedCharacters = length(input.output);
      const excess = length(JSON.stringify(input)) - 12000;
      if (excess <= 0) break;
      input.output = truncate(input.output, Math.max(0, length(input.output) - excess));
    }
    input.coverage.reviewedCharacters = length(input.output);
    if (!input.output.trim() || length(JSON.stringify(input)) > 12000) fail(413, 'ADVICE_INPUT_TOO_LARGE', '本次题目或回答超出有界点评输入，请使用本地自查。');
    return input;
  }

  assertEnabled() {
    if (!this.config().enabled) fail(409, 'ADVICE_DISABLED', '自动点评已关闭。');
    if (!this.modelConfigured()) fail(503, 'MODEL_UNAVAILABLE', '尚未配置可用模型或外部处理授权。');
  }

  assertCurrent(attemptId, context) {
    this.assertEnabled();
    const material = this.material(attemptId);
    if (digest(material.context) !== digest(context)) fail(409, 'ADVICE_CONTEXT_CHANGED', '点评所需的题目、来源、设置或授权已变化。');
    return material;
  }

  failureStatus(error) {
    if (error.code === 'ADVICE_DISABLED') return 'off';
    if (error.code === 'ADVICE_LIMIT') return 'limited';
    if (error.code === 'MODEL_UNAVAILABLE' || error.code === 'ADVICE_INPUT_TOO_LARGE') return 'unavailable';
    if (error.code === 'ADVICE_CONTEXT_CHANGED') return 'stale';
    return error.uncertain ? 'uncertain' : 'failed';
  }

  schedule(attemptId, { automatic = false, retry = false } = {}) {
    const attempt = this.store.get('attempt', attemptId);
    if (!attempt) {
      if (automatic) return null;
      this.store.require('attempt', attemptId);
    }
    const previous = this.state(attemptId); const current = this.public(attemptId);
    if (current.status === 'ready' || ACTIVE.includes(current.status) || !retry && ['failed', 'uncertain', 'stale'].includes(current.status)) return current;
    try {
      boolean(retry, 'retry'); this.assertEnabled();
      if (this.calls().length >= this.config().dailyCallLimit) fail(429, 'ADVICE_LIMIT', '今天的 AI 点评次数已用完。');
      const material = this.material(attemptId); this.input(material);
      this.store.transaction(() => {
        const generation = (previous?.generation ?? 0) + 1;
        const ack = this.jobs.enqueue('answer_advice', { attemptId, context: material.context, trigger: automatic ? 'automatic' : 'user' },
          `advice_${digest([attemptId, generation]).slice(0, 48)}`, `advice:${attemptId}`);
        this.save(attemptId, { status: 'queued', jobId: ack.jobId, generation, feedbackId: null, lastError: null });
      });
    } catch (error) {
      this.save(attemptId, { status: this.failureStatus(error), jobId: null, lastError: { ...publicError(error).body.error, retryable: false } });
    }
    return this.public(attemptId);
  }

  recordUsage(jobId, usage) {
    const call = this.store.get('advice-call', jobId);
    if (call) this.store.put('advice-call', { ...call, usage }, jobId);
  }

  finishResult(attemptId, result, rubric) {
    const reviewed = new Set(result.observations.map(observation => observation.criterionId));
    return { ...result, observations: [...result.observations, ...rubric.filter(criterion => !reviewed.has(criterion.id))
      .map(criterion => ({ criterionId: criterion.id, finding: 'not_assessed', comment: '本次输入预算未覆盖该评价项。', evidenceRefs: [] }))] };
  }

  async run(payload, job) {
    const { attemptId, context } = payload; const saved = this.state(attemptId);
    if (saved?.jobId !== job.id) return { superseded: true };
    const prior = this.store.get('advice-call', job.id);
    if (prior) {
      if (prior.status === 'complete' && saved.feedbackId) return { feedbackId: saved.feedbackId, resumedWithoutResend: true };
      if (prior.status === 'failed') {
        this.save(attemptId, { status: 'failed', lastError: saved.lastError ?? null });
        return { resumedWithoutResend: true };
      }
      if (prior.status === 'reserved') this.store.put('advice-call', { ...prior, status: 'uncertain' }, job.id);
      this.save(attemptId, { status: 'uncertain', lastError: { code: 'RECONCILIATION_REQUIRED', message: MESSAGES.uncertain, retryable: false } });
      return { resumedWithoutResend: true };
    }
    try {
      const material = this.assertCurrent(attemptId, context); const input = this.input(material);
      this.store.transaction(() => {
        this.assertCurrent(attemptId, context);
        if (this.calls().length >= this.config().dailyCallLimit) fail(429, 'ADVICE_LIMIT', '今天的 AI 点评次数已用完。');
        this.store.put('advice-call', { attemptId, date: this.date(), attemptedAt: this.clock().toISOString(), status: 'reserved',
          context, coverage: input.coverage, usage: null }, job.id);
        this.save(attemptId, { status: 'running', lastError: null });
      });
      const result = await generateAdvice(this.model, input, { onUsage: usage => this.recordUsage(job.id, usage) });
      return this.store.transaction(() => {
        this.assertCurrent(attemptId, context);
        if (this.state(attemptId)?.jobId !== job.id) fail(409, 'ADVICE_CONTEXT_CHANGED', '这次点评任务已被替换。');
        const savedFeedback = this.learning.saveFeedback(attemptId, 'model', this.finishResult(attemptId, result, material.practice.rubric));
        this.store.put('advice-call', { ...this.store.require('advice-call', job.id), status: 'complete', finishedAt: this.clock().toISOString() }, job.id);
        this.save(attemptId, { status: 'ready', feedbackId: savedFeedback.feedbackId, lastError: null });
        return { feedbackId: savedFeedback.feedbackId };
      });
    } catch (error) {
      const call = this.store.get('advice-call', job.id);
      if (call?.status === 'reserved') this.store.put('advice-call', { ...call, status: error.uncertain ? 'uncertain' : 'failed',
        failedAt: this.clock().toISOString(), errorCode: error.code ?? 'INTERNAL_ERROR' }, job.id);
      if (this.state(attemptId)?.jobId === job.id) this.save(attemptId, { status: this.failureStatus(error),
        lastError: { ...publicError(error).body.error, retryable: false } });
      throw error;
    }
  }
}
