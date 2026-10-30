import type { AdviceSettings, AdviceState, AdviceStatus, Automation, Connection, DailyPlan, Dashboard, Feedback, Job, Knowledge, LearningProfile, ListData, Practice, PracticeAttempt, ReviewAnswer, ReviewPrompt, SourceRef, TodayData, TodayHighlight } from '../types';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function revision(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

export function sourceRefText(value: unknown): string {
  const ref = record(value);
  const title = text(ref.title) || text(ref.externalId) || text(ref.sourceId) || '未命名来源';
  const excerpt = text(ref.excerpt);
  const url = text(ref.url);
  return [title, excerpt, url].filter(Boolean).join(' · ');
}

function sourceRefs(value: unknown): SourceRef[] {
  if (!Array.isArray(value)) return [];
  return value.map(record).filter((item) => text(item.sourceId)).map((item) => ({
    ...item,
    sourceId: text(item.sourceId),
    title: text(item.title) || text(item.externalId) || '未命名来源',
    kind: text(item.kind, 'manual'),
    url: typeof item.url === 'string' ? item.url : null,
    excerpt: typeof item.excerpt === 'string' ? item.excerpt : null,
  })) as SourceRef[];
}

export function normalizeProfile(value: unknown): LearningProfile {
  const profile = record(value);
  return {
    goals: strings(profile.goals),
    careerDirection: text(profile.careerDirection),
    skills: strings(profile.skills),
    dailyBudgetMinutes: typeof profile.dailyBudgetMinutes === 'number' ? profile.dailyBudgetMinutes : 15,
    timeZone: text(profile.timeZone, 'Asia/Shanghai'),
    revision: revision(profile.revision, 1),
    createdAt: profile.createdAt as string | null | undefined,
    updatedAt: profile.updatedAt as string | null | undefined,
  };
}

export function normalizeKnowledge(value: unknown): Knowledge {
  const item = record(value);
  return {
    ...item,
    id: text(item.id),
    question: text(item.question),
    answer: text(item.answer),
    projectId: typeof item.projectId === 'string' ? item.projectId : null,
    sourceRefs: sourceRefs(item.sourceRefs),
    status: text(item.status, 'draft'),
    revision: revision(item.revision, 1),
  } as Knowledge;
}

export function normalizePractice(value: unknown): Practice {
  const item = record(value);
  const prompt = text(item.prompt);
  const rubric = Array.isArray(item.rubric) ? item.rubric.map((value) => {
    const criterion = record(value);
    return {
      id: text(criterion.id),
      label: text(criterion.label, '评价要点'),
      description: text(criterion.description),
      expectedEvidence: strings(criterion.expectedEvidence),
    };
  }) : [];
  return {
    ...item,
    id: text(item.id),
    title: text(item.title) || text(item.goal) || prompt.slice(0, 60) || '未命名练习',
    prompt,
    goal: text(item.goal),
    skill: text(item.skill),
    kind: text(item.kind, 'explanation'),
    projectId: typeof item.projectId === 'string' ? item.projectId : null,
    sourceRefs: sourceRefs(item.sourceRefs),
    rubric,
    revision: revision(item.revision, 1),
  } as Practice;
}

export function normalizeKnowledgeList(value: ListData<unknown>): ListData<Knowledge> {
  return { items: (value.items || []).map(normalizeKnowledge), total: value.total || 0 };
}

export function normalizePracticeList(value: ListData<unknown>): ListData<Practice> {
  return { items: (value.items || []).map(normalizePractice), total: value.total || 0 };
}

export function normalizeReviewAnswer(value: unknown): ReviewAnswer {
  const answer = record(value);
  return {
    cardId: text(answer.cardId) || undefined,
    presentationId: text(answer.presentationId) || undefined,
    answer: text(answer.answer),
    sourceRefs: sourceRefs(answer.sourceRefs),
  };
}

export function normalizeReviewPrompt(value: unknown): ReviewPrompt {
  const next = record(value);
  const card = record(next.card);
  const state = text(next.state, 'question');
  return {
    cardId: text(card.cardId) || text(next.cardId),
    presentationId: text(card.presentationId) || text(next.presentationId),
    prompt: text(card.question) || text(next.prompt),
    done: state === 'empty' || next.done === true,
    remaining: typeof next.remaining === 'number' ? next.remaining : undefined,
    state,
    jobId: text(next.jobId) || undefined,
    failure: next.failure as ReviewPrompt['failure'],
    session: next.session as ReviewPrompt['session'],
  };
}

export function normalizeDailyPlan(value: unknown, fallbackBudget = 0): DailyPlan {
  const plan = record(value);
  const items = Array.isArray(plan.items) ? plan.items.map((value) => {
    const item = record(value);
    return {
      ...item,
      id: text(item.id),
      title: text(item.title),
      kind: text(item.kind, 'practice'),
      estimatedMinutes: typeof item.estimatedMinutes === 'number' ? item.estimatedMinutes : 1,
      state: text(item.state, 'pending'),
    };
  }) : [];
  return {
    ...plan,
    id: typeof plan.id === 'string' ? plan.id : null,
    revision: revision(plan.revision),
    date: text(plan.date),
    timeZone: text(plan.timeZone, 'Asia/Shanghai'),
    profileRevision: typeof plan.profileRevision === 'number' ? plan.profileRevision : null,
    budgetMinutes: typeof plan.budgetMinutes === 'number' ? plan.budgetMinutes : fallbackBudget,
    scheduledMinutes: typeof plan.scheduledMinutes === 'number' ? plan.scheduledMinutes : 0,
    unallocatedMinutes: typeof plan.unallocatedMinutes === 'number' ? plan.unallocatedMinutes : 0,
    reviewDueCount: typeof plan.reviewDueCount === 'number' ? plan.reviewDueCount : null,
    items,
    status: text(plan.status, 'not_generated'),
    notices: Array.isArray(plan.notices) ? plan.notices as DailyPlan['notices'] : [],
  } as DailyPlan;
}

export function normalizeDashboard(value: unknown): Dashboard {
  const dashboard = record(value);
  const profile = normalizeProfile(dashboard.profile);
  const summary = record(dashboard.summary);
  const warnings = Array.isArray(dashboard.warnings) ? dashboard.warnings.map((item) => text(record(item).message)).filter(Boolean) : [];
  const checkpoints = Array.isArray(dashboard.recentCheckpoints) ? dashboard.recentCheckpoints : [];
  const reviewDue = summary.reviewDue;
  return {
    date: text(dashboard.date) || undefined,
    timeZone: text(dashboard.timeZone) || profile.timeZone,
    profile,
    goals: profile.goals,
    reviewDueCount: typeof reviewDue === 'number' ? reviewDue : null,
    recentCheckpoint: (dashboard.recentCheckpoint ?? checkpoints[0] ?? null) as Dashboard['recentCheckpoint'],
    dailyBudgetMinutes: profile.dailyBudgetMinutes,
    limitations: warnings,
    dailyPlan: dashboard.dailyPlan ? normalizeDailyPlan(dashboard.dailyPlan, profile.dailyBudgetMinutes) : null,
    connections: Array.isArray(dashboard.connections) ? normalizeConnections(dashboard.connections) : undefined,
  };
}

export function normalizeConnections(value: unknown): Connection[] {
  const raw = Array.isArray(value) ? value : Array.isArray(record(value).items) ? record(value).items as unknown[] : [];
  return raw.map((value) => {
    const connection = record(value);
    const status = text(connection.status);
    return {
      provider: text(connection.kind) || 'unknown',
      configured: connection.configured === true,
      connected: status === 'connected',
      status,
      detail: text(record(connection.lastError).message) || undefined,
      lastCheckedAt: text(connection.lastCheckedAt) || null,
      revision: typeof connection.revision === 'number' ? connection.revision : undefined,
      baseUrl: typeof connection.baseUrl === 'string' ? connection.baseUrl : null,
      notebookTitle: text(connection.notebookTitle) || undefined,
      tokenConfigured: connection.tokenConfigured === true,
      configurationSource: text(connection.configurationSource) || undefined,
    };
  });
}

export function normalizeJob(value: unknown): Job {
  const job = record(value);
  const result = record(job.result);
  return {
    id: text(job.id) || text(job.jobId),
    type: text(job.type) || undefined,
    status: text(job.status, 'queued'),
    commitState: text(job.commitState) || undefined,
    operationId: text(job.operationId) || undefined,
    progress: job.progress as Job['progress'],
    syncedCount: typeof result.sourcesCreated === 'number' ? result.sourcesCreated : undefined,
    skippedCount: typeof result.sourcesUpdated === 'number' ? result.sourcesUpdated : undefined,
    result: job.result ? result : null,
    error: text(record(job.error).message) || text(job.error) || null,
  };
}

export function normalizeFeedback(value: unknown): Feedback {
  const item = record(value);
  return {
    ...item,
    id: text(item.id),
    attemptId: text(item.attemptId),
    mode: text(item.mode, 'template'),
    basis: text(item.basis),
    summary: text(item.summary),
    observations: Array.isArray(item.observations) ? item.observations.map((value) => {
      const observation = record(value);
      return {
        ...observation,
        criterionId: text(observation.criterionId),
        finding: text(observation.finding, 'not_assessed'),
        comment: text(observation.comment),
        evidenceRefs: Array.isArray(observation.evidenceRefs) ? observation.evidenceRefs : [],
      };
    }) : [],
    nextActions: strings(item.nextActions),
    limitations: strings(item.limitations),
  } as Feedback;
}

export function normalizeAttempt(value: unknown): PracticeAttempt {
  const attempt = record(value);
  return {
    ...attempt,
    id: text(attempt.id),
    practiceId: text(attempt.practiceId),
    output: text(attempt.output),
    assistanceLevel: text(attempt.assistanceLevel, 'none'),
    evidenceRefs: Array.isArray(attempt.evidenceRefs) ? attempt.evidenceRefs as PracticeAttempt['evidenceRefs'] : [],
    feedback: attempt.feedback ? normalizeFeedback(attempt.feedback) : null,
  } as PracticeAttempt;
}

export function normalizeAutomation(value: unknown): Automation {
  const item = record(value);
  const setup = record(item.setup);
  const lastError = item.lastError === null ? null : record(item.lastError);
  return {
    enabled: item.enabled === true,
    revision: revision(item.revision),
    state: text(item.state, 'off') as Automation['state'],
    message: text(item.message),
    setup: { profile: setup.profile === true, scope: setup.scope === true, model: setup.model === true },
    dailyCallLimit: 3,
    callsToday: typeof item.callsToday === 'number' ? item.callsToday : 0,
    nextRunAt: typeof item.nextRunAt === 'string' ? item.nextRunAt : null,
    lastSuccessAt: typeof item.lastSuccessAt === 'string' ? item.lastSuccessAt : null,
    lastError: lastError ? { code: text(lastError.code), message: text(lastError.message), retryable: lastError.retryable === true } : null,
  };
}

function boundedInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 20 ? value : fallback;
}

