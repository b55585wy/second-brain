import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CodexPage } from './CodexPage';
import { api } from '../services/api';
import type { CodexScope, CodexThread } from '../types';

vi.mock('../services/api', () => ({ api: {
  codexThreads: vi.fn(), discoverCodexThreads: vi.fn(), projects: vi.fn(), codexScope: vi.fn(), importManualDialogue: vi.fn(), syncCodex: vi.fn(), job: vi.fn(), saveCodexScope: vi.fn(),
} }));

const scope: CodexScope = { enabled: false, allowedThreadIds: [], allowedProjectPaths: [], excludedThreadIds: [], excludedProjectPaths: [], includeArchived: false, allowManualImports: true, revision: 1 };
const thread: CodexThread = { id: 'thread-1', title: '近期讨论', projectPath: 'C:/work/project', updatedAt: '2026-10-27T10:00:00Z', allowed: false };

function setupPage(saved: CodexScope = scope, authorizedThreads: CodexThread[] = []) {
  vi.mocked(api.codexThreads).mockResolvedValue({ items: authorizedThreads, total: authorizedThreads.length });
  vi.mocked(api.projects).mockResolvedValue({ items: [], total: 0 });
  vi.mocked(api.codexScope).mockResolvedValue(saved);
}

beforeEach(() => {
  vi.clearAllMocks();
  setupPage();
  vi.mocked(api.discoverCodexThreads).mockResolvedValue({ items: [], total: 0 });
});

