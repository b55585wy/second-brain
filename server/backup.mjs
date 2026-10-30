import { FIELDS, SOURCE_FIELDS, dto, select } from './dto.mjs';
import { UNVERIFIED, NOT_SYNCED } from './sources.mjs';
import { id, now, digest, text, onlyFields, integer, expectedRevision, timeZone, dateString } from './validation.mjs';
import { fail, requireValue } from './errors.mjs';
import { validateEntity, validateProfileFields } from './import-schema.mjs';

export const EXPORT_SCHEMA = 'second-brain.export.v1';
const KINDS = {
  profileRevisions: 'profile-revision', projects: 'project', checkpoints: 'checkpoint', sources: 'source', knowledge: 'knowledge',
  practices: 'practice', attempts: 'attempt', feedback: 'feedback', outputs: 'output', plans: 'daily-plan',
  reviewSessions: 'review-session', reviewResponses: 'review-response', jobHistory: 'job-history',
  focusArtifacts: 'focus-artifact',
  adviceSelections: 'advice-selection',
};
const JOB_FIELDS = ['id', 'type', 'trigger', 'status', 'commitState', 'operationId', 'progress', 'createdAt', 'updatedAt', 'finishedAt', 'error'];
const canonical = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  return value;
}
const entityId = (entity, value) => entity === 'sources' ? value.sourceId : value.id;

export class Backup {
  constructor(store, domain, sources, secrets, jobs, version) {
    this.store = store; this.domain = domain; this.sources = sources; this.secrets = secrets; this.jobs = jobs; this.version = version;
  }

  exportRecord(entity, record, includeContent) {
    if (entity === 'sources') return { ...this.sources.ref(record), projectId: record.projectId ?? null, text: includeContent ? record.content : null, revision: record.revision, updatedAt: record.updatedAt };
    if (entity === 'attempts') {
      const { feedback, ...attempt } = dto(entity, record);
      return { ...attempt, latestFeedbackId: feedback?.id ?? null };
    }
    if (entity === 'jobHistory') return select(record.kind ? this.jobs.public(record.id) : record, JOB_FIELDS);
    return dto(entity, record);
  }

  document(body) {
    onlyFields(body, ['scope', 'projectIds', 'includeSourceContent']);
    requireValue(['all', 'projects'].includes(body.scope), 'scope 必须为 all 或 projects。');
    requireValue(Array.isArray(body.projectIds) && body.projectIds.length <= 100, 'projectIds 最多 100 项。');
    requireValue(body.scope === 'all' ? body.projectIds.length === 0 : body.projectIds.length > 0, '导出范围与 projectIds 不匹配。');
    requireValue(body.includeSourceContent === undefined || typeof body.includeSourceContent === 'boolean', 'includeSourceContent 必须为布尔值。');
    for (const projectId of body.projectIds) this.domain.project(projectId);
    const includeContent = body.includeSourceContent ?? false;
    const data = { profile: dto('profile', this.domain.profile()) };
    for (const [entity, kind] of Object.entries(KINDS)) {
      const records = entity === 'jobHistory' ? [...this.store.all('job'), ...this.store.all('job-history')] : this.store.all(kind);
      data[entity] = records.map(record => this.exportRecord(entity, record, includeContent));
    }
    if (body.scope === 'projects') this.filterProjects(data, body.projectIds);
    if (!includeContent) this.removeExcerpts(data);
    let redactionCount = 0;
    const redact = value => {
      if (typeof value === 'string') { const clean = this.secrets.redact(value); if (clean !== value) redactionCount++; return clean; }
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
      return value;
    };
    const cleaned = redact(data);
    const document = { schemaVersion: EXPORT_SCHEMA, productVersion: this.version, exportedAt: now(), sourceContentIncluded: includeContent, redactionCount, data: cleaned };
    this.size(document);
    return document;
  }

