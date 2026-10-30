import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TodayPage } from './TodayPage';
import { api } from '../services/api';
import { normalizePractice } from '../services/adapters';
import type { AdviceSettings, AdviceState, Automation, Feedback, Practice, PracticeAttempt, TodayData } from '../types';

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return { ...actual, api: { ...actual.api, today: vi.fn(), saveAutomation: vi.fn(), attemptPractice: vi.fn(), feedback: vi.fn(), advice: vi.fn(), requestAdvice: vi.fn() } };
});

const automation = (overrides: Partial<Automation> = {}): Automation => ({
  enabled: true, revision: 4, state: 'ready', message: '今天的内容已准备好',
  setup: { profile: true, scope: true, model: true }, dailyCallLimit: 3, callsToday: 1,
  nextRunAt: null, lastSuccessAt: null, lastError: null, ...overrides,
});
const practice = (id = 'practice-1'): Practice => ({
  id, title: '解释索引', prompt: '用自己的话解释索引。', goal: '理解数据库', skill: '数据库', kind: 'explanation', projectId: null, revision: 3,
  sourceRefs: [{ sourceId: 'source-1', kind: 'manual', title: '索引笔记', excerpt: '原始摘录', url: null }],
  rubric: [{ id: 'rubric-1', label: '权衡', description: '说明读写权衡', expectedEvidence: ['一个例子'] }],
});
const feedback: Feedback = { id: 'feedback-1', attemptId: 'attempt-1', mode: 'template', basis: 'rubric', summary: '模板未判断正确性。', observations: [{ criterionId: 'rubric-1', finding: 'not_assessed', comment: '请自行核对。', evidenceRefs: [] }], nextActions: ['核对来源'], limitations: ['未验证事实'] };
const attempt = (overrides: Partial<PracticeAttempt> = {}): PracticeAttempt => ({ id: 'attempt-1', practiceId: 'practice-1', output: '已保存的解释', assistanceLevel: 'none', evidenceRefs: [], feedback: null, ...overrides });
const adviceSettings = (overrides: Partial<AdviceSettings> = {}): AdviceSettings => ({ enabled: true, dailyCallLimit: 3, revision: 2, callsToday: 0, remainingToday: 3, modelConfigured: true, ...overrides });
const modelFeedback = (attemptId = 'attempt-1'): Feedback => ({ id: `model-${attemptId}`, attemptId, mode: 'model', basis: '回答与评价要点', summary: '模型建议摘要', observations: [{ criterionId: 'rubric-1', finding: 'partial', comment: '答案提到“读写权衡”，还需补充例子。', evidenceRefs: [{ kind: 'output', id: attemptId, url: null, label: '本次回答' }] }], nextActions: ['补充一个查询例子'], limitations: ['建议未核验全部事实'] });
const adviceState = (overrides: Partial<AdviceState> = {}): AdviceState => ({ attemptId: 'attempt-1', status: 'idle', jobId: null, feedback: null, message: '可以请求 AI 建议', canRequest: false, canRetry: false, lastError: null, ...overrides });
const today = (overrides: Partial<TodayData> = {}): TodayData => ({
  date: '2026-10-28', profile: { goals: ['理解数据库'], careerDirection: '', skills: [], dailyBudgetMinutes: 15, timeZone: 'Asia/Shanghai', revision: 2 },
  automation: automation(), highlights: [], practice: null, attempt: null, generatedAt: null, ...overrides,
});
const highlight = (id: string) => ({ id, title: `重点 ${id}`, summary: '摘要', goal: '理解数据库', whyRelevant: '直接对应当前目标', sourceRefs: [{ sourceId: `source-${id}`, kind: 'manual', title: `来源 ${id}`, excerpt: '原文', url: null }] });

function renderToday() { return render(<MemoryRouter><TodayPage /></MemoryRouter>); }
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.today).mockResolvedValue(today());
});
afterEach(() => vi.useRealTimers());

