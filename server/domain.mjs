import { choice, integer, onlyFields, strings, text, timeZone, operationId, digest, now } from './validation.mjs';
import { fail, requireValue } from './errors.mjs';
import { UNVERIFIED, NOT_SYNCED } from './sources.mjs';

export const PROJECT_STATUSES = ['active', 'maintenance', 'paused', 'archived'];
export const KNOWLEDGE_STATUSES = ['draft', 'accepted', 'rejected', 'needs_recheck', 'archived'];
export const DEFAULT_PROFILE = { goals: [], careerDirection: '', skills: [], dailyBudgetMinutes: 15, timeZone: 'Asia/Shanghai' };

export class Domain {
  constructor(store, secrets, sources) {
    this.store = store; this.secrets = secrets; this.sources = sources;
    if (!store.get('profile', 'learning')) {
      const initial = store.put('profile', DEFAULT_PROFILE, 'learning');
      store.put('profile-revision', { profileRevision: initial.revision, values: DEFAULT_PROFILE, changedAt: initial.updatedAt, actor: 'initialization' });
    }
  }

  profile() { return this.store.get('profile', 'learning') ?? { ...DEFAULT_PROFILE, id: 'learning', revision: 0, createdAt: null, updatedAt: null }; }

  updateProfile(body, actor = 'user') {
    onlyFields(body, Object.keys(DEFAULT_PROFILE));
    requireValue(Object.keys(DEFAULT_PROFILE).every(key => Object.hasOwn(body, key)), '学习配置的五个字段均为必填。');
    const value = { ...this.profile() };
    if (body.goals !== undefined) value.goals = strings(body.goals, 'goals', 20, 500);
    if (body.careerDirection !== undefined) value.careerDirection = text(body.careerDirection, 'careerDirection', 1000, true);
    if (body.skills !== undefined) value.skills = strings(body.skills, 'skills', 50, 500);
    if (body.dailyBudgetMinutes !== undefined) value.dailyBudgetMinutes = integer(body.dailyBudgetMinutes, 'dailyBudgetMinutes', 0, 120);
    if (body.timeZone !== undefined) value.timeZone = timeZone(body.timeZone);
    const saved = this.store.put('profile', this.secrets.clean(value), 'learning');
    if (saved.revision !== value.revision) {
      const values = Object.fromEntries(Object.keys(DEFAULT_PROFILE).map(key => [key, saved[key]]));
      this.store.put('profile-revision', { profileRevision: saved.revision, values, changedAt: saved.updatedAt, actor });
      for (const plan of this.store.all('daily-plan')) {
        if (plan.status !== 'completed') this.store.put('daily-plan', { ...plan, status: 'stale' });
      }
    }
    return saved;
  }

  project(projectId, writable = false) {
    if (!projectId) return null;
    const project = this.store.require('project', projectId);
    if (writable && project.status === 'archived') fail(409, 'INVALID_STATE', '请先恢复项目，再添加或修改内容。');
    return project;
  }

  createProject(body) {
    onlyFields(body, ['title', 'goal', 'status']);
    return this.store.put('project', this.secrets.clean({ title: text(body.title, 'title', 200), goal: text(body.goal, 'goal', 2000, true),
      status: choice(body.status ?? 'active', PROJECT_STATUSES, 'status') }));
  }

  updateProject(projectId, body) {
    onlyFields(body, ['title', 'goal', 'status']);
    const project = this.project(projectId);
    if (body.title !== undefined) project.title = text(body.title, 'title', 200);
    requireValue(Object.keys(body).length, '至少修改一个字段。');
    if (body.goal !== undefined) project.goal = text(body.goal, 'goal', 2000, true);
    if (body.status !== undefined) project.status = choice(body.status, PROJECT_STATUSES, 'status');
    return this.store.put('project', this.secrets.clean(project));
  }

  deleteProject(projectId) {
    const project = this.project(projectId);
    const archived = this.store.put('project', { ...project, status: 'archived' });
    return { projectId, status: 'archived', revision: archived.revision };
  }

  checkpoint(projectId, body) {
    this.project(projectId, true);
    onlyFields(body, ['progress', 'nextAction', 'openQuestion']);
    requireValue(['progress', 'nextAction', 'openQuestion'].some(key => typeof body[key] === 'string' && body[key].trim()), '至少填写一项检查点内容。');
    return this.store.put('checkpoint', this.secrets.clean({ projectId,
      progress: text(body.progress, 'progress', 4000, true),
      nextAction: text(body.nextAction, 'nextAction', 4000, true),
      openQuestion: text(body.openQuestion, 'openQuestion', 4000, true) }));
  }

