import { id, now, digest, dateInZone, dateString, timeZone, choice, integer, onlyFields, strings, text, expectedRevision } from './validation.mjs';
import { fail, requireValue } from './errors.mjs';
import { choosePracticeMaterial } from './relevance.mjs';

export class Learning {
  constructor(store, domain, sources, siyuan, model, settings) {
    this.store = store; this.domain = domain; this.sources = sources; this.siyuan = siyuan; this.model = model; this.settings = settings;
  }

  provenance(mode, refs = [], profile = this.domain.profile(), selectionReason = '') {
    const label = mode === 'template' ? '本地练习模板，未经正确性评估' : mode === 'model' ? '模型建议，需要核验' : '用户手工创建';
    return { mode, label: selectionReason ? `${label}。${selectionReason}` : label,
      sourceRefs: refs, profileRevision: profile.revision, model: mode === 'model' ? { provider: 'openai-compatible', model: this.settings.raw().model.model } : null, generatedAt: now() };
  }

  rubric(items) {
    requireValue(Array.isArray(items) && items.length >= 1 && items.length <= 10, 'rubric 需要 1–10 项。');
    return items.map(item => {
      onlyFields(item, ['label', 'description', 'expectedEvidence']);
      return { id: id(), label: text(item.label, 'label', 200), description: text(item.description, 'description', 2000), expectedEvidence: strings(item.expectedEvidence, 'expectedEvidence', 10, 500) };
    });
  }

  createPractice(body, provenance = null, recordId) {
    onlyFields(body, ['projectId', 'kind', 'goal', 'skill', 'prompt', 'estimatedMinutes', 'rubric', 'sourceRefs']);
    const projectId = body.projectId === null ? null : text(body.projectId, 'projectId', 128);
    this.domain.project(projectId, true);
    const refs = provenance ? body.sourceRefs : this.sources.inputs(body.sourceRefs);
    const fields = { projectId, kind: choice(body.kind, ['explanation', 'new_scenario', 'artifact'], 'kind'),
      goal: text(body.goal, 'goal', 500), skill: text(body.skill, 'skill', 500, true), prompt: text(body.prompt, 'prompt', 10000),
      estimatedMinutes: integer(body.estimatedMinutes, 'estimatedMinutes', 1, 120), rubric: this.rubric(body.rubric),
      sourceRefs: refs, provenance: provenance ?? this.provenance('manual', refs), status: 'open' };
    return this.store.put('practice', this.sources.secrets.clean(fields), recordId);
  }

  planId(date, zone) { return `plan_${digest([date, zone]).slice(0, 40)}`; }

  plan(date, zone) {
    const profile = this.domain.profile();
    const selectedZone = zone === undefined ? profile.timeZone : timeZone(zone);
    const selectedDate = date === undefined ? dateInZone(new Date(), selectedZone) : dateString(date);
    return this.store.get('daily-plan', this.planId(selectedDate, selectedZone)) ?? {
      id: null, revision: 0, date: selectedDate, timeZone: selectedZone, profileRevision: null,
      budgetMinutes: profile.dailyBudgetMinutes, scheduledMinutes: 0, unallocatedMinutes: profile.dailyBudgetMinutes,
      reviewDueCount: null, status: 'not_generated', items: [], notices: [], generationJobId: null, createdAt: null, updatedAt: null,
    };
  }

  validateGeneration(body) {
    onlyFields(body, ['date', 'expectedProfileRevision', 'expectedPlanRevision', 'mode', 'allowTemplateFallback']);
    const profile = this.domain.profile();
    expectedRevision(body.expectedProfileRevision, profile);
    const date = body.date === undefined ? dateInZone(new Date(), profile.timeZone) : dateString(body.date);
    requireValue(date === dateInZone(new Date(), profile.timeZone), '只能为当前时区的今天生成计划。');
    expectedRevision(body.expectedPlanRevision, this.plan(date));
    const mode = choice(body.mode ?? 'template', ['template', 'model'], 'mode');
    requireValue(body.allowTemplateFallback === undefined || typeof body.allowTemplateFallback === 'boolean', 'allowTemplateFallback 必须为布尔值。');
    return { ...body, date, mode, allowTemplateFallback: body.allowTemplateFallback ?? true, timeZone: profile.timeZone };
  }

