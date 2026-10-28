import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ReviewPage } from './ReviewPage';
import { api, ApiError } from '../services/api';

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return { ...actual, operationId: vi.fn(() => 'op-review-1'), api: {
    createReviewSession: vi.fn(), reviewNext: vi.fn(), revealReview: vi.fn(), rateReview: vi.fn(), waitForJob: vi.fn(),
  } };
});

const prompt = { cardId: 'card-1', presentationId: 'presentation-1', prompt: '什么是主动回忆？', remaining: 1 };
const answer = { cardId: 'card-1', answer: '先尝试提取，再查看答案。', sourceRefs: [{ sourceId: 'src-1', kind: 'manual', title: '测试来源' }] };

function readySession() {
  vi.mocked(api.createReviewSession).mockResolvedValue({ id: 'session-1' });
  vi.mocked(api.reviewNext).mockResolvedValue(prompt);
  vi.mocked(api.revealReview).mockResolvedValue(answer);
}
async function revealAnswer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '开始复习' }));
  await screen.findByRole('heading', { name: prompt.prompt });
  await user.click(screen.getByLabelText('我已经独立尝试过回忆'));
  await user.click(screen.getByRole('button', { name: '揭示答案' }));
  await screen.findByText(answer.answer);
}

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe('复习恢复与卡片绑定', () => {
  it('揭示前没有答案，评分绑定 cardId，双击只提交一次', async () => {
    const user = userEvent.setup();
    readySession();
    vi.mocked(api.reviewNext).mockResolvedValueOnce(prompt).mockResolvedValueOnce({ cardId: '', presentationId: '', prompt: '', done: true });
    let resolveRating: (() => void) | undefined;
    vi.mocked(api.rateReview).mockImplementation(() => new Promise<void>((resolve) => { resolveRating = resolve; }));
    render(<MemoryRouter><ReviewPage /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: '开始复习' }));
    await screen.findByRole('heading', { name: prompt.prompt });
    expect(screen.queryByText(answer.answer)).toBeNull();
    expect(screen.getByRole('button', { name: '揭示答案' })).toBeDisabled();
    await user.click(screen.getByLabelText('我已经独立尝试过回忆'));
    await user.click(screen.getByRole('button', { name: '揭示答案' }));
    expect(await screen.findByText(answer.answer)).toBeVisible();
    expect(api.revealReview).toHaveBeenCalledWith('session-1', 'presentation-1', 'card-1');
    const good = screen.getByRole('button', { name: /记得.*顺利回忆/ });
    await user.dblClick(good);
    expect(api.rateReview).toHaveBeenCalledTimes(1);
    expect(api.rateReview).toHaveBeenCalledWith('session-1', 'presentation-1', 'card-1', 'good', 'op-review-1', expect.any(Number), undefined);
    resolveRating!();
    expect(await screen.findByText('本次复习已完成')).toBeVisible();
  });

  it('创建后首次 next 失败仍保留会话，并可重试恢复', async () => {
    const user = userEvent.setup();
    vi.mocked(api.createReviewSession).mockResolvedValue({ id: 'session-new' });
    vi.mocked(api.reviewNext).mockRejectedValueOnce(new ApiError('NETWORK_ERROR', '暂时离线', true)).mockResolvedValueOnce(prompt);
    render(<MemoryRouter><ReviewPage /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: '开始复习' }));
    expect(await screen.findByText('会话暂未恢复')).toBeVisible();
    expect(localStorage.getItem('zhixing.reviewSessionId')).toBe('session-new');
    await user.click(screen.getByRole('button', { name: '重试读取' }));
    expect(await screen.findByRole('heading', { name: prompt.prompt })).toBeVisible();
    expect(localStorage.getItem('zhixing.reviewSessionId')).toBe('session-new');
  });

  it('恢复暂时失败不会丢弃已存会话，也不会重新创建会话', async () => {
    const user = userEvent.setup();
    localStorage.setItem('zhixing.reviewSessionId', 'session-saved');
    vi.mocked(api.reviewNext).mockRejectedValueOnce(new ApiError('NETWORK_ERROR', '暂时离线', true)).mockResolvedValueOnce(prompt);
    render(<MemoryRouter><ReviewPage /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: '继续上次会话' }));
    expect(await screen.findByText('会话暂未恢复')).toBeVisible();
    expect(api.createReviewSession).not.toHaveBeenCalled();
    expect(localStorage.getItem('zhixing.reviewSessionId')).toBe('session-saved');
    await user.click(screen.getByRole('button', { name: '重试读取' }));
    expect(await screen.findByRole('heading', { name: prompt.prompt })).toBeVisible();
  });

  it('uncertain 评分阻止新评分，重试复用相同 operationId', async () => {
    const user = userEvent.setup();
    readySession();
    vi.mocked(api.reviewNext).mockResolvedValueOnce(prompt).mockResolvedValueOnce({ cardId: '', presentationId: '', prompt: '', done: true });
    vi.mocked(api.rateReview).mockRejectedValueOnce(new ApiError('NETWORK_ERROR', '结果未知', true)).mockResolvedValueOnce(undefined);
    render(<MemoryRouter><ReviewPage /></MemoryRouter>);
    await revealAnswer(user);
    await user.click(screen.getByRole('button', { name: /记得.*顺利回忆/ }));
    expect(await screen.findByText(/评分处于待确认状态/)).toBeVisible();
    expect(screen.getByRole('button', { name: /很轻松.*毫无困难/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '用同一操作重试' }));
    await waitFor(() => expect(api.rateReview).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.rateReview).mock.calls[0]).toEqual(vi.mocked(api.rateReview).mock.calls[1]);
    expect(vi.mocked(api.rateReview).mock.calls[1][4]).toBe('op-review-1');
    expect(await screen.findByText('本次复习已完成')).toBeVisible();
  });
});
