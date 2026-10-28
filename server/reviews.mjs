import { id, now, integer, choice, text, onlyFields } from './validation.mjs';
import { ApiError, fail, requireValue } from './errors.mjs';

export class Reviews {
  constructor(store, domain, siyuan, jobs, learning) {
    this.store = store; this.domain = domain; this.siyuan = siyuan; this.jobs = jobs; this.learning = learning;
  }

  public(session) {
    const result = {};
    for (const key of ['id', 'projectId', 'deckId', 'limit', 'reviewedCount', 'status', 'pendingJobId', 'lastResponseId', 'createdAt', 'updatedAt']) result[key] = session[key];
    return result;
  }

  eligible(cards, projectId) {
    const knowledge = this.store.all('knowledge').filter(item => item.status === 'accepted' && item.sync.status === 'synced' && (!projectId || item.projectId === projectId));
    const owned = this.store.get('config', 'siyuan-owned');
    return cards.filter(card => card.deckID === owned?.deckId).map(card => ({ card, knowledge: knowledge.find(item => item.siyuanBlockId === card.blockID) })).filter(item => item.knowledge);
  }

  presentationState(session) {
    const presentation = this.store.get('review-presentation', session.presentationId);
    const write = this.store.all('review-write').find(item => item.deckId === session.deckId && ['queued', 'inflight', 'uncertain'].includes(item.state));
    const jobId = session.pendingJobId ?? presentation?.jobId ?? write?.jobId;
    if (jobId || session.status === 'uncertain' || write) {
      const job = this.store.get('job', jobId);
      return { session, presentation, locked: true, jobId, uncertain: session.status === 'uncertain' || job?.status === 'uncertain' || write?.state === 'uncertain' };
    }
    if (!presentation || !['presented', 'revealed', 'blocked'].includes(presentation.status)) return { session, presentation: null };
    const knowledge = this.store.get('knowledge', presentation.knowledgeId);
    if (['presented', 'revealed'].includes(presentation.status) && knowledge?.status === 'accepted' && knowledge.sync?.status === 'synced' && knowledge.revision === presentation.knowledgeRevision) {
      return { session: session.status === 'blocked' ? this.store.put('review-session', { ...session, status: 'active' }) : session, presentation };
    }
    this.store.put('review-presentation', { ...presentation, status: 'stale' });
    return { session: this.store.put('review-session', { ...session, status: 'blocked', presentationId: null }), presentation: null };
  }

  async create(body) {
    const epoch = this.siyuan.epoch();
    onlyFields(body, ['projectId', 'limit']);
    const projectId = body.projectId === null ? null : text(body.projectId, 'projectId', 128);
    this.domain.project(projectId);
    const limit = integer(body.limit ?? 10, 'limit', 1, 100);
    const previous = this.store.all('review-session').filter(item => item.connectionEpoch === epoch && item.projectId === projectId && ['active', 'blocked', 'uncertain'].includes(item.status))
      .map(item => this.presentationState(item));
    const reusable = previous.find(item => item.locked) ?? previous.find(item => item.session.status === 'active');
    if (reusable) return { session: this.public(reusable.session), reused: true };
    const due = await this.siyuan.dueCards([], epoch);
    this.siyuan.assertEpoch(epoch);
    const owned = this.store.get('config', 'siyuan-owned');
    const session = this.store.put('review-session', { projectId, deckId: owned?.deckId ?? null, limit, connectionEpoch: epoch,
      reviewedCount: 0, status: 'active', pendingJobId: null, lastResponseId: null, presentationId: null });
    if (!this.eligible(due.cards, projectId).length) {
      return { session: this.public(this.store.put('review-session', { ...session, status: 'completed', emptyReason: 'no_due_cards' })), reused: false };
    }
    return { session: this.public(session), reused: false };
  }

  async next(sessionId) {
    const original = this.store.require('review-session', sessionId);
    if (original.emptyReason === 'connection_changed') return { state: 'empty', session: this.public(original), reason: 'connection_changed' };
    this.siyuan.assertEpoch(original.connectionEpoch);
    const state = this.presentationState(this.store.require('review-session', sessionId));
    let session = state.session;
    if (state.locked) return { state: state.uncertain ? 'uncertain' : 'rating_pending', session: this.public(session), jobId: state.jobId };
    if (session.status === 'completed') return { state: 'empty', session: this.public(session), reason: session.emptyReason ?? 'session_limit_reached' };
    let presentation = state.presentation;
    if (!presentation) {
      const reviewedCards = this.store.all('review-response').filter(item => item.sessionId === sessionId).map(item => ({ cardID: item.cardId }));
      const due = await this.siyuan.dueCards(reviewedCards, session.connectionEpoch);
      this.siyuan.assertEpoch(session.connectionEpoch);
      const eligible = this.eligible(due.cards, session.projectId);
      if (!eligible.length) {
        if (session.status === 'blocked') return { state: 'blocked', session: this.public(session), failure: { code: 'INVALID_STATE', message: '知识已变化，请先重新审核并同步。', retryable: false } };
        session = this.store.put('review-session', { ...session, status: 'completed', emptyReason: 'no_due_cards' });
        return { state: 'empty', session: this.public(session), reason: 'no_due_cards' };
      }
      const { card, knowledge } = eligible[0];
      presentation = this.store.put('review-presentation', { sessionId, connectionEpoch: session.connectionEpoch, cardId: card.cardID, knowledgeId: knowledge.id, knowledgeRevision: knowledge.revision,
        question: knowledge.question, status: 'presented', baseline: card, jobId: null });
      session = this.store.put('review-session', { ...session, status: 'active', presentationId: presentation.id });
    }
    const knowledge = this.store.get('knowledge', presentation.knowledgeId);
    if (!knowledge || knowledge.status !== 'accepted' || knowledge.sync?.status !== 'synced' || knowledge.revision !== presentation.knowledgeRevision) {
      session = this.presentationState(session).session;
      return { state: 'blocked', session: this.public(session), failure: { code: 'INVALID_STATE', message: '知识已变化，请先重新审核。', retryable: false } };
    }
    return { state: 'question', session: this.public(session), card: { presentationId: presentation.id, cardId: presentation.cardId,
      knowledgeId: presentation.knowledgeId, question: presentation.question, revealed: presentation.status === 'revealed' } };
  }

