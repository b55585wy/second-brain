import type {
  AdviceSettingsInput, CodexScope, CodexScopeInput, CodexThread, EvidenceRef, ExportArtifact, Feedback, FeishuChatEntry, FeishuChatInput, FeishuChatPair,
  FeishuChatSendToday, FeishuChatStatus, FeishuRegistrationStatus, Job, JobAck, LearningProfile, LearningProfileInput, ListData, ManualDialogueInput,
  Output, OutputInput, PracticeAttempt, Project, ReviewSession, Settings, SettingsInput,
  SiyuanInput, SourceRef, SourceRefInput,
} from '../types';
import type { Checkpoint } from '../types';
import {
  normalizeAdviceSettings, normalizeAdviceState, normalizeAttempt, normalizeAutomation, normalizeConnections, normalizeDailyPlan, normalizeDashboard,
  normalizeJob, normalizeKnowledge, normalizeKnowledgeList, normalizePracticeList,
  normalizeProfile, normalizeReviewAnswer, normalizeReviewPrompt, normalizeToday,
} from './adapters';

const API_ROOT = '/api/v1';
const revisions = new Map<string, number>();

export class ApiError extends Error {
  constructor(public code: string, message: string, public retryable = false, public status = 0) {
    super(message);
    this.name = 'ApiError';
  }
}

type RequestOptions = Omit<RequestInit, 'body'> & { body?: unknown };
type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function remember(path: string, value: unknown): void {
  if (!isFields(value) || typeof value.revision !== 'number') return;
  if (path !== '/advice-settings' || value.revision >= (revisions.get(path) ?? -Infinity)) revisions.set(path, value.revision);
}

function rememberConnections(value: unknown): void {
  if (!isFields(value) || !Array.isArray(value.items)) return;
  for (const item of value.items) {
    if (isFields(item) && typeof item.kind === 'string') remember(`/connections/${item.kind}`, item);
  }
}

function rememberRecords(path: string, value: unknown): void {
  if (!isFields(value)) return;
  if (Array.isArray(value.items)) {
    for (const item of value.items) {
      if (isFields(item) && typeof item.id === 'string') remember(`${path}/${item.id}`, item);
    }
  }
  if (typeof value.id === 'string') remember(`${path}/${value.id}`, value);
}

function captureRevisions(path: string, value: unknown): void {
  const pathname = path.split('?')[0];
  if (['/learning-profile', '/settings', '/connections/codex/scope', '/daily-plan', '/automation', '/feishu-chat', '/advice-settings'].includes(pathname)) remember(pathname, value);
  if (pathname === '/today' && isFields(value)) {
    remember('/learning-profile', value.profile);
    remember('/automation', value.automation);
    remember('/advice-settings', value.adviceSettings);
    if (isFields(value.practice) && typeof value.practice.id === 'string') remember(`/practices/${value.practice.id}`, value.practice);
    if (isFields(value.attempt) && typeof value.attempt.id === 'string') remember(`/attempts/${value.attempt.id}`, value.attempt);
  }
  if (pathname === '/dashboard' && isFields(value)) {
    remember('/learning-profile', value.profile);
    remember('/daily-plan', value.dailyPlan);
    rememberConnections({ items: value.connections });
  }
  if (pathname === '/connections') rememberConnections(value);
  for (const collection of ['/projects', '/knowledge', '/outputs']) {
    if (pathname === collection) rememberRecords(collection, value);
    if (pathname.startsWith(`${collection}/`) && isFields(value) && typeof value.id === 'string') remember(pathname, value);
  }
}

function expectedRevision(path: string, supplied?: number): number {
  const value = supplied ?? revisions.get(path);
  if (value === undefined) throw new ApiError('REVISION_UNKNOWN', '无法确认服务器最新修订。请先重新加载当前页面，再提交；已填写的内容不会丢失。');
  return value;
}

function versioned(path: string, body: object, revision?: number): Fields {
  const fields = body as Fields;
  return { ...fields, expectedRevision: fields.expectedRevision ?? expectedRevision(path, revision) };
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const mutating = !['GET', 'HEAD'].includes(method);
  const originalBody = isFields(options.body) ? options.body : {};
  const body = mutating ? { ...originalBody, operationId: originalBody.operationId ?? operationId() } : undefined;
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...options,
      method,
      headers: {
        Accept: 'application/json',
        ...(mutating ? { 'Content-Type': 'application/json', 'X-Second-Brain-Client': 'local-ui' } : {}),
        ...options.headers,
      },
      body: mutating ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', '无法连接本地服务。请确认后端已启动；可用同一操作安全重试，当前输入已保留。', true);
  }

  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null) as
    | { data?: T; error?: { code?: string; message?: string; retryable?: boolean } }
    | null;
  if (!response.ok || payload?.error) {
    const code = payload?.error?.code || 'REQUEST_FAILED';
    const originalMessage = payload?.error?.message || `请求失败（${response.status}）`;
    const message = code === 'REVISION_CONFLICT' ? `${originalMessage} 请重新加载当前页面，核对最新内容后再提交；你的输入已保留。` : originalMessage;
    throw new ApiError(code, message, payload?.error?.retryable ?? response.status >= 500, response.status);
  }
  if (!payload || !('data' in payload)) {
    throw new ApiError('INVALID_RESPONSE', '服务返回了无法识别的数据，请检查 API 版本。', false, response.status);
  }
  captureRevisions(path, payload.data);
  return payload.data as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body: object = {}) => request<T>(path, { method: 'POST', body });
