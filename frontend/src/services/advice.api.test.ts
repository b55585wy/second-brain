import { api } from './api';
import { normalizeToday } from './adapters';

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function mockFetch(data: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(data, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

const settings = { enabled: false, dailyCallLimit: 3, revision: 4, callsToday: 1, remainingToday: 2, modelConfigured: true };
const feedback = { id: 'f1', attemptId: 'a1', mode: 'model', basis: 'answer+rubric', summary: '建议摘要', observations: [], nextActions: [], limitations: [] };
const advice = { attemptId: 'a1', status: 'ready', jobId: null, feedback, message: '建议已准备好', canRequest: false, canRetry: true, lastError: null };

describe('自动点评线协议与适配', () => {
  it('advice-settings GET/PUT 使用独立路由、精确字段、修订与操作身份', async () => {
    const fetchMock = mockFetch({ data: settings });
    await expect(api.adviceSettings()).resolves.toEqual(settings);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/advice-settings', expect.objectContaining({ method: 'GET', body: undefined }));

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ...settings, enabled: true, dailyCallLimit: 20, revision: 5 } }));
    await expect(api.saveAdviceSettings({ enabled: true, dailyCallLimit: 20 }, 4, 'operation-advice-settings')).resolves.toMatchObject({ revision: 5, dailyCallLimit: 20 });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/advice-settings', expect.objectContaining({ method: 'PUT' }));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ operationId: 'operation-advice-settings', expectedRevision: 4, enabled: true, dailyCallLimit: 20 });
  });

  it('advice GET 与显式 POST 直接返回 AdviceState，不轮询 job，retry 仅在需要时发送', async () => {
    const fetchMock = mockFetch({ data: { ...advice, status: 'idle', feedback: null, canRequest: true } });
    await expect(api.advice('a/1')).resolves.toMatchObject({ attemptId: 'a1', status: 'idle' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/attempts/a%2F1/advice');

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: advice }));
    await expect(api.requestAdvice('a1', 'operation-advice-retry', true)).resolves.toMatchObject({ status: 'ready', feedback });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ operationId: 'operation-advice-retry', retry: true });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/jobs/'))).toBe(false);
  });

  it('普通显式请求复用调用方 operationId 且不伪造 retry 字段', async () => {
    const fetchMock = mockFetch({ data: { ...advice, status: 'queued', feedback: null } });
    await api.requestAdvice('a1', 'same-ambiguous-operation');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ operationId: 'same-ambiguous-operation' });
  });

  it('advice-settings 较低修订 GET 不撤销较新 PUT 的修订缓存', async () => {
    const fetchMock = mockFetch({ data: { ...settings, enabled: true, dailyCallLimit: 8, revision: 12 } });
    await api.saveAdviceSettings({ enabled: true, dailyCallLimit: 8 }, 11, 'operation-advice-newer');
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ...settings, revision: 11 } }));
    await api.adviceSettings();
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ...settings, enabled: true, dailyCallLimit: 9, revision: 13 } }));
    await api.saveAdviceSettings({ enabled: true, dailyCallLimit: 9 }, undefined, 'operation-advice-after-old-get');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ operationId: 'operation-advice-after-old-get', expectedRevision: 12, enabled: true, dailyCallLimit: 9 });
  });

  it('既有学习档案保留后发响应覆盖修订缓存的语义', async () => {
    const profile = { goals: ['目标'], careerDirection: '', skills: [], dailyBudgetMinutes: 15, timeZone: 'Asia/Shanghai' };
    const fetchMock = mockFetch({ data: { ...profile, revision: 22 } });
    await api.saveProfile(profile, 21);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ...profile, revision: 21 } }));
    await api.profile();
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ...profile, revision: 23 } }));
    await api.saveProfile(profile);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).expectedRevision).toBe(21);
  });

  it('legacy Today 缺少可选字段时保持缺失，不虚构功能支持', () => {
    const raw = { date: '2026-10-30', profile: { goals: [], revision: 1 }, automation: { revision: 1 }, highlights: [], practice: null, attempt: null, generatedAt: null };
    const normalized = normalizeToday(raw);
    expect(normalized).not.toHaveProperty('adviceSettings');
    expect(normalized).not.toHaveProperty('advice');
  });

  it('存在的 Today 可选字段按真实 DTO 归一化，advice:null 保持 null', () => {
    const raw = { date: '2026-10-30', profile: { goals: [], revision: 1 }, automation: { revision: 1 }, highlights: [], practice: null, attempt: null, generatedAt: null, adviceSettings: settings, advice: null };
    const normalized = normalizeToday(raw);
    expect(normalized.adviceSettings).toEqual(settings);
    expect(normalized.advice).toBeNull();
    expect(normalizeToday({ ...raw, advice: { ...advice, lastError: { code: 'X', message: '失败', retryable: true } } }).advice?.lastError).toEqual({ code: 'X', message: '失败', retryable: false });
  });
});
