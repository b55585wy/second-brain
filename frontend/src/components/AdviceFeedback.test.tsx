import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdviceFeedback } from './AdviceFeedback';
import type { Feedback, FeedbackObservation } from '../types';

function observation(id: string, finding: FeedbackObservation['finding']): FeedbackObservation {
  return { criterionId: id, finding, comment: `${id} 的点评与“原文证据”`, evidenceRefs: [{ kind: 'output', id: 'a1', url: null, label: `${id} 证据` }] };
}

const modelFeedback: Feedback = {
  id: 'f1', attemptId: 'a1', mode: 'model', basis: 'model_suggestion', summary: '简洁建议摘要',
  observations: [observation('met-1', 'met'), observation('met-2', 'met'), observation('met-3', 'met'), observation('partial-1', 'partial'), observation('not-met-1', 'not_met'), observation('not-assessed-1', 'not_assessed')],
  nextActions: ['只保留的第一步', '不应出现在下一步的第二步'], limitations: ['模型可能误引，请核对原文'],
};

describe('AI 建议反馈', () => {
  it('按三类紧凑展示，每类最多两条且下一步最多一条，依据与限制可展开', async () => {
    const user = userEvent.setup();
    render(<AdviceFeedback feedback={modelFeedback} />);
    expect(screen.getByText('AI建议')).toBeVisible();
    expect(screen.getByText('简洁建议摘要')).toBeVisible();
    const met = screen.getByRole('heading', { name: '已做到' }).closest('section') as HTMLElement;
    const improve = screen.getByRole('heading', { name: '待改进' }).closest('section') as HTMLElement;
    const next = screen.getByRole('heading', { name: '下一步' }).closest('section') as HTMLElement;
    expect(within(met).getByText(/met-1 的点评/)).toBeVisible();
    expect(within(met).getByText(/met-2 的点评/)).toBeVisible();
    expect(within(met).queryByText(/met-3 的点评/)).toBeNull();
    expect(within(improve).getByText(/partial-1 的点评/)).toBeVisible();
    expect(within(improve).getByText(/not-met-1 的点评/)).toBeVisible();
    expect(within(improve).queryByText(/not-assessed-1 的点评/)).toBeNull();
    expect(within(next).getByText('只保留的第一步')).toBeVisible();
    expect(within(next).queryByText('不应出现在下一步的第二步')).toBeNull();
    expect(screen.queryByText(/掌握率|\d+%/)).toBeNull();
    await user.click(screen.getByText('查看依据与限制'));
    expect(screen.getByText('模型可能误引，请核对原文')).toBeVisible();
    expect(screen.getAllByText('met-3 证据').length).toBeGreaterThan(0);
    expect(screen.queryByText(/model_suggestion/)).toBeNull();
  });

  it('空分类使用中性事实文案，不编造表扬或掌握结论', () => {
    render(<AdviceFeedback feedback={{ ...modelFeedback, observations: [], nextActions: [], limitations: [] }} />);
    expect(screen.getByText('暂无已确认达到的评价要点。')).toBeVisible();
    expect(screen.getByText('暂无待改进的评价要点。')).toBeVisible();
    expect(screen.getByText('暂无下一步建议。')).toBeVisible();
    expect(screen.getByText('未提供额外限制说明；仍请核对原始来源。')).toBeInTheDocument();
  });
});
