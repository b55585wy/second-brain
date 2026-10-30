import { api } from './api';
import { normalizeAttempt } from './adapters';
import type { AssistanceLevel, SettingsInput } from '../types';

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function mockFetch(data: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(data, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

describe('API transport 与公共 DTO', () => {
  it('返回服务端错误信息而不是伪造成功', async () => {
    mockFetch({ error: { code: 'OFFLINE', message: '思源未连接', retryable: true } }, 503);
    await expect(api.dashboard()).rejects.toMatchObject({ code: 'OFFLINE', message: '思源未连接', retryable: true });
  });

  it('所有写请求自动携带 operationId、本地客户端头与 JSON 头', async () => {
    const fetchMock = mockFetch({ data: { projectId: 'p-delete', status: 'archived', revision: 2 } });
    await api.deleteProject('p-delete', 2);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ expectedRevision: 2 });
    expect(body.operationId).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['X-Second-Brain-Client']).toBe('local-ui');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('决策保留真实结构化来源，不把对象压成文本或伪造新身份', async () => {
    const source = { sourceId: 'src-1', kind: 'manual', title: '内部来源', excerpt: '公开摘录', url: null };
    const fetchMock = mockFetch({ data: { id: 'k1', question: '问题', answer: '答案', projectId: null, status: 'accepted', revision: 5, sourceRefs: [source] } });
    const result = await api.knowledgeDecision('k1', 'accept', 4);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ decision: 'accept', expectedRevision: 4 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).operationId).toBeTruthy();
    expect(result.sourceRefs).toEqual([source]);
  });

  it('知识查询使用 q，导出使用真实 content 而不是下载 URL', async () => {
    let fetchMock = mockFetch({ data: { items: [], total: 0 } });
    await api.knowledge('q=索引&status=draft');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/knowledge?q=索引&status=draft');
    const artifact = { filename: 'second-brain-test.json', mediaType: 'application/json', schemaVersion: 'second-brain.export.v1', content: JSON.stringify({ schemaVersion: 'second-brain.export.v1', data: {} }), byteLength: 50, sha256: 'abc' };
    fetchMock = mockFetch({ data: artifact });
    await expect(api.exportDownload()).resolves.toEqual(artifact);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ scope: 'all', projectIds: [], includeSourceContent: false });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).operationId).toBeTruthy();
  });

  it('同步接受 jobId ack，连接读取实际分页记录', async () => {
    const fetchMock = mockFetch({ data: { jobId: 'job-1', operationId: 'op-1' } });
    await expect(api.syncCodex()).resolves.toMatchObject({ id: 'job-1', status: 'queued' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).operationId).toBeTruthy();
    mockFetch({ data: { items: [{ kind: 'siyuan', configured: true, status: 'connected', revision: 3 }], total: 1 } });
    await expect(api.connections()).resolves.toEqual([expect.objectContaining({ provider: 'siyuan', configured: true, connected: true, status: 'connected', revision: 3 })]);
  });

  it('揭示自动生成 operationId，并绑定 presentationId/cardId', async () => {
    mockFetch({ data: { state: 'question', card: { presentationId: 'presentation-1', cardId: 'card-1', question: '问题' } } });
    await expect(api.reviewNext('session-1')).resolves.toMatchObject({ state: 'question', presentationId: 'presentation-1', cardId: 'card-1', prompt: '问题' });
    const fetchMock = mockFetch({ data: { cardId: 'card-1', answer: '答案', sourceRefs: [] } });
    await api.revealReview('session-1', 'presentation-1', 'card-1');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ presentationId: 'presentation-1', cardId: 'card-1' });
    expect(body.operationId).toBeTruthy();
  });

  it('档案和完整设置更新携带修订且不回显 configured 秘密标志', async () => {
    let fetchMock = mockFetch({ data: { goals: [], careerDirection: '', skills: [], dailyBudgetMinutes: 15, timeZone: 'Asia/Shanghai', revision: 2 } });
    await api.saveProfile({ goals: [], careerDirection: '', skills: [], dailyBudgetMinutes: 15, timeZone: 'Asia/Shanghai' }, 1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ expectedRevision: 1 });
    const settings: SettingsInput = {
      model: { enabled: false, provider: 'openai-compatible', endpoint: null, model: null, allowExternalProcessing: false },
      feishu: { enabled: false, appId: null, apiBase: 'https://open.feishu.cn' },
      scheduler: { enabled: false, codexSyncEnabled: false, dailyPlanEnabled: false, codexSyncIntervalMinutes: 60, dailyPlanLocalTime: '09:00', catchUpEnabled: false },
    };
    fetchMock = mockFetch({ data: { ...settings, revision: 2 } });
    await api.saveSettings(settings, 1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ expectedRevision: 1, ...settings });
    expect(body.model).not.toHaveProperty('apiKeyConfigured');
    expect(body.feishu).not.toHaveProperty('appSecretConfigured');
  });

  it('按固定七天二十条参数发现 Codex 元数据并解包真实响应', async () => {
    const data = { items: [{ id: 'thread-1', title: '近期讨论', projectPath: 'D:/project', updatedAt: '2026-10-27T10:00:00Z', allowed: false }], total: 1 };
    const fetchMock = mockFetch({ data, requestId: 'request-1' });
    await expect(api.discoverCodexThreads()).resolves.toEqual(data);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/codex/discovery?days=7&limit=20', expect.objectContaining({ method: 'GET', body: undefined }));
  });
});


