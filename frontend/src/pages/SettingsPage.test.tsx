import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from './SettingsPage';
import { api } from '../services/api';
import type { Settings } from '../types';

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return { ...actual, api: {
    profile: vi.fn(), connections: vi.fn(), settings: vi.fn(), automation: vi.fn(), saveAutomation: vi.fn(), saveSettings: vi.fn(), saveSiyuan: vi.fn(), saveProfile: vi.fn(), exportDownload: vi.fn(), checkSiyuan: vi.fn(), notebooks: vi.fn(),
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
  vi.mocked(api.saveSettings).mockResolvedValue(settings);
  window.history.replaceState(null, '', '/');
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
});
