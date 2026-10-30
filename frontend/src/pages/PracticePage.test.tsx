import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PracticePage } from './PracticePage';
import { api } from '../services/api';
import type { AdviceState, Practice, PracticeAttempt } from '../types';

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return { ...actual, api: {
    practices: vi.fn(), outputs: vi.fn(), practiceAttempts: vi.fn(), attemptPractice: vi.fn(), feedback: vi.fn(), advice: vi.fn(), requestAdvice: vi.fn(), createOutput: vi.fn(), updateOutput: vi.fn(),
  } };
});

const practice: Practice = {
  id: 'p1', title: '解释索引', prompt: '向同事解释索引。', goal: '能解释索引取舍', skill: '数据库', kind: 'explanation', projectId: null, revision: 1,
  sourceRefs: [{ sourceId: 'src-1', kind: 'manual', title: '教材第 2 章', excerpt: '索引摘录' }],
  rubric: [{ id: 'criterion-1', label: '说明权衡', description: '解释收益与代价', expectedEvidence: ['具体例子'] }],
};
const savedAttempt = (overrides: Partial<PracticeAttempt> = {}): PracticeAttempt => ({ id: 'a1', practiceId: 'p1', output: '已有回答', assistanceLevel: 'none', evidenceRefs: [], feedback: null, ...overrides });
const adviceState = (overrides: Partial<AdviceState> = {}): AdviceState => ({ attemptId: 'a1', status: 'idle', jobId: null, feedback: null, message: '可以请求建议', canRequest: false, canRetry: false, lastError: null, ...overrides });
const readyAdvice = (attemptId = 'a1'): AdviceState => adviceState({ attemptId, status: 'ready', message: '建议已准备好', feedback: { id: `model-${attemptId}`, attemptId, mode: 'model', basis: 'rubric', summary: ` ${attemptId} 的模型建议`, observations: [], nextActions: ['核对原文'], limitations: ['仍需人工核验'] } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.outputs).mockResolvedValue({ items: [], total: 0 });
  vi.mocked(api.practiceAttempts).mockResolvedValue({ items: [], total: 0 });
  vi.mocked(api.advice).mockResolvedValue(adviceState());
});
afterEach(() => vi.useRealTimers());

describe('练习写作', () => {
  it('提交真实辅助枚举与结构化证据，模板反馈保持未评估并显示 rubric', async () => {
    const user = userEvent.setup();
    vi.mocked(api.practices).mockResolvedValue({ items: [practice], total: 1 });
    vi.mocked(api.outputs).mockResolvedValue({ items: [], total: 0 });
    vi.mocked(api.attemptPractice).mockResolvedValue({ id: 'a1', practiceId: 'p1', output: '我的解释', assistanceLevel: 'none', evidenceRefs: [{ kind: 'source', id: 'src-1', url: null, label: '教材第 2 章' }] });
    vi.mocked(api.feedback).mockResolvedValue({
      id: 'f1', attemptId: 'a1', mode: 'template', basis: 'deterministic_checklist', summary: '已保存提交，正确性尚未评估。',
      observations: [{ criterionId: 'criterion-1', finding: 'not_assessed', comment: '需要检查具体例子。', evidenceRefs: [] }],
      nextActions: ['补充可验证例子'], limitations: ['本地清单不判断正确性'],
    });
    render(<PracticePage />);

    await user.click(await screen.findByRole('button', { name: /解释索引/ }));
    await user.click(screen.getByText('来源与评价要点'));
    expect(screen.getByText('解释收益与代价')).toBeVisible();
    expect(screen.getByText(/需要的证据：具体例子/)).toBeVisible();
    await user.type(screen.getByLabelText('你的输出'), '我的解释');
    await waitFor(() => expect(localStorage.getItem('zhixing.practiceDraft.p1')).toBe('我的解释'));
    await user.click(screen.getByRole('button', { name: '提交本次尝试' }));
    await waitFor(() => expect(api.attemptPractice).toHaveBeenCalledWith('p1', {
      output: '我的解释', assistanceLevel: 'none', evidenceRefs: [{ kind: 'source', id: 'src-1', url: null, label: '教材第 2 章' }],
    }));
    expect(localStorage.getItem('zhixing.practiceDraft.p1')).toBeNull();

    await user.click(screen.getByRole('button', { name: '获取模板反馈' }));
    expect(await screen.findByText('本地模板 · 未评估正确性')).toBeVisible();
    expect(screen.getByText('本地清单不判断正确性')).toBeVisible();
    expect(screen.getByText(/说明权衡 · 未评估/)).toBeVisible();
    expect(api.feedback).toHaveBeenCalledWith('a1', 'p1', 'template');
  });
});