  filterProjects(data, projectIds) {
    const selected = Object.fromEntries(Object.keys(KINDS).map(entity => [entity, new Set()]));
    selected.projects = new Set(projectIds);
    for (const entity of ['knowledge', 'practices', 'outputs', 'checkpoints', 'reviewSessions']) {
      for (const record of data[entity]) if (projectIds.includes(record.projectId)) selected[entity].add(entityId(entity, record));
    }
    let changed = true;
    while (changed) {
      changed = false;
      const add = (entity, recordId) => { if (recordId && !selected[entity].has(recordId)) { selected[entity].add(recordId); changed = true; } };
      for (const entity of Object.keys(KINDS)) for (const record of data[entity]) {
        if (entity === 'attempts' && selected.practices.has(record.practiceId)) add(entity, record.id);
        if (entity === 'feedback' && selected.attempts.has(record.attemptId)) add(entity, record.id);
        if (entity === 'adviceSelections' && (selected.attempts.has(record.attemptId) || selected.feedback.has(record.feedbackId))) add(entity, record.id);
        if (entity === 'reviewResponses' && selected.reviewSessions.has(record.sessionId)) add(entity, record.id);
        if (entity === 'plans' && record.items.some(item => selected.practices.has(item.practiceId) || selected.outputs.has(item.outputId) || item.knowledgeIds.some(key => selected.knowledge.has(key)))) add(entity, record.id);
        if (!selected[entity].has(entityId(entity, record))) continue;
        for (const [dependency, dependencyId] of this.dependencies(entity, record)) add(dependency, dependencyId);
      }
    }
    for (const entity of Object.keys(KINDS)) {
      if (entity === 'profileRevisions') continue;
      data[entity] = entity === 'jobHistory' ? [] : data[entity].filter(record => selected[entity].has(entityId(entity, record)));
    }
  }

