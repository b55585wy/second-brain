import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { FeishuChatSettings } from './FeishuChatSettings';
import { api, ApiError } from '../services/api';
import type { FeishuChatSendToday, FeishuChatStatus } from '../types';

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return { ...actual, api: {
    feishuChat: vi.fn(), feishuChatEntry: vi.fn(), feishuRegistration: vi.fn(), startFeishuRegistration: vi.fn(), saveFeishuChat: vi.fn(), pairFeishuChat: vi.fn(), sendFeishuToday: vi.fn(),
  } };
});

const status: FeishuChatStatus = {
  enabled: true,
  revision: 7,
  remindersEnabled: false,
  reminderLocalTime: '09:30',
  bound: false,
  configured: true,
  lastReceivedAt: null,
  lastSentAt: null,
  connection: { state: 'connected', message: '机器人已连接', lastError: null },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.feishuChat).mockResolvedValue(status);
  vi.mocked(api.feishuChatEntry).mockResolvedValue({ url: null, qrDataUrl: null });
  vi.mocked(api.feishuRegistration).mockResolvedValue({ state: 'idle', url: null, qrDataUrl: null, expiresAt: null, message: '', error: null });
  vi.mocked(api.startFeishuRegistration).mockResolvedValue({ state: 'waiting', url: 'https://example.test/authorize', qrDataUrl: 'data:image/png;base64,SYNTHETIC', expiresAt: '2099-01-01T00:00:00.000Z', message: '请扫码', error: null });
  vi.mocked(api.saveFeishuChat).mockImplementation(async (body, revision) => ({ ...status, ...body, revision: revision + 1 }));
  vi.mocked(api.pairFeishuChat).mockResolvedValue({ code: 'TEST42', expiresAt: '2026-10-29T12:00:00.000Z' });
  vi.mocked(api.sendFeishuToday).mockResolvedValue({ queued: true, alreadySent: false, practiceId: 'practice-synthetic' });
});

