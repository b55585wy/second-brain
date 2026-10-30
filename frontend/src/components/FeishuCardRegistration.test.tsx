import { act, fireEvent, render, screen } from '@testing-library/react';
import { FeishuRegistration } from './FeishuRegistration';
import { api, ApiError } from '../services/api';
import type { FeishuRegistrationStatus } from '../types';

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return { ...actual, api: {
    feishuRegistration: vi.fn(),
    startFeishuRegistration: vi.fn(),
    feishuCardRegistration: vi.fn(),
    startFeishuCardRegistration: vi.fn(),
    cancelFeishuCardRegistration: vi.fn(),
  } };
});

const idle: FeishuRegistrationStatus = { state: 'idle', url: null, qrDataUrl: null, expiresAt: null, message: '', error: null };
const waiting: FeishuRegistrationStatus = {
  state: 'waiting',
  url: 'https://example.test/cards/authorize',
  qrDataUrl: 'data:image/png;base64,CARD-SYNTHETIC',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  message: '请扫码启用学习卡片',
  error: null,
};
let onComplete: () => Promise<void>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function renderCards() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<FeishuRegistration purpose="cards" configured onComplete={onComplete} />);
    await Promise.resolve();
  });
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  onComplete = vi.fn().mockResolvedValue(undefined);
  vi.mocked(api.feishuCardRegistration).mockResolvedValue(idle);
  vi.mocked(api.startFeishuCardRegistration).mockResolvedValue(waiting);
  vi.mocked(api.cancelFeishuCardRegistration).mockResolvedValue(idle);
});

it('卡片二维码只在显式点击后创建，取消也只显式调用一次且不使用连接端点', async () => {
  const starting = deferred<FeishuRegistrationStatus>();
  vi.mocked(api.startFeishuCardRegistration).mockReturnValue(starting.promise);
  await renderCards();
  const button = await screen.findByRole('button', { name: '扫码启用学习卡片' });
  expect(api.feishuCardRegistration).toHaveBeenCalledTimes(1);
  expect(api.startFeishuCardRegistration).not.toHaveBeenCalled();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.startFeishuCardRegistration).toHaveBeenCalledTimes(1);
  await act(async () => starting.resolve(waiting));
  expect(await screen.findByRole('img', { name: '学习卡片授权二维码' })).toHaveAttribute('src', waiting.qrDataUrl);
  fireEvent.click(screen.getByRole('button', { name: '取消扫码授权' }));
  expect(await screen.findByRole('button', { name: '扫码启用学习卡片' })).toBeVisible();
  expect(api.cancelFeishuCardRegistration).toHaveBeenCalledTimes(1);
  expect(api.feishuRegistration).not.toHaveBeenCalled();
  expect(api.startFeishuRegistration).not.toHaveBeenCalled();
});

it('初始或恢复的 waiting 只按完成驱动 GET 轮询，不重复 POST，卸载后清理', async () => {
  const pending = deferred<FeishuRegistrationStatus>();
  vi.mocked(api.feishuCardRegistration).mockResolvedValueOnce(waiting).mockReturnValueOnce(pending.promise);
  const view = await renderCards();
  expect(await screen.findByRole('img', { name: '学习卡片授权二维码' })).toBeVisible();
  expect(api.startFeishuCardRegistration).not.toHaveBeenCalled();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
  expect(api.feishuCardRegistration).toHaveBeenCalledTimes(2);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
  expect(api.feishuCardRegistration).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(async () => pending.resolve(waiting));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
  expect(api.feishuCardRegistration).toHaveBeenCalledTimes(2);
  expect(api.startFeishuCardRegistration).not.toHaveBeenCalled();
}, 10000);

it('409 原样显示其他授权流冲突且不自动重试创建或取消', async () => {
  vi.mocked(api.startFeishuCardRegistration).mockRejectedValue(new ApiError('REGISTRATION_PENDING', '另一项扫码授权正在进行，请先完成或取消。', false, 409));
  await renderCards();
  fireEvent.click(await screen.findByRole('button', { name: '扫码启用学习卡片' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('另一项扫码授权正在进行，请先完成或取消。');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
  expect(api.startFeishuCardRegistration).toHaveBeenCalledTimes(1);
  expect(api.cancelFeishuCardRegistration).not.toHaveBeenCalled();
  expect(api.feishuCardRegistration).toHaveBeenCalledTimes(1);
});