  current(sessionId, body) {
    const session = this.store.require('review-session', sessionId);
    this.siyuan.assertEpoch(session.connectionEpoch);
    const presentation = this.store.get('review-presentation', body.presentationId);
    if (!presentation || presentation.sessionId !== sessionId || presentation.id !== session.presentationId || presentation.cardId !== body.cardId) fail(409, 'INVALID_STATE', '卡片或呈现身份已经过期。');
    return { session, presentation };
  }

  reveal(sessionId, body) {
    onlyFields(body, ['presentationId', 'cardId']);
    const { session, presentation } = this.current(sessionId, body);
    if (session.status !== 'active' || session.pendingJobId || !['presented', 'revealed'].includes(presentation.status)) fail(409, 'INVALID_STATE', '当前不能揭示此卡片。');
    const knowledge = this.store.require('knowledge', presentation.knowledgeId);
    if (knowledge.status !== 'accepted' || knowledge.revision !== presentation.knowledgeRevision) fail(409, 'INVALID_STATE', '知识已变化，请先审核。');
    this.store.put('review-presentation', { ...presentation, status: 'revealed' });
    return { session: this.public(session), presentationId: presentation.id, cardId: presentation.cardId, knowledgeId: knowledge.id,
      question: presentation.question, answer: knowledge.answer, sourceRefs: knowledge.sourceRefs, validation: knowledge.validation };
  }

  queueResponse(sessionId, body, operationId) {
    this.siyuan.assertEpoch(this.store.require('review-session', sessionId).connectionEpoch);
    onlyFields(body, ['presentationId', 'cardId', 'rating', 'elapsedMs', 'answer']);
    const rating = choice(body.rating, ['again', 'forgot', 'hard', 'good', 'easy'], 'rating') === 'forgot' ? 'again' : body.rating;
    const elapsedMs = integer(body.elapsedMs ?? 0, 'elapsedMs', 0, 3600000);
    if (body.answer !== undefined) text(body.answer, 'answer', 100000, true);
    const priorPresentation = this.store.get('review-presentation', body.presentationId);
    if (priorPresentation?.sessionId === sessionId && priorPresentation.cardId === body.cardId && priorPresentation.jobId) {
      if (priorPresentation.rating !== rating || priorPresentation.elapsedMs !== elapsedMs) fail(409, 'INVALID_STATE', '该呈现已经提交另一评分。');
      return { jobId: priorPresentation.jobId, operationId: this.store.require('job', priorPresentation.jobId).operationId };
    }
    const { session, presentation } = this.current(sessionId, body);
    if (presentation.jobId) {
      if (presentation.rating !== rating || presentation.elapsedMs !== elapsedMs) fail(409, 'INVALID_STATE', '该呈现已经提交另一评分。');
      return { jobId: presentation.jobId, operationId: this.store.require('job', presentation.jobId).operationId };
    }
    if (session.status !== 'active' || presentation.status !== 'revealed') fail(409, 'INVALID_STATE', '必须先揭示当前答案才能提交记忆自评。');
    const lock = this.store.all('review-write').find(item => item.deckId === presentation.baseline.deckID && ['queued', 'inflight', 'uncertain'].includes(item.state));
    if (lock) fail(409, 'REVIEW_COMMIT_UNCERTAIN', '该卡片已有未确认的评分，禁止重复提交。');
    const ack = this.jobs.enqueue('review_response', { sessionId, presentationId: presentation.id, rating, elapsedMs, answer: body.answer ?? null }, operationId, `riff:${presentation.baseline.deckID}:${presentation.cardId}`);
    this.store.put('review-write', { deckId: presentation.baseline.deckID, cardId: presentation.cardId, connectionEpoch: session.connectionEpoch, state: 'queued', baseline: presentation.baseline, jobId: ack.jobId, operationId }, presentation.id);
    this.store.put('review-presentation', { ...presentation, jobId: ack.jobId, rating, elapsedMs });
    this.store.put('review-session', { ...session, pendingJobId: ack.jobId });
    return ack;
  }

