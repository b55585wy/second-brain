import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KnowledgePage } from './KnowledgePage';
import { api } from '../services/api';
import type { Knowledge } from '../types';

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return { ...actual, api: {
    knowledge: vi.fn(), projects: vi.fn(), knowledgeDecision: vi.fn(), createKnowledge: vi.fn(), updateKnowledge: vi.fn(), importSource: vi.fn(), syncKnowledge: vi.fn(),
  } };
});

const candidate: Knowledge = {
  id: 'k1', question: '候选问题', answer: '<img src=x onerror=alert(1)> 文本答案',
  sourceRefs: [{ sourceId: 'src-1', kind: 'manual', title: '对话 #42', excerpt: '公开摘录', url: null }],
  status: 'draft', projectId: null, revision: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.knowledge).mockResolvedValue({ items: [candidate], total: 1 });
  vi.mocked(api.projects).mockResolvedValue({ items: [], total: 0 });
});

describe('候选知识与失败保留', () => {
  it('接受状态与未核验状态独立显示，接受不代表事实正确', async () => {
    vi.mocked(api.knowledge).mockResolvedValue({ items: [{ ...candidate, status: 'accepted', validation: { status: 'unverified' } }], total: 1 });
    render(<KnowledgePage />);
    expect(await screen.findByTitle('接受状态仅表示是否保留，不代表事实正确。')).toHaveTextContent('已接受');
    expect(screen.getByText('未核验')).toHaveAttribute('title', expect.stringContaining('不代表内容正确或错误'));
  });

  it.each([
    ['unverified', '未核验'],
    ['supported', '证据支持'],
    ['contradicted', '存在反证'],
    ['mixed', '证据不一'],
    ['future-status', '未核验'],
    [undefined, '未核验'],
  ])('事实状态 %s 显示为 %s，不推断已验证', async (validationStatus, label) => {
    vi.mocked(api.knowledge).mockResolvedValue({ items: [{ ...candidate, validation: validationStatus ? { status: validationStatus } : undefined }], total: 1 });
    render(<KnowledgePage />);
    expect(await screen.findByText(label)).toBeVisible();
    expect(screen.getByTitle('接受状态仅表示是否保留，不代表事实正确。')).toHaveTextContent('待确认');
  });

  it('显示结构化来源并携带实际修订接受草稿，不渲染答案 HTML', async () => {
    const user = userEvent.setup();
    vi.mocked(api.knowledgeDecision).mockResolvedValue({ ...candidate, status: 'accepted' });
    const { container } = render(<KnowledgePage />);
    expect(await screen.findByText(/文本答案/)).toBeVisible();
    expect(container.querySelector('img')).toBeNull();
    await user.click(screen.getByText('查看来源（1）'));
    expect(screen.getByText('对话 #42')).toBeVisible();
    expect(screen.getByText('公开摘录')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '接受' }));
    await waitFor(() => expect(api.knowledgeDecision).toHaveBeenCalledWith('k1', 'accept', 2));
  });

  it.each([
    ['服务器 500', new Error('服务器暂时失败')],
    ['网络失败', new TypeError('Failed to fetch')],
  ])('创建遇到%s时保留用户文字和表单', async (_label, failure) => {
    const user = userEvent.setup();
    vi.mocked(api.createKnowledge).mockRejectedValue(failure);
    render(<KnowledgePage />);
    await screen.findByRole('heading', { name: '候选问题' });
    await user.click(screen.getByRole('button', { name: '手动记录' }));
    await user.type(screen.getByLabelText('问题'), '尚未保存的问题');
    await user.type(screen.getByLabelText('答案'), '尚未保存的答案');
    await user.type(screen.getByLabelText('手工来源（每行一条 URL 或摘录）'), '一条真实摘录');
    await user.click(screen.getByRole('button', { name: '保存草稿' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(failure.message);
    expect(screen.getByLabelText('问题')).toHaveValue('尚未保存的问题');
    expect(screen.getByLabelText('答案')).toHaveValue('尚未保存的答案');
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeVisible();
  });

  it('编辑失败后保留修改内容与已有来源身份', async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateKnowledge).mockRejectedValue(new Error('编辑写入失败'));
    render(<KnowledgePage />);
    await screen.findByRole('heading', { name: '候选问题' });
    await user.click(screen.getByRole('button', { name: '编辑' }));
    const answer = screen.getByLabelText('答案');
    await user.clear(answer); await user.type(answer, '修改后仍未丢失');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('编辑写入失败');
    expect(screen.getByLabelText('答案')).toHaveValue('修改后仍未丢失');
    expect(vi.mocked(api.updateKnowledge).mock.calls[0][1].sourceRefs).toEqual([{ sourceId: 'src-1' }]);
    expect(vi.mocked(api.updateKnowledge).mock.calls[0][2]).toBe(2);
  });

  it('来源导入失败后保留实际 kind 对应标识和表单', async () => {
    const user = userEvent.setup();
    vi.mocked(api.importSource).mockRejectedValue(new Error('导入服务不可用'));
    render(<KnowledgePage />);
    await screen.findByRole('heading', { name: '候选问题' });
    await user.click(screen.getByRole('button', { name: '导入来源' }));
    await user.type(screen.getByLabelText('思源文档 ID'), '20261027090000-abcdefg');
    await user.click(screen.getByRole('button', { name: '提交导入' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('导入服务不可用');
    expect(screen.getByLabelText('思源文档 ID')).toHaveValue('20261027090000-abcdefg');
    expect(api.importSource).toHaveBeenCalledWith({ kind: 'siyuan_document', documentId: '20261027090000-abcdefg', projectId: null, extractCandidates: true });
    expect(screen.getByRole('button', { name: '提交导入' })).toBeVisible();
  });
});