describe('Today 服务端状态与设置入口', () => {
  it.each(['ready', 'collecting', 'organizing', 'waiting', 'limited', 'error'] as const)('%s 状态只显示后端消息，不产生写入或模型调用', async (state) => {
    vi.mocked(api.today).mockResolvedValue(today({ automation: automation({ state, message: `服务端 ${state} 消息` }) }));
    renderToday();
    expect(await screen.findByText(`服务端 ${state} 消息`)).toBeVisible();
    expect(api.saveAutomation).not.toHaveBeenCalled();
    expect(api.attemptPractice).not.toHaveBeenCalled();
    expect(api.feedback).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(0);
  });

  it.each([
    [{ profile: false, scope: false, model: false }, '先完善学习档案', '/settings#profile'],
    [{ profile: true, scope: false, model: false }, '选择可读取的对话', '/codex'],
    [{ profile: true, scope: true, model: false }, '配置模型服务', '/settings#model'],
  ])('设置缺失时只提供第一个入口 %s', async (setup, label, href) => {
    vi.mocked(api.today).mockResolvedValue(today({ automation: automation({ enabled: false, state: 'setup', setup, message: '需要完成设置' }) }));
    renderToday();
    expect(await screen.findByRole('link', { name: label })).toHaveAttribute('href', href);
    expect(screen.queryByRole('button', { name: '开启自动整理' })).toBeNull();
    expect(screen.getAllByRole('link').filter((link) => link.classList.contains('btn-primary'))).toHaveLength(1);
  });

  it('GET 失败提供重试且没有伪造学习内容', async () => {
    vi.mocked(api.today).mockRejectedValue(new Error('读取失败'));
    renderToday();
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByText('今日练习')).toBeNull();
    expect(api.saveAutomation).not.toHaveBeenCalled();
  });

  it('刷新失败保留最近重点、练习和后端状态', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.today).mockResolvedValueOnce(today({ highlights: [highlight('1')], practice: practice() })).mockRejectedValueOnce(new Error('暂时离线'));
    renderToday();
    expect(await screen.findByText('重点 1')).toBeVisible();
    await act(async () => vi.advanceTimersByTime(60000));
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.getByText('重点 1')).toBeVisible();
    expect(screen.getByText('用自己的话解释索引。')).toBeVisible();
    expect(screen.getByText('今天的内容已准备好')).toBeVisible();
  });

  it('自动整理一次提交使用 DTO 修订，pending 防重复，失败保留状态', async () => {
    const user = userEvent.setup();
    vi.mocked(api.today).mockResolvedValueOnce(today({ automation: automation({ enabled: false, state: 'off', revision: 11, message: '尚未开启' }) })).mockResolvedValue(today({ automation: automation({ enabled: true, revision: 12, message: '已开启' }) }));
    let resolveSave: ((value: Automation) => void) | undefined;
    vi.mocked(api.saveAutomation).mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; }));
    renderToday();
    const toggle = await screen.findByRole('button', { name: '开启自动整理' });
    await user.click(toggle);
    await user.click(toggle);
    expect(api.saveAutomation).toHaveBeenCalledTimes(1);
    expect(api.saveAutomation).toHaveBeenCalledWith(true, 11);
    resolveSave?.(automation({ enabled: true, revision: 12 }));
    await waitFor(() => expect(api.today).toHaveBeenCalledTimes(2));

    vi.mocked(api.saveAutomation).mockRejectedValueOnce(new Error('开关保存失败'));
    await user.click(await screen.findByRole('button', { name: '停用自动整理' }));
    expect(await screen.findByText('开关保存失败')).toBeVisible();
    expect(screen.getByRole('button', { name: '停用自动整理' })).toBeInTheDocument();
  });

  it('已配置且关闭自动整理、无练习时，开启操作是唯一主 CTA', async () => {
    vi.mocked(api.today).mockResolvedValue(today({ automation: automation({ enabled: false, state: 'off', message: '尚未开启' }) }));
    renderToday();
    const toggle = await screen.findByRole('button', { name: '开启自动整理' });
    expect(toggle).toHaveClass('btn-primary');
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(1);
  });
});