  activeProject(projectId) {
    const project = projectId ? this.store.get('project', projectId) : null;
    return !projectId || project && ['active', 'maintenance'].includes(project.status);
  }

  practiceSelection(profile = this.domain.profile()) {
    const completedIds = new Set(this.store.all('attempt').map(item => item.practiceId));
    const completed = this.store.all('practice').filter(item => completedIds.has(item.id));
    const facts = this.store.all('knowledge').filter(item => item.status === 'accepted' && this.activeProject(item.projectId));
    return choosePracticeMaterial(facts, profile, completed);
  }

  async generate(payload, job) {
    const profile = this.domain.profile();
    requireValue(payload.date === dateInZone(new Date(), profile.timeZone), '过期的日计划作业不能补造历史安排。');
    expectedRevision(payload.expectedProfileRevision, profile);
    const original = this.plan(payload.date, profile.timeZone);
    expectedRevision(payload.expectedPlanRevision, original);
    const notices = [];
    let reviewDueCount = null;
    let due = [];
    try {
      const queue = await this.siyuan.dueCards();
      const accepted = this.store.all('knowledge').filter(item => item.status === 'accepted' && item.sync?.status === 'synced' && this.activeProject(item.projectId));
      due = queue.cards.filter(card => accepted.some(item => item.siyuanBlockId === card.blockID));
      reviewDueCount = due.length;
    } catch { notices.push({ code: 'SIYUAN_UNAVAILABLE', message: 'SiYuan 复习不可用，尚未检查到期数量。' }); }
    expectedRevision(payload.expectedProfileRevision, this.domain.profile());
    expectedRevision(payload.expectedPlanRevision, this.plan(payload.date));
    const completed = original.items.filter(item => item.state === 'completed');
    const completedMinutes = completed.reduce((sum, item) => sum + item.estimatedMinutes, 0);
    if (completedMinutes > profile.dailyBudgetMinutes) {
      return this.savePlan({ ...original, items: completed, status: 'stale', notices: [{ code: 'BUDGET_EXHAUSTED', message: '已完成安排超过新预算，保留原预算及历史证据。' }], generationJobId: job.id });
    }
    const items = [...completed];
    let remaining = profile.dailyBudgetMinutes - completedMinutes;
    let selection = this.practiceSelection(profile);
    const existingItem = original.profileRevision === profile.revision ? original.items.find(item => item.kind === 'practice' && item.state === 'pending') : null;
    let existingPractice = existingItem ? this.store.get('practice', existingItem.practiceId) : null;
    if (existingPractice && this.activeProject(existingPractice.projectId)
      && existingItem.knowledgeIds.every(knowledgeId => { const fact = this.store.get('knowledge', knowledgeId); return fact?.status === 'accepted' && this.activeProject(fact.projectId); })) {
      selection = { goal: existingPractice.goal, skill: existingPractice.skill, fact: this.store.get('knowledge', existingItem.knowledgeIds[0]), reason: existingPractice.provenance.label };
    } else existingPractice = null;
    const goal = selection?.goal ?? null;
    const fact = selection?.fact ?? null;
    const skill = selection?.skill ?? '';
    const facts = fact ? [fact] : [];
    if (!goal) notices.push({ code: 'NO_GOALS', message: '尚未填写学习目标，未生成针对性练习。' });
    if (!this.store.all('knowledge').some(item => item.status === 'accepted' && this.activeProject(item.projectId))) notices.push({ code: 'NO_ACCEPTED_KNOWLEDGE', message: '没有已接受知识，练习模板只依据用户明确目标。' });
    if (goal && !fact) notices.push({ code: 'NO_RELEVANT_KNOWLEDGE', message: '没有与明确目标或技能字面匹配的已接受材料，产物模板只依据用户明确目标。' });
    if (goal && remaining && !completed.some(item => item.kind === 'practice')) {
      const minutes = Math.min(10, remaining);
      const refs = fact?.sourceRefs ?? [];
      let mode = fact ? payload.mode : 'template';
      let exercise;
      if (mode === 'model' && !existingPractice) {
        try { exercise = await this.model.practice({ goal, skill, budgetMinutes: minutes, knowledge: facts.map(item => ({ id: item.id, question: item.question, answer: item.answer, sourceRefs: item.sourceRefs })) }); }
        catch (error) {
          if (!payload.allowTemplateFallback) throw error;
          mode = 'template'; notices.push({ code: 'TEMPLATE_FALLBACK', message: '模型不可用，使用明确标注的本地模板。' });
        }
      }
      exercise ??= { kind: fact ? 'explanation' : 'artifact', estimatedMinutes: minutes,
        prompt: fact ? `目标：${goal}\n请用自己的话回答“${fact.question}”，写出理由，并给出一个可以检查的新例子。请标明仍需验证之处。` : `尚无匹配的已接受材料；以下仅为目标产物模板。\n目标：${goal}\n在 ${minutes} 分钟内提交一个可检查的小产物或方案片段，写明它如何推进目标，以及一个下一步验证动作。`,
        rubric: [{ label: '目标与产物', description: '说明这份实际输出怎样推进用户填写的目标。', expectedEvidence: ['实际输出', '与目标的联系'] },
          { label: '可检查依据', description: '给出推理、具体例子或可执行验证；未知处明确保留。', expectedEvidence: ['理由或例子', '验证动作或未知项'] }] };
      expectedRevision(payload.expectedProfileRevision, this.domain.profile());
      expectedRevision(payload.expectedPlanRevision, this.plan(payload.date, profile.timeZone));
      const practiceId = existingPractice?.id ?? `practice_${digest([payload.date, profile.timeZone, profile.revision, goal, fact?.id ?? null]).slice(0, 40)}`;
      let practice = existingPractice ?? this.store.get('practice', practiceId);
      if (!practice) practice = this.createPractice({ projectId: fact?.projectId ?? null, goal, skill, sourceRefs: refs, ...exercise }, this.provenance(mode, refs, profile, selection.reason), practiceId);
      if (practice.estimatedMinutes <= remaining) {
        items.push(this.item('practice', { title: practice.kind === 'explanation' ? '解释并举例' : '提交可检查的小产物', goal, skill: practice.skill,
          estimatedMinutes: practice.estimatedMinutes, knowledgeIds: fact ? [fact.id] : [], practiceId: practice.id, provenance: practice.provenance }));
        remaining -= practice.estimatedMinutes;
      }
    }
    if (due.length && remaining && !completed.some(item => item.kind === 'review')) {
      const minutes = Math.min(3, remaining);
      items.push(this.item('review', { title: 'SiYuan 到期记忆复习', estimatedMinutes: minutes, reviewLimit: Math.min(100, due.length, minutes * 2), provenance: this.provenance('template') }));
      remaining -= minutes;
    }
    const output = this.store.all('output').find(item => item.status === 'draft' && this.activeProject(item.projectId) && !completed.some(done => done.outputId === item.id));
    if (output && remaining >= 1) items.push(this.item('output', { title: output.title, goal: output.goal || null, estimatedMinutes: Math.min(5, remaining), outputId: output.id, provenance: this.provenance('manual', output.sourceRefs) }));
    if (!profile.dailyBudgetMinutes) notices.push({ code: 'BUDGET_EXHAUSTED', message: '今日预算为零，未安排工作。' });
    if (!items.length) notices.push({ code: 'NO_ACTIONABLE_ITEMS', message: '当前没有可行动安排。' });
    return this.savePlan({ ...original, id: this.planId(payload.date, profile.timeZone), date: payload.date, timeZone: profile.timeZone,
      profileRevision: profile.revision, budgetMinutes: profile.dailyBudgetMinutes, items, reviewDueCount,
      status: items.length ? items.every(item => item.state === 'completed') ? 'completed' : 'ready' : 'blocked', notices, generationJobId: job.id });
  }