  createKnowledge(body, extra = {}) {
    onlyFields(body, ['projectId', 'question', 'answer', 'sourceRefs']);
    requireValue(body.projectId === null || typeof body.projectId === 'string' && body.projectId.trim(), 'projectId 必须为 ID 或 null。');
    const projectId = body.projectId === null ? null : text(body.projectId, 'projectId', 128);
    this.project(projectId, true);
    return this.store.put('knowledge', this.secrets.clean({ projectId, question: text(body.question, 'question', 2000),
      answer: text(body.answer, 'answer', 20000), sourceRefs: this.sources.inputs(body.sourceRefs), status: 'draft',
      origin: 'manual', validation: { ...UNVERIFIED }, lastDecision: null, sync: { ...NOT_SYNCED }, siyuanBlockId: null, ...extra }));
  }

  updateKnowledge(knowledgeId, body) {
    onlyFields(body, ['projectId', 'question', 'answer', 'sourceRefs', 'status', 'validation']);
    requireValue(Object.keys(body).length, '至少修改一个字段。');
    const record = this.store.require('knowledge', knowledgeId);
    this.project(record.projectId, true);
    const next = { ...record };
    if (body.projectId !== undefined) {
      next.projectId = body.projectId ? text(body.projectId, 'projectId', 200) : null;
      this.project(next.projectId, true);
    }
    if (body.question !== undefined) next.question = text(body.question, 'question', 2000);
    if (body.answer !== undefined) next.answer = text(body.answer, 'answer', 20000);
    if (body.sourceRefs !== undefined) next.sourceRefs = this.sources.inputs(body.sourceRefs);
    requireValue(next.origin === 'manual' || next.sourceRefs.length, '来源导入的知识必须保留至少一条来源。');
    if (body.validation !== undefined) next.validation = this.sources.validation(body.validation);
    const changed = ['question', 'answer', 'sourceRefs', 'validation'].some(key => JSON.stringify(next[key]) !== JSON.stringify(record[key]));
    if (body.status !== undefined) {
      choice(body.status, KNOWLEDGE_STATUSES, 'status');
      requireValue(['draft', 'needs_recheck', 'archived'].includes(body.status), '接受或拒绝必须通过 decision 操作。');
      const transitions = { draft: ['draft', 'archived'], accepted: ['needs_recheck', 'archived'], rejected: ['draft', 'archived'], needs_recheck: ['needs_recheck', 'archived'], archived: ['draft', 'archived'] };
      if (!transitions[record.status].includes(body.status)) fail(409, 'INVALID_STATE', '不允许该状态变更。');
      next.status = body.status;
    }
    if (changed && record.status === 'accepted' && next.status !== 'archived') next.status = 'needs_recheck';
    if (changed && body.validation === undefined) next.validation = { ...UNVERIFIED };
    if (changed && record.siyuanBlockId) next.sync = { ...record.sync, status: 'stale' };
    return this.store.put('knowledge', this.secrets.clean(next));
  }

  decide(knowledgeId, body) {
    onlyFields(body, ['decision', 'operationId']);
    const decision = choice(body.decision, ['accept', 'reject'], 'decision');
    const opId = operationId(body.operationId);
    const requestDigest = digest({ knowledgeId, decision });
    const previous = this.store.operation('knowledge-decision', opId);
    if (previous) {
      if (previous.requestDigest !== requestDigest) fail(409, 'IDEMPOTENCY_CONFLICT', 'operationId 已用于另一操作。');
      return previous.result;
    }
    return this.store.transaction(() => {
      const record = this.store.require('knowledge', knowledgeId);
      this.project(record.projectId, true);
      const target = decision === 'accept' ? 'accepted' : 'rejected';
      if (record.status === target) {
        this.store.saveOperation('knowledge-decision', opId, { requestDigest, result: record, state: 'confirmed' });
        return record;
      }
      if (!['draft', 'needs_recheck'].includes(record.status) && !(record.status === 'accepted' && decision === 'reject')) fail(409, 'INVALID_STATE', '该知识状态不允许此决定。');
      requireValue(decision !== 'accept' || record.answer.trim(), '接受前需要填写答案。');
      const result = this.store.put('knowledge', { ...record, status: target,
        lastDecision: { action: decision, actor: 'user', operationId: opId, at: now() } });
      this.store.saveOperation('knowledge-decision', opId, { requestDigest, result, state: 'confirmed' });
      return result;
    });
  }

  search(kind, query) {
    let items = this.store.all(kind);
    for (const key of ['projectId', 'status']) if (query.has(key)) items = items.filter(item => item[key] === query.get(key));
    const needle = (query.get('q') ?? query.get('search') ?? '').trim().toLocaleLowerCase();
    requireValue([...needle].length <= 200, '搜索文本过长。');
    if (query.has('sourceKind')) items = items.filter(item => item.sourceRefs?.some(ref => ref.kind === query.get('sourceKind')));
    if (query.has('validationStatus')) items = items.filter(item => item.validation?.status === query.get('validationStatus'));
    if (needle) items = items.filter(item => [item.title, item.goal, item.question, item.answer, item.content, item.progress, ...(item.sourceRefs?.map(ref => ref.title) ?? [])].some(value => value?.toLocaleLowerCase().includes(needle)));
    return items;
  }
}
