import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from './SettingsPage';
import { api } from '../services/api';
import type { Settings } from '../types';

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return { ...actual, api: {
    profile: vi.fn(), connections: vi.fn(), settings: vi.fn(), saveSettings: vi.fn(), saveSiyuan: vi.fn(), saveProfile: vi.fn(), exportDownload: vi.fn(), checkSiyuan: vi.fn(), notebooks: vi.fn(),
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
  vi.mocked(api.saveSettings).mockResolvedValue(settings);
});

describe('实际设置 DTO 与秘密省略', () => {
  it('发送完整新版设置并在空秘密时省略秘密键', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);
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
