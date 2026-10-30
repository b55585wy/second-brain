import { FIELDS, SOURCE_FIELDS } from './dto.mjs';
import { requireValue } from './errors.mjs';
import { onlyFields, text, integer, choice, strings, timeZone, dateString, operationId } from './validation.mjs';
import { referenceUrl } from './sources.mjs';

const localId = value => { requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), '备份本地身份无效。'); };
const externalId = value => text(value, 'externalId', 512);
const nullable = (value, check) => { if (value !== null) check(value); };
const instant = value => { requireValue(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, '备份时间必须为有效 UTC Instant。'); };
const bool = value => requireValue(typeof value === 'boolean', '备份布尔值无效。');
const hash = value => requireValue(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), '备份摘要无效。');
const count = value => integer(value, 'count', 0, Number.MAX_SAFE_INTEGER);
const revision = value => integer(value, 'revision', 1, Number.MAX_SAFE_INTEGER);
const array = (value, check, max = 100) => { requireValue(Array.isArray(value) && value.length <= max, '备份数组无效或超过上限。'); value.forEach(check); };
const shape = (value, fields, optional = []) => {
  onlyFields(value, [...fields, ...optional]);
  requireValue(fields.every(key => Object.hasOwn(value, key)), '备份嵌套字段不完整。');
};

function versioned(value) { revision(value.revision); instant(value.createdAt); instant(value.updatedAt); }
function sourceRef(value) {
  shape(value, SOURCE_FIELDS);
  localId(value.sourceId); externalId(value.externalId); text(value.title, 'source title', 200);
  choice(value.kind, ['codex', 'manual_dialogue', 'siyuan', 'feishu', 'manual'], 'source.kind');
  if (value.url !== null) {
    if (value.kind === 'siyuan') requireValue(typeof value.url === 'string' && /^siyuan:\/\/blocks\/\d{14}-[a-z0-9]{7}$/.test(value.url), '备份 SiYuan 引用无效。');
    else referenceUrl(value.url);
  }
  for (const key of ['threadId', 'messageId', 'documentId', 'blockId']) nullable(value[key], externalId);
  nullable(value.excerpt, item => text(item, 'excerpt', 2000, true)); hash(value.contentDigest);
  nullable(value.role, item => choice(item, ['user', 'assistant'], 'role'));
  nullable(value.occurredAt, instant); instant(value.capturedAt); bool(value.redacted);
}

function evidence(value) {
  shape(value, ['kind', 'id', 'url', 'label']); text(value.label, 'label', 200);
  choice(value.kind, ['source', 'output', 'url'], 'evidence.kind');
  if (value.kind === 'url') { requireValue(value.id === null && value.url !== null, '备份 URL 证据身份无效。'); referenceUrl(value.url); }
  else { localId(value.id); requireValue(value.url === null, '本地证据不得携带 URL。'); }
}

function validation(value) {
  shape(value, ['status', 'method', 'notes', 'evidenceRefs', 'checkedAt', 'checkedBy']);
  choice(value.status, ['unverified', 'supported', 'contradicted', 'mixed'], 'validation.status');
  choice(value.method, ['none', 'user_review', 'source_check', 'executable_evidence'], 'validation.method');
  text(value.notes, 'notes', 10000, true); array(value.evidenceRefs, evidence, 50);
  nullable(value.checkedAt, instant); nullable(value.checkedBy, item => choice(item, ['user'], 'checkedBy'));
  requireValue(value.status === 'unverified' || value.evidenceRefs.length && value.method !== 'none' && value.checkedAt && value.checkedBy === 'user', '备份校验结论缺少用户证据。');
}

function provenance(value) {
  shape(value, ['mode', 'label', 'sourceRefs', 'profileRevision', 'model', 'generatedAt']);
  choice(value.mode, ['manual', 'template', 'model'], 'provenance.mode'); text(value.label, 'label', 2000);
  array(value.sourceRefs, sourceRef, 50); nullable(value.profileRevision, revision); nullable(value.generatedAt, instant);
  nullable(value.model, item => { shape(item, ['provider', 'model']); choice(item.provider, ['openai-compatible'], 'provider'); text(item.model, 'model', 200); });
  requireValue(value.mode !== 'model' || value.model, '模型来源缺少模型标识。');
}

