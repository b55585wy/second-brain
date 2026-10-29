import { digest, dateInZone, boolean } from './validation.mjs';
import { fail, publicError } from './errors.mjs';
import { dto } from './dto.mjs';
import { assessRelevance } from './relevance.mjs';

const HOUR = 60 * 60000;
const CONNECTION_RETRY_DELAY = 60000;
const STEP = 15000;
const CALL_LIMIT = 3;
const INPUT_LIMIT = 12000;
const asTime = value => value ? +new Date(value) : 0;
const highlightKey = item => digest([item.goal, item.title, item.summary].map(value => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()));
const appearance = (a, b) => a.generatedAt.localeCompare(b.generatedAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

function firstHighlights(focuses) {
  const seen = new Set(); const selected = [];
  for (const entry of focuses.flatMap(focus => focus.highlights.map(item => ({ focus, item })))) {
    const key = highlightKey(entry.item);
    if (seen.has(key)) continue;
    seen.add(key); selected.push(entry);
    if (selected.length === 3) break;
  }
  return selected;
}

export class Automation {
  constructor(store, settings, domain, sources, collector, learning, model, jobs, { clock = () => new Date() } = {}) {
    Object.assign(this, { store, settings, domain, sources, collector, learning, model, jobs, clock });
    if (!this.store.get('config', 'learning-automation')) this.store.put('config', { enabled: false }, 'learning-automation');
  }

  config() { return this.store.get('config', 'learning-automation'); }
  state() { return this.store.get('automation-state', 'main') ?? {}; }
  saveState(fields) { return this.store.put('automation-state', { ...this.state(), ...fields }, 'main'); }
  date(clock = this.clock()) { return dateInZone(clock, this.domain.profile().timeZone); }
  calls(date = this.date()) {
    // A local developer reset grants a new budget without rewriting the usage ledger.
    const reset = this.store.get('automation-quota-reset', date);
    const excluded = new Set(Array.isArray(reset?.callIds) ? reset.callIds : []);
    return this.store.all('automation-call').filter(call => call.date === date && !excluded.has(call.id));
  }
  modelKey() { return digest(this.settings.raw().model); }

  context() {
    return { configRevision: this.config().revision, profileRevision: this.domain.profile().revision,
      scopeRevision: this.collector.scope().revision, modelKey: this.modelKey() };
  }

  analysisKey(context) { return digest([context.profileRevision, context.scopeRevision, context.modelKey]); }
  sameContext(context) { return !!context && JSON.stringify(context) === JSON.stringify(this.context()); }

  setup() {
    const profile = this.domain.profile(); const scope = this.collector.scope(); const model = this.settings.raw().model;
    let available = false;
    try {
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(model.endpoint).hostname);
      available = !!(model.enabled && model.model && (local || model.allowExternalProcessing && this.model.secrets.get('model.apiKey')));
    } catch {}
    return { profile: profile.goals.some(goal => goal.trim()),
      scope: scope.enabled && (scope.allowedThreadIds.some(id => !scope.excludedThreadIds.includes(id)) || scope.allowedProjectPaths.length > 0), model: available };
  }

  assertCurrent(context, parts = []) {
    if (!this.config().enabled || !this.sameContext(context) || !Object.values(this.setup()).every(Boolean)) fail(409, 'INVALID_STATE', '自动整理设置、授权或学习档案已变化，旧结果未发布。');
    for (const part of parts) {
      if (this.store.get('source', part.sourceId)?.contentDigest !== part.contentDigest) fail(409, 'INVALID_STATE', '来源已变化，旧整理结果未发布。');
    }
  }

  activeJob() { return this.store.all('job').find(job => job.kind === 'learning_automation' && ['queued', 'running'].includes(job.status)); }

  pending(context = this.context()) {
    const key = this.analysisKey(context);
    return this.store.all('automation-receipt').filter(receipt => receipt.scopeRevision === context.scopeRevision && receipt.length > 0
      && (receipt.analysisKey !== key || receipt.offset < receipt.length));
  }

  lastCall() {
    return this.store.all('automation-call').sort((a, b) => asTime(b.attemptedAt) - asTime(a.attemptedAt)
      || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? null;
  }

  lastAttempt() { return asTime(this.lastCall()?.attemptedAt); }

  nextAttempt() {
    const call = this.lastCall(); const normal = { at: call ? asTime(call.attemptedAt) + HOUR : 0, quickRetryOf: null };
    if (!call || !this.sameContext(call.context) || call.status === 'complete') return normal;
    const saved = this.state();
    // Older calls kept only their public error in the matching automation state.
    const legacyCode = saved.lastErrorStage !== 'collection' && this.sameContext(saved.errorContext) ? saved.lastError?.code : null;
    const connection = ['failed', 'uncertain'].includes(call.status)
      && ['UPSTREAM_UNAVAILABLE', 'CONNECTION_UNAVAILABLE'].includes(call.errorCode ?? legacyCode);
    if (connection && !call.quickRetryOf) return { at: (asTime(call.failedAt) || asTime(call.attemptedAt)) + CONNECTION_RETRY_DELAY, quickRetryOf: call.id };
    // Preserve the consumed recovery chain across later hourly failures and restarts.
    return { ...normal, quickRetryOf: call.quickRetryOf ?? null };
  }

  digestDue(clock = this.clock()) { return this.calls(this.date(clock)).length < CALL_LIMIT && +clock >= this.nextAttempt().at && this.pending().length > 0; }

  contextFocuses() {
    const context = this.context();
    return this.store.all('focus-artifact').filter(focus => focus.profileRevision === context.profileRevision
      && focus.scopeRevision === context.scopeRevision && focus.modelConfigKey === context.modelKey);
  }

  validFocuses(date = null, allDates = false) {
    const candidates = this.contextFocuses().filter(focus => !date || focus.date === date)
      .sort((a, b) => b.date.localeCompare(a.date) || appearance(a, b));
    const digests = new Map();
    const unchanged = item => {
      if (!digests.has(item.sourceId)) digests.set(item.sourceId, this.store.get('source', item.sourceId)?.contentDigest);
      return digests.get(item.sourceId) === item.contentDigest;
    };
    const valid = []; let selectedDate = date;
    for (const focus of candidates) {
      if (!allDates && selectedDate && focus.date !== selectedDate) break;
      if (!focus.sourceDigests.every(unchanged)) continue;
      if (!allDates) selectedDate ??= focus.date;
      valid.push(focus);
    }
    return valid;
  }

  highlightHistory() {
    const seen = new Set();
    return this.validFocuses(this.date()).flatMap(focus => focus.highlights).filter(item => {
      const key = highlightKey(item); if (seen.has(key)) return false; seen.add(key); return true;
    });
  }

  currentFocus() {
    const focuses = this.validFocuses(); const entries = firstHighlights(focuses);
    const highlights = entries.map(entry => entry.item); const selected = [...new Set(entries.map(entry => entry.focus))];
    const base = selected.at(-1) ?? focuses.at(-1);
    if (!base) return null;
    const sourceDigests = (selected.length ? selected : [base]).flatMap(focus => focus.sourceDigests)
      .filter((item, index, values) => values.findIndex(value => value.sourceId === item.sourceId) === index);
    const refs = highlights.flatMap(item => item.sourceRefs).filter((item, index, values) => values.findIndex(value => value.sourceId === item.sourceId) === index);
    return { ...base, highlights, sourceDigests, provenance: { ...base.provenance, sourceRefs: refs },
      practiceId: base.date === this.date() ? this.practiceForToday()?.id ?? null : base.practiceId };
  }

  scheduledHighlights(date = this.date()) {
    const days = new Map(); const scheduled = new Map();
    const history = this.contextFocuses().filter(focus => focus.date < date)
      .sort((a, b) => a.date.localeCompare(b.date) || appearance(a, b));
    for (const focus of history) { const entries = days.get(focus.date) ?? []; entries.push(focus); days.set(focus.date, entries); }
    // Later evidence changes cannot turn a day's archived extras into its original schedule.
    for (const [scheduledDate, focuses] of days) for (const { item } of firstHighlights(focuses)) scheduled.set(highlightKey(item), scheduledDate);
    return scheduled;
  }

  nextDayFocus(date = this.date()) {
    const scheduled = this.scheduledHighlights(date); const unique = new Map();
    const history = this.validFocuses(null, true).filter(focus => focus.date < date).sort(appearance);
    for (const focus of history) for (const item of focus.highlights) {
      const key = highlightKey(item); if (!unique.has(key)) unique.set(key, { focus, item, key, order: unique.size });
    }
    const entries = [...unique.values()].sort((a, b) => (scheduled.get(a.key) ?? '').localeCompare(scheduled.get(b.key) ?? '') || a.order - b.order).slice(0, 3);
    if (!entries.length) return null;
    const base = entries.map(entry => entry.focus).sort(appearance).at(-1); const highlights = entries.map(entry => entry.item);
    const refs = highlights.flatMap(item => item.sourceRefs).filter((item, index, values) => values.findIndex(value => value.sourceId === item.sourceId) === index);
    return { ...base, highlights, practiceId: null, sourceDigests: refs.map(ref => ({ sourceId: ref.sourceId, contentDigest: ref.contentDigest })),
      provenance: { ...base.provenance, sourceRefs: refs } };
  }

  public() {
    const config = this.config(); const setup = this.setup(); const saved = this.state(); const current = this.context();
    const job = this.activeJob(); const pending = this.pending(current).length > 0;
    const callsToday = this.calls().length; const focus = this.currentFocus();
    const lastError = this.sameContext(saved.errorContext) && saved.lastError ? saved.lastError : null;
    let state = 'waiting'; let message = '后台会继续整理，值得学习的内容会出现在这里。';
    if (!config.enabled) { state = 'off'; message = '自动整理已关闭。'; }
    else if (!Object.values(setup).every(Boolean)) {
      state = 'setup'; message = !setup.profile ? '先填写一个学习目标。' : !setup.scope ? '请选择一次需要整理的对话。' : '请先配置并允许模型整理。';
    } else if (job && this.sameContext(job.payload.context)) {
      state = saved.phase === 'organizing' ? 'organizing' : 'collecting'; message = state === 'organizing' ? '正在按你的职业目标整理学习重点。' : '正在后台收集已授权对话，你可以继续工作。';
    } else if (pending && callsToday >= CALL_LIMIT) { state = 'limited'; message = '今天的自动整理额度已用完，明天继续。'; }
    else if (lastError) { state = 'error'; message = '本次整理未完成，已保留进度，稍后自动再试。'; }
    else if (focus?.highlights.length) { state = 'ready'; message = '今天的学习重点已经准备好。'; }
    const nextTimes = [asTime(saved.nextCollectAt)];
    if (pending && callsToday < CALL_LIMIT) nextTimes.push(Math.max(+this.clock(), this.nextAttempt().at));
    const next = nextTimes.filter(value => value > 0).map(value => Math.max(+this.clock(), value)).sort((a, b) => a - b)[0];
    return { enabled: config.enabled, revision: config.revision, state, message, setup, dailyCallLimit: CALL_LIMIT, callsToday,
      nextRunAt: config.enabled && Object.values(setup).every(Boolean) && next ? new Date(next).toISOString() : null,
      lastSuccessAt: saved.lastSuccessAt ?? null,
      lastError: lastError ? { code: lastError.code, message: lastError.message, retryable: !!lastError.retryable } : null };
  }

  today() {
    const focus = this.currentFocus(); const date = this.date();
    const practice = focus?.date === date ? this.practiceForFocus(focus) : null;
    const attempt = practice ? this.store.all('attempt').filter(item => item.practiceId === practice.id)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || b.id.localeCompare(a.id))[0] : null;
    return { date, profile: dto('profile', this.domain.profile()), automation: this.public(), highlights: focus?.highlights ?? [],
      practice: practice ? dto('practices', practice) : null, attempt: attempt ? dto('attempts', attempt) : null, generatedAt: focus?.generatedAt ?? null };
  }

  update(body) {
    const enabled = boolean(body.enabled, 'enabled');
    const before = this.config(); this.store.put('config', { enabled }, 'learning-automation');
    if (enabled && !before.enabled) this.saveState({ nextCollectAt: null, lastError: null, errorContext: null });
    this.tick(); return this.public();
  }

  tick(clock = this.clock()) {
    if (!this.config().enabled) return;
    const setup = this.setup();
    if (!setup.profile || !setup.scope) return;
    this.reuseDailyFocus();
    if (!setup.model || this.activeJob()) return;
    const collect = +clock >= asTime(this.state().nextCollectAt);
    if (!collect && !this.digestDue(clock)) return;
    const context = this.context();
    try { this.jobs.enqueue('learning_automation', { context, collect, trigger: 'scheduler' }, `auto_${digest([context, +clock, this.store.all('job').length]).slice(0, 48)}`, 'learning-automation'); }
    catch (error) { if (error.code !== 'JOB_OVERLAP') throw error; }
  }

  rank(source, profile = this.domain.profile()) {
    const relevance = assessRelevance({ question: source.title, answer: source.content.slice(0, 4000) }, profile);
    return relevance.score + relevance.careerScore / 100;
  }

  recordReceipts(sourceIds, context) {
    this.assertCurrent(context);
    for (const sourceId of sourceIds) {
      const source = this.store.require('source', sourceId); const id = digest([context.scopeRevision, sourceId]);
      const previous = this.store.get('automation-receipt', id); const same = previous?.contentDigest === source.contentDigest;
      this.store.put('automation-receipt', { sourceId, contentDigest: source.contentDigest, scopeRevision: context.scopeRevision,
        length: [...source.content].length, offset: same ? previous.offset : 0, analysisKey: same ? previous.analysisKey : null,
        rank: this.rank(source), rankProfileRevision: context.profileRevision, threadId: source.threadId, occurredAt: source.occurredAt ?? source.capturedAt }, id);
    }
  }

  segments(context) {
    const key = this.analysisKey(context); const pending = this.pending(context);
    const fresh = pending.filter(item => item.rankProfileRevision === context.profileRevision);
    const stale = pending.filter(item => item.rankProfileRevision !== context.profileRevision)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 100);
    const candidates = [...fresh, ...stale.map(receipt => {
      const source = this.store.get('source', receipt.sourceId);
      return source ? { ...receipt, rank: this.rank(source) } : receipt;
    })].sort((a, b) => b.rank - a.rank || b.occurredAt.localeCompare(a.occurredAt));
    const threads = new Map();
    for (const item of candidates) { const group = threads.get(item.threadId) ?? []; group.push(item); threads.set(item.threadId, group); }
    const ordered = [];
    while (ordered.length < 6 && [...threads.values()].some(group => group.length)) {
      for (const group of threads.values()) { if (group.length && ordered.length < 6) ordered.push(group.shift()); }
    }
    const perSource = Math.floor(INPUT_LIMIT / Math.max(1, ordered.length)); const parts = [];
    for (const receipt of ordered) {
      const source = this.store.get('source', receipt.sourceId);
      if (!source || source.contentDigest !== receipt.contentDigest) continue;
      const start = receipt.analysisKey === key ? receipt.offset : 0; const characters = [...source.content];
      const text = characters.slice(start, start + perSource).join('');
      if (text) parts.push({ sourceId: source.id, title: source.title, text, offset: start, length: [...text].length,
        contentDigest: source.contentDigest, receiptId: receipt.id });
    }
    return parts;
  }

  async run(payload, job) {
    const context = payload.context;
    this.assertCurrent(context);
    const complete = this.store.get('automation-run', job.id);
    if (complete?.finished) return complete.result;
    if (this.store.get('automation-call', job.id)) {
      this.saveState({ phase: null, nextCollectAt: new Date(+this.clock() + HOUR).toISOString() });
      return { resumedWithoutResend: true };
    }
    try {
      if (payload.collect && !complete?.collected) await this.collect(context, job);
      if (this.digestDue()) await this.organize(context, job);
      const result = { focusId: this.currentFocus()?.id ?? null, hasMore: !!this.state().hasMore };
      this.store.put('automation-run', { ...this.store.get('automation-run', job.id), finished: true, result }, job.id);
      this.saveState({ phase: null }); return result;
    } catch (error) {
      const call = this.store.get('automation-call', job.id);
      if (call?.status === 'reserved') this.store.put('automation-call', { ...call, status: error.uncertain ? 'uncertain' : 'failed',
        failedAt: this.clock().toISOString(), errorCode: error.code ?? 'INTERNAL_ERROR' }, job.id);
      const continuing = call && this.state().hasMore;
      if (this.sameContext(context)) this.saveState({ phase: null, lastError: publicError(error).body.error, errorContext: context,
        lastErrorStage: call ? 'model' : 'collection', nextCollectAt: new Date(+this.clock() + (continuing ? STEP : HOUR)).toISOString() });
      throw error;
    }
  }

  async collect(context, job) {
    this.assertCurrent(context); this.saveState({ phase: 'collecting' });
    const result = await this.collector.sync(this.collector.scope(), { captureOnly: true, maxThreads: 1, maxMessages: 100,
      onCaptured: sourceIds => this.recordReceipts(sourceIds, context) });
    this.assertCurrent(context);
    this.store.transaction(() => {
      this.recordReceipts(result.capturedSourceIds, context);
      this.store.put('automation-run', { collected: true }, job.id);
      const failedModel = this.state().lastErrorStage === 'model';
      this.saveState({ hasMore: result.truncated, nextCollectAt: new Date(+this.clock() + (result.truncated ? STEP : HOUR)).toISOString(),
        lastError: failedModel ? this.state().lastError : null, errorContext: failedModel ? this.state().errorContext : null });
    });
  }

  async organize(context, job) {
    const parts = this.segments(context);
    if (!parts.length) return;
    this.assertCurrent(context, parts);
    const profile = this.domain.profile(); const date = this.date();
    this.store.transaction(() => {
      this.assertCurrent(context, parts);
      if (this.calls(date).length >= CALL_LIMIT || this.store.get('automation-call', job.id)) fail(409, 'INVALID_STATE', '本次自动整理额度已使用。');
      const attempt = this.nextAttempt();
      if (+this.clock() < attempt.at) fail(409, 'INVALID_STATE', '自动整理尚在冷却，未发出新请求。');
      this.store.put('automation-call', { date, attemptedAt: this.clock().toISOString(), status: 'reserved', context,
        ...(attempt.quickRetryOf ? { quickRetryOf: attempt.quickRetryOf } : {}),
        inputDigest: digest(parts.map(part => [part.sourceId, part.contentDigest, part.offset, part.length])) }, job.id);
      this.saveState({ phase: 'organizing' });
    });
    const previousHighlights = this.highlightHistory().slice(0, 12).map(({ title, summary, goal }) => ({ title, summary, goal }));
    const result = await this.model.digest({ profile: { goals: profile.goals, careerDirection: profile.careerDirection, skills: profile.skills },
      budgetMinutes: Math.min(10, profile.dailyBudgetMinutes), segments: parts.map(({ sourceId, title, text }) => ({ sourceId, title, text })), previousHighlights });
    this.store.transaction(() => {
      this.assertCurrent(context, parts);
      this.publish(result, context, profile, job, parts);
      for (const part of parts) {
        const receipt = this.store.require('automation-receipt', part.receiptId);
        this.store.put('automation-receipt', { ...receipt, analysisKey: this.analysisKey(context), offset: part.offset + part.length }, receipt.id);
      }
      this.store.put('automation-call', { ...this.store.require('automation-call', job.id), status: 'complete' }, job.id);
      this.saveState({ lastSuccessAt: this.clock().toISOString(), lastError: null, errorContext: null, lastErrorStage: null });
    });
  }

  references(evidence) {
    return evidence.map(item => ({ ...this.sources.ref(this.store.require('source', item.sourceId)), excerpt: item.quote }));
  }

  practiceForFocus(focus) {
    const context = this.context();
    if (!focus?.practiceId || focus.profileRevision !== context.profileRevision || focus.scopeRevision !== context.scopeRevision || focus.modelConfigKey !== context.modelKey) return null;
    const practice = this.store.get('practice', focus.practiceId);
    if (!practice?.sourceRefs?.length || practice.provenance?.profileRevision !== context.profileRevision || !this.domain.profile().goals.includes(practice.goal)) return null;
    return practice.sourceRefs.every(ref => this.store.get('source', ref.sourceId)?.contentDigest === ref.contentDigest) ? practice : null;
  }

  practiceForToday() {
    const context = this.context();
    const focuses = this.store.all('focus-artifact').filter(item => item.date === this.date() && item.profileRevision === context.profileRevision
      && item.scopeRevision === context.scopeRevision && item.modelConfigKey === context.modelKey && item.practiceId);
    for (const focus of focuses) {
      const practice = this.practiceForFocus(focus);
      if (practice) return practice;
    }
    return null;
  }

  createPractice(exercise, goal, refs, profile, mode) {
    const existing = this.practiceForToday();
    if (existing) return existing;
    const recordId = `practice_auto_${digest([this.date(), profile.revision, this.collector.scope().revision,
      this.modelKey(), refs.map(ref => [ref.sourceId, ref.contentDigest])]).slice(0, 40)}`;
    return this.store.get('practice', recordId) ?? this.learning.createPractice({ projectId: null, goal, skill: '', sourceRefs: refs, ...exercise },
      { ...this.learning.provenance(mode, refs, profile), generatedAt: this.clock().toISOString() }, recordId);
  }

  publish(result, context, profile, job, parts) {
    const known = new Set(this.highlightHistory().map(highlightKey));
    const all = result.highlights.map(item => {
      const fields = { title: item.title, summary: item.summary, goal: profile.goals[item.goalIndex], whyRelevant: item.whyRelevant, sourceRefs: this.references(item.evidence) };
      return { id: `highlight_${highlightKey(fields).slice(0, 40)}`, ...fields };
    });
    const highlights = all.filter(item => { const key = highlightKey(item); if (known.has(key)) return false; known.add(key); return true; });
    if (!highlights.length && this.currentFocus()?.highlights.length) return;
    const refs = all.flatMap(item => item.sourceRefs).filter((ref, index, values) => values.findIndex(item => item.sourceId === ref.sourceId) === index);
    let practice = this.practiceForToday();
    if (!practice && result.exercise) {
      const { highlightIndex, ...exercise } = result.exercise;
      practice = this.createPractice(exercise, all[highlightIndex].goal, all[highlightIndex].sourceRefs, profile, 'model');
    }
    this.store.put('focus-artifact', { date: this.date(), timeZone: profile.timeZone, profileRevision: context.profileRevision,
      scopeRevision: context.scopeRevision, modelConfigKey: context.modelKey, highlights, practiceId: practice?.id ?? null,
      sourceDigests: parts.map(part => ({ sourceId: part.sourceId, contentDigest: part.contentDigest })),
      provenance: { ...this.learning.provenance('model', refs, profile), generatedAt: this.clock().toISOString() }, generatedAt: this.clock().toISOString() }, `focus_${digest(job.id).slice(0, 40)}`);
  }

  reuseDailyFocus() {
    let focus = this.currentFocus(); const profile = this.domain.profile(); const date = this.date();
    if (!focus?.highlights.length) return;
    if (focus.date !== date) focus = this.nextDayFocus(date);
    if (!focus?.highlights.length) return;
    const refs = focus.highlights[0].sourceRefs; const budget = Math.min(10, profile.dailyBudgetMinutes);
    if (focus.date === date && (!budget || this.practiceForFocus(focus))) return;
    const practice = budget ? this.createPractice({ kind: 'new_scenario', prompt: `目标：${focus.highlights[0].goal}\n请不看材料，用自己的话解释“${focus.highlights[0].title}”，给出一个新的应用例子和一种可检查依据。`, estimatedMinutes: budget,
      rubric: [{ label: '独立解释', description: '用自己的表达说明理由，明确未知之处。', expectedEvidence: ['自己的解释'] },
        { label: '应用与检查', description: '给出新例子以及可执行的检查。', expectedEvidence: ['新例子', '检查方式'] }] }, focus.highlights[0].goal, refs, profile, 'template') : null;
    const { id, ownerId, revision, createdAt, updatedAt, ...fields } = focus;
    this.store.put('focus-artifact', { ...fields, date, practiceId: practice?.id ?? null }, `focus_reuse_${digest([date, focus.id, focus.highlights.map(highlightKey)]).slice(0, 36)}`);
  }
}
