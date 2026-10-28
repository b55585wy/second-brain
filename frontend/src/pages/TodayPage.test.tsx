import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TodayPage } from './TodayPage';
import { api } from '../services/api';
import type { DailyPlan, LearningProfile } from '../types';
import { dateInTimeZone } from '../utils/text';

vi.mock('../services/api', () => ({ api: { dashboard: vi.fn(), dailyPlan: vi.fn(), generateDailyPlan: vi.fn() } }));

const profile = (dailyBudgetMinutes: number, timeZone = 'Asia/Shanghai'): LearningProfile => ({ goals: ['真实目标'], careerDirection: '', skills: [], dailyBudgetMinutes, timeZone, revision: 2 });
const plan = (date: string, dailyBudgetMinutes: number, timeZone = 'Asia/Shanghai'): DailyPlan => ({ id: null, revision: 0, date, timeZone, profileRevision: null, budgetMinutes: dailyBudgetMinutes, scheduledMinutes: 0, unallocatedMinutes: dailyBudgetMinutes, reviewDueCount: null, items: [], status: 'not_generated' });

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('今日日期与嵌套 DTO', () => {
  it('同一跨午夜时刻按配置时区而非浏览器时区决定日期', () => {
    const instant = new Date('2026-10-27T16:30:00.000Z');
    expect(dateInTimeZone('Asia/Shanghai', instant)).toBe('2026-10-28');
    expect(dateInTimeZone('America/Los_Angeles', instant)).toBe('2026-10-27');
  });

  it('缺少服务端日期时按 profile 时区请求计划，并接受 0 预算暂停', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T16:30:00.000Z'));
    vi.mocked(api.dashboard).mockResolvedValue({
      timeZone: 'Asia/Shanghai', profile: profile(0), goals: ['真实目标'], reviewDueCount: null, dailyBudgetMinutes: 0,
      dailyPlan: null, limitations: [],
    });
    vi.mocked(api.dailyPlan).mockResolvedValue(plan('2026-10-28', 0));
    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    expect(await screen.findByText('今日学习已暂停')).toBeVisible();
    expect(api.dailyPlan).toHaveBeenCalledWith('2026-10-28');
    expect(screen.getByText('真实目标')).toBeVisible();
    expect(screen.getByRole('button', { name: '今日计划已暂停' })).toBeDisabled();
  });

  it('没有目标时下一步只提供设置目标入口，不显示或调用计划生成', async () => {
    vi.mocked(api.dashboard).mockResolvedValue({
      date: '2026-10-27', timeZone: 'Asia/Shanghai', profile: { ...profile(15), goals: [] }, goals: [], reviewDueCount: null, dailyBudgetMinutes: 15,
      dailyPlan: plan('2026-10-27', 15), limitations: [],
    });
    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: '先设置学习目标' })).toBeVisible();
    expect(screen.getByRole('link', { name: '设置学习目标' })).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('button', { name: '生成今日计划' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重新安排今天' })).toBeNull();
    expect(api.generateDailyPlan).not.toHaveBeenCalled();
  });

  it('已配置目标时保留带真实档案和计划修订的生成操作', async () => {
    const currentPlan = plan('2026-10-27', 15);
    vi.mocked(api.dashboard).mockResolvedValue({
      date: '2026-10-27', timeZone: 'Asia/Shanghai', profile: profile(15), goals: ['真实目标'], reviewDueCount: null, dailyBudgetMinutes: 15,
      dailyPlan: currentPlan, limitations: [],
    });
    vi.mocked(api.generateDailyPlan).mockResolvedValue({ ...currentPlan, revision: 1, status: 'ready' });
    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    const generate = await screen.findByRole('button', { name: '重新安排今天' });
    generate.click();
    await waitFor(() => expect(api.generateDailyPlan).toHaveBeenCalledWith('2026-10-27', 2, 0));
  });

  it('服务端 dashboard.date 优先，未知到期数显示连接状态而不是零', async () => {
    vi.mocked(api.dashboard).mockResolvedValue({
      date: '2026-10-28', timeZone: 'America/Los_Angeles', profile: profile(15, 'America/Los_Angeles'), goals: ['真实目标'], reviewDueCount: null,
      dailyPlan: plan('2026-10-28', 15, 'America/Los_Angeles'), limitations: [], connections: [{ provider: 'siyuan', configured: false, status: 'not_configured' }],
    });
    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    expect(await screen.findByText(/2026年10月28日/)).toBeVisible();
    expect(api.dailyPlan).not.toHaveBeenCalled();
    expect(screen.getByText(/尚未获得真实到期数量/)).toBeVisible();
    expect(screen.queryByText('当前没有待复习知识。')).toBeNull();
  });
});