describe('Today 重点、预算与练习', () => {
  const rawPractice = {
    id: 'practice-raw', prompt: '请完整说明索引的作用，并举一个查询例子。', goal: '能够解释索引的用途', skill: '',
    kind: 'explanation', projectId: null, sourceRefs: [], rubric: [], revision: 7,
  };

  it('标准无 title DTO 经适配器后不重复目标，空技能不显示 eyebrow', async () => {
    const normalized = normalizePractice(rawPractice);
    expect(normalized.title).toBe(rawPractice.goal);
    vi.mocked(api.today).mockResolvedValue(today({ practice: normalized }));
    renderToday();
    expect(await screen.findByText(rawPractice.prompt)).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: '今日练习' })).toBeVisible();
    expect(screen.getByText(`目标：${rawPractice.goal}`)).toBeVisible();
    expect(screen.queryByRole('heading', { level: 3, name: rawPractice.goal })).toBeNull();
    expect(screen.getByText(rawPractice.prompt).closest('article')?.querySelector('.eyebrow')).toBeNull();
  });

  it.each([
    ['短完整提示', '用自己的话说明索引。'],
    ['60 字截断提示', '请解释索引如何影响读写性能，并结合一个具体查询说明取舍。'.repeat(4)],
  ])('%s 的适配器标题回退不渲染为 h3，完整提示仍显示', async (_label, prompt) => {
    const normalized = normalizePractice({ ...rawPractice, goal: '', prompt });
    expect(normalized.title).toBe(prompt.slice(0, 60));
    vi.mocked(api.today).mockResolvedValue(today({ practice: normalized }));
    renderToday();
    expect(await screen.findByText(prompt)).toBeVisible();
    expect(screen.queryByRole('heading', { level: 3, name: normalized.title })).toBeNull();
  });

  it('独立标题保留为 h3，非空技能单独显示为 eyebrow', async () => {
    const normalized = normalizePractice({ ...rawPractice, title: '设计适合查询的索引', skill: '数据库' });
    vi.mocked(api.today).mockResolvedValue(today({ practice: normalized }));
    renderToday();
    expect(await screen.findByRole('heading', { level: 3, name: '设计适合查询的索引' })).toBeVisible();
    expect(screen.getByText(rawPractice.prompt).closest('article')?.querySelector('.eyebrow')).toHaveTextContent('数据库');
    expect(screen.getByText(`目标：${rawPractice.goal}`)).toBeVisible();
  });

  it('重点最多三项且文本转义，来源可展开', async () => {
    const user = userEvent.setup();
    const unsafe = { ...highlight('unsafe'), title: '<img src=x onerror=alert(1)>', summary: '<script>不执行</script>' };
    vi.mocked(api.today).mockResolvedValue(today({ highlights: [unsafe, highlight('2'), highlight('3'), highlight('4')] }));
    renderToday();
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeVisible();
    expect(screen.queryByText('重点 4')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    await user.click(screen.getAllByText('查看来源')[0]);
    expect(screen.getByText('来源 unsafe')).toBeVisible();
  });

  it('零预算且无练习解释暂停，不生成练习', async () => {
    vi.mocked(api.today).mockResolvedValue(today({ profile: { ...today().profile, dailyBudgetMinutes: 0 } }));
    renderToday();
    expect(await screen.findByText('今日练习因预算暂停')).toBeVisible();
    expect(screen.getByText(/每日预算为 0 分钟/)).toBeVisible();
    expect(screen.queryByLabelText('你的输出')).toBeNull();
    expect(api.attemptPractice).not.toHaveBeenCalled();
  });

  it('选中练习直接显示，空输出禁用，失败保存保留草稿', async () => {
    const user = userEvent.setup();
    vi.mocked(api.today).mockResolvedValue(today({ practice: practice() }));
    vi.mocked(api.attemptPractice).mockRejectedValue(new Error('保存失败'));
    renderToday();
    expect(await screen.findByText('用自己的话解释索引。')).toBeVisible();
    expect(screen.getByRole('button', { name: '保存输出' })).toBeDisabled();
    await user.click(screen.getByText('评价要点与来源'));
    expect(screen.getByText('说明读写权衡')).toBeVisible();
    await user.type(screen.getByLabelText('你的输出'), '尚未保存的解释');
    await user.click(screen.getByRole('button', { name: '保存输出' }));
    expect(await screen.findByText('保存失败')).toBeVisible();
    expect(screen.getByLabelText('你的输出')).toHaveValue('尚未保存的解释');
    expect(localStorage.getItem('zhixing.todayDraft.practice-1')).toBe('尚未保存的解释');
    expect(api.feedback).not.toHaveBeenCalled();
  });

  it('保存后自动请求一次模板反馈；反馈失败不清除 durable 输出，只重试反馈', async () => {
    const user = userEvent.setup();
    vi.mocked(api.today).mockResolvedValue(today({ practice: practice() }));
    vi.mocked(api.attemptPractice).mockResolvedValue(attempt({ output: '确认保存的输出' }));
    vi.mocked(api.feedback).mockRejectedValueOnce(new Error('反馈离线')).mockResolvedValueOnce(feedback);
    renderToday();
    await user.type(await screen.findByLabelText('你的输出'), '确认保存的输出');
    await user.click(screen.getByRole('button', { name: '保存输出' }));
    expect(await screen.findByText(/本次输出已保存。核对要点暂不可用/)).toBeVisible();
    expect(screen.getByText('确认保存的输出')).toBeVisible();
    expect(screen.queryByLabelText('你的输出')).toBeNull();
    expect(localStorage.getItem('zhixing.todayDraft.practice-1')).toBeNull();
    expect(api.attemptPractice).toHaveBeenCalledTimes(1);
    expect(api.feedback).toHaveBeenCalledWith('attempt-1', 'practice-1', 'template');
    await user.click(screen.getByRole('button', { name: '仅重试核对要点' }));
    await user.click(await screen.findByText('核对要点'));
    expect(await screen.findByText('模板未判断正确性。')).toBeVisible();
    expect(api.attemptPractice).toHaveBeenCalledTimes(1);
    expect(api.feedback).toHaveBeenCalledTimes(2);
  });

  it('已有 GET attempt 直接显示保存输出，展开后显示反馈', async () => {
    const user = userEvent.setup();
    vi.mocked(api.today).mockResolvedValue(today({ practice: practice(), attempt: attempt({ feedback }) }));
    renderToday();
    expect(await screen.findByText('本次输出已保存')).toBeVisible();
    expect(screen.getByText('已保存的解释')).toBeVisible();
    await user.click(screen.getByText('核对要点'));
    expect(screen.getByText('模板未判断正确性。')).toBeVisible();
    expect(screen.getByText('模板反馈 · 未核验正确性')).toBeVisible();
    expect(api.feedback).not.toHaveBeenCalled();
  });

  it('保存结果默认收起核对要点，只直接展示保存状态和本人输出', async () => {
    vi.mocked(api.today).mockResolvedValue(today({ practice: practice(), attempt: attempt({ feedback }) }));
    renderToday();
    expect(await screen.findByText('本次输出已保存')).toBeVisible();
    expect(screen.getByText('已保存的解释')).toBeVisible();
    expect(screen.getByText('核对要点').closest('details')).not.toHaveAttribute('open');
  });

  it('主动展开核对要点后显示自查提示和可核对反馈', async () => {
    const user = userEvent.setup();
    vi.mocked(api.today).mockResolvedValue(today({ practice: practice(), attempt: attempt({ feedback }) }));
    renderToday();
    await user.click(await screen.findByText('核对要点'));
    expect(screen.getByText('核对要点').closest('details')).toHaveAttribute('open');
    expect(screen.getByText('这是自查提示，未自动判分')).toBeVisible();
    expect(screen.getByText('请自行核对。')).toBeVisible();
    expect(screen.getByText('核对来源')).toBeVisible();
    expect(screen.getByText('未验证事实')).toBeVisible();
  });
});