  item(kind, fields) {
    return { id: id(), kind, title: '', goal: null, skill: null, offsetMinutes: 0, estimatedMinutes: 1,
      knowledgeIds: [], practiceId: null, outputId: null, reviewLimit: null, state: 'pending', ...fields };
  }

  savePlan(plan) {
    let offset = 0;
    const items = plan.items.map(item => { const result = { ...item, offsetMinutes: offset }; offset += item.estimatedMinutes; return result; });
    return this.store.put('daily-plan', { ...plan, items, scheduledMinutes: offset, unallocatedMinutes: Math.max(0, plan.budgetMinutes - offset) }, plan.id);
  }

  finishItems(predicate) {
    for (const plan of this.store.all('daily-plan')) {
      if (!plan.items.some(predicate)) continue;
      const items = plan.items.map(item => predicate(item) ? { ...item, state: 'completed' } : item);
      this.store.put('daily-plan', { ...plan, items, status: items.every(item => item.state === 'completed') ? 'completed' : plan.status });
    }
  }

  snapshots(refs) {
    let size = 0;
    return refs.map(reference => {
      const record = reference.kind === 'url' ? null : this.store.require(reference.kind, reference.id);
      const content = record ? reference.kind === 'source' ? record.content : record.content : null;
      if (content !== null) {
        if ([...content].length > 20000) fail(413, 'PAYLOAD_TOO_LARGE', '单条证据快照超过 20000 字符，请引用更小的证据。');
        size += Buffer.byteLength(content);
        if (size > 1024 * 1024) fail(413, 'PAYLOAD_TOO_LARGE', '证据快照总量超过 1 MiB。');
      }
      return { reference, revision: record?.revision ?? null, digest: content === null ? null : digest(content), text: content, capturedAt: now() };
    });
  }

