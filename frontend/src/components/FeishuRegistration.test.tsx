import { act, fireEvent, render, screen } from '@testing-library/react';
import { FeishuRegistration } from './FeishuRegistration';
import { api } from '../services/api';
import type { FeishuRegistrationStatus } from '../types';

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return { ...actual, api: { feishuRegistration: vi.fn(), startFeishuRegistration: vi.fn() } };
});

const idle: FeishuRegistrationStatus = { state: 'idle', url: null, qrDataUrl: null, expiresAt: null, message: '', error: null };
const waiting: FeishuRegistrationStatus = {
  state: 'waiting',
  url: 'https://example.test/authorize?from=scan%20unchanged',
  qrDataUrl: 'data:image/png;base64,SYNTHETIC',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  message: '请使用飞书扫码授权',
  error: null,
};
const complete: FeishuRegistrationStatus = { ...idle, state: 'complete', message: '扫码授权已完成' };
let onComplete: () => Promise<void>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function renderRegistration(configured = false) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<FeishuRegistration configured={configured} onComplete={onComplete} />);
    await Promise.resolve();
  });
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  onComplete = vi.fn().mockResolvedValue(undefined);
  vi.mocked(api.feishuRegistration).mockResolvedValue(idle);
  vi.mocked(api.startFeishuRegistration).mockResolvedValue(waiting);
});

it('只在显式点击后启动一次扫码，原样显示授权链接和二维码', async () => {
  const starting = deferred<FeishuRegistrationStatus>();
  vi.mocked(api.startFeishuRegistration).mockReturnValue(starting.promise);
  await renderRegistration();
  const button = await screen.findByRole('button', { name: '扫码连接飞书' });
  expect(api.feishuRegistration).toHaveBeenCalledTimes(1);
  expect(api.startFeishuRegistration).not.toHaveBeenCalled();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.startFeishuRegistration).toHaveBeenCalledTimes(1);
  await act(async () => starting.resolve(waiting));
  const link = await screen.findByRole('link', { name: waiting.url! });
  expect(link).toHaveAttribute('href', waiting.url);
  expect(screen.getByRole('img', { name: '飞书应用授权二维码' })).toHaveAttribute('src', waiting.qrDataUrl);
  expect(screen.getByText(/飞书可能仍要求发布应用或由管理员审核/)).toBeVisible();
});

it('重新打开 waiting 只恢复 GET 轮询，不重复 POST，请求不重叠且卸载后停止', async () => {
  const pending = deferred<FeishuRegistrationStatus>();
  vi.mocked(api.feishuRegistration).mockResolvedValueOnce(waiting).mockReturnValueOnce(pending.promise);
  const view = await renderRegistration();
  expect(await screen.findByRole('img', { name: '飞书应用授权二维码' })).toBeVisible();
  expect(api.feishuRegistration).toHaveBeenCalledTimes(1);
  expect(api.startFeishuRegistration).not.toHaveBeenCalled();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
  expect(api.feishuRegistration).toHaveBeenCalledTimes(2);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
  expect(api.feishuRegistration).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(async () => pending.resolve(waiting));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
  expect(api.feishuRegistration).toHaveBeenCalledTimes(2);
  expect(api.startFeishuRegistration).not.toHaveBeenCalled();
}, 10000);

it('waiting 完成后只触发一次完成刷新，不把授权完成显示成已连接', async () => {
  vi.mocked(api.feishuRegistration).mockResolvedValueOnce(waiting).mockResolvedValueOnce(complete);
  await renderRegistration();
  await screen.findByRole('img', { name: '飞书应用授权二维码' });
  expect(await screen.findByText('扫码授权已完成', {}, { timeout: 3500 })).toBeVisible();
  expect(screen.getByText(/授权完成不代表飞书已经连接/)).toBeVisible();
  expect(screen.queryByText('已连接')).not.toBeInTheDocument();
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(api.feishuRegistration).toHaveBeenCalledTimes(2);
  expect(api.startFeishuRegistration).not.toHaveBeenCalled();
});

it('初始 complete 每次挂载只刷新一次且不重新创建', async () => {
  vi.mocked(api.feishuRegistration).mockResolvedValue(complete);
  await renderRegistration(true);
  expect(await screen.findByText('扫码授权已完成')).toBeVisible();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
  expect(api.feishuRegistration).toHaveBeenCalledTimes(1);
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(api.startFeishuRegistration).not.toHaveBeenCalled();
});

it('轮询 GET 拒绝后保留二维码和错误，并恢复轮询到 complete', async () => {
  vi.mocked(api.feishuRegistration)
    .mockResolvedValueOnce(waiting)
    .mockRejectedValueOnce(new Error('暂时无法读取扫码进度'))
    .mockResolvedValueOnce(complete);
  await renderRegistration();
  expect(await screen.findByRole('img', { name: '飞书应用授权二维码' })).toBeVisible();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法读取扫码进度');
  expect(screen.getByRole('img', { name: '飞书应用授权二维码' })).toBeVisible();
  expect(await screen.findByText('扫码授权已完成', {}, { timeout: 3500 })).toBeVisible();
  expect(api.feishuRegistration).toHaveBeenCalledTimes(3);
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(api.startFeishuRegistration).not.toHaveBeenCalled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
}, 10000);

it('注册错误只在显式重试时重新创建', async () => {
  vi.mocked(api.feishuRegistration).mockResolvedValue({ ...idle, state: 'error', message: '创建失败', error: { code: 'SYNTHETIC', message: '请稍后重新扫码', retryable: true } });
  await renderRegistration();
  expect(await screen.findByText('请稍后重新扫码')).toBeVisible();
  expect(api.startFeishuRegistration).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重新生成二维码' }));
  expect(await screen.findByRole('img', { name: '飞书应用授权二维码' })).toBeVisible();
  expect(api.startFeishuRegistration).toHaveBeenCalledTimes(1);
});

it('二维码过期后停止轮询，只有显式点击才重新生成', async () => {
  vi.mocked(api.feishuRegistration).mockResolvedValue({ ...waiting, expiresAt: '2020-01-01T00:00:00.000Z' });
  await renderRegistration();
  expect(await screen.findByText(/二维码已过期，请重新生成/)).toBeVisible();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
  expect(api.feishuRegistration).toHaveBeenCalledTimes(1);
  expect(api.startFeishuRegistration).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重新生成二维码' }));
  expect(await screen.findByRole('img', { name: '飞书应用授权二维码' })).toBeVisible();
  expect(api.startFeishuRegistration).toHaveBeenCalledTimes(1);
});
