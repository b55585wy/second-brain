import { id, now } from './validation.mjs';
import { publicError, fail } from './errors.mjs';
import { dto } from './dto.mjs';
import { isSiyuanJob } from './siyuan-state.mjs';

const EXTERNAL_WRITES = new Set(['knowledge_sync', 'review_response']);

export class Jobs {
  constructor(store, settings = null) {
    this.store = store; this.settings = settings; this.handlers = new Map(); this.workerId = id(); this.running = new Set(); this.stopped = true;
  }

  register(kind, handler) { this.handlers.set(kind, handler); }

  enqueue(kind, payload, operationId, scope = kind) {
    const prior = this.store.all('job').find(job => job.operationId === operationId);
    if (prior) return { jobId: prior.id, operationId };
    const pending = this.store.all('job').filter(job => ['queued', 'running', 'uncertain'].includes(job.status));
    if (pending.length >= 100) fail(429, 'RATE_LIMITED', '本地作业队列已满。', true);
    const overlap = pending.find(job => job.scope === scope);
    if (overlap) fail(409, overlap.status === 'uncertain' ? 'RECONCILIATION_REQUIRED' : 'JOB_OVERLAP', '同一范围已有未结束的作业。');
    if (this.settings && isSiyuanJob({ kind, payload })) payload = { ...payload, connectionEpoch: this.settings.siyuan().connectionEpoch };
    const job = this.store.put('job', { kind, payload, operationId, scope, status: 'queued', result: null, error: null,
      trigger: payload.trigger ?? 'user', parentJobId: payload.originalJobId ?? null, commitState: EXTERNAL_WRITES.has(kind) ? 'not_started' : 'not_applicable',
      startedAt: null, finishedAt: null, leaseOwner: null, leaseUntil: null, attempts: 0,
      progress: { completed: 0, total: 1, message: '等待处理' } });
    if (!this.stopped) setImmediate(() => this.pump());
    return { jobId: job.id, operationId };
  }

  public(jobId) {
    const job = this.store.require('job', jobId);
    return { id: job.id, type: job.kind, trigger: job.trigger, status: job.status, commitState: job.commitState,
      operationId: job.operationId, parentJobId: job.parentJobId, progress: { completed: job.progress.completed, total: job.progress.total, unit: 'steps' },
      attemptCount: job.attempts, createdAt: job.createdAt, startedAt: job.startedAt, updatedAt: job.updatedAt,
      finishedAt: job.finishedAt, error: job.error, result: job.result };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.recover();
    this.timer = setInterval(() => {
      if (this.stopped) return;
      for (const job of this.store.all('job')) {
        if (job.status === 'running' && job.leaseOwner === this.workerId) this.store.put('job', { ...job, leaseUntil: Date.now() + 30000 });
      }
      this.recover(); this.pump();
    }, 1000);
    this.timer.unref();
    setImmediate(() => this.pump());
  }

  recover() {
    for (const job of this.store.all('job')) {
      if (job.status !== 'running' || job.leaseOwner === this.workerId || job.leaseUntil > Date.now()) continue;
      if (job.kind === 'review_response') {
        const write = this.store.get('review-write', job.payload.presentationId);
        const receipt = write?.state === 'confirmed' && write.responseId ? this.store.get('review-response', write.responseId) : null;
        if (receipt?.operationId === job.operationId) {
          this.store.put('job', { ...job, status: 'succeeded', commitState: 'confirmed', result: { kind: 'review_response', response: dto('reviewResponses', receipt) },
            error: null, finishedAt: now(), leaseOwner: null, leaseUntil: null, progress: { completed: 1, total: 1, message: '已恢复确认凭据' } });
          continue;
        }
      }
      if (job.kind === 'knowledge_sync') {
        const target = this.store.get('sync-target', job.payload.knowledgeId);
        if (target?.confirmedJobId === job.id && target.receipt) {
          this.store.put('job', { ...job, status: 'succeeded', commitState: 'confirmed', result: { kind: 'knowledge_sync', ...target.receipt },
            error: null, finishedAt: now(), leaseOwner: null, leaseUntil: null, progress: { completed: 1, total: 1, message: '已恢复同步凭据' } });
          continue;
        }
      }
      const uncertain = EXTERNAL_WRITES.has(job.kind) && job.commitState === 'may_have_committed';
      this.store.put('job', { ...job, status: uncertain ? 'uncertain' : 'queued', leaseOwner: null, leaseUntil: null,
        error: uncertain ? { code: 'RECONCILIATION_REQUIRED', message: '上次进程退出时，远端提交状态未知。', retryable: false } : null });
      if (uncertain && job.kind === 'review_response') {
        const session = this.store.get('review-session', job.payload.sessionId);
        if (session) this.store.put('review-session', { ...session, status: 'uncertain', pendingJobId: job.id });
      }
    }
  }