  attempt(practiceId, body) {
    onlyFields(body, ['output', 'assistanceLevel', 'evidenceRefs']);
    const practice = this.store.require('practice', practiceId);
    const evidenceRefs = this.sources.evidence(body.evidenceRefs);
    const fields = { practiceId, output: text(body.output, 'output', 100000), assistanceLevel: choice(body.assistanceLevel, ['none', 'hint', 'partial', 'full'], 'assistanceLevel'),
      evidenceRefs, evidenceSnapshots: this.snapshots(evidenceRefs), submittedAt: now(), feedback: null };
    const attempt = this.store.put('attempt', this.sources.secrets.clean(fields));
    this.store.put('practice', { ...practice, status: 'completed' });
    this.finishItems(item => item.practiceId === practiceId);
    return attempt;
  }

  checkObservations(observations, practice) {
    requireValue(Array.isArray(observations) && observations.length === practice.rubric.length, '每项 rubric 必须恰好有一条 observation。');
    const ids = new Set();
    return observations.map(observation => {
      onlyFields(observation, ['criterionId', 'finding', 'comment', 'evidenceRefs']);
      requireValue(practice.rubric.some(item => item.id === observation.criterionId) && !ids.has(observation.criterionId), 'observation 的 criterionId 无效或重复。');
      ids.add(observation.criterionId);
      return { criterionId: observation.criterionId, finding: choice(observation.finding, ['met', 'partial', 'not_met', 'not_assessed'], 'finding'),
        comment: text(observation.comment, 'comment', 4000, true), evidenceRefs: this.sources.evidence(observation.evidenceRefs) };
    });
  }

