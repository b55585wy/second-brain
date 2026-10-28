import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PracticePage } from './PracticePage';
import { api } from '../services/api';
import type { Practice } from '../types';

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return { ...actual, api: {
    practices: vi.fn(), outputs: vi.fn(), attemptPractice: vi.fn(), feedback: vi.fn(), createOutput: vi.fn(), updateOutput: vi.fn(),
  } };
});

const practice: Practice = {
  id: 'p1', title: '解释索引', prompt: '向同事解释索引。', goal: '能解释索引取舍', skill: '数据库', kind: 'explanation', projectId: null, revision: 1,
  sourceRefs: [{ sourceId: 'src-1', kind: 'manual', title: '教材第 2 章', excerpt: '索引摘录' }],
  rubric: [{ id: 'criterion-1', label: '说明权衡', description: '解释收益与代价', expectedEvidence: ['具体例子'] }],
};

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
