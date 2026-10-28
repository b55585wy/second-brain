import { id, now } from './validation.mjs';
import { fail } from './errors.mjs';
import { NOT_SYNCED } from './sources.mjs';

export const isSiyuanJob = job => ['knowledge_sync', 'review_response'].includes(job.kind)
  || job.kind === 'source_import' && ['siyuan_block', 'siyuan_document'].includes(job.payload.kind);

function assertSwitchable(store) {
  const pendingWrite = store.all('job').some(job => ['knowledge_sync', 'review_response'].includes(job.kind)
    && (['running', 'uncertain'].includes(job.status) || job.commitState === 'may_have_committed'));
  const lockedReview = store.all('review-write').some(write => ['inflight', 'uncertain'].includes(write.state)
    || write.state === 'queued' && store.get('job', write.jobId)?.status !== 'queued');
  const owned = store.get('config', 'siyuan-owned');
  if (pendingWrite || lockedReview || store.all('review-session').some(session => session.status === 'uncertain')
    || owned?.notebookCreationPending || owned?.deckCreationPending || store.all('sync-target').some(target => target.creationPending)) {
    fail(409, 'RECONCILIATION_REQUIRED', '原 SiYuan 存在执行中或提交状态未知的写入，保留连接和凭据，请先核对。');
  }
}

function resetBindings(store, previous) {
  const owned = store.get('config', 'siyuan-owned');
  const targets = store.all('sync-target');
  const knowledge = store.all('knowledge').filter(record => record.siyuanBlockId || record.sync?.status !== 'not_synced');
  const select = (record, fields) => record ? Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => [key, record[key]])) : null;
  store.put('siyuan-binding-archive', { connection: { baseUrl: previous.baseUrl, stableId: previous.stableId, epoch: previous.epoch },
    owned: select(owned, ['identity', 'notebookId', 'deckId']),
    targets: targets.map(target => select(target, ['knowledgeId', 'docId', 'cardBlockId', 'cardId', 'path', 'state', 'confirmedJobId', 'receipt'])),
    mappings: knowledge.map(record => ({ knowledgeId: record.id, siyuanBlockId: record.siyuanBlockId,
      sync: select(record.sync, ['status', 'lastSyncedRevision', 'lastSyncedAt', 'jobId']) })), archivedAt: now() });
  for (const job of store.all('job').filter(job => isSiyuanJob(job) && job.status === 'queued')) {
    store.put('job', { ...job, status: 'cancelled', finishedAt: now(), leaseOwner: null, leaseUntil: null,
      error: { code: 'INVALID_STATE', message: 'SiYuan 连接已变更，尚未发送的作业已取消。', retryable: false } });
  }
  for (const write of store.all('review-write').filter(write => write.state === 'queued')) store.put('review-write', { ...write, state: 'cancelled' });
  for (const presentation of store.all('review-presentation').filter(item => ['presented', 'revealed', 'blocked'].includes(item.status))) {
    store.put('review-presentation', { ...presentation, status: 'stale' });
  }
  for (const session of store.all('review-session').filter(item => ['active', 'blocked'].includes(item.status))) {
    store.put('review-session', { ...session, status: 'completed', emptyReason: 'connection_changed', presentationId: null, pendingJobId: null });
  }
  store.remove('config', 'siyuan-owned');
  for (const target of targets) store.remove('sync-target', target.id);
  for (const record of knowledge) store.put('knowledge', { ...record, siyuanBlockId: null, sync: { ...NOT_SYNCED } });
}

// Single current binding only; archives are evidence and are never reactivated.
export function selectSiyuanInstance(store, baseUrl, stableId = null) {
  const previous = store.get('config', 'siyuan-instance');
  const changed = previous && (previous.baseUrl !== baseUrl || stableId && previous.stableId && previous.stableId !== stableId);
  if (changed) assertSwitchable(store);
  return store.transaction(() => {
    if (changed) resetBindings(store, previous);
    const selected = store.put('config', { baseUrl, stableId: stableId ?? (previous?.baseUrl === baseUrl ? previous.stableId : null),
      epoch: changed || !previous ? id() : previous.epoch }, 'siyuan-instance');
    if (!previous) {
      // Adopt pre-epoch persisted work without losing its locks or receipts.
      for (const job of store.all('job').filter(isSiyuanJob)) store.put('job', { ...job, payload: { ...job.payload, connectionEpoch: selected.epoch } });
      for (const kind of ['review-session', 'review-presentation', 'review-write']) {
        for (const record of store.all(kind)) store.put(kind, { ...record, connectionEpoch: selected.epoch });
      }
    }
    if (changed) store.remove('config', 'siyuan-check');
    return selected;
  });
}