function error(value) {
  shape(value, ['code', 'message'], ['retryable']); text(value.code, 'code', 100); text(value.message, 'message', 4000);
  if (value.retryable !== undefined) bool(value.retryable);
}

function sync(value) {
  shape(value, ['status', 'lastSyncedRevision', 'lastSyncedAt', 'jobId', 'lastError']);
  choice(value.status, ['not_synced', 'pending', 'synced', 'stale', 'uncertain', 'failed'], 'sync.status');
  nullable(value.lastSyncedRevision, revision); nullable(value.lastSyncedAt, instant); nullable(value.jobId, localId); nullable(value.lastError, error);
}

function observation(value) {
  shape(value, ['criterionId', 'finding', 'comment', 'evidenceRefs']); localId(value.criterionId);
  choice(value.finding, ['met', 'partial', 'not_met', 'not_assessed'], 'finding'); text(value.comment, 'comment', 4000, true); array(value.evidenceRefs, evidence, 50);
}

function rubric(value) {
  shape(value, ['id', 'label', 'description', 'expectedEvidence']); localId(value.id); text(value.label, 'label', 200); text(value.description, 'description', 2000);
  strings(value.expectedEvidence, 'expectedEvidence', 10, 500);
}

export function validateProfileFields(value, withVersion = true) {
  shape(value, withVersion ? FIELDS.profile : ['goals', 'careerDirection', 'skills', 'dailyBudgetMinutes', 'timeZone']);
  strings(value.goals, 'goals', 20, 500); strings(value.skills, 'skills', 50, 500); text(value.careerDirection, 'careerDirection', 1000, true);
  integer(value.dailyBudgetMinutes, 'dailyBudgetMinutes', 0, 120); timeZone(value.timeZone);
  if (withVersion) versioned(value);
}

function planItem(value) {
  shape(value, ['id', 'kind', 'title', 'goal', 'skill', 'offsetMinutes', 'estimatedMinutes', 'knowledgeIds', 'practiceId', 'outputId', 'reviewLimit', 'state', 'provenance']);
  localId(value.id); choice(value.kind, ['review', 'practice', 'output'], 'plan item kind'); text(value.title, 'title', 200);
  nullable(value.goal, item => text(item, 'goal', 500, true)); nullable(value.skill, item => text(item, 'skill', 500, true)); count(value.offsetMinutes);
  integer(value.estimatedMinutes, 'estimatedMinutes', 1, 120); array(value.knowledgeIds, localId); nullable(value.practiceId, localId); nullable(value.outputId, localId);
  nullable(value.reviewLimit, item => integer(item, 'reviewLimit', 1, 100)); choice(value.state, ['pending', 'completed', 'blocked'], 'state'); provenance(value.provenance);
  requireValue(value.kind === 'review' ? value.reviewLimit !== null && value.practiceId === null && value.outputId === null : value.reviewLimit === null && (value.kind === 'practice' ? value.practiceId !== null && value.outputId === null : value.outputId !== null && value.practiceId === null), '备份计划项引用不匹配。');
}