describe('Codex 授权与同步', () => {
  it('挂载只读授权列表和范围，不显式点击就不发现', async () => {
    render(<CodexPage />);
    await waitFor(() => expect(api.codexScope).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.codexThreads).toHaveBeenCalledTimes(1));
    expect(api.discoverCodexThreads).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '查看近期对话' })).toBeEnabled();
  });

  it('首次空范围可浏览，覆盖加载、空状态和显式刷新', async () => {
    const user = userEvent.setup();
    let resolveDiscovery: ((value: { items: CodexThread[]; total: number }) => void) | undefined;
    vi.mocked(api.discoverCodexThreads).mockImplementationOnce(() => new Promise((resolve) => { resolveDiscovery = resolve; }));
    vi.mocked(api.discoverCodexThreads).mockResolvedValueOnce({ items: [thread], total: 1 });
    render(<CodexPage />);
    await user.click(screen.getByRole('button', { name: '查看近期对话' }));
    expect(screen.getByRole('button', { name: '正在查看近期对话…' })).toBeDisabled();
    expect(screen.getByText('正在读取近期对话元数据…')).toBeVisible();
    resolveDiscovery?.({ items: [], total: 0 });
    expect(await screen.findByText(/最近 7 天没有发现对话/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '刷新近期对话' }));
    expect(await screen.findByText('近期讨论')).toBeVisible();
    expect(api.discoverCodexThreads).toHaveBeenCalledTimes(2);
  });

  it('勾选仅改草稿，不保存、同步或再次读取，HTML 标题和路径按文本显示', async () => {
    const user = userEvent.setup();
    const unsafe = { ...thread, title: '<img src=x onerror=alert(1)> 标题', projectPath: '<script>alert(1)</script>' };
    vi.mocked(api.discoverCodexThreads).mockResolvedValue({ items: [unsafe], total: 1 });
    render(<CodexPage />);
    await user.click(screen.getByRole('button', { name: '查看近期对话' }));
    const checkbox = await screen.findByRole('checkbox', { name: /<img src=x onerror=alert\(1\)> 标题/ });
    expect(screen.getByText((content) => content.includes('<script>alert(1)</script>'))).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    vi.mocked(api.discoverCodexThreads).mockClear();
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(api.saveCodexScope).not.toHaveBeenCalled();
    expect(api.syncCodex).not.toHaveBeenCalled();
    expect(api.discoverCodexThreads).not.toHaveBeenCalled();
  });

  it('主保存启用采集，携带完整字段和当前修订并保留列表外授权', async () => {
    const user = userEvent.setup();
    const saved: CodexScope = { enabled: false, allowedThreadIds: ['outside-list'], allowedProjectPaths: ['D:/allowed'], excludedThreadIds: ['blocked'], excludedProjectPaths: ['D:/blocked'], includeArchived: true, allowManualImports: false, revision: 7 };
    setupPage(saved);
    vi.mocked(api.discoverCodexThreads).mockResolvedValue({ items: [thread], total: 1 });
    vi.mocked(api.saveCodexScope).mockImplementation(async (input, revision) => ({ ...input, revision: (revision ?? saved.revision) + 1 }));
    render(<CodexPage />);
    await user.click(screen.getByRole('button', { name: '查看近期对话' }));
    await user.click(await screen.findByRole('checkbox', { name: /近期讨论/ }));
    await user.click(screen.getByRole('button', { name: '保存所选对话' }));
    await waitFor(() => expect(api.saveCodexScope).toHaveBeenCalledWith({
      enabled: true,
      allowedThreadIds: ['outside-list', 'thread-1'],
      allowedProjectPaths: ['D:/allowed'],
      excludedThreadIds: ['blocked'],
      excludedProjectPaths: ['D:/blocked'],
      includeArchived: true,
      allowManualImports: false,
    }, 7));
    expect(await screen.findByText(/另有 1 条已选对话不在当前列表/)).toBeVisible();
  });

  it('未保存的勾选和高级修改阻断同步，恢复保存态后可同步', async () => {
    const user = userEvent.setup();
    const saved = { ...scope, enabled: true, allowedThreadIds: ['thread-1'] };
    setupPage(saved, [{ ...thread, allowed: true }]);
    render(<CodexPage />);
    const sync = await screen.findByRole('button', { name: '同步授权对话' });
    await waitFor(() => expect(sync).toBeEnabled());
    const checkbox = screen.getByRole('checkbox', { name: /近期讨论/ });
    await user.click(checkbox);
    expect(sync).toBeDisabled();
    expect(screen.getByText(/有未保存的范围修改/)).toBeVisible();
    await user.click(checkbox);
    expect(sync).toBeEnabled();
    await user.click(screen.getByText('高级设置'));
    const archived = screen.getByRole('checkbox', { name: '包含已归档对话' });
    await user.click(archived);
    expect(sync).toBeDisabled();
    await user.click(archived);
    expect(sync).toBeEnabled();
    expect(api.syncCodex).not.toHaveBeenCalled();
  });

  it('成功保存采用服务器实际返回范围，同步只发送已保存返回 ID', async () => {
    const user = userEvent.setup();
    const saved = { ...scope, enabled: true, allowedThreadIds: ['server-saved'], revision: 9 };
    vi.mocked(api.discoverCodexThreads).mockResolvedValue({ items: [thread], total: 1 });
    vi.mocked(api.saveCodexScope).mockResolvedValue(saved);
    vi.mocked(api.syncCodex).mockResolvedValue({ id: 'job-sync', status: 'succeeded' });
    render(<CodexPage />);
    await user.click(screen.getByRole('button', { name: '查看近期对话' }));
    await user.click(await screen.findByRole('checkbox', { name: /近期讨论/ }));
    await user.click(screen.getByRole('button', { name: '保存所选对话' }));
    const sync = screen.getByRole('button', { name: '同步授权对话' });
    await waitFor(() => expect(sync).toBeEnabled());
    await user.click(sync);
    expect(api.syncCodex).toHaveBeenCalledWith(['server-saved']);
  });

  it('失败保存保留草稿和原修订且不能同步，显式重试后恢复', async () => {
    const user = userEvent.setup();
    vi.mocked(api.discoverCodexThreads).mockResolvedValue({ items: [thread], total: 1 });
    vi.mocked(api.saveCodexScope).mockRejectedValueOnce(new Error('保存失败'));
    vi.mocked(api.saveCodexScope).mockResolvedValueOnce({ ...scope, enabled: true, allowedThreadIds: ['thread-1'], revision: 2 });
    vi.mocked(api.syncCodex).mockResolvedValue({ id: 'job-sync', status: 'succeeded' });
    render(<CodexPage />);
    await user.click(screen.getByRole('button', { name: '查看近期对话' }));
    const checkbox = await screen.findByRole('checkbox', { name: /近期讨论/ });
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: '保存所选对话' }));
    expect(await screen.findByText('保存失败')).toBeVisible();
    expect(checkbox).toBeChecked();
    expect(screen.getByRole('button', { name: '同步授权对话' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '保存所选对话' }));
    await waitFor(() => expect(api.saveCodexScope).toHaveBeenCalledTimes(2));
    expect(api.saveCodexScope).toHaveBeenNthCalledWith(2, expect.anything(), 1);
    const sync = screen.getByRole('button', { name: '同步授权对话' });
    await waitFor(() => expect(sync).toBeEnabled());
    await user.click(sync);
    expect(api.syncCodex).toHaveBeenCalledWith(['thread-1']);
  });

  it('排除行清晰可见，保存保留排除字段且没有合格对象时不能同步', async () => {
    const user = userEvent.setup();
    const saved = { ...scope, enabled: true, allowedThreadIds: ['thread-1'], excludedThreadIds: ['thread-1'] };
    setupPage(saved, [thread]);
    vi.mocked(api.saveCodexScope).mockImplementation(async (input) => ({ ...input, revision: 2 }));
    render(<CodexPage />);
    expect(await screen.findByText('排除规则生效')).toBeVisible();
    expect(screen.getByText(/保存不会清除排除设置/)).toBeVisible();
    expect(screen.getByRole('button', { name: '同步授权对话' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '保存所选对话' }));
    await waitFor(() => expect(api.saveCodexScope).toHaveBeenCalledWith(expect.objectContaining({ excludedThreadIds: ['thread-1'] }), 1));
    expect(screen.getByRole('button', { name: '同步授权对话' })).toBeDisabled();
  });

  it('高级保存仍支持清空选择和停用采集', async () => {
    const user = userEvent.setup();
    const saved = { ...scope, enabled: true, allowedThreadIds: ['thread-1'] };
    setupPage(saved, [thread]);
    vi.mocked(api.saveCodexScope).mockImplementation(async (input) => ({ ...input, revision: 2 }));
    render(<CodexPage />);
    await user.click(screen.getByText('高级设置'));
    const enabled = await screen.findByRole('checkbox', { name: '启用自动采集' });
    await user.click(enabled);
    await user.clear(screen.getByLabelText('授权线程 ID（每行一条）'));
    await user.click(screen.getByRole('button', { name: '保存采集范围' }));
    await waitFor(() => expect(api.saveCodexScope).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, allowedThreadIds: [] }), 1));
  });

  it('发现失败只能显式重试，且不阻断正确结构的手动导入', async () => {
    const user = userEvent.setup();
    vi.mocked(api.discoverCodexThreads).mockRejectedValueOnce(new Error('发现暂不可用'));
    vi.mocked(api.discoverCodexThreads).mockResolvedValueOnce({ items: [thread], total: 1 });
    vi.mocked(api.importManualDialogue).mockResolvedValue({ id: 'job-manual', status: 'succeeded', syncedCount: 1 });
    render(<CodexPage />);
    await user.click(screen.getByRole('button', { name: '查看近期对话' }));
    expect(await screen.findByText('发现暂不可用')).toBeVisible();
    expect(api.discoverCodexThreads).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText('对话标题'), '发现失败后的手动导入');
    await user.type(screen.getByLabelText('稳定来源 ID'), 'manual-source');
    await user.type(screen.getByLabelText('第 1 条消息内容'), '<b>保留为文本</b>');
    await user.click(screen.getByRole('button', { name: '提交手动导入' }));
    await waitFor(() => expect(api.importManualDialogue).toHaveBeenCalledWith({
      projectId: null,
      title: '发现失败后的手动导入',
      externalSourceId: 'manual-source',
      messages: [{ sourceMessageId: 'message-1', role: 'user', content: '<b>保留为文本</b>', occurredAt: null }],
    }));
    await user.click(screen.getByRole('button', { name: '重试查看近期对话' }));
    expect(await screen.findByText('近期讨论')).toBeVisible();
    expect(api.discoverCodexThreads).toHaveBeenCalledTimes(2);
  });

  it('授权列表失败时仍显示、选择并保存显式发现的对话', async () => {
    const user = userEvent.setup();
    vi.mocked(api.codexThreads).mockRejectedValue(new Error('授权列表暂不可用'));
    vi.mocked(api.discoverCodexThreads).mockResolvedValue({ items: [thread], total: 1 });
    vi.mocked(api.saveCodexScope).mockImplementation(async (input) => ({ ...input, revision: 2 }));
    render(<CodexPage />);

    expect(await screen.findByText(/授权列表暂不可用/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '查看近期对话' }));
    const checkbox = await screen.findByRole('checkbox', { name: /近期讨论/ });
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
    await user.click(screen.getByRole('button', { name: '保存所选对话' }));
    await waitFor(() => expect(api.saveCodexScope).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, allowedThreadIds: ['thread-1'] }), 1));
  });

  it('手动导入权限只采用已保存范围，草稿切换不即时生效', async () => {
    const user = userEvent.setup();
    setupPage({ ...scope, allowManualImports: false });
    vi.mocked(api.saveCodexScope).mockImplementation(async (input) => ({ ...input, revision: 2 }));
    render(<CodexPage />);

    const submit = await screen.findByRole('button', { name: '提交手动导入' });
    await waitFor(() => expect(submit).toBeDisabled());
    await user.click(screen.getByText('高级设置'));
    const allowManual = screen.getByRole('checkbox', { name: '允许手动导入' });
    await user.click(allowManual);
    expect(allowManual).toBeChecked();
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '保存采集范围' }));
    await waitFor(() => expect(submit).toBeEnabled());

    await user.click(allowManual);
    expect(allowManual).not.toBeChecked();
    expect(submit).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '保存采集范围' }));
    await waitFor(() => expect(submit).toBeDisabled());
    expect(api.saveCodexScope).toHaveBeenNthCalledWith(2, expect.objectContaining({ allowManualImports: false }), 2);
    expect(api.importManualDialogue).not.toHaveBeenCalled();
  });

  it('显式刷新发现保留草稿选择和列表外已保存 ID，不触发保存或同步', async () => {
    const user = userEvent.setup();
    setupPage({ ...scope, enabled: true, allowedThreadIds: ['outside-list'] });
    vi.mocked(api.discoverCodexThreads).mockResolvedValue({ items: [thread], total: 1 });
    render(<CodexPage />);

    await user.click(screen.getByRole('button', { name: '查看近期对话' }));
    const checkbox = await screen.findByRole('checkbox', { name: /近期讨论/ });
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: '刷新近期对话' }));
    await waitFor(() => expect(api.discoverCodexThreads).toHaveBeenCalledTimes(2));
    expect(checkbox).toBeChecked();
    expect(screen.getByText(/另有 1 条已选对话不在当前列表/)).toBeVisible();
    expect(api.saveCodexScope).not.toHaveBeenCalled();
    expect(api.syncCodex).not.toHaveBeenCalled();
  });
});

