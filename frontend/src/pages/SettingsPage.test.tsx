import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from './SettingsPage';
import { api } from '../services/api';
import type { Settings } from '../types';

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return { ...actual, api: {
    profile: vi.fn(), connections: vi.fn(), settings: vi.fn(), automation: vi.fn(), saveAutomation: vi.fn(), saveSettings: vi.fn(), saveSiyuan: vi.fn(), saveProfile: vi.fn(), exportDownload: vi.fn(), checkSiyuan: vi.fn(), notebooks: vi.fn(),
    adviceSettings: vi.fn(), saveAdviceSettings: vi.fn(),
    feishuChat: vi.fn(), feishuChatEntry: vi.fn(), feishuRegistration: vi.fn(), startFeishuRegistration: vi.fn(), saveFeishuChat: vi.fn(), pairFeishuChat: vi.fn(), sendFeishuToday: vi.fn(),
  } };
});

const settings: Settings = {
  revision: 3,
  model: { enabled: false, provider: 'openai-compatible', endpoint: 'http://127.0.0.1:11434/v1', model: 'local-model', allowExternalProcessing: false, apiKeyConfigured: true },
  feishu: { enabled: false, appId: 'cli_app', apiBase: 'https://open.feishu.cn', appSecretConfigured: true },
  scheduler: { enabled: true, codexSyncEnabled: true, dailyPlanEnabled: true, codexSyncIntervalMinutes: 90, dailyPlanLocalTime: '08:45', catchUpEnabled: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.profile).mockResolvedValue({ goals: [], careerDirection: '', skills: [], dailyBudgetMinutes: 0, timeZone: 'Asia/Shanghai', revision: 1 });
  vi.mocked(api.connections).mockResolvedValue([{ provider: 'siyuan', configured: true, status: 'unchecked', revision: 4, baseUrl: 'http://127.0.0.1:6806', notebookTitle: '第二大脑', tokenConfigured: true, configurationSource: 'manual' }, { provider: 'model', configured: true, status: 'unchecked' }]);
  vi.mocked(api.settings).mockResolvedValue(settings);
  vi.mocked(api.automation).mockResolvedValue({ enabled: false, revision: 8, state: 'off', message: '自动整理已关闭', setup: { profile: true, scope: true, model: true }, dailyCallLimit: 3, callsToday: 0, nextRunAt: null, lastSuccessAt: null, lastError: null });
  vi.mocked(api.saveAutomation).mockImplementation(async (enabled, revision) => ({ enabled, revision: revision + 1, state: enabled ? 'ready' : 'off', message: enabled ? '自动整理已开启' : '自动整理已关闭', setup: { profile: true, scope: true, model: true }, dailyCallLimit: 3, callsToday: 0, nextRunAt: null, lastSuccessAt: null, lastError: null }));
  vi.mocked(api.adviceSettings).mockResolvedValue({ enabled: false, dailyCallLimit: 3, revision: 2, callsToday: 0, remainingToday: 3, modelConfigured: true });
  vi.mocked(api.saveAdviceSettings).mockImplementation(async (body, revision) => ({ ...body, revision: (revision ?? 2) + 1, callsToday: 0, remainingToday: body.dailyCallLimit, modelConfigured: true }));
  vi.mocked(api.saveSettings).mockResolvedValue(settings);
  vi.mocked(api.feishuChat).mockResolvedValue({ enabled: true, revision: 12, remindersEnabled: false, reminderLocalTime: '09:30', bound: false, configured: true, lastReceivedAt: null, lastSentAt: null, connection: { state: 'connected', message: '机器人已连接', lastError: null } });
  vi.mocked(api.feishuChatEntry).mockResolvedValue({ url: null, qrDataUrl: null });
  vi.mocked(api.feishuRegistration).mockResolvedValue({ state: 'idle', url: null, qrDataUrl: null, expiresAt: null, message: '', error: null });
  vi.mocked(api.startFeishuRegistration).mockResolvedValue({ state: 'waiting', url: 'https://example.test/authorize', qrDataUrl: 'data:image/png;base64,SYNTHETIC', expiresAt: '2099-01-01T00:00:00.000Z', message: '请扫码', error: null });
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('实际设置 DTO 与秘密省略', () => {
  it('发送完整新版设置并在空秘密时省略秘密键', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);
    await user.click(await screen.findByText('模型服务（高级）'));
    await user.click(screen.getByText('飞书与定时任务（高级）'));
    expect(await screen.findByLabelText('API Base URL')).toHaveValue('http://127.0.0.1:11434/v1');
    expect(screen.getByLabelText('每日计划时间')).toHaveValue('08:45');
    expect(screen.getByLabelText('Codex 同步间隔（分钟）')).toHaveValue(90);
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    expect(screen.getByLabelText('飞书 App Secret')).toHaveValue('');
    await user.click(screen.getByLabelText('启用模型处理'));
    await user.click(screen.getByRole('button', { name: '保存模型设置' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(1));
    const [body, revision] = vi.mocked(api.saveSettings).mock.calls[0];
    expect(body.model).toEqual({ enabled: true, provider: 'openai-compatible', endpoint: 'http://127.0.0.1:11434/v1', model: 'local-model', allowExternalProcessing: false });
    expect(body.scheduler).toEqual(settings.scheduler);
    expect(body.feishu).toEqual({ enabled: false, appId: 'cli_app', apiBase: 'https://open.feishu.cn' });
    expect(body.model).not.toHaveProperty('apiKey');
    expect(body.feishu).not.toHaveProperty('appSecret');
    expect(revision).toBe(3);
  });

  it('思源保存发送运行时标记、笔记本和修订，空 token 不覆盖已有令牌', async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveSiyuan).mockResolvedValue(undefined);
    render(<SettingsPage />);
    expect(await screen.findByLabelText('服务地址')).toHaveValue('http://127.0.0.1:6806');
    await user.click(screen.getByRole('button', { name: '保存思源配置' }));
    await waitFor(() => expect(api.saveSiyuan).toHaveBeenCalledWith({ useRuntimeConnection: false, baseUrl: 'http://127.0.0.1:6806', notebookTitle: '第二大脑' }, 4));
    expect(screen.getByLabelText('访问令牌')).toHaveValue('');
  });
});