export function validateEntity(entity, value) {
  if (entity === 'sources') {
    shape(value, [...SOURCE_FIELDS, 'projectId', 'text', 'revision', 'updatedAt']);
    sourceRef(Object.fromEntries(SOURCE_FIELDS.map(key => [key, value[key]])));
    nullable(value.projectId, localId); nullable(value.text, item => { text(item, 'source text', 1024 * 1024, true); requireValue(Buffer.byteLength(item) <= 1024 * 1024, '来源文本超过上限。'); });
    revision(value.revision); instant(value.updatedAt); return;
  }
  if (entity !== 'jobHistory') {
    const fields = entity === 'attempts' ? [...FIELDS.attempts.filter(key => key !== 'feedback'), 'latestFeedbackId'] : FIELDS[entity];
    shape(value, fields); localId(value.id);
  }
  if (['projects', 'knowledge', 'practices', 'outputs', 'focusArtifacts', 'adviceSelections'].includes(entity)) versioned(value);
  if ('projectId' in value) nullable(value.projectId, localId);
  if ('sourceRefs' in value) array(value.sourceRefs, sourceRef, 50);
  if ('evidenceRefs' in value) array(value.evidenceRefs, evidence, 50);
  switch (entity) {
    case 'adviceSelections':
      localId(value.feedbackId); localId(value.attemptId); nullable(value.outputId, localId); instant(value.selectedAt);
      choice(value.state, ['saved', 'dismissed'], 'state');
      requireValue(value.id === value.feedbackId && (value.state !== 'saved' || value.outputId !== null), '建议选择身份或已保存输出无效。'); break;
    case 'focusArtifacts':
      dateString(value.date); timeZone(value.timeZone); nullable(value.profileRevision, revision); nullable(value.scopeRevision, revision); nullable(value.modelConfigKey, hash);
      nullable(value.practiceId, localId); instant(value.generatedAt); provenance(value.provenance);
      array(value.sourceDigests, item => { shape(item, ['sourceId', 'contentDigest']); localId(item.sourceId); hash(item.contentDigest); }, 18);
      array(value.highlights, item => {
        shape(item, ['id', 'title', 'summary', 'goal', 'whyRelevant', 'sourceRefs']); localId(item.id); text(item.title, 'title', 200);
        text(item.summary, 'summary', 1000); text(item.goal, 'goal', 500); text(item.whyRelevant, 'whyRelevant', 500);
        requireValue(Array.isArray(item.sourceRefs) && item.sourceRefs.length > 0, '重点必须有来源。'); array(item.sourceRefs, sourceRef, 3);
        requireValue(item.sourceRefs.every(ref => value.sourceDigests.some(source => source.sourceId === ref.sourceId && source.contentDigest === ref.contentDigest)), '重点来源摘要不匹配。');
      }, 3); break;
    case 'profileRevisions': revision(value.profileRevision); validateProfileFields(value.values, false); instant(value.changedAt); choice(value.actor, ['user', 'import', 'initialization'], 'actor'); break;
    case 'projects': text(value.title, 'title', 200); text(value.goal, 'goal', 2000, true); choice(value.status, ['active', 'maintenance', 'paused', 'archived'], 'status'); break;
    case 'checkpoints': localId(value.projectId); for (const key of ['progress', 'nextAction', 'openQuestion']) text(value[key], key, 4000, true); instant(value.createdAt); break;
    case 'knowledge':
      text(value.question, 'question', 2000); text(value.answer, 'answer', 20000); choice(value.status, ['draft', 'accepted', 'rejected', 'needs_recheck', 'archived'], 'status');
      choice(value.origin, ['manual', 'codex', 'manual_dialogue', 'siyuan', 'feishu', 'backup'], 'origin'); nullable(value.siyuanBlockId, externalId); validation(value.validation); sync(value.sync);
      nullable(value.lastDecision, item => { shape(item, ['action', 'actor', 'operationId', 'at']); choice(item.action, ['accept', 'reject'], 'action'); choice(item.actor, ['user'], 'actor'); operationId(item.operationId); instant(item.at); }); break;
    case 'practices':
      choice(value.kind, ['explanation', 'new_scenario', 'artifact'], 'kind'); choice(value.status, ['open', 'completed'], 'status'); text(value.goal, 'goal', 500); text(value.skill, 'skill', 500, true); text(value.prompt, 'prompt', 10000);
      integer(value.estimatedMinutes, 'estimatedMinutes', 1, 120); requireValue(value.rubric?.length >= 1, 'rubric 不能为空。'); array(value.rubric, rubric, 10); requireValue(new Set(value.rubric.map(item => item.id)).size === value.rubric.length, 'rubric 身份重复。'); provenance(value.provenance); break;
    case 'attempts': {
      localId(value.practiceId); text(value.output, 'output', 100000); choice(value.assistanceLevel, ['none', 'hint', 'partial', 'full', 'unknown'], 'assistanceLevel'); instant(value.submittedAt); nullable(value.latestFeedbackId, localId);
      let bytes = 0;
      array(value.evidenceSnapshots, item => { shape(item, ['reference', 'revision', 'digest', 'text', 'capturedAt']); evidence(item.reference); nullable(item.revision, revision); nullable(item.digest, hash); nullable(item.text, content => { text(content, 'snapshot text', 20000, true); bytes += Buffer.byteLength(content); }); instant(item.capturedAt); }, 50);
      requireValue(bytes <= 1024 * 1024, '证据快照过大。'); break;
    }
    case 'feedback': localId(value.attemptId); choice(value.mode, ['manual', 'template', 'model'], 'mode'); choice(value.basis, ['user_judgment', 'deterministic_checklist', 'model_suggestion'], 'basis'); text(value.summary, 'summary', 4000); array(value.observations, observation, 10); strings(value.nextActions, 'nextActions', 10, 2000); strings(value.limitations, 'limitations', 10, 2000); provenance(value.provenance); instant(value.createdAt); break;
    case 'outputs': nullable(value.practiceId, localId); text(value.title, 'title', 200); text(value.goal, 'goal', 500, true); choice(value.status, ['draft', 'final'], 'status'); text(value.content, 'content', 100000, value.status === 'draft'); break;
    case 'plans': {
      versioned(value); dateString(value.date); timeZone(value.timeZone); nullable(value.profileRevision, revision); integer(value.budgetMinutes, 'budgetMinutes', 0, 120); count(value.scheduledMinutes); count(value.unallocatedMinutes); nullable(value.reviewDueCount, count);
      choice(value.status, ['ready', 'completed', 'blocked', 'stale'], 'status'); array(value.items, planItem); array(value.notices, item => { shape(item, ['code', 'message']); text(item.code, 'code', 100); text(item.message, 'message', 4000); }); nullable(value.generationJobId, localId);
      let offset = 0; for (const item of value.items) { requireValue(item.offsetMinutes === offset, '计划偏移不连续。'); offset += item.estimatedMinutes; }
      requireValue(offset === value.scheduledMinutes && offset <= value.budgetMinutes && value.unallocatedMinutes === value.budgetMinutes - offset, '计划估时不符合预算。'); break;
    }
    case 'reviewSessions': nullable(value.deckId, externalId); integer(value.limit, 'limit', 1, 100); integer(value.reviewedCount, 'reviewedCount', 0, value.limit); choice(value.status, ['active', 'completed', 'blocked', 'uncertain'], 'status'); nullable(value.pendingJobId, localId); nullable(value.lastResponseId, localId); instant(value.createdAt); instant(value.updatedAt); break;
    case 'reviewResponses':
      for (const key of ['sessionId', 'presentationId', 'knowledgeId']) localId(value[key]); externalId(value.cardId); choice(value.rating, ['again', 'hard', 'good', 'easy'], 'rating'); integer(value.elapsedMs, 'elapsedMs', 0, 3600000); operationId(value.operationId); choice(value.status, ['confirmed'], 'status'); instant(value.committedAt);
      shape(value.riffEvidence, ['method', 'externalResponseId', 'checkedAt']); choice(value.riffEvidence.method, ['response', 'read_after_write'], 'method'); nullable(value.riffEvidence.externalResponseId, externalId); instant(value.riffEvidence.checkedAt); break;
    case 'jobHistory':
      shape(value, ['id', 'type', 'trigger', 'status', 'commitState', 'operationId', 'progress', 'createdAt', 'updatedAt', 'finishedAt', 'error']); localId(value.id); choice(value.type, ['codex_sync', 'manual_dialogue_import', 'source_import', 'knowledge_sync', 'daily_plan_generate', 'practice_feedback', 'answer_advice', 'feishu_card_action', 'review_response', 'reconcile', 'learning_automation'], 'type'); choice(value.trigger, ['user', 'scheduler', 'recovery', 'automatic'], 'trigger');
      choice(value.status, ['queued', 'running', 'succeeded', 'failed', 'blocked', 'uncertain', 'cancelled'], 'status'); choice(value.commitState, ['not_applicable', 'not_started', 'may_have_committed', 'confirmed', 'not_committed'], 'commitState'); operationId(value.operationId);
      shape(value.progress, ['completed', 'total', 'unit']); count(value.progress.completed); nullable(value.progress.total, count); requireValue(value.progress.total === null || value.progress.completed <= value.progress.total, '作业进度无效。'); choice(value.progress.unit, ['threads', 'messages', 'items', 'steps'], 'unit'); instant(value.createdAt); instant(value.updatedAt); nullable(value.finishedAt, instant); nullable(value.error, error); break;
  }
}
