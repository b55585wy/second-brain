import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CodexPage } from './CodexPage';
import { api } from '../services/api';
import type { CodexScope } from '../types';

vi.mock('../services/api', () => ({ api: {
  codexThreads: vi.fn(), projects: vi.fn(), codexScope: vi.fn(), importManualDialogue: vi.fn(), syncCodex: vi.fn(), job: vi.fn(), saveCodexScope: vi.fn(),
} }));

const scope: CodexScope = { enabled: false, allowedThreadIds: [], allowedProjectPaths: [], excludedThreadIds: [], excludedProjectPaths: [], includeArchived: false, allowManualImports: true, revision: 1 };

describe('Codex 手动后备', () => {
  it('自动 app-server 列表失败时仍能提交实际手动对话结构', async () => {
    const user = userEvent.setup();
    vi.mocked(api.codexThreads).mockRejectedValue(new Error('app-server 不可用'));
    vi.mocked(api.projects).mockResolvedValue({ items: [], total: 0 });
    vi.mocked(api.codexScope).mockResolvedValue(scope);
    vi.mocked(api.importManualDialogue).mockResolvedValue({ id: 'job-manual', status: 'succeeded', syncedCount: 1 });
    render(<CodexPage />);

    expect(await screen.findByText('app-server 不可用')).toBeVisible();
    expect(screen.getByRole('button', { name: '重试自动发现' })).toBeVisible();
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
  });
});