describe('独立自动整理与高级设置入口', () => {
  it('自动整理只发送自身状态和修订，不混入 scheduler 或 scope', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);
    const toggle = await screen.findByRole('switch', { name: '开启自动整理' });
    expect(screen.getByText('自动整理已关闭')).toBeVisible();
    await user.click(toggle);
    await waitFor(() => expect(api.saveAutomation).toHaveBeenCalledWith(true, 8));
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(settings.scheduler.enabled).toBe(true);
    expect(await screen.findByRole('switch', { name: '停用自动整理' })).toHaveAttribute('aria-checked', 'true');
  });

  it('#model 直接展开目标折叠，档案锚点保留且高级飞书默认折叠', async () => {
    window.history.replaceState(null, '', '/settings#model');
    render(<SettingsPage />);
    expect(await screen.findByLabelText('API Base URL')).toBeVisible();
    expect(document.getElementById('model')).toHaveAttribute('open');
    expect(document.getElementById('profile')).not.toBeNull();
    expect(screen.getByLabelText('飞书 App ID')).not.toBeVisible();
  });

  it('档案保存仍使用自身输入和修订', async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveProfile).mockResolvedValue({ goals: ['新目标'], careerDirection: '', skills: [], dailyBudgetMinutes: 20, timeZone: 'Asia/Shanghai', revision: 2 });
    render(<SettingsPage />);
    await user.type(await screen.findByLabelText('当前目标（每行一条）'), '新目标');
    await user.clear(screen.getByLabelText('每日预算（分钟）'));
    await user.type(screen.getByLabelText('每日预算（分钟）'), '20');
    await user.click(screen.getByRole('button', { name: '保存学习档案' }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith({ goals: ['新目标'], careerDirection: '', skills: [], dailyBudgetMinutes: 20, timeZone: 'Asia/Shanghai' }, 1));
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('#feishu 直接展开现有凭据表单且不创建第二个 Secret 表单', async () => {
    window.history.replaceState(null, '', '/settings#feishu');
    render(<SettingsPage />);
    expect(await screen.findByLabelText('飞书 App Secret')).toBeVisible();
    expect(document.getElementById('feishu')).toHaveAttribute('open');
    expect(screen.getAllByLabelText('飞书 App Secret')).toHaveLength(1);
    expect(screen.queryByLabelText(/open_id|chat_id/)).not.toBeInTheDocument();
  });

  it('未配置学习连接时链接通过 hash 导航展开既有高级表单', async () => {
    const user = userEvent.setup();
    vi.mocked(api.feishuChat).mockResolvedValue({ enabled: false, revision: 12, remindersEnabled: false, reminderLocalTime: '09:30', bound: false, configured: false, lastReceivedAt: null, lastSentAt: null, connection: { state: 'setup', message: '请配置应用', lastError: null } });
    render(<SettingsPage />);
    await user.click(await screen.findByRole('link', { name: '飞书 App ID 与 App Secret' }));
    await waitFor(() => expect(document.getElementById('feishu')).toHaveAttribute('open'));
    expect(screen.getByLabelText('飞书 App ID')).toBeVisible();
    expect(window.location.hash).toBe('#feishu');
  });

  it('飞书学习 GET 失败不阻断现有 App ID 与 Secret 编辑', async () => {
    const user = userEvent.setup();
    vi.mocked(api.feishuChat).mockRejectedValue(new Error('局部状态不可用'));
    render(<SettingsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('局部状态不可用');
    await user.click(screen.getByText('飞书与定时任务（高级）'));
    const appId = screen.getByLabelText('飞书 App ID');
    await user.clear(appId);
    await user.type(appId, 'cli_synthetic');
    expect(appId).toHaveValue('cli_synthetic');
    expect(screen.getByLabelText('飞书 App Secret')).toBeEnabled();
  });

  it('扫码完成原地刷新聊天和设置，保留提醒草稿并采用最新 enabled 与 revision', async () => {
    const user = userEvent.setup();
    const initial = { enabled: false, revision: 12, remindersEnabled: false, reminderLocalTime: '09:30', bound: false, configured: false, lastReceivedAt: null, lastSentAt: null, connection: { state: 'setup' as const, message: '请扫码设置应用', lastError: null } };
    const refreshed = { ...initial, enabled: true, configured: true, revision: 13, connection: { state: 'connecting' as const, message: '等待飞书连接', lastError: null } };
    vi.mocked(api.feishuChat).mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    vi.mocked(api.feishuChatEntry)
      .mockResolvedValueOnce({ url: null, qrDataUrl: null })
      .mockResolvedValueOnce({ url: 'https://applink.feishu.cn/client/bot/open?appId=cli_scanned', qrDataUrl: 'data:image/png;base64,SCANNED' });
    vi.mocked(api.feishuRegistration)
      .mockResolvedValueOnce({ state: 'waiting', url: 'https://example.test/authorize', qrDataUrl: 'data:image/png;base64,SYNTHETIC', expiresAt: '2099-01-01T00:00:00.000Z', message: '请扫码', error: null })
      .mockResolvedValueOnce({ state: 'complete', url: null, qrDataUrl: null, expiresAt: null, message: '扫码授权已完成', error: null });
    vi.mocked(api.settings).mockResolvedValueOnce(settings).mockResolvedValueOnce({ ...settings, revision: 4, feishu: { ...settings.feishu, appId: 'cli_scanned' } });
    vi.mocked(api.saveFeishuChat).mockImplementation(async (body, revision) => ({ ...refreshed, ...body, revision: revision + 1 }));
    render(<SettingsPage />);
    await act(async () => { await Promise.resolve(); });
    const time = await screen.findByLabelText('每日提醒时间');
    await user.clear(time);
    await user.type(time, '22:10');
    expect(await screen.findByText('等待飞书连接', {}, { timeout: 3500 })).toBeVisible();
    expect(screen.getByText('授权完成不代表飞书已经连接，请查看当前连接状态，并按提示完成账号绑定。')).toBeVisible();
    await waitFor(() => expect(api.settings).toHaveBeenCalledTimes(2));
    expect(time).toHaveValue('22:10');
    expect(await screen.findByRole('link', { name: '打开飞书私聊' })).toHaveAttribute('href', 'https://applink.feishu.cn/client/bot/open?appId=cli_scanned');
    expect(api.feishuChatEntry).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: '保存学习提醒' }));
    expect(api.saveFeishuChat).toHaveBeenCalledWith({ enabled: true, remindersEnabled: false, reminderLocalTime: '22:10' }, 13);
    await user.click(screen.getByText('飞书与定时任务（高级）'));
    expect(screen.getByLabelText('飞书 App ID')).toHaveValue('cli_scanned');
    expect(api.feishuRegistration).toHaveBeenCalledTimes(2);
    expect(api.startFeishuRegistration).not.toHaveBeenCalled();
    expect(api.settings).toHaveBeenCalledTimes(2);
  });
});