  pump() {
    if (this.stopped || this.running.size) return;
    const job = this.store.transaction(() => {
      const next = this.store.all('job').filter(item => item.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
      if (!next) return null;
      return this.store.put('job', { ...next, status: 'running', startedAt: now(), attempts: next.attempts + 1, leaseOwner: this.workerId, leaseUntil: Date.now() + 30000 });
    });
    if (!job) return;
    const work = this.run(job);
    this.running.add(work);
    work.finally(() => { this.running.delete(work); if (!this.stopped) setImmediate(() => this.pump()); });
  }

  async run(job) {
    if (this.settings && isSiyuanJob(job)) {
      try {
        if (this.store.require('job', job.id).status === 'cancelled') return;
        if (EXTERNAL_WRITES.has(job.kind) && job.commitState === 'may_have_committed') fail(409, 'RECONCILIATION_REQUIRED', '已有可能提交的记录，禁止重新发送。');
        this.settings.assertSiyuanEpoch(job.payload.connectionEpoch);
      } catch (error) {
        const uncertain = EXTERNAL_WRITES.has(job.kind) && (job.commitState === 'may_have_committed' || error.code === 'RECONCILIATION_REQUIRED');
        this.store.put('job', { ...this.store.require('job', job.id), status: uncertain ? 'uncertain' : 'cancelled',
          commitState: uncertain ? 'may_have_committed' : job.commitState, finishedAt: uncertain ? null : now(),
          leaseOwner: null, leaseUntil: null, error: publicError(error).body.error });
        return;
      }
    }
    try {
      const handler = this.handlers.get(job.kind);
      if (!handler) fail(503, 'CAPABILITY_UNSUPPORTED', '该作业类型当前不可执行。');
      if (EXTERNAL_WRITES.has(job.kind)) this.store.put('job', { ...this.store.require('job', job.id), commitState: 'may_have_committed' });
      const result = await handler(job.payload, job);
      const current = this.store.require('job', job.id);
      this.store.put('job', { ...current, status: 'succeeded', commitState: EXTERNAL_WRITES.has(job.kind) ? 'confirmed' : 'not_applicable', result: { kind: job.kind, ...result }, error: null, finishedAt: now(), leaseOwner: null, leaseUntil: null,
        progress: { completed: 1, total: 1, message: '处理完成' } });
    } catch (error) {
      const current = this.store.require('job', job.id);
      const uncertain = EXTERNAL_WRITES.has(job.kind) && (error.uncertain || error.code === 'REVIEW_COMMIT_UNCERTAIN' || error.code === 'RECONCILIATION_REQUIRED');
      this.store.put('job', { ...current, status: uncertain ? 'uncertain' : 'failed', commitState: uncertain ? 'may_have_committed' : EXTERNAL_WRITES.has(job.kind) ? 'not_committed' : 'not_applicable', error: publicError(error).body.error,
        finishedAt: uncertain ? null : now(), leaseOwner: null, leaseUntil: null });
      if (job.kind === 'knowledge_sync') {
        const record = this.store.get('knowledge', job.payload.knowledgeId);
        if (record) this.store.put('knowledge', { ...record, sync: { ...record.sync, status: uncertain ? 'uncertain' : 'failed', lastError: publicError(error).body.error } });
      }
      if (job.kind === 'review_response' && !uncertain) {
        const session = this.store.get('review-session', job.payload.sessionId);
        const presentation = this.store.get('review-presentation', job.payload.presentationId);
        const write = this.store.get('review-write', job.payload.presentationId);
        if (session) this.store.put('review-session', { ...session, status: 'active', pendingJobId: null });
        if (presentation) this.store.put('review-presentation', { ...presentation, jobId: null });
        if (write) this.store.put('review-write', { ...write, state: 'failed' });
      }
    }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.running]);
  }
}