  async grade(payload, job) {
    this.siyuan.assertEpoch(payload.connectionEpoch);
    let session = this.store.require('review-session', payload.sessionId);
    const presentation = this.store.require('review-presentation', payload.presentationId);
    const knowledge = this.store.require('knowledge', presentation.knowledgeId);
    if (knowledge.status !== 'accepted' || knowledge.revision !== presentation.knowledgeRevision) fail(409, 'INVALID_STATE', '知识已变化，评分未发送。');
    const write = this.store.require('review-write', presentation.id);
    if (write.state !== 'queued') fail(409, 'REVIEW_COMMIT_UNCERTAIN', '该评分已有发送记录，不会自动重放。');
    await this.siyuan.compatible(payload.connectionEpoch);
    const reviewedCards = this.store.all('review-response').filter(item => item.sessionId === session.id).map(item => ({ cardID: item.cardId }));
    const due = await this.siyuan.dueCards(reviewedCards, payload.connectionEpoch);
    this.siyuan.assertEpoch(payload.connectionEpoch);
    const native = due.cards.find(card => card.cardID === presentation.cardId && card.deckID === presentation.baseline.deckID);
    if (!native || native.reps !== presentation.baseline.reps || native.lastReview !== presentation.baseline.lastReview) {
      this.store.put('review-presentation', { ...presentation, status: 'stale', jobId: null });
      fail(409, 'INVALID_STATE', '原生 SiYuan 卡片状态已经变化，请重新获取问题再自评。');
    }
    this.store.put('review-write', { ...write, state: 'inflight', sentAt: now() });
    let sent = true;
    try {
      const result = await this.siyuan.grade(presentation.baseline, payload.rating, [...reviewedCards, { cardID: presentation.cardId }], payload.connectionEpoch);
      if (result !== null) fail(502, 'UPSTREAM_ERROR', '固定 Riff 评分响应不兼容，提交状态待核对。');
      return this.store.transaction(() => {
        this.siyuan.assertEpoch(payload.connectionEpoch);
        const response = this.store.put('review-response', { sessionId: session.id, presentationId: presentation.id, cardId: presentation.cardId,
          knowledgeId: knowledge.id, rating: payload.rating, elapsedMs: payload.elapsedMs, operationId: job.operationId, status: 'confirmed', committedAt: now(),
          riffEvidence: { method: 'response', externalResponseId: null, checkedAt: now() } });
        session = this.store.require('review-session', session.id);
        const reviewedCount = session.reviewedCount + 1;
        this.store.put('review-session', { ...session, reviewedCount, status: reviewedCount >= session.limit ? 'completed' : 'active', pendingJobId: null, lastResponseId: response.id, presentationId: null });
        this.store.put('review-presentation', { ...presentation, status: 'confirmed', jobId: job.id, rating: payload.rating, elapsedMs: payload.elapsedMs });
        this.store.put('review-write', { ...write, state: 'confirmed', jobId: job.id, responseId: response.id });
        this.learning.finishItems(item => item.kind === 'review' && item.reviewLimit <= reviewedCount);
        return { responseId: response.id, sessionId: session.id, response };
      });
    } catch (error) {
      // A transport failure after sending is not proof of a failed native write.
      const uncertain = sent && !['UPSTREAM_UNAUTHORIZED', 'UPSTREAM_FORBIDDEN', 'SCOPE_FORBIDDEN'].includes(error.code);
      this.store.put('review-write', { ...write, state: uncertain ? 'uncertain' : 'failed', jobId: job.id });
      this.store.put('review-session', { ...this.store.require('review-session', session.id), status: uncertain ? 'uncertain' : 'active', pendingJobId: uncertain ? job.id : null });
      if (uncertain) throw new ApiError(409, 'REVIEW_COMMIT_UNCERTAIN', '评分可能已提交，必须核对原生 SiYuan；不会重复发送。');
      this.store.put('review-presentation', { ...presentation, jobId: null });
      throw error;
    }
  }

  async reconcile(jobId) {
    const job = this.store.require('job', jobId);
    if (job.kind !== 'review_response' || job.status !== 'uncertain') fail(409, 'INVALID_STATE', '仅能核对待确认的评分作业。');
    const presentation = this.store.require('review-presentation', job.payload.presentationId);
    const data = await this.siyuan.dueCards([], job.payload.connectionEpoch);
    this.siyuan.assertEpoch(job.payload.connectionEpoch);
    const observed = data.cards.find(card => card.cardID === presentation.cardId && card.deckID === presentation.baseline.deckID);
    const reconciliation = { checkedAt: now(), baseline: { reps: presentation.baseline.reps, lastReview: presentation.baseline.lastReview },
      observed: observed ? { reps: observed.reps, lastReview: observed.lastReview } : null,
      commitProven: false, reason: '原生到期 API 不提供可关联 operationId 的提交凭据；次数或时间变化不能证明该操作。保持锁定，请检查 SiYuan。' };
    this.store.put('job', { ...job, reconciliation });
    return this.jobs.public(jobId);
  }
}