const put = <T>(path: string, body: object) => request<T>(path, { method: 'PUT', body });
const patch = <T>(path: string, body: object) => request<T>(path, { method: 'PATCH', body });
const remove = <T>(path: string, body: object = {}) => request<T>(path, { method: 'DELETE', body });

export function operationId(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function completedJob(job: Job): boolean {
  return !['queued', 'running'].includes(job.status);
}

function jobFailure(job: Job): ApiError {
  if (job.status === 'uncertain') return new ApiError('RECONCILIATION_REQUIRED', job.error || '任务提交状态待核对，请勿重复操作。');
  return new ApiError('JOB_FAILED', job.error || `任务未成功（${job.status}）。`);
}

async function waitForJob(ack: JobAck | Job): Promise<Job> {
  let job = 'jobId' in ack ? normalizeJob(ack) : ack;
  for (let attempt = 0; !completedJob(job); attempt++) {
    if (attempt >= 120) throw new ApiError('JOB_TIMEOUT', '任务仍在处理，请稍后到任务状态中核对，不要重复提交。', true);
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * (attempt + 1), 5000)));
    job = await api.job(job.id);
  }
  if (job.status !== 'succeeded') throw jobFailure(job);
  return job;
}

export function manualSourceInputs(value: string): SourceRefInput[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
    let url: URL | null = null;
    try { url = new URL(line); } catch { /* 手工摘录不是 URL。 */ }
    if (url && ['http:', 'https:'].includes(url.protocol)) return { kind: 'manual', title: url.hostname || `手工来源 ${index + 1}`, url: url.href, excerpt: null };
    return { kind: 'manual', title: `手工摘录 ${index + 1}`, url: null, excerpt: line };
  });
}

export function sourceRefInputs(existing: SourceRef[], additional = ''): SourceRefInput[] {
  return [...existing.map((ref) => ({ sourceId: ref.sourceId })), ...manualSourceInputs(additional)];
}

export function evidenceRefInputs(existing: SourceRef[], additional = ''): EvidenceRef[] {
  const sources = existing.map((ref) => ({ kind: 'source' as const, id: ref.sourceId, url: null, label: ref.title || '已有来源' }));
  const urls = additional.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const url = new URL(line);
    if (!['http:', 'https:'].includes(url.protocol)) throw new ApiError('INVALID_EVIDENCE_URL', '新增证据只支持 http/https URL。');
    return { kind: 'url' as const, id: null, url: url.href, label: url.hostname };
  });
  return [...sources, ...urls];
}

function assertSafeExport(artifact: ExportArtifact): void {
  let document: unknown;
  try { document = JSON.parse(artifact.content); } catch { throw new ApiError('INVALID_EXPORT', '导出内容不是有效 JSON，未创建下载文件。'); }
  const forbidden = new Set(['apiKey', 'appSecret', 'accessToken', 'token', 'tokenFile', 'cookie', 'settings', 'connections', 'payload', 'leaseOwner', 'leaseUntil']);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isFields(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.has(key)) throw new ApiError('UNSAFE_EXPORT', '导出内容包含不允许的秘密或执行字段，已阻止下载。');
      visit(child);
    }
  };
  visit(document);
}