describe('Today 草稿与轮询边界', () => {
  it('同 ID 刷新保留草稿，切换练习恢复各自草稿', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem('zhixing.todayDraft.practice-2', '第二题草稿');
    vi.mocked(api.today).mockResolvedValueOnce(today({ practice: practice() })).mockResolvedValueOnce(today({ practice: practice() })).mockResolvedValueOnce(today({ practice: practice('practice-2') }));
    renderToday();
    const textarea = await screen.findByLabelText('你的输出');
    fireEvent.change(textarea, { target: { value: '第一题草稿' } });
    await act(async () => vi.advanceTimersByTime(60000));
    expect(screen.getByLabelText('你的输出')).toHaveValue('第一题草稿');
    await act(async () => vi.advanceTimersByTime(60000));
    expect(screen.getByLabelText('你的输出')).toHaveValue('第二题草稿');
    expect(localStorage.getItem('zhixing.todayDraft.practice-1')).toBe('第一题草稿');
  });

  it('保存后的轮询不会用缺失 attempt 的响应撤销完成态', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.today).mockResolvedValue(today({ practice: practice() }));
    vi.mocked(api.attemptPractice).mockResolvedValue(attempt());
    vi.mocked(api.feedback).mockResolvedValue(feedback);
    renderToday();
    fireEvent.change(await screen.findByLabelText('你的输出'), { target: { value: '已保存的解释' } });
    fireEvent.click(screen.getByRole('button', { name: '保存输出' }));
    expect(await screen.findByText('本次输出已保存')).toBeVisible();
    await act(async () => vi.advanceTimersByTime(60000));
    expect(screen.getByText('本次输出已保存')).toBeVisible();
    expect(screen.queryByLabelText('你的输出')).toBeNull();
    expect(api.attemptPractice).toHaveBeenCalledTimes(1);
  });

  it('请求不重叠，卸载后清理轮询', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let resolveFirst: ((value: TodayData) => void) | undefined;
    vi.mocked(api.today).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    const view = renderToday();
    await act(async () => vi.advanceTimersByTime(120000));
    expect(api.today).toHaveBeenCalledTimes(1);
    resolveFirst?.(today({ automation: automation({ state: 'collecting' }) }));
    expect(await screen.findByText('今天的内容已准备好')).toBeVisible();
    view.unmount();
    await act(async () => vi.advanceTimersByTime(120000));
    expect(api.today).toHaveBeenCalledTimes(1);
  });

  it('collecting 状态每四秒连续轮询且请求完成后才安排下一次', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.today).mockResolvedValue(today({ automation: automation({ state: 'collecting', message: '正在收集' }) }));
    renderToday();
    expect(await screen.findByText('正在收集')).toBeVisible();
    expect(api.today).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(3900));
    expect(api.today).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    await waitFor(() => expect(api.today).toHaveBeenCalledTimes(2));
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    await waitFor(() => expect(api.today).toHaveBeenCalledTimes(3));
  });

  it('拒绝的轮询保留内容并按六十秒自动恢复', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.today)
      .mockResolvedValueOnce(today({ highlights: [highlight('kept')], practice: practice() }))
      .mockRejectedValueOnce(new Error('一次读取失败'))
      .mockResolvedValueOnce(today({ highlights: [highlight('kept')], practice: practice(), automation: automation({ message: '已经自动恢复' }) }));
    renderToday();
    expect(await screen.findByText('重点 kept')).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(await screen.findByText(/一次读取失败/)).toBeVisible();
    expect(screen.getByText('重点 kept')).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(await screen.findByText('已经自动恢复')).toBeVisible();
    expect(screen.queryByText(/一次读取失败/)).toBeNull();
    expect(api.today).toHaveBeenCalledTimes(3);
  });

  it('草稿在显式卸载和重新挂载后恢复', async () => {
    vi.mocked(api.today).mockResolvedValue(today({ practice: practice() }));
    const first = renderToday();
    fireEvent.change(await screen.findByLabelText('你的输出'), { target: { value: '跨挂载保留的草稿' } });
    first.unmount();
    renderToday();
    expect(await screen.findByLabelText('你的输出')).toHaveValue('跨挂载保留的草稿');
  });

  it.each(['collecting', 'organizing', 'waiting', 'limited', 'error'] as const)('%s 显式返回的有效旧重点、练习和尝试继续显示', async (state) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.today)
      .mockResolvedValueOnce(today({ highlights: [highlight('latest')], practice: practice(), attempt: attempt({ feedback }) }))
      .mockResolvedValueOnce(today({ highlights: [highlight('latest')], practice: practice(), attempt: attempt({ feedback }), automation: automation({ state, message: `过渡 ${state}` }) }));
    renderToday();
    expect(await screen.findByText('重点 latest')).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(await screen.findByText(`过渡 ${state}`)).toBeVisible();
    expect(screen.getByText('重点 latest')).toBeVisible();
    expect(screen.getByText('用自己的话解释索引。')).toBeVisible();
    expect(screen.getByText('已保存的解释')).toBeVisible();
    fireEvent.click(screen.getByText('核对要点'));
    expect(screen.getByText('模板未判断正确性。')).toBeVisible();
  });

  it.each([
    ['档案修订变化且工作状态成功', today({ profile: { ...today().profile, revision: 3 }, automation: automation({ state: 'organizing', message: '档案已更新，正在重新整理' }) })],
    ['scope 失效', today({ automation: automation({ state: 'collecting', message: '授权范围已变化', setup: { profile: true, scope: false, model: true } }) })],
    ['model 失效', today({ automation: automation({ state: 'error', message: '模型配置已失效', setup: { profile: true, scope: true, model: false } }) })],
  ])('%s 时成功的空响应权威清除旧重点和练习', async (_label, emptyToday) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.today)
      .mockResolvedValueOnce(today({ highlights: [highlight('stale')], practice: practice(), attempt: attempt({ feedback }) }))
      .mockResolvedValueOnce(emptyToday);
    renderToday();
    expect(await screen.findByText('重点 stale')).toBeVisible();
    expect(screen.getByText('已保存的解释')).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(await screen.findByText(emptyToday.automation.message)).toBeVisible();
    expect(screen.queryByText('重点 stale')).toBeNull();
    expect(screen.queryByText('用自己的话解释索引。')).toBeNull();
    expect(screen.queryByText('已保存的解释')).toBeNull();
    expect(screen.getByText('今天还没有可展示的重点')).toBeVisible();
    expect(screen.getByText('今天还没有练习')).toBeVisible();
  });

  it('成功返回 null 练习时，本地已确认尝试不会使其复活', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.today)
      .mockResolvedValueOnce(today({ highlights: [highlight('saved')], practice: practice() }))
      .mockResolvedValueOnce(today({ highlights: [], practice: null, attempt: null, automation: automation({ state: 'limited', message: '练习已失效' }) }));
    vi.mocked(api.attemptPractice).mockResolvedValue(attempt());
    vi.mocked(api.feedback).mockResolvedValue(feedback);
    renderToday();
    fireEvent.change(await screen.findByLabelText('你的输出'), { target: { value: '已保存的解释' } });
    fireEvent.click(screen.getByRole('button', { name: '保存输出' }));
    expect(await screen.findByText('本次输出已保存')).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(await screen.findByText('练习已失效')).toBeVisible();
    expect(screen.queryByText('本次输出已保存')).toBeNull();
    expect(screen.queryByText('已保存的解释')).toBeNull();
    expect(screen.queryByText('重点 saved')).toBeNull();
    expect(screen.getByText('今天还没有练习')).toBeVisible();
  });

  it('设置入口与未保存练习同时存在时只有一个主 CTA', async () => {
    vi.mocked(api.today).mockResolvedValue(today({ practice: practice(), automation: automation({ state: 'setup', setup: { profile: false, scope: false, model: false } }) }));
    renderToday();
    expect(await screen.findByLabelText('你的输出')).toBeVisible();
    expect(document.querySelectorAll('.btn-primary')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '保存输出' })).toHaveClass('btn-primary');
    expect(screen.getByRole('link', { name: '先完善学习档案' })).toHaveClass('btn-secondary');
  });

  it('A 保存期间切换到 B 后，A 的保存和反馈失败只保留给 A', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem('zhixing.todayDraft.practice-2', 'B 的草稿');
    let resolveSave: ((value: PracticeAttempt) => void) | undefined;
    let rejectFeedback: ((reason: Error) => void) | undefined;
    vi.mocked(api.today)
      .mockResolvedValueOnce(today({ practice: practice('practice-1') }))
      .mockResolvedValueOnce(today({ practice: practice('practice-2') }))
      .mockResolvedValueOnce(today({ practice: practice('practice-1') }));
    vi.mocked(api.attemptPractice).mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; }));
    vi.mocked(api.feedback).mockImplementation(() => new Promise((_, reject) => { rejectFeedback = reject; }));
    renderToday();
    fireEvent.change(await screen.findByLabelText('你的输出'), { target: { value: 'A 的已保存输出' } });
    fireEvent.click(screen.getByRole('button', { name: '保存输出' }));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(await screen.findByLabelText('你的输出')).toHaveValue('B 的草稿');
    await act(async () => resolveSave?.(attempt({ id: 'attempt-A', practiceId: 'practice-1', output: 'A 的已保存输出' })));
    await waitFor(() => expect(api.feedback).toHaveBeenCalledWith('attempt-A', 'practice-1', 'template'));
    expect(api.attemptPractice).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('你的输出')).toHaveValue('B 的草稿');
    expect(screen.queryByText('本次输出已保存')).toBeNull();
    expect(screen.queryByText('A 的已保存输出')).toBeNull();
    await act(async () => rejectFeedback?.(new Error('A 的旧反馈失败')));
    expect(screen.getByLabelText('你的输出')).toHaveValue('B 的草稿');
    expect(screen.queryByText(/A 的旧反馈失败/)).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(await screen.findByText('本次输出已保存')).toBeVisible();
    expect(screen.getByText('A 的已保存输出')).toBeVisible();
    expect(screen.getByText(/A 的旧反馈失败/)).toBeVisible();
    expect(api.attemptPractice).toHaveBeenCalledTimes(1);
    expect(api.feedback).toHaveBeenCalledTimes(1);
  });

  it('A 反馈 pending 时切换到 B 不串状态，返回 A 后保留反馈且不重复保存', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem('zhixing.todayDraft.practice-2', 'B 自己的输入');
    let resolveFeedback: ((value: Feedback) => void) | undefined;
    vi.mocked(api.today)
      .mockResolvedValueOnce(today({ practice: practice('practice-1') }))
      .mockResolvedValueOnce(today({ practice: practice('practice-2') }))
      .mockResolvedValueOnce(today({ practice: practice('practice-1') }));
    vi.mocked(api.attemptPractice).mockResolvedValue(attempt({ id: 'attempt-A', practiceId: 'practice-1', output: 'A 的完成输出' }));
    vi.mocked(api.feedback).mockImplementation(() => new Promise((resolve) => { resolveFeedback = resolve; }));
    renderToday();
    fireEvent.change(await screen.findByLabelText('你的输出'), { target: { value: 'A 的完成输出' } });
    fireEvent.click(screen.getByRole('button', { name: '保存输出' }));
    await waitFor(() => expect(api.feedback).toHaveBeenCalledTimes(1));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(await screen.findByLabelText('你的输出')).toHaveValue('B 自己的输入');
    expect(screen.queryByText('本次输出已保存')).toBeNull();
    expect(screen.queryByText('正在准备核对要点…')).toBeNull();
    await act(async () => resolveFeedback?.(feedback));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    fireEvent.click(await screen.findByText('核对要点'));
    expect(screen.getByText('模板未判断正确性。')).toBeVisible();
    expect(screen.getByText('A 的完成输出')).toBeVisible();
    expect(api.attemptPractice).toHaveBeenCalledTimes(1);
    expect(api.feedback).toHaveBeenCalledTimes(1);
  });

  it('延迟旧 GET 不撤销较新的自动整理 PUT，下一次仍使用新修订', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let resolveOldGet: ((value: TodayData) => void) | undefined;
    vi.mocked(api.today).mockReset();
    vi.mocked(api.today)
      .mockResolvedValueOnce(today({ automation: automation({ enabled: false, revision: 4, state: 'off', message: '旧 GET 关闭 rev4' }) }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOldGet = resolve; }))
      .mockResolvedValue(today({ automation: automation({ enabled: false, revision: 6, state: 'off', message: '已经停用 rev6' }) }));
    vi.mocked(api.saveAutomation)
      .mockResolvedValueOnce(automation({ enabled: true, revision: 5, message: 'PUT 已启用 rev5' }))
      .mockResolvedValueOnce(automation({ enabled: false, revision: 6, state: 'off', message: 'PUT 已停用 rev6' }));
    renderToday();
    expect(await screen.findByRole('button', { name: '开启自动整理' })).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    await waitFor(() => expect(api.today).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '开启自动整理' }));
    expect(await screen.findByText('PUT 已启用 rev5')).toBeVisible();
    await act(async () => resolveOldGet?.(today({ automation: automation({ enabled: false, revision: 4, state: 'off', message: '旧 GET 关闭 rev4' }) })));
    expect(screen.getByText('PUT 已启用 rev5')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '停用自动整理' }));
    await waitFor(() => expect(api.saveAutomation).toHaveBeenCalledTimes(2));
    expect(api.saveAutomation).toHaveBeenNthCalledWith(1, true, 4);
    expect(api.saveAutomation).toHaveBeenNthCalledWith(2, false, 5);
  });
});

