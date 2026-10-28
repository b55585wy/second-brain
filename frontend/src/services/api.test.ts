import { api } from './api';
import type { SettingsInput } from '../types';

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