  async feedback(attemptId, body) {
    this.validateFeedback(attemptId, body);
    onlyFields(body, ['mode', 'allowTemplateFallback', 'manual']);
    let mode = choice(body.mode, ['template', 'model', 'manual'], 'mode');
    requireValue(mode === 'manual' ? body.manual : body.manual === undefined, '仅 manual 模式需要 manual 对象。');
    requireValue(body.allowTemplateFallback === undefined || typeof body.allowTemplateFallback === 'boolean', 'allowTemplateFallback 必须为布尔值。');
    const attempt = this.store.require('attempt', attemptId);
    const practice = this.store.require('practice', attempt.practiceId);
    let result = body.manual;
    let fallback = false;
    if (mode === 'model') {
      try { result = await this.model.feedback({ output: attempt.output, assistanceLevel: attempt.assistanceLevel, evidenceSnapshots: attempt.evidenceSnapshots, rubric: practice.rubric, goal: practice.goal }); }
      catch (error) { if (body.allowTemplateFallback === false) throw error; mode = 'template'; fallback = true; }
    }
    if (mode === 'template') result = {
      summary: `已保存真实提交（${[...attempt.output].length} 字符）；辅助程度：${attempt.assistanceLevel}。正确性与应用能力尚未评估。`,
      observations: practice.rubric.map(criterion => ({ criterionId: criterion.id, finding: 'not_assessed', comment: `需要检查：${criterion.expectedEvidence.join('、') || criterion.description}。现有证据引用 ${attempt.evidenceRefs.length} 条。`, evidenceRefs: [] })),
      nextActions: ['按 rubric 检查输出，并补充可验证的例子或执行证据。'],
      limitations: ['本地清单不判断正确性，也不推断技能掌握。', ...(attempt.evidenceRefs.some(ref => ref.kind === 'url') ? ['URL 内容未抓取或检查。'] : []), ...(fallback ? ['模型不可用，已明确回退为模板反馈。'] : [])],
    };
    onlyFields(result, ['summary', 'observations', 'nextActions', 'limitations']);
    const feedback = this.store.put('feedback', this.sources.secrets.clean({ attemptId, mode, basis: { manual: 'user_judgment', template: 'deterministic_checklist', model: 'model_suggestion' }[mode],
      summary: text(result.summary, 'summary', 4000), observations: this.checkObservations(result.observations, practice),
      nextActions: strings(result.nextActions, 'nextActions', 10, 2000), limitations: strings(result.limitations, 'limitations', 10, 2000), provenance: this.provenance(mode, practice.sourceRefs) }));
    this.store.put('attempt', { ...attempt, feedback });
    return { feedbackId: feedback.id, attemptId, feedback };
  }

  validateFeedback(attemptId, body) {
    onlyFields(body, ['mode', 'allowTemplateFallback', 'manual']);
    const mode = choice(body.mode, ['template', 'model', 'manual'], 'mode');
    requireValue(body.allowTemplateFallback === undefined || typeof body.allowTemplateFallback === 'boolean', 'allowTemplateFallback 必须为布尔值。');
    requireValue(mode === 'manual' ? body.manual : body.manual === undefined, 'manual 字段与模式不匹配。');
    const attempt = this.store.require('attempt', attemptId);
    if (mode !== 'manual') return;
    onlyFields(body.manual, ['summary', 'observations', 'nextActions', 'limitations']);
    text(body.manual.summary, 'summary', 4000);
    this.checkObservations(body.manual.observations, this.store.require('practice', attempt.practiceId));
    strings(body.manual.nextActions, 'nextActions', 10, 2000); strings(body.manual.limitations, 'limitations', 10, 2000);
  }

  output(body, recordId = null) {
    onlyFields(body, ['projectId', 'practiceId', 'title', 'content', 'goal', 'status', 'sourceRefs', 'evidenceRefs']);
    const existing = recordId ? this.store.require('output', recordId) : null;
    requireValue(Object.keys(body).length && (existing || Object.keys(body).length === 8), '新输出需要八个业务字段；修改至少一项。');
    const next = { ...existing, ...body };
    if (next.projectId !== null) this.domain.project(text(next.projectId, 'projectId', 128));
    if (next.practiceId !== null) this.store.require('practice', text(next.practiceId, 'practiceId', 128));
    next.title = text(next.title, 'title', 200); next.content = text(next.content, 'content', 100000, true); next.goal = text(next.goal, 'goal', 500, true);
    next.status = choice(next.status, ['draft', 'final'], 'status');
    requireValue(next.status !== 'final' || next.content.trim(), 'final 输出需要非空正文。');
    next.sourceRefs = body.sourceRefs === undefined && existing ? existing.sourceRefs : this.sources.inputs(next.sourceRefs);
    next.evidenceRefs = body.evidenceRefs === undefined && existing ? existing.evidenceRefs : this.sources.evidence(next.evidenceRefs);
    if (existing) this.store.put('output-revision', { outputId: existing.id, outputRevision: existing.revision, snapshot: existing });
    const saved = this.store.put('output', this.sources.secrets.clean(next), recordId ?? undefined);
    if (saved.status === 'final') this.finishItems(item => item.outputId === saved.id);
    return saved;
  }
}