describe('Today 与自动化线协议', () => {
  const automation = { enabled: false, revision: 6, state: 'ready', message: '可开启', setup: { profile: true, scope: true, model: true }, dailyCallLimit: 3, callsToday: 0, nextRunAt: null, lastSuccessAt: null, lastError: null };

  it('automation GET 与 PUT 只发送 operationId、显式 expectedRevision 和 enabled', async () => {
    const fetchMock = mockFetch({ data: automation });
    await expect(api.automation()).resolves.toMatchObject({ revision: 6, state: 'ready' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ...automation, enabled: true, revision: 7 } }));
    await expect(api.saveAutomation(true, 6, 'operation-auto')).resolves.toMatchObject({ enabled: true, revision: 7 });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/automation');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ operationId: 'operation-auto', expectedRevision: 6, enabled: true });
  });

  it('Today 原始嵌套 DTO 走标准适配器并缓存修订，后续尝试和模板反馈保持原协议', async () => {
    const source = { sourceId: 'source-1', kind: 'manual', title: '原始来源', excerpt: '摘录', url: null };
    const rawAttempt = { id: 'attempt-1', practiceId: 'practice-1', output: '原始输出', assistanceLevel: 'none', evidenceRefs: [], revision: 2, feedback: null };
    const rawPractice = { id: 'practice-1', prompt: '没有 title 的原始练习', goal: '真实目标', skill: '技能', kind: 'explanation', projectId: null, sourceRefs: [source], rubric: [], revision: 9 };
    const rawToday = { date: '2026-10-28', profile: { goals: ['真实目标'], careerDirection: '', skills: [], dailyBudgetMinutes: 15, timeZone: 'Asia/Shanghai', revision: 5 }, automation, highlights: [{ id: 'h1', title: '重点', summary: '摘要', goal: '真实目标', whyRelevant: '相关', sourceRefs: [source] }], practice: rawPractice, attempt: rawAttempt, generatedAt: null };
    const fetchMock = mockFetch({ data: rawToday });
    const normalized = await api.today();
    expect(normalized.practice?.title).toBe('真实目标');
    expect(normalized.practice?.prompt).toBe('没有 title 的原始练习');
    expect(normalized.profile.revision).toBe(5);
    expect(normalized.attempt?.output).toBe('原始输出');
    expect(normalized.highlights[0].sourceRefs).toEqual([source]);

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: rawAttempt }));
    await api.attemptPractice('practice-1', { output: '新输出', assistanceLevel: 'none', evidenceRefs: [] });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ output: '新输出', assistanceLevel: 'none', evidenceRefs: [], operationId: expect.any(String) });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).operationId).toBeTruthy();

    const savedFeedback = { id: 'feedback-1', attemptId: 'attempt-1', mode: 'template', basis: 'rubric', summary: '模板反馈', observations: [], nextActions: [], limitations: ['未核验'] };
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { jobId: 'job-feedback', operationId: 'op-feedback' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'job-feedback', status: 'succeeded' } }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { items: [{ ...rawAttempt, feedback: savedFeedback }], total: 1 } }));
    await expect(api.feedback('attempt-1', 'practice-1', 'template')).resolves.toEqual(savedFeedback);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ mode: 'template', operationId: expect.any(String) });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty('allowTemplateFallback');
    expect(fetchMock.mock.calls[4][0]).toBe('/api/v1/practices/practice-1/attempts');
  });

  it('Today 的原始档案修订用于未显式传修订的 saveProfile', async () => {
    const profile = { goals: ['缓存目标'], careerDirection: '', skills: [], dailyBudgetMinutes: 20, timeZone: 'Asia/Shanghai', revision: 41 };
    const rawToday = { date: '2026-10-28', profile, automation, highlights: [], practice: null, attempt: null, generatedAt: null };
    const fetchMock = mockFetch({ data: rawToday });
    await api.today();
    const input = { goals: ['更新目标'], careerDirection: '', skills: [], dailyBudgetMinutes: 20, timeZone: 'Asia/Shanghai' };
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ...input, revision: 42 } }));
    await api.saveProfile(input);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/learning-profile');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ ...input, expectedRevision: 41, operationId: expect.any(String) });
  });
});