describe('Codex 手动后备', () => {
  it('自动 app-server 列表失败时仍能提交实际手动对话结构', async () => {
    const user = userEvent.setup();
    vi.mocked(api.codexThreads).mockRejectedValue(new Error('app-server 不可用'));
    vi.mocked(api.importManualDialogue).mockResolvedValue({ id: 'job-manual', status: 'succeeded', syncedCount: 1 });
    render(<CodexPage />);

    expect(await screen.findByText(/app-server 不可用/)).toBeVisible();
    expect(screen.getByRole('button', { name: '重试授权列表' })).toBeVisible();
    await user.type(screen.getByLabelText('对话标题'), '手动保留的讨论');
    await user.type(screen.getByLabelText('稳定来源 ID'), 'discussion-2026-10-27');
    await user.type(screen.getByLabelText('第 1 条消息内容'), '<script>不执行</script> 如何恢复会话？');
    await user.click(screen.getByRole('button', { name: '提交手动导入' }));

    await waitFor(() => expect(api.importManualDialogue).toHaveBeenCalledWith({
      projectId: null,
      title: '手动保留的讨论',
      externalSourceId: 'discussion-2026-10-27',
      messages: [{ sourceMessageId: 'message-1', role: 'user', content: '<script>不执行</script> 如何恢复会话？', occurredAt: null }],
    }));
    expect(await screen.findByText(/手动对话导入任务已提交/)).toBeVisible();
    expect(screen.getByText('任务 job-manual')).toBeVisible();
    expect(api.discoverCodexThreads).not.toHaveBeenCalled();
  });
});