describe('Practice 自动 AI 建议', () => {
  it('选择已有 attempt 只读 GET 并渲染共享模型反馈，不自动 POST', async () => {
    const user = userEvent.setup();
    vi.mocked(api.practices).mockResolvedValue({ items: [practice], total: 1 });
    vi.mocked(api.practiceAttempts).mockResolvedValue({ items: [savedAttempt()], total: 1 });
    vi.mocked(api.advice).mockResolvedValue(readyAdvice());
    render(<PracticePage />);
    await user.click(await screen.findByRole('button', { name: /解释索引/ }));
    expect(await screen.findByText(/a1 的模型建议/)).toBeVisible();
    expect(screen.getByText('AI建议')).toBeVisible();
    expect(api.practiceAttempts).toHaveBeenCalledWith('p1');
    expect(api.advice).toHaveBeenCalledWith('a1');
    expect(api.requestAdvice).not.toHaveBeenCalled();
    expect(api.feedback).not.toHaveBeenCalled();
  });

  it('历史选择显示只读已保存回答，显式获取建议不重新提交尝试', async () => {
    const user = userEvent.setup();
    vi.mocked(api.practices).mockResolvedValue({ items: [practice], total: 1 });
    vi.mocked(api.practiceAttempts).mockResolvedValue({ items: [savedAttempt({ output: '历史回答原文' })], total: 1 });
    vi.mocked(api.advice).mockResolvedValue(adviceState({ canRequest: true }));
    vi.mocked(api.requestAdvice).mockResolvedValue(readyAdvice());
    render(<PracticePage />);
    await user.click(await screen.findByRole('button', { name: /解释索引/ }));
    expect(await screen.findByText('已保存的回答')).toBeVisible();
    expect(screen.getByText('历史回答原文')).toBeVisible();
    expect(screen.getByLabelText('你的输出')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: '获取AI建议' }));
    expect(await screen.findByText(/a1 的模型建议/)).toBeVisible();
    expect(screen.getByText('历史回答原文')).toBeVisible();
    expect(api.attemptPractice).not.toHaveBeenCalled();
    expect(api.requestAdvice).toHaveBeenCalledTimes(1);
  });

  it('新保存尝试权威保留，延迟的同练习历史 GET 不覆盖新回答或建议', async () => {
    const user = userEvent.setup();
    let resolveHistory: ((value: { items: PracticeAttempt[]; total: number }) => void) | undefined;
    vi.mocked(api.practices).mockResolvedValue({ items: [practice], total: 1 });
    vi.mocked(api.practiceAttempts).mockImplementation(() => new Promise((resolve) => { resolveHistory = resolve; }));
    vi.mocked(api.attemptPractice).mockResolvedValue(savedAttempt({ id: 'a-new', output: '新保存的回答' }));
    vi.mocked(api.advice).mockImplementation(async (attemptId) => readyAdvice(attemptId));
    render(<PracticePage />);
    await user.click(await screen.findByRole('button', { name: /解释索引/ }));
    await user.type(screen.getByLabelText('你的输出'), '新保存的回答');
    await user.click(screen.getByRole('button', { name: '提交本次尝试' }));
    expect(await screen.findByText(/a-new 的模型建议/)).toBeVisible();
    const savedAnswer = screen.getByRole('heading', { name: '已保存的回答' }).parentElement;
    expect(savedAnswer).toHaveTextContent('新保存的回答');
    await act(async () => { resolveHistory?.({ items: [savedAttempt({ output: '较旧的历史回答' })], total: 1 }); });
    expect(savedAnswer).toHaveTextContent('新保存的回答');
    expect(screen.queryByText('较旧的历史回答')).toBeNull();
    expect(screen.getByText(/a-new 的模型建议/)).toBeVisible();
    expect(api.attemptPractice).toHaveBeenCalledTimes(1);
    expect(api.requestAdvice).not.toHaveBeenCalled();
  });

  it('pending 每四秒非重叠续读，切换 attempt 后迟到结果不串状态，卸载清理', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const second = { ...practice, id: 'p2', title: '解释缓存' };
    let resolveLateA: ((value: AdviceState) => void) | undefined;
    vi.mocked(api.practices).mockResolvedValue({ items: [practice, second], total: 2 });
    vi.mocked(api.practiceAttempts).mockImplementation(async (practiceId) => ({ items: [savedAttempt({ id: practiceId === 'p1' ? 'a1' : 'a2', practiceId })], total: 1 }));
    vi.mocked(api.advice)
      .mockResolvedValueOnce(adviceState({ status: 'queued', message: 'A 正在排队' }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveLateA = resolve; }))
      .mockResolvedValue(adviceState({ attemptId: 'a2', status: 'off', message: 'B 未开启点评' }));
    const view = render(<PracticePage />);
    fireEvent.click(await screen.findByRole('button', { name: /解释索引/ }));
    expect(await screen.findByText('A 正在排队')).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(3900));
    expect(api.advice).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    await waitFor(() => expect(api.advice).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: /解释缓存/ }));
    expect(await screen.findByText('B 未开启点评')).toBeVisible();
    await act(async () => { resolveLateA?.(readyAdvice()); });
    expect(screen.queryByText(/a1 的模型建议/)).toBeNull();
    expect(screen.getByText('B 未开启点评')).toBeVisible();
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(12000));
    expect(api.advice).toHaveBeenCalledTimes(3);
    expect(api.requestAdvice).not.toHaveBeenCalled();
  });

  it('显式请求受 canRequest 与 pending 防重复控制，完成后渲染结果', async () => {
    const user = userEvent.setup();
    let resolveRequest: ((value: AdviceState) => void) | undefined;
    vi.mocked(api.practices).mockResolvedValue({ items: [practice], total: 1 });
    vi.mocked(api.practiceAttempts).mockResolvedValue({ items: [savedAttempt()], total: 1 });
    vi.mocked(api.advice).mockResolvedValue(adviceState({ canRequest: true }));
    vi.mocked(api.requestAdvice).mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve; }));
    render(<PracticePage />);
    await user.click(await screen.findByRole('button', { name: /解释索引/ }));
    const button = await screen.findByRole('button', { name: '获取AI建议' });
    await user.click(button);
    await user.click(button);
    expect(api.requestAdvice).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.requestAdvice).mock.calls[0][0]).toBe('a1');
    expect(vi.mocked(api.requestAdvice).mock.calls[0][2]).toBe(false);
    await act(async () => { resolveRequest?.(readyAdvice()); });
    expect(await screen.findByText(/a1 的模型建议/)).toBeVisible();
  });
});