describe('飞书学习固定线协议', () => {
  const rawStatus = {
    enabled: true,
    revision: 17,
    remindersEnabled: true,
    reminderLocalTime: '20:30',
    bound: true,
    configured: true,
    lastReceivedAt: null,
    lastSentAt: null,
    state: 'ready',
    lastError: null,
    snoozedUntil: null,
    pendingMessages: [{ opaque: 'synthetic' }],
    connection: { state: 'connected', message: '已连接', lastError: null },
  };

  it('GET 只读并返回原始 FeishuChatStatus', async () => {
    const fetchMock = mockFetch({ data: rawStatus });
    await expect(api.feishuChat()).resolves.toEqual(rawStatus);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/feishu-chat', expect.objectContaining({ method: 'GET', body: undefined }));
  });

  it('entry GET 只读，无 body 或 operationId，并返回服务端原始入口', async () => {
    const entry = { url: 'https://applink.feishu.cn/client/bot/open?appId=cli_synthetic', qrDataUrl: 'data:image/png;base64,SYNTHETIC' };
    const fetchMock = mockFetch({ data: entry });
    await expect(api.feishuChatEntry()).resolves.toEqual(entry);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/feishu-chat/entry', expect.objectContaining({ method: 'GET', body: undefined }));
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Content-Type');
  });

  it('registration GET 只读，显式 POST body 只有 operationId', async () => {
    const registration = { state: 'waiting', url: 'https://example.test/auth', qrDataUrl: 'data:image/png;base64,SYNTHETIC', expiresAt: '2099-01-01T00:00:00.000Z', message: '请扫码', error: null };
    const fetchMock = mockFetch({ data: registration });
    await expect(api.feishuRegistration()).resolves.toEqual(registration);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/feishu-chat/registration', expect.objectContaining({ method: 'GET', body: undefined }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: registration }));
    await expect(api.startFeishuRegistration('operation-registration')).resolves.toEqual(registration);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/feishu-chat/registration', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ operationId: 'operation-registration' });
  });

  it('cards registration GET 只读，显式 start/cancel POST body 各自只有 operationId', async () => {
    const registration = { state: 'waiting', url: 'https://example.test/cards/auth', qrDataUrl: 'data:image/png;base64,SYNTHETIC', expiresAt: '2099-01-01T00:00:00.000Z', message: '请扫码', error: null };
    const fetchMock = mockFetch({ data: registration });
    await expect(api.feishuCardRegistration()).resolves.toEqual(registration);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/feishu-chat/cards/registration', expect.objectContaining({ method: 'GET', body: undefined }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: registration }));
    await expect(api.startFeishuCardRegistration('operation-card-start')).resolves.toEqual(registration);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/feishu-chat/cards/registration', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ operationId: 'operation-card-start' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ...registration, state: 'idle' } }));
    await expect(api.cancelFeishuCardRegistration('operation-card-cancel')).resolves.toEqual({ ...registration, state: 'idle' });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/feishu-chat/cards/registration/cancel', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ operationId: 'operation-card-cancel' });
  });

  it('PUT 只在提供时附加 cardsEnabled，旧字段保持原样', async () => {
    const fetchMock = mockFetch({ data: { ...rawStatus, cardsEnabled: false } });
    await api.saveFeishuChat({ enabled: true, remindersEnabled: true, reminderLocalTime: '20:30', cardsEnabled: false }, 16, 'operation-chat-cards');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ operationId: 'operation-chat-cards', expectedRevision: 16, enabled: true, remindersEnabled: true, reminderLocalTime: '20:30', cardsEnabled: false });
  });

  it('PUT 只发送 operationId、独立 expectedRevision 和三个配置字段', async () => {
    const fetchMock = mockFetch({ data: rawStatus });
    await api.saveFeishuChat({ enabled: true, remindersEnabled: true, reminderLocalTime: '20:30' }, 16, 'operation-chat-save');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/feishu-chat', expect.objectContaining({ method: 'PUT' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ operationId: 'operation-chat-save', expectedRevision: 16, enabled: true, remindersEnabled: true, reminderLocalTime: '20:30' });
  });

  it('pair 与 send-today 的 POST body 各自只有 operationId', async () => {
    let fetchMock = mockFetch({ data: { code: 'TEST42', expiresAt: '2026-10-29T12:00:00.000Z' } });
    await expect(api.pairFeishuChat('operation-pair')).resolves.toEqual({ code: 'TEST42', expiresAt: '2026-10-29T12:00:00.000Z' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/feishu-chat/pair', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ operationId: 'operation-pair' });
    fetchMock = mockFetch({ data: { queued: true, alreadySent: false, practiceId: 'practice-synthetic' } });
    await expect(api.sendFeishuToday('operation-send')).resolves.toEqual({ queued: true, alreadySent: false, practiceId: 'practice-synthetic' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/feishu-chat/send-today', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ operationId: 'operation-send' });
  });

  it('现有归一化保留类型有效的 unknown 辅助程度', () => {
    const incoming: AssistanceLevel = 'unknown';
    const normalized = normalizeAttempt({ id: 'attempt-synthetic', practiceId: 'practice-synthetic', output: '合成输出', assistanceLevel: incoming, evidenceRefs: [] });
    expect(normalized.assistanceLevel).toBe('unknown');
  });
});