describe('Today 自动 AI 建议', () => {
  it('启用时保存一次后只 GET 自动点评，四秒完成轮询并恢复六十秒，不自动 POST 或模板调用', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const queued = adviceState({ status: 'queued', message: 'AI 点评排队中' });
    const ready = adviceState({ status: 'ready', message: 'AI 建议已准备好', feedback: modelFeedback() });
    vi.mocked(api.today)
      .mockResolvedValueOnce(today({ practice: practice(), adviceSettings: adviceSettings() }))
      .mockResolvedValue(today({ practice: practice(), attempt: attempt(), adviceSettings: adviceSettings(), advice: ready }));
    vi.mocked(api.attemptPractice).mockResolvedValue(attempt());
    vi.mocked(api.advice).mockResolvedValue(queued);
    renderToday();
    fireEvent.change(await screen.findByLabelText('你的输出'), { target: { value: '新的已保存回答' } });
    fireEvent.click(screen.getByRole('button', { name: '保存输出' }));
    expect(await screen.findByText('AI 点评排队中')).toBeVisible();
    expect(api.attemptPractice).toHaveBeenCalledTimes(1);
    expect(api.advice).toHaveBeenCalledWith('attempt-1');
    expect(api.feedback).not.toHaveBeenCalled();
    expect(api.requestAdvice).not.toHaveBeenCalled();
    expect(api.today).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(await screen.findByText('模型建议摘要')).toBeVisible();
    expect(screen.getByText('AI建议')).toBeVisible();
    expect(api.today).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    await waitFor(() => expect(api.today).toHaveBeenCalledTimes(3));
    expect(api.requestAdvice).not.toHaveBeenCalled();
  });

  it('显式请求进入 queued 后即时改用四秒轮询，ready 后恢复六十秒并清理', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const queued = adviceState({ status: 'queued', message: '显式请求已排队' });
    const ready = adviceState({ status: 'ready', message: 'AI 建议已准备好', feedback: modelFeedback() });
    vi.mocked(api.today)
      .mockResolvedValueOnce(today({ practice: practice(), attempt: attempt(), adviceSettings: adviceSettings(), advice: adviceState({ canRequest: true }) }))
      .mockResolvedValue(today({ practice: practice(), attempt: attempt(), adviceSettings: adviceSettings(), advice: ready }));
    vi.mocked(api.requestAdvice).mockResolvedValue(queued);
    const view = renderToday();
    fireEvent.click(await screen.findByRole('button', { name: '获取AI建议' }));
    expect(await screen.findByText('显式请求已排队')).toBeVisible();
    expect(api.today).toHaveBeenCalledTimes(1);
    expect(api.requestAdvice).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(await screen.findByText('模型建议摘要')).toBeVisible();
    expect(api.today).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    await waitFor(() => expect(api.today).toHaveBeenCalledTimes(3));
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    expect(api.today).toHaveBeenCalledTimes(3);
    expect(api.advice).not.toHaveBeenCalled();
    expect(api.requestAdvice).toHaveBeenCalledTimes(1);
  });

  it.each(['off', 'limited', 'unavailable', 'failed', 'uncertain', 'stale'] as const)('%s 保留原回答、真实状态和本地自查，不自动发起付费请求', async (status) => {
    vi.mocked(api.today).mockResolvedValue(today({ practice: practice(), attempt: attempt(), adviceSettings: adviceSettings(), advice: adviceState({ status, message: `服务端 ${status} 状态` }) }));
    renderToday();
    expect(await screen.findByText('已保存的解释')).toBeVisible();
    expect(screen.getByText(`服务端 ${status} 状态`)).toBeVisible();
    expect(screen.getByRole('button', { name: '使用本地模板自查' })).toBeVisible();
    expect(api.advice).not.toHaveBeenCalled();
    expect(api.requestAdvice).not.toHaveBeenCalled();
    expect(api.feedback).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'idle' as const, message: '可以请求 AI 建议', canRequest: true, canRetry: false, action: '获取AI建议' },
    { status: 'failed' as const, message: 'AI 点评失败', canRequest: false, canRetry: true, action: '重新请求点评' },
    { status: 'queued' as const, message: 'AI 点评排队中', canRequest: false, canRetry: false, action: null },
    { status: 'running' as const, message: 'AI 点评生成中', canRequest: false, canRetry: false, action: null },
  ])('已有回答和模板反馈仍独立显示 $status 建议状态与操作', async ({ status, message, canRequest, canRetry, action }) => {
    vi.mocked(api.today).mockResolvedValue(today({
      practice: practice(), attempt: attempt({ feedback }), adviceSettings: adviceSettings(),
      advice: adviceState({ status, message, canRequest, canRetry }),
    }));
    renderToday();
    expect(await screen.findByText('已保存的解释')).toBeVisible();
    expect(screen.getByText('模板未判断正确性。')).toBeInTheDocument();
    expect(screen.getByText(message)).toBeVisible();
    if (action) expect(screen.getByRole('button', { name: action })).toBeVisible();
    expect(api.requestAdvice).not.toHaveBeenCalled();
    expect(api.attemptPractice).not.toHaveBeenCalled();
  });

  it('显式请求防双重点击，未知结果复用 operationId，已知终态的新重试使用新身份', async () => {
    const user = userEvent.setup();
    let rejectFirst: ((reason: Error) => void) | undefined;
    vi.mocked(api.today).mockResolvedValue(today({ practice: practice(), attempt: attempt(), adviceSettings: adviceSettings(), advice: adviceState({ canRequest: true }) }));
    vi.mocked(api.requestAdvice)
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce(adviceState({ status: 'failed', message: '本次点评失败', canRetry: true }))
      .mockResolvedValueOnce(adviceState({ status: 'ready', message: '建议已准备好', feedback: modelFeedback() }));
    renderToday();
    const request = await screen.findByRole('button', { name: '获取AI建议' });
    await user.click(request);
    await user.click(request);
    expect(api.requestAdvice).toHaveBeenCalledTimes(1);
    await act(async () => { rejectFirst?.(new Error('网络结果未知')); });
    await user.click(await screen.findByRole('button', { name: '安全重试请求' }));
    expect(await screen.findByRole('button', { name: '重新请求点评' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '重新请求点评' }));
    expect(await screen.findByText('模型建议摘要')).toBeVisible();
    expect(api.requestAdvice).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(api.requestAdvice).mock.calls;
    expect(calls[0][1]).toBe(calls[1][1]);
    expect(calls[0][2]).toBe(false);
    expect(calls[1][2]).toBe(false);
    expect(calls[2][1]).not.toBe(calls[0][1]);
    expect(calls[2][2]).toBe(true);
  });

  it('同一 attempt 的迟到 pending 状态不覆盖已 ready 的模型反馈', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ready = adviceState({ status: 'ready', message: '建议已完成', feedback: modelFeedback() });
    vi.mocked(api.today)
      .mockResolvedValueOnce(today({ practice: practice(), attempt: attempt({ feedback: modelFeedback() }), adviceSettings: adviceSettings(), advice: ready, automation: automation({ state: 'collecting' }) }))
      .mockResolvedValueOnce(today({ practice: practice(), attempt: attempt(), adviceSettings: adviceSettings(), advice: adviceState({ status: 'running', message: '旧状态仍在运行' }), automation: automation({ state: 'collecting' }) }));
    renderToday();
    expect(await screen.findByText('模型建议摘要')).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(screen.getByText('模型建议摘要')).toBeVisible();
    expect(screen.getByText('AI建议')).toBeVisible();
    expect(screen.queryByText('旧状态仍在运行')).toBeNull();
  });

  it('未启用或 legacy 响应仍只走既有模板路径', async () => {
    const user = userEvent.setup();
    vi.mocked(api.today).mockResolvedValue(today({ practice: practice(), adviceSettings: adviceSettings({ enabled: false }) }));
    vi.mocked(api.attemptPractice).mockResolvedValue(attempt());
    vi.mocked(api.feedback).mockResolvedValue(feedback);
    renderToday();
    await user.type(await screen.findByLabelText('你的输出'), '旧路径回答');
    await user.click(screen.getByRole('button', { name: '保存输出' }));
    await user.click(await screen.findByText('核对要点'));
    expect(await screen.findByText('模板未判断正确性。')).toBeVisible();
    expect(api.advice).not.toHaveBeenCalled();
    expect(api.requestAdvice).not.toHaveBeenCalled();
    expect(api.feedback).toHaveBeenCalledWith('attempt-1', 'practice-1', 'template');
  });
});