export function normalizeAdviceSettings(value: unknown): AdviceSettings {
  const item = record(value);
  return {
    enabled: item.enabled === true,
    dailyCallLimit: boundedInteger(item.dailyCallLimit, 3),
    revision: revision(item.revision),
    callsToday: boundedInteger(item.callsToday, 0),
    remainingToday: boundedInteger(item.remainingToday, 0),
    modelConfigured: item.modelConfigured === true,
  };
}

const adviceStatuses = new Set<AdviceStatus>(['off', 'idle', 'queued', 'running', 'ready', 'failed', 'uncertain', 'limited', 'unavailable', 'stale']);

export function normalizeAdviceState(value: unknown): AdviceState {
  const item = record(value);
  const candidate = text(item.status) as AdviceStatus;
  const lastError = item.lastError === null ? null : record(item.lastError);
  return {
    attemptId: text(item.attemptId),
    status: adviceStatuses.has(candidate) ? candidate : 'unavailable',
    jobId: typeof item.jobId === 'string' ? item.jobId : null,
    feedback: item.feedback ? normalizeFeedback(item.feedback) : null,
    message: text(item.message),
    canRequest: item.canRequest === true,
    canRetry: item.canRetry === true,
    lastError: lastError ? { code: text(lastError.code), message: text(lastError.message), retryable: false } : null,
  };
}

export function normalizeToday(value: unknown): TodayData {
  const item = record(value);
  const highlights = Array.isArray(item.highlights) ? item.highlights.map((value): TodayHighlight => {
    const highlight = record(value);
    return {
      id: text(highlight.id),
      title: text(highlight.title),
      summary: text(highlight.summary),
      goal: text(highlight.goal),
      whyRelevant: text(highlight.whyRelevant),
      sourceRefs: sourceRefs(highlight.sourceRefs),
    };
  }) : [];
  const result: TodayData = {
    date: text(item.date),
    profile: normalizeProfile(item.profile),
    automation: normalizeAutomation(item.automation),
    highlights,
    practice: item.practice ? normalizePractice(item.practice) : null,
    attempt: item.attempt ? normalizeAttempt(item.attempt) : null,
    generatedAt: typeof item.generatedAt === 'string' ? item.generatedAt : null,
  };
  if (item.adviceSettings !== undefined) result.adviceSettings = normalizeAdviceSettings(item.adviceSettings);
  if (item.advice !== undefined) result.advice = item.advice === null ? null : normalizeAdviceState(item.advice);
  return result;
}