export const api = {
  automation: async () => normalizeAutomation(await get<unknown>('/automation')),
  saveAutomation: async (enabled: boolean, revision: number, id = operationId()) => normalizeAutomation(await put<unknown>('/automation', { operationId: id, expectedRevision: revision, enabled })),
  today: async () => normalizeToday(await get<unknown>('/today')),
  adviceSettings: async () => normalizeAdviceSettings(await get<unknown>('/advice-settings')),
  saveAdviceSettings: async (body: AdviceSettingsInput, revision?: number, id = operationId()) => normalizeAdviceSettings(await put<unknown>('/advice-settings', versioned('/advice-settings', { operationId: id, enabled: body.enabled, dailyCallLimit: body.dailyCallLimit }, revision))),
  advice: async (attemptId: string) => normalizeAdviceState(await get<unknown>(`/attempts/${encodeURIComponent(attemptId)}/advice`)),
  requestAdvice: async (attemptId: string, id = operationId(), retry = false) => normalizeAdviceState(await post<unknown>(`/attempts/${encodeURIComponent(attemptId)}/advice`, { operationId: id, ...(retry ? { retry: true } : {}) })),
  dashboard: async () => normalizeDashboard(await get<unknown>('/dashboard')),
  dailyPlan: async (date: string) => normalizeDailyPlan(await get<unknown>(`/daily-plan?date=${encodeURIComponent(date)}`)),
  generateDailyPlan: async (date: string, profileRevision?: number, planRevision?: number) => {
    const ack = await post<JobAck>('/daily-plan/generate', {
      date,
      expectedProfileRevision: expectedRevision('/learning-profile', profileRevision),
      expectedPlanRevision: expectedRevision('/daily-plan', planRevision),
      mode: 'template',
      allowTemplateFallback: true,
    });
    await waitForJob(ack);
    return api.dailyPlan(date);
  },
  projects: () => get<ListData<Project>>('/projects'),
  createProject: (body: Pick<Project, 'title' | 'goal' | 'status'>) => post<Project>('/projects', body),
  updateProject: (id: string, body: Partial<Pick<Project, 'title' | 'goal' | 'status'>>, revision?: number) => patch<Project>(`/projects/${id}`, versioned(`/projects/${id}`, body, revision)),
  deleteProject: (id: string, revision?: number) => remove<{ projectId: string; status: 'archived'; revision: number }>(`/projects/${id}`, versioned(`/projects/${id}`, {}, revision)),
  checkpoints: (projectId: string) => get<ListData<Checkpoint>>(`/projects/${projectId}/checkpoints`),
  createCheckpoint: (projectId: string, body: Omit<Checkpoint, 'id' | 'projectId' | 'createdAt'>) => post<Checkpoint>(`/projects/${projectId}/checkpoints`, body),
  knowledge: async (query = '') => normalizeKnowledgeList(await get<ListData<unknown>>(`/knowledge${query ? `?${query}` : ''}`)),
  createKnowledge: async (body: { projectId: string | null; question: string; answer: string; sourceRefs: SourceRefInput[] }) => normalizeKnowledge(await post<unknown>('/knowledge', body)),
  updateKnowledge: async (id: string, body: Partial<{ projectId: string | null; question: string; answer: string; sourceRefs: SourceRefInput[]; status: 'draft' | 'needs_recheck' | 'archived' }>, revision?: number) => normalizeKnowledge(await patch<unknown>(`/knowledge/${id}`, versioned(`/knowledge/${id}`, body, revision))),
  knowledgeDecision: async (id: string, decision: 'accept' | 'reject', revision?: number) => normalizeKnowledge(await post<unknown>(`/knowledge/${id}/decision`, versioned(`/knowledge/${id}`, { decision }, revision))),
  syncKnowledge: async (id: string, revision?: number) => normalizeJob(await post<unknown>(`/knowledge/${id}/sync`, versioned(`/knowledge/${id}`, {}, revision))),
  importSource: async (body: { kind: 'siyuan_document' | 'siyuan_block' | 'feishu_document'; documentId?: string; blockId?: string; url?: string; projectId: string | null; extractCandidates?: boolean }) => normalizeJob(await post<unknown>('/sources/import', body)),
  codexThreads: () => get<ListData<CodexThread>>('/codex/threads'),
  discoverCodexThreads: () => get<ListData<CodexThread>>('/codex/discovery?days=7&limit=20'),
  codexScope: () => get<CodexScope>('/connections/codex/scope'),
  saveCodexScope: (body: CodexScopeInput, revision?: number) => put<CodexScope>('/connections/codex/scope', versioned('/connections/codex/scope', body, revision)),
  syncCodex: async (threadIds?: string[]) => normalizeJob(await post<unknown>('/codex/sync', { ...(threadIds?.length ? { threadIds } : {}) })),
  importManualDialogue: async (body: ManualDialogueInput) => normalizeJob(await post<unknown>('/codex/manual-import', body)),
  job: async (id: string) => normalizeJob(await get<unknown>(`/jobs/${id}`)),
  waitForJob,
  createReviewSession: async (body: { projectId: string | null; limit: number }) => post<ReviewSession>('/review-sessions', body),
  reviewNext: async (id: string) => normalizeReviewPrompt(await get<unknown>(`/review-sessions/${id}/next`)),
  revealReview: async (id: string, presentationId: string, cardId: string) => normalizeReviewAnswer(await post<unknown>(`/review-sessions/${id}/reveal`, { presentationId, cardId })),
  rateReview: async (id: string, presentationId: string, cardId: string, rating: 'again' | 'hard' | 'good' | 'easy', submissionId: string, elapsedMs = 0, answer?: string) => {
    const ack = await post<JobAck>(`/review-sessions/${id}/responses`, { presentationId, cardId, rating, elapsedMs, ...(answer !== undefined ? { answer } : {}), operationId: submissionId });
    await waitForJob(ack);
  },
  practices: async () => normalizePracticeList(await get<ListData<unknown>>('/practices')),
  practiceAttempts: async (practiceId: string) => {
    const result = await get<ListData<unknown>>(`/practices/${practiceId}/attempts`);
    return { items: result.items.map(normalizeAttempt), total: result.total };
  },
  attemptPractice: async (id: string, body: { output: string; assistanceLevel: PracticeAttempt['assistanceLevel']; evidenceRefs: EvidenceRef[] }) => normalizeAttempt(await post<unknown>(`/practices/${id}/attempts`, body)),
  feedback: async (attemptId: string, practiceId: string, mode: 'template' | 'model' = 'template'): Promise<Feedback> => {
    const ack = await post<JobAck>(`/attempts/${attemptId}/feedback`, { mode, ...(mode === 'model' ? { allowTemplateFallback: true } : {}) });
    await waitForJob(ack);
    const attempts = await api.practiceAttempts(practiceId);
    const attempt = attempts.items.find((item) => item.id === attemptId);
    if (!attempt?.feedback) throw new ApiError('INVALID_RESPONSE', '反馈任务已完成，但未能读取该次尝试的反馈，请重新加载后核对。');
    return attempt.feedback;
  },
  outputs: () => get<ListData<Output>>('/outputs'),
  createOutput: (body: OutputInput) => post<Output>('/outputs', body),
  updateOutput: (id: string, body: Partial<OutputInput>, revision?: number) => patch<Output>(`/outputs/${id}`, versioned(`/outputs/${id}`, body, revision)),
  profile: async () => normalizeProfile(await get<unknown>('/learning-profile')),
  saveProfile: (body: LearningProfileInput, revision?: number) => put<LearningProfile>('/learning-profile', versioned('/learning-profile', body, revision)),
  connections: async () => normalizeConnections(await get<unknown>('/connections')),
  saveSiyuan: (body: SiyuanInput, revision?: number) => put<unknown>('/connections/siyuan', versioned('/connections/siyuan', body, revision)),
  checkSiyuan: () => post<unknown>('/connections/siyuan/check'),
  notebooks: () => get<ListData<{ id: string; name: string }>>('/siyuan/notebooks'),
  settings: () => get<Settings>('/settings'),
  saveSettings: (body: SettingsInput, revision?: number) => put<Settings>('/settings', versioned('/settings', body, revision)),
  feishuChat: () => get<FeishuChatStatus>('/feishu-chat'),
  feishuChatEntry: () => get<FeishuChatEntry>('/feishu-chat/entry'),
  feishuRegistration: () => get<FeishuRegistrationStatus>('/feishu-chat/registration'),
  startFeishuRegistration: (id = operationId()) => post<FeishuRegistrationStatus>('/feishu-chat/registration', { operationId: id }),
  feishuCardRegistration: () => get<FeishuRegistrationStatus>('/feishu-chat/cards/registration'),
  startFeishuCardRegistration: (id = operationId()) => post<FeishuRegistrationStatus>('/feishu-chat/cards/registration', { operationId: id }),
  cancelFeishuCardRegistration: (id = operationId()) => post<FeishuRegistrationStatus>('/feishu-chat/cards/registration/cancel', { operationId: id }),
  saveFeishuChat: (body: FeishuChatInput, revision: number, id = operationId()) => put<FeishuChatStatus>('/feishu-chat', { operationId: id, expectedRevision: revision, enabled: body.enabled, remindersEnabled: body.remindersEnabled, reminderLocalTime: body.reminderLocalTime, ...(typeof body.cardsEnabled === 'boolean' ? { cardsEnabled: body.cardsEnabled } : {}) }),
  pairFeishuChat: (id = operationId()) => post<FeishuChatPair>('/feishu-chat/pair', { operationId: id }),
  sendFeishuToday: (id = operationId()) => post<FeishuChatSendToday>('/feishu-chat/send-today', { operationId: id }),
  exportDownload: async (scope: 'all' | 'projects' = 'all', projectIds: string[] = []) => {
    const artifact = await post<ExportArtifact>('/exports', { scope, projectIds, includeSourceContent: false });
    assertSafeExport(artifact);
    return artifact;
  },
};