  dependencies(entity, record) {
    const result = [];
    const add = (kind, recordId) => { if (recordId) result.push([kind, recordId]); };
    add('projects', record.projectId);
    if (entity === 'attempts' || entity === 'outputs') add('practices', record.practiceId);
    if (entity === 'focusArtifacts') add('practices', record.practiceId);
    if (entity === 'feedback') add('attempts', record.attemptId);
    if (entity === 'adviceSelections') { add('feedback', record.feedbackId); add('attempts', record.attemptId); add('outputs', record.outputId); }
    if (entity === 'reviewResponses') { add('reviewSessions', record.sessionId); add('knowledge', record.knowledgeId); }
    const visit = value => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== 'object') return;
      if (value.sourceId) add('sources', value.sourceId);
      if (value.kind === 'source' && value.id) add('sources', value.id);
      if (value.kind === 'output' && value.id) add('outputs', value.id);
      for (const child of Object.values(value)) visit(child);
    };
    // SourceRef.sourceId is this entity's own identity, not a circular foreign key.
    if (entity !== 'sources') visit(record);
    if (entity === 'plans') for (const item of record.items) {
      add('practices', item.practiceId); add('outputs', item.outputId); for (const key of item.knowledgeIds) add('knowledge', key);
    }
    return result;
  }

  removeExcerpts(value) {
    if (!value || typeof value !== 'object') return;
    if ('sourceId' in value && 'excerpt' in value) value.excerpt = null;
    for (const child of Object.values(value)) this.removeExcerpts(child);
  }

  size(document) {
    if (Buffer.byteLength(JSON.stringify(document)) > 9 * 1024 * 1024) fail(413, 'PAYLOAD_TOO_LARGE', '备份超过 9 MiB，请选择项目范围。');
    const count = 1 + Object.values(document.data).filter(Array.isArray).reduce((sum, records) => sum + records.length, 0);
    if (count > 10000) fail(413, 'PAYLOAD_TOO_LARGE', '备份超过 10000 条记录，请选择项目范围。');
  }

  export(body) {
    const document = this.document(body);
    const content = JSON.stringify(document, null, 2);
    if (Buffer.byteLength(content) > 9 * 1024 * 1024) fail(413, 'PAYLOAD_TOO_LARGE', '备份超过 9 MiB。');
    const artifact = { filename: `second-brain-${document.exportedAt.replace(/[-:.]/g, '')}.json`, mediaType: 'application/json', schemaVersion: EXPORT_SCHEMA,
      content, byteLength: Buffer.byteLength(content), sha256: digest(content) };
    const record = this.store.put('export', artifact);
    return { artifact, id: record.id };
  }

  validate(document) {
    onlyFields(document, ['schemaVersion', 'productVersion', 'exportedAt', 'sourceContentIncluded', 'redactionCount', 'data']);
    if (document.schemaVersion !== EXPORT_SCHEMA) fail(422, 'IMPORT_SCHEMA_UNSUPPORTED', '不支持此备份版本。');
    onlyFields(document.data, ['profile', ...Object.keys(KINDS)]);
    for (const entity of ['focusArtifacts', 'adviceSelections']) {
      if (!Object.hasOwn(document.data, entity)) document = { ...document, data: { ...document.data, [entity]: [] } };
    }
    requireValue(Object.keys(document.data).length === 1 + Object.keys(KINDS).length, '备份缺少必要集合。');
    this.size(document);
    const profile = document.data.profile;
    validateProfileFields(profile);
    onlyFields(profile, FIELDS.profile);
    requireValue(FIELDS.profile.every(key => Object.hasOwn(profile, key)), '备份 profile 字段不完整。');
    timeZone(profile.timeZone); integer(profile.dailyBudgetMinutes, 'dailyBudgetMinutes', 0, 120);
    requireValue(Array.isArray(profile.goals) && profile.goals.length <= 20 && profile.goals.every(item => typeof item === 'string' && item.trim() && [...item].length <= 500), '备份目标无效。');
    requireValue(Array.isArray(profile.skills) && profile.skills.length <= 50 && profile.skills.every(item => typeof item === 'string' && item.trim() && [...item].length <= 500), '备份技能无效。');
    text(profile.careerDirection, 'careerDirection', 1000, true);
    const walk = (value, depth = 0) => {
      requireValue(depth <= 40, '备份嵌套过深。');
      if (typeof value === 'number') requireValue(Number.isFinite(value), '备份含无效数字。');
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        requireValue(!['__proto__', 'constructor', 'prototype', 'apiKey', 'appSecret', 'accessToken', 'token', 'tokenFile', 'cookie', 'settings', 'connections', 'payload', 'leaseOwner', 'leaseUntil'].includes(key), '备份含不支持或秘密字段。');
        walk(child, depth + 1);
      }
    };
    walk(document);
    for (const entity of Object.keys(KINDS)) {
      const records = document.data[entity];
      requireValue(Array.isArray(records), `备份 ${entity} 必须是集合。`);
      const fields = entity === 'sources' ? [...SOURCE_FIELDS, 'projectId', 'text', 'revision', 'updatedAt'] : entity === 'attempts' ? [...FIELDS.attempts.filter(key => key !== 'feedback'), 'latestFeedbackId'] : entity === 'jobHistory' ? JOB_FIELDS : FIELDS[entity];
      const ids = new Set();
      for (const record of records) {
        validateEntity(entity, record);
        onlyFields(record, fields);
        requireValue(fields.every(key => Object.hasOwn(record, key)), `备份 ${entity} 字段不完整。`);
        const recordId = entityId(entity, record);
        requireValue(typeof recordId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(recordId) && !ids.has(recordId), '备份实体身份无效或重复。');
        ids.add(recordId);
        if ('revision' in record) integer(record.revision, 'revision', 1, Number.MAX_SAFE_INTEGER);
        if (entity === 'projects') { text(record.title, 'title', 200); text(record.goal, 'goal', 2000, true); requireValue(['active', 'maintenance', 'paused', 'archived'].includes(record.status), '备份项目状态无效。'); }
        if (entity === 'knowledge') {
          text(record.question, 'question', 2000); text(record.answer, 'answer', 20000);
          requireValue(['draft', 'accepted', 'rejected', 'needs_recheck', 'archived'].includes(record.status), '备份知识状态无效。');
        }
        if (entity === 'outputs') { text(record.title, 'title', 200); text(record.content, 'content', 100000, record.status === 'draft'); requireValue(['draft', 'final'].includes(record.status), '备份输出状态无效。'); }
        if (entity === 'attempts') { text(record.output, 'output', 100000); requireValue(['none', 'hint', 'partial', 'full', 'unknown'].includes(record.assistanceLevel), '备份辅助程度无效。'); }
        if (entity === 'plans') { dateString(record.date); timeZone(record.timeZone); requireValue(Array.isArray(record.items), '备份计划无效。'); }
        if (entity === 'sources') {
          requireValue(['codex', 'manual_dialogue', 'siyuan', 'feishu', 'manual'].includes(record.kind) && /^[a-f0-9]{64}$/.test(record.contentDigest), '备份来源无效。');
          requireValue(record.text === null || typeof record.text === 'string' && Buffer.byteLength(record.text) <= 1024 * 1024, '备份来源文本过大或无效。');
        }
      }
    }
    return document;
  }

  import(body) {
    onlyFields(body, ['document', 'mode', 'applyProfile', 'expectedProfileRevision']);
    requireValue(body.mode === 'merge', '导入仅支持 merge。');
    requireValue(body.applyProfile === undefined || typeof body.applyProfile === 'boolean', 'applyProfile 必须为布尔值。');
    const document = this.validate(body.document);
    if (body.applyProfile) expectedRevision(body.expectedProfileRevision, this.domain.profile());
    const data = this.secrets.clean(document.data);
    const report = { id: id(), schemaVersion: EXPORT_SCHEMA, importedAt: now(), counts: Object.fromEntries(['profile', ...Object.keys(KINDS)].map(key => [key, { inserted: 0, skipped: 0, conflicted: 0 }])),
      conflictTotal: 0, conflicts: [], needsRecheck: 0, profileApplied: false, notices: [] };
    const auditKey = digest([body.document, body.applyProfile ?? false]);
    const knownAudit = this.store.get('import-audit', auditKey);
    if (knownAudit) {
      const automation = this.store.get('config', 'learning-automation');
      if (automation?.enabled) this.store.put('config', { ...automation, enabled: false }, 'learning-automation');
      for (const [entity, records] of Object.entries(data)) report.counts[entity].skipped = Array.isArray(records) ? records.length : 1;
      return report;
    }
    const conflict = (entity, recordId, reason) => {
      report.counts[entity].conflicted++; report.conflictTotal++;
      if (report.conflicts.length < 100) report.conflicts.push({ entity, id: recordId, reason });
    };
    return this.store.transaction(() => {
      const automation = this.store.get('config', 'learning-automation');
      if (automation?.enabled) this.store.put('config', { ...automation, enabled: false }, 'learning-automation');
      const profileMap = new Map();
      if (body.applyProfile) {
        for (const record of [...data.profileRevisions].sort((a, b) => a.profileRevision - b.profileRevision)) {
          const previous = this.domain.profile();
          const saved = this.domain.updateProfile(record.values, 'import');
          profileMap.set(record.profileRevision, saved.revision);
          report.counts.profileRevisions[saved.revision === previous.revision ? 'skipped' : 'inserted']++;
        }
        const values = Object.fromEntries(FIELDS.profile.filter(key => !['revision', 'createdAt', 'updatedAt'].includes(key)).map(key => [key, data.profile[key]]));
        const saved = this.domain.updateProfile(values, 'import');
        profileMap.set(data.profile.revision, saved.revision);
        report.profileApplied = true; report.counts.profile.inserted++;
      } else report.counts.profile.skipped++;
      const sourceAliases = new Map();
      const identities = new Map(this.store.all('source').map(record => [canonical([record.kind, record.externalId, record.contentDigest]), record.id]));
      const aliasRecords = new Set();
      for (const source of data.sources) {
        const identity = canonical([source.kind, source.externalId, source.contentDigest]);
        const found = identities.get(identity);
        if (found && found !== source.sourceId) { sourceAliases.set(source.sourceId, found); aliasRecords.add(source.sourceId); }
        else identities.set(identity, source.sourceId);
      }
      const remap = value => {
        if (!value || typeof value !== 'object') return;
        if (value.sourceId && sourceAliases.has(value.sourceId)) value.sourceId = sourceAliases.get(value.sourceId);
        if (value.kind === 'source' && sourceAliases.has(value.id)) value.id = sourceAliases.get(value.id);
        for (const item of Object.values(value)) remap(item);
      };
      for (const [entity, records] of Object.entries(data)) if (entity !== 'sources') remap(records);
      const pending = [];
      const blocked = new Set();
      for (const [entity, kind] of Object.entries(KINDS)) for (const record of data[entity]) {
        if (entity === 'profileRevisions') { if (!body.applyProfile) report.counts[entity].skipped++; continue; }
        if (entity === 'sources' && aliasRecords.has(record.sourceId)) { report.counts.sources.skipped++; continue; }
        const recordId = entityId(entity, record);
        const previous = this.store.get(kind, recordId);
        const priorImport = this.store.get('import-identity', `${entity}:${recordId}`);
        const recordDigest = digest(canonical(record));
        if (entity === 'sources' && previous?.kind === record.kind && previous.externalId === record.externalId && previous.contentDigest === record.contentDigest) { report.counts.sources.skipped++; continue; }
        if (previous && (canonical(this.exportRecord(entity, previous, body.document.sourceContentIncluded)) === canonical(record) || priorImport?.digest === recordDigest)) { report.counts[entity].skipped++; continue; }
        if (previous) { conflict(entity, recordId, 'different_existing_value'); blocked.add(`${entity}:${recordId}`); continue; }
        pending.push({ entity, kind, record, recordId, recordDigest });
      }
      let work = pending;
      while (work.length) {
        let progress = false;
        const next = [];
        for (const item of work) {
          const deps = this.dependencies(item.entity, item.record);
          if (deps.some(([entity, key]) => blocked.has(`${entity}:${key}`))) { conflict(item.entity, item.recordId, 'missing_dependency'); blocked.add(`${item.entity}:${item.recordId}`); continue; }
          if (deps.some(([entity, key]) => !this.store.get(KINDS[entity], key))) { next.push(item); continue; }
          const record = this.restore(item.entity, item.record, body.applyProfile, report, profileMap);
          this.store.insertImported(item.kind, { ...record, id: item.recordId, revision: record.revision ?? 1,
            createdAt: record.createdAt ?? record.submittedAt ?? record.capturedAt ?? record.committedAt ?? now(), updatedAt: record.updatedAt ?? record.createdAt ?? now() });
          this.store.put('import-identity', { digest: item.recordDigest, auditKey }, `${item.entity}:${item.recordId}`);
          report.counts[item.entity].inserted++; progress = true;
        }
        if (!progress) { for (const item of next) conflict(item.entity, item.recordId, 'missing_dependency'); break; }
        work = next;
      }
      for (const attempt of data.attempts) {
        const feedback = attempt.latestFeedbackId ? this.store.get('feedback', attempt.latestFeedbackId) : null;
        const restored = this.store.get('attempt', attempt.id);
        if (feedback && restored && !restored.feedback) this.store.put('attempt', { ...restored, feedback: dto('feedback', feedback) });
      }
      if (report.conflictTotal) report.notices.push({ code: 'IMPORT_CONFLICTS', message: '冲突记录保留在本地，未覆盖。' });
      this.store.put('import-audit', { original: this.secrets.clean(body.document.data), report, digest: auditKey, profileRevisionMap: Object.fromEntries(profileMap), sourceAliases: Object.fromEntries(sourceAliases) }, auditKey);
      return report;
    });
  }

  restore(entity, input, applyProfile, report, profileMap = new Map()) {
    const record = structuredClone(input);
    if (entity === 'sources') return { ...record, content: record.text, id: record.sourceId, createdAt: record.capturedAt };
    if (entity === 'knowledge') {
      if (record.status === 'accepted') { record.status = 'needs_recheck'; report.needsRecheck++; }
      record.origin = 'backup'; record.siyuanBlockId = null; record.sync = { ...NOT_SYNCED };
    }
    if (entity === 'focusArtifacts') { record.scopeRevision = null; record.modelConfigKey = null; }
    if (entity === 'reviewSessions') { record.status = 'blocked'; record.pendingJobId = null; record.presentationId = null; }
    if (entity === 'plans') { if (record.status !== 'completed') record.status = 'stale'; record.generationJobId = null; }
    if (entity === 'attempts') { record.feedback = null; delete record.latestFeedbackId; }
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if ('profileRevision' in value) value.profileRevision = applyProfile ? profileMap.get(value.profileRevision) ?? null : null;
      for (const child of Object.values(value)) visit(child);
    };
    if (entity !== 'profileRevisions') visit(record);
    return record;
  }
}