describe('飞书学习状态与独立修订', () => {
  it('挂载只读取状态，诚实显示后端消息和运行限制，不自动写入', async () => {
    render(<FeishuChatSettings />);
    expect(await screen.findByText('机器人已连接')).toBeVisible();
    expect(api.feishuChat).toHaveBeenCalledTimes(1);
    expect(api.saveFeishuChat).not.toHaveBeenCalled();
    expect(api.pairFeishuChat).not.toHaveBeenCalled();
    expect(api.sendFeishuToday).not.toHaveBeenCalled();
    expect(screen.getByText(/连接只在本程序运行时有效/)).toBeVisible();
    expect(screen.getByText(/同一份输出会出现在网页“今天”/)).toBeVisible();
    expect(screen.queryByLabelText(/open_id|chat_id|接收人 ID/)).not.toBeInTheDocument();
  });

  it('StrictMode 挂载清理周期不会发起重叠 GET', async () => {
    const reading = deferred<FeishuChatStatus>();
    vi.mocked(api.feishuChat).mockReturnValue(reading.promise);
    render(<StrictMode><FeishuChatSettings /></StrictMode>);
    expect(api.feishuChat).toHaveBeenCalledTimes(1);
    await act(async () => reading.resolve(status));
    expect(await screen.findByText('机器人已连接')).toBeVisible();
    expect(api.feishuChat).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['off', '已停用'],
    ['setup', '待配置'],
    ['connecting', '连接中'],
    ['connected', '已连接'],
    ['error', '连接错误'],
  ] as const)('显示 %s 连接状态及后端消息', async (state, label) => {
    vi.mocked(api.feishuChat).mockResolvedValue({ ...status, enabled: state !== 'off', configured: state !== 'setup', connection: { state, message: `后端 ${state} 消息`, lastError: state === 'error' ? { code: 'SYNTHETIC', message: '合成连接故障', retryable: true } : null } });
    render(<FeishuChatSettings />);
    expect(await screen.findByText(`后端 ${state} 消息`)).toBeVisible();
    expect(screen.getByText(label)).toBeVisible();
    if (state === 'error') expect(screen.getByText('合成连接故障（可重试）')).toBeVisible();
  });

  it('未配置时链接现有 #feishu 凭据表单，已启用的连接仍可停用', async () => {
    const user = userEvent.setup();
    vi.mocked(api.feishuChat).mockResolvedValue({ ...status, configured: false, connection: { state: 'error', message: '凭据已移除', lastError: null } });
    render(<FeishuChatSettings />);
    expect(await screen.findByRole('link', { name: '飞书 App ID 与 App Secret' })).toHaveAttribute('href', '#feishu');
    await user.click(screen.getByRole('switch', { name: '停用飞书学习' }));
    expect(api.saveFeishuChat).toHaveBeenCalledWith({ enabled: false, remindersEnabled: false, reminderLocalTime: '09:30' }, 7);
    expect(await screen.findByRole('switch', { name: '启用飞书学习' })).toHaveAttribute('aria-checked', 'false');
  });

  it('提醒保存发送独立当前修订并阻止重复 pending 提交', async () => {
    const user = userEvent.setup();
    const saving = deferred<FeishuChatStatus>();
    vi.mocked(api.saveFeishuChat).mockReturnValue(saving.promise);
    render(<FeishuChatSettings />);
    const time = await screen.findByLabelText('每日提醒时间');
    await user.clear(time);
    await user.type(time, '21:15');
    await user.click(screen.getByLabelText('启用飞书学习提醒'));
    const submit = screen.getByRole('button', { name: '保存学习提醒' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(api.saveFeishuChat).toHaveBeenCalledTimes(1);
    expect(api.saveFeishuChat).toHaveBeenCalledWith({ enabled: true, remindersEnabled: true, reminderLocalTime: '21:15' }, 7);
    await act(async () => saving.resolve({ ...status, revision: 8, remindersEnabled: true, reminderLocalTime: '21:15' }));
    expect(await screen.findByText('飞书学习设置已保存。')).toBeVisible();
    expect(time).toHaveValue('21:15');
  });

  it('写入失败保留提醒草稿和当前状态', async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveFeishuChat).mockRejectedValue(new ApiError('SYNTHETIC', '保存失败，草稿仍在'));
    render(<FeishuChatSettings />);
    const time = await screen.findByLabelText('每日提醒时间');
    await user.clear(time);
    await user.type(time, '20:45');
    await user.click(screen.getByRole('button', { name: '保存学习提醒' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败，草稿仍在');
    expect(time).toHaveValue('20:45');
    expect(screen.getByText('机器人已连接')).toBeVisible();
  });

  it('读取失败与后续成功刷新都保留未保存提醒，外部绑定不会自动发送', async () => {
    const user = userEvent.setup();
    vi.mocked(api.feishuChat)
      .mockResolvedValueOnce(status)
      .mockRejectedValueOnce(new ApiError('OFFLINE', '读取暂时失败'))
      .mockResolvedValueOnce({ ...status, revision: 9, bound: true, reminderLocalTime: '08:00' });
    render(<FeishuChatSettings />);
    const time = await screen.findByLabelText('每日提醒时间');
    await user.clear(time);
    await user.type(time, '22:05');
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('读取暂时失败');
    expect(time).toHaveValue('22:05');
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    expect(await screen.findByText('已完成绑定。如果刚在飞书完成绑定，可刷新状态查看最新结果。')).toBeVisible();
    expect(time).toHaveValue('22:05');
    expect(api.feishuChat).toHaveBeenCalledTimes(3);
    expect(api.sendFeishuToday).not.toHaveBeenCalled();
    expect(api.pairFeishuChat).not.toHaveBeenCalled();
  });

  it('修订冲突不自动重试，显式刷新后手工保存采用最新修订且保留草稿', async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveFeishuChat)
      .mockRejectedValueOnce(new ApiError('REVISION_CONFLICT', '修订冲突，输入已保留'))
      .mockResolvedValueOnce({ ...status, revision: 11, reminderLocalTime: '19:40' });
    vi.mocked(api.feishuChat)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ ...status, revision: 10, reminderLocalTime: '08:00' });
    render(<FeishuChatSettings />);
    const time = await screen.findByLabelText('每日提醒时间');
    await user.clear(time);
    await user.type(time, '19:40');
    await user.click(screen.getByRole('button', { name: '保存学习提醒' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('修订冲突');
    expect(api.saveFeishuChat).toHaveBeenCalledTimes(1);
    expect(time).toHaveValue('19:40');
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    await waitFor(() => expect(api.feishuChat).toHaveBeenCalledTimes(2));
    expect(time).toHaveValue('19:40');
    await user.click(screen.getByRole('button', { name: '保存学习提醒' }));
    expect(api.saveFeishuChat).toHaveBeenNthCalledWith(2, { enabled: true, remindersEnabled: false, reminderLocalTime: '19:40' }, 10);
  });

  it('较低修订的迟到 GET 不撤销更新成功或最新 enabled 草稿', async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveFeishuChat).mockResolvedValue({ ...status, enabled: true, revision: 8 });
    vi.mocked(api.feishuChat)
      .mockResolvedValueOnce({ ...status, enabled: false, connection: { state: 'off', message: '尚未启用', lastError: null } })
      .mockResolvedValueOnce({ ...status, enabled: false, connection: { state: 'off', message: '旧状态', lastError: null } });
    render(<FeishuChatSettings />);
    await user.click(await screen.findByRole('switch', { name: '启用飞书学习' }));
    expect(await screen.findByRole('switch', { name: '停用飞书学习' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    await waitFor(() => expect(api.feishuChat).toHaveBeenCalledTimes(2));
    expect(screen.getByText('机器人已连接')).toBeVisible();
    expect(screen.queryByText('旧状态')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存学习提醒' }));
    expect(api.saveFeishuChat).toHaveBeenLastCalledWith({ enabled: true, remindersEnabled: false, reminderLocalTime: '09:30' }, 8);
  });

  it('初次 GET 失败只显示局部错误，显式重试可恢复', async () => {
    const user = userEvent.setup();
    vi.mocked(api.feishuChat).mockRejectedValueOnce(new ApiError('OFFLINE', '飞书状态读取失败')).mockResolvedValueOnce(status);
    render(<FeishuChatSettings />);
    expect(await screen.findByRole('alert')).toHaveTextContent('飞书状态读取失败');
    await user.click(screen.getByRole('button', { name: '重试读取飞书学习状态' }));
    expect(await screen.findByText('机器人已连接')).toBeVisible();
    expect(api.feishuChat).toHaveBeenCalledTimes(2);
  });
});

describe('飞书私聊只读入口', () => {
  it('服务端返回 null 时隐藏入口，挂载不触发任何注册、绑定、保存或发送写入', async () => {
    render(<FeishuChatSettings />);
    expect(await screen.findByText('机器人已连接')).toBeVisible();
    await waitFor(() => expect(api.feishuChatEntry).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('link', { name: '打开飞书私聊' })).not.toBeInTheDocument();
    expect(screen.queryByText('手机扫码打开')).not.toBeInTheDocument();
    expect(screen.queryByAltText('飞书私聊入口二维码')).not.toBeInTheDocument();
    expect(api.startFeishuRegistration).not.toHaveBeenCalled();
    expect(api.saveFeishuChat).not.toHaveBeenCalled();
    expect(api.pairFeishuChat).not.toHaveBeenCalled();
    expect(api.sendFeishuToday).not.toHaveBeenCalled();
  });

  it.each([
    'https://applink.feishu.cn/client/bot/open?appId=cli_synthetic',
    'https://applink.larksuite.com/client/bot/open?appId=cli_synthetic',
  ])('原样使用官方服务端 AppLink %s，并在安全的新窗口打开', async (url) => {
    vi.mocked(api.feishuChatEntry).mockResolvedValue({ url, qrDataUrl: null });
    render(<FeishuChatSettings />);
    const link = await screen.findByRole('link', { name: '打开飞书私聊' });
    expect(link).toHaveAttribute('href', url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(api.pairFeishuChat).not.toHaveBeenCalled();
    expect(api.sendFeishuToday).not.toHaveBeenCalled();
  });

  it.each([
    'https://example.test/client/bot/open?appId=cli_synthetic',
    'https://applink.feishu.cn/client/bot/other?appId=cli_synthetic',
    'https://applink.feishu.cn/client/bot/open',
    'https://applink.feishu.cn/client/bot/open?appId=',
    'javascript:alert(1)',
  ])('拒绝非官方或缺少 appId 的入口 %s，也不显示其二维码', async (url) => {
    vi.mocked(api.feishuChatEntry).mockResolvedValue({ url, qrDataUrl: 'data:image/png;base64,UNTRUSTED' });
    render(<FeishuChatSettings />);
    expect(await screen.findByText('机器人已连接')).toBeVisible();
    await waitFor(() => expect(api.feishuChatEntry).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('link', { name: '打开飞书私聊' })).not.toBeInTheDocument();
    expect(screen.queryByText('手机扫码打开')).not.toBeInTheDocument();
    expect(screen.queryByAltText('飞书私聊入口二维码')).not.toBeInTheDocument();
  });

  it('二维码默认折叠，展开后使用服务端 data URL 和指定替代文本', async () => {
    const user = userEvent.setup();
    vi.mocked(api.feishuChatEntry).mockResolvedValue({ url: 'https://applink.feishu.cn/client/bot/open?appId=cli_synthetic', qrDataUrl: 'data:image/png;base64,SYNTHETIC' });
    render(<FeishuChatSettings />);
    expect(await screen.findByRole('link', { name: '打开飞书私聊' })).toBeVisible();
    const summary = screen.getByText('手机扫码打开');
    const details = summary.closest('details');
    const image = screen.getByAltText('飞书私聊入口二维码');
    expect(details).not.toHaveAttribute('open');
    expect(image).not.toBeVisible();
    await user.click(summary);
    expect(details).toHaveAttribute('open');
    expect(image).toBeVisible();
    expect(image).toHaveAttribute('src', 'data:image/png;base64,SYNTHETIC');
    expect(screen.getByText(/无需创建群聊/)).toBeVisible();
  });

  it('入口 GET 失败只显示局部错误和重试，保留提醒草稿及现有控件且不写入', async () => {
    const user = userEvent.setup();
    const url = 'https://applink.feishu.cn/client/bot/open?appId=cli_retry';
    vi.mocked(api.feishuChatEntry).mockRejectedValueOnce(new ApiError('OFFLINE', '私聊入口暂时不可用')).mockResolvedValueOnce({ url, qrDataUrl: null });
    render(<FeishuChatSettings />);
    const time = await screen.findByLabelText('每日提醒时间');
    await user.clear(time);
    await user.type(time, '21:40');
    expect(await screen.findByRole('alert')).toHaveTextContent('私聊入口暂时不可用');
    expect(time).toHaveValue('21:40');
    expect(screen.getByRole('button', { name: '获取绑定码' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '保存学习提醒' })).toBeEnabled();
    expect(screen.getByText('机器人已连接')).toBeVisible();
    expect(screen.queryByRole('link', { name: '打开飞书私聊' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试读取私聊入口' }));
    expect(await screen.findByRole('link', { name: '打开飞书私聊' })).toHaveAttribute('href', url);
    expect(time).toHaveValue('21:40');
    expect(api.feishuChat).toHaveBeenCalledTimes(2);
    expect(api.feishuChatEntry).toHaveBeenCalledTimes(2);
    expect(api.startFeishuRegistration).not.toHaveBeenCalled();
    expect(api.saveFeishuChat).not.toHaveBeenCalled();
    expect(api.pairFeishuChat).not.toHaveBeenCalled();
    expect(api.sendFeishuToday).not.toHaveBeenCalled();
  });

  it('刷新后的权威 null 同时清除旧链接和二维码', async () => {
    const user = userEvent.setup();
    vi.mocked(api.feishuChatEntry)
      .mockResolvedValueOnce({ url: 'https://applink.feishu.cn/client/bot/open?appId=cli_old', qrDataUrl: 'data:image/png;base64,OLD' })
      .mockResolvedValueOnce({ url: null, qrDataUrl: null });
    render(<FeishuChatSettings />);
    expect(await screen.findByRole('link', { name: '打开飞书私聊' })).toBeVisible();
    expect(screen.getByAltText('飞书私聊入口二维码')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    expect(await screen.findByRole('button', { name: '刷新状态' })).toBeEnabled();
    expect(api.feishuChatEntry).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('link', { name: '打开飞书私聊' })).not.toBeInTheDocument();
    expect(screen.queryByAltText('飞书私聊入口二维码')).not.toBeInTheDocument();
    expect(api.saveFeishuChat).not.toHaveBeenCalled();
    expect(api.pairFeishuChat).not.toHaveBeenCalled();
    expect(api.sendFeishuToday).not.toHaveBeenCalled();
  });

  it('应用变化刷新立即撤下旧入口，串行读取只应用本轮新入口', async () => {
    const user = userEvent.setup();
    const reading = deferred<{ url: string | null; qrDataUrl: string | null }>();
    const oldUrl = 'https://applink.feishu.cn/client/bot/open?appId=cli_old';
    const newUrl = 'https://applink.larksuite.com/client/bot/open?appId=cli_new';
    vi.mocked(api.feishuChat)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ ...status, revision: 8, configured: false, connection: { state: 'setup', message: '应用已更换', lastError: null } });
    vi.mocked(api.feishuChatEntry)
      .mockResolvedValueOnce({ url: oldUrl, qrDataUrl: 'data:image/png;base64,OLD' })
      .mockReturnValueOnce(reading.promise);
    render(<FeishuChatSettings />);
    expect(await screen.findByRole('link', { name: '打开飞书私聊' })).toHaveAttribute('href', oldUrl);
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    expect(screen.queryByRole('link', { name: '打开飞书私聊' })).not.toBeInTheDocument();
    expect(api.feishuChat).toHaveBeenCalledTimes(2);
    expect(api.feishuChatEntry).toHaveBeenCalledTimes(2);
    await act(async () => reading.resolve({ url: newUrl, qrDataUrl: null }));
    expect(await screen.findByRole('link', { name: '打开飞书私聊' })).toHaveAttribute('href', newUrl);
    expect(screen.queryByAltText('飞书私聊入口二维码')).not.toBeInTheDocument();
    expect(api.startFeishuRegistration).not.toHaveBeenCalled();
    expect(api.saveFeishuChat).not.toHaveBeenCalled();
    expect(api.pairFeishuChat).not.toHaveBeenCalled();
    expect(api.sendFeishuToday).not.toHaveBeenCalled();
  });
});

describe('飞书绑定与发送命令', () => {
  it('仅显式获取一次绑定码，显示指令和过期状态且过期不自动换码', async () => {
    const pairing = deferred<{ code: string; expiresAt: string }>();
    vi.mocked(api.pairFeishuChat).mockReturnValue(pairing.promise);
    render(<FeishuChatSettings />);
    const button = await screen.findByRole('button', { name: '获取绑定码' });
    expect(api.pairFeishuChat).not.toHaveBeenCalled();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.pairFeishuChat).toHaveBeenCalledTimes(1);
    await act(async () => pairing.resolve({ code: 'TEST42', expiresAt: '2020-01-01T00:00:00.000Z' }));
    expect(screen.getByText((_, element) => element?.textContent === '在飞书私聊机器人发送：绑定 TEST42')).toBeVisible();
    expect(screen.getByRole('time')).toHaveAttribute('datetime', '2020-01-01T00:00:00.000Z');
    expect(await screen.findByRole('alert')).toHaveTextContent('绑定码已过期');
    expect(api.pairFeishuChat).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '重新获取绑定码' })).toBeEnabled();
    expect(api.sendFeishuToday).not.toHaveBeenCalled();
  });

  it('绑定失败保留状态和已编辑提醒，允许显式重试', async () => {
    const user = userEvent.setup();
    vi.mocked(api.pairFeishuChat).mockRejectedValueOnce(new ApiError('PAIR_FAILED', '绑定码申请失败')).mockResolvedValueOnce({ code: 'RETRY7', expiresAt: '2026-10-29T12:00:00.000Z' });
    render(<FeishuChatSettings />);
    const time = await screen.findByLabelText('每日提醒时间');
    await user.clear(time);
    await user.type(time, '18:25');
    await user.click(screen.getByRole('button', { name: '获取绑定码' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('绑定码申请失败');
    expect(time).toHaveValue('18:25');
    await user.click(screen.getByRole('button', { name: '获取绑定码' }));
    expect(await screen.findByText('RETRY7')).toBeVisible();
    expect(api.pairFeishuChat).toHaveBeenCalledTimes(2);
  });

  it.each([
    { bound: false },
    { enabled: false },
    { connection: { state: 'connecting', message: '连接中', lastError: null } },
  ] satisfies Partial<FeishuChatStatus>[])('发送资格不满足时禁用：%s', async (override) => {
    vi.mocked(api.feishuChat).mockResolvedValue({ ...status, bound: true, ...override });
    render(<FeishuChatSettings />);
    expect(await screen.findByRole('button', { name: '发送今日练习' })).toBeDisabled();
    expect(api.sendFeishuToday).not.toHaveBeenCalled();
  });

  it.each([
    [{ queued: true, alreadySent: false, practiceId: 'practice-synthetic' }, '正在排队或发送中，尚不代表已经送达'],
    [{ queued: false, alreadySent: true, practiceId: 'practice-synthetic' }, '已发送，未重复排队'],
    [{ queued: false, alreadySent: false, practiceId: null }, '当前没有可发送的今日练习'],
    [{ queued: false, alreadySent: false, practiceId: 'practice-synthetic' }, '未进入发送队列'],
    [{ queued: false, alreadySent: false, practiceId: null, completed: true }, '今日已作答'],
    [{ queued: false, alreadySent: false, practiceId: null, deliveryState: 'sent' }, '已发送，未重复排队'],
    [{ queued: false, alreadySent: false, practiceId: null, deliveryState: 'pending' }, '正在排队或发送中，尚不代表已经送达'],
    [{ queued: false, alreadySent: false, practiceId: null, deliveryState: 'sending' }, '正在排队或发送中，尚不代表已经送达'],
    [{ queued: false, alreadySent: false, practiceId: null, deliveryState: 'failed' }, '暂未送达'],
    [{ queued: false, alreadySent: false, practiceId: null, deliveryState: 'cancelled' }, '暂未送达'],
  ] satisfies [FeishuChatSendToday, string][])('诚实显示发送结果 %s', async (result, message) => {
    const user = userEvent.setup();
    vi.mocked(api.feishuChat).mockResolvedValue({ ...status, bound: true });
    vi.mocked(api.sendFeishuToday).mockResolvedValue(result);
    render(<FeishuChatSettings />);
    const button = await screen.findByRole('button', { name: '发送今日练习' });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(await screen.findByText((content) => content.includes(message))).toBeVisible();
    expect(api.sendFeishuToday).toHaveBeenCalledTimes(1);
  });

  it('投递未确认时阻止刷新或再次点击造成重复 POST，并提供网页 Today 继续入口', async () => {
    const user = userEvent.setup();
    vi.mocked(api.feishuChat).mockResolvedValue({ ...status, bound: true });
    vi.mocked(api.sendFeishuToday).mockResolvedValue({ queued: false, alreadySent: false, practiceId: null, deliveryState: 'uncertain' });
    render(<FeishuChatSettings />);
    const button = await screen.findByRole('button', { name: '发送今日练习' });
    await user.click(button);
    expect(await screen.findByText(/上次投递未确认，请检查飞书/)).toBeVisible();
    expect(screen.getByRole('link', { name: '回网页“今天”继续' })).toHaveAttribute('href', '/');
    expect(button).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    await waitFor(() => expect(api.feishuChat).toHaveBeenCalledTimes(2));
    fireEvent.click(button);
    expect(api.sendFeishuToday).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
  });

  it('发送 pending 防重复，失败保留状态和提醒草稿', async () => {
    const user = userEvent.setup();
    const sending = deferred<FeishuChatSendToday>();
    vi.mocked(api.feishuChat).mockResolvedValue({ ...status, bound: true });
    vi.mocked(api.sendFeishuToday).mockReturnValueOnce(sending.promise).mockRejectedValueOnce(new ApiError('SEND_FAILED', '发送命令失败'));
    render(<FeishuChatSettings />);
    const button = await screen.findByRole('button', { name: '发送今日练习' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.sendFeishuToday).toHaveBeenCalledTimes(1);
    await act(async () => sending.resolve({ queued: false, alreadySent: true, practiceId: 'practice-synthetic' }));
    const time = screen.getByLabelText('每日提醒时间');
    await user.clear(time);
    await user.type(time, '17:55');
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('发送命令失败');
    expect(time).toHaveValue('17:55');
    expect(screen.getByText('机器人已连接')).toBeVisible();
  });
});
