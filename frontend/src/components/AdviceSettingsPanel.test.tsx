import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdviceSettingsPanel } from './AdviceSettingsPanel';
import { api } from '../services/api';
import type { AdviceSettings } from '../types';

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return { ...actual, api: { ...actual.api, adviceSettings: vi.fn(), saveAdviceSettings: vi.fn() } };
});

const settings = (overrides: Partial<AdviceSettings> = {}): AdviceSettings => ({ enabled: false, dailyCallLimit: 3, revision: 4, callsToday: 1, remainingToday: 2, modelConfigured: true, ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.adviceSettings).mockResolvedValue(settings());
  vi.mocked(api.saveAdviceSettings).mockImplementation(async (body, revision) => settings({ ...body, revision: (revision ?? 4) + 1 }));
});

describe('独立自动点评设置', () => {
  it('挂载仅 GET，展示真实用量和模型配置，保存只提交自身字段与修订', async () => {
    const user = userEvent.setup();
    render(<AdviceSettingsPanel />);
    const limit = await screen.findByLabelText('每日点评上限（0–20 次）');
    expect(limit).toHaveValue(3);
    expect(screen.getByText('今日已用 1 次 · 剩余 2 次')).toBeVisible();
    expect(screen.getByText('模型已配置')).toBeVisible();
    expect(api.adviceSettings).toHaveBeenCalledTimes(1);
    expect(api.saveAdviceSettings).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText('启用新回答自动点评'));
    await user.click(screen.getByRole('button', { name: '保存自动点评' }));
    await waitFor(() => expect(api.saveAdviceSettings).toHaveBeenCalledWith({ enabled: true, dailyCallLimit: 3 }, 4));
    expect(await screen.findByText('自动点评设置已保存。')).toBeVisible();
  });

  it.each([0, 20])('接受边界每日上限 %i', async (dailyCallLimit) => {
    const user = userEvent.setup();
    render(<AdviceSettingsPanel />);
    const limit = await screen.findByLabelText('每日点评上限（0–20 次）');
    await user.clear(limit);
    await user.type(limit, String(dailyCallLimit));
    await user.click(screen.getByRole('button', { name: '保存自动点评' }));
    await waitFor(() => expect(api.saveAdviceSettings).toHaveBeenCalledWith({ enabled: false, dailyCallLimit }, 4));
  });

  it.each(['', '-1', '21', '1.5'])('拒绝无效每日上限 %s 并保留草稿', async (value) => {
    render(<AdviceSettingsPanel />);
    const limit = await screen.findByLabelText('每日点评上限（0–20 次）');
    fireEvent.change(limit, { target: { value } });
    const form = limit.closest('form') as HTMLFormElement;
    fireEvent.submit(form);
    expect(await screen.findByText(/每日点评上限需为 0–20 的整数/)).toBeVisible();
    expect(api.saveAdviceSettings).not.toHaveBeenCalled();
    expect(limit).toHaveValue(value === '' ? null : Number(value));
  });

  it('GET 刷新失败与修订冲突都局部提示并保留未保存草稿', async () => {
    const user = userEvent.setup();
    vi.mocked(api.adviceSettings).mockResolvedValueOnce(settings()).mockRejectedValueOnce(new Error('刷新离线'));
    vi.mocked(api.saveAdviceSettings).mockRejectedValueOnce(new Error('修订冲突，请刷新'));
    render(<AdviceSettingsPanel />);
    const limit = await screen.findByLabelText('每日点评上限（0–20 次）');
    await user.clear(limit);
    await user.type(limit, '12');
    await user.click(screen.getByRole('button', { name: '刷新自动点评' }));
    expect(await screen.findByText('刷新离线')).toBeVisible();
    expect(limit).toHaveValue(12);
    await user.click(screen.getByRole('button', { name: '保存自动点评' }));
    expect(await screen.findByText('修订冲突，请刷新')).toBeVisible();
    expect(limit).toHaveValue(12);
  });

  it('显式刷新采用新来源和用量，同时保留 dirty 字段', async () => {
    const user = userEvent.setup();
    vi.mocked(api.adviceSettings).mockResolvedValueOnce(settings()).mockResolvedValueOnce(settings({ enabled: true, dailyCallLimit: 2, revision: 5, callsToday: 8, remainingToday: 12 }));
    render(<AdviceSettingsPanel />);
    const limit = await screen.findByLabelText('每日点评上限（0–20 次）');
    await user.clear(limit);
    await user.type(limit, '9');
    await user.click(screen.getByRole('button', { name: '刷新自动点评' }));
    await waitFor(() => expect(screen.getByLabelText('启用新回答自动点评')).toBeChecked());
    expect(limit).toHaveValue(9);
    expect(screen.getByText('今日已用 8 次 · 剩余 12 次')).toBeVisible();
  });

  it('较低修订的迟到 GET 不撤销成功的 PUT', async () => {
    const user = userEvent.setup();
    let resolveOldGet: ((value: AdviceSettings) => void) | undefined;
    vi.mocked(api.adviceSettings).mockResolvedValueOnce(settings()).mockImplementationOnce(() => new Promise((resolve) => { resolveOldGet = resolve; }));
    vi.mocked(api.saveAdviceSettings).mockResolvedValueOnce(settings({ enabled: true, dailyCallLimit: 8, revision: 6, callsToday: 2, remainingToday: 6 }));
    render(<AdviceSettingsPanel />);
    const limit = await screen.findByLabelText('每日点评上限（0–20 次）');
    await user.click(screen.getByRole('button', { name: '刷新自动点评' }));
    await user.click(screen.getByLabelText('启用新回答自动点评'));
    await user.clear(limit);
    await user.type(limit, '8');
    await user.click(screen.getByRole('button', { name: '保存自动点评' }));
    expect(await screen.findByText('自动点评设置已保存。')).toBeVisible();
    await act(async () => { resolveOldGet?.(settings({ revision: 4 })); });
    expect(screen.getByLabelText('启用新回答自动点评')).toBeChecked();
    expect(limit).toHaveValue(8);
    expect(screen.getByText('今日已用 2 次 · 剩余 6 次')).toBeVisible();
  });
});
