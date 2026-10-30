import { QrCode, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import type { FeishuRegistrationStatus } from '../types';
import { errorMessage } from '../utils/text';
import { Button, Loading, Notice } from './ui';

function expiryText(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
}

type FeishuRegistrationProps = {
  configured: boolean;
  onComplete: () => Promise<void>;
  purpose?: 'connect' | 'cards';
};

export function FeishuRegistration({ configured, onComplete, purpose = 'connect' }: FeishuRegistrationProps) {
  const cards = purpose === 'cards';
  const [registration, setRegistration] = useState<FeishuRegistrationStatus | null>(null);
  const [reading, setReading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [readError, setReadError] = useState('');
  const [expired, setExpired] = useState(false);
  const [readVersion, setReadVersion] = useState(0);
  const mounted = useRef(true);
  const registrationRef = useRef<FeishuRegistrationStatus | null>(null);
  const completionHandledRef = useRef(false);
  const readingRef = useRef(false);
  const startingRef = useRef(false);
  const cancellingRef = useRef(false);

  const readRegistration = useCallback(() => cards
    ? api.feishuCardRegistration()
    : api.feishuRegistration(), [cards]);

  const complete = useCallback(async () => {
    try {
      await onComplete();
    } catch (reason) {
      if (mounted.current) setReadError(errorMessage(reason));
    }
  }, [onComplete]);

  const accept = useCallback((next: FeishuRegistrationStatus) => {
    if (!mounted.current) return;
    registrationRef.current = next;
    setRegistration(next);
    if (next.state === 'complete' && !completionHandledRef.current) {
      completionHandledRef.current = true;
      void complete();
    }
  }, [complete]);

  const refresh = useCallback(async () => {
    if (readingRef.current) return;
    readingRef.current = true;
    setReading(true);
    try {
      const next = await readRegistration();
      accept(next);
      if (mounted.current) setReadError('');
    } catch (reason) {
      if (mounted.current) setReadError(errorMessage(reason));
    } finally {
      readingRef.current = false;
      if (mounted.current) {
        setReading(false);
        setReadVersion((current) => current + 1);
      }
    }
  }, [accept, readRegistration]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!registration || !['starting', 'waiting'].includes(registration.state) || expired) return;
    const timer = window.setTimeout(() => void refresh(), 2000);
    return () => window.clearTimeout(timer);
  }, [registration, readVersion, expired, refresh]);

  useEffect(() => {
    setExpired(false);
    if (registration?.state !== 'waiting' || !registration.expiresAt) return;
    const expiresAt = Date.parse(registration.expiresAt);
    if (Number.isNaN(expiresAt)) return;
    const delay = expiresAt - Date.now();
    if (delay <= 0) {
      setExpired(true);
      return;
    }
    const timer = window.setTimeout(() => setExpired(Date.now() >= expiresAt), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [registration]);

  async function start() {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setReadError('');
    try {
      accept(await (cards ? api.startFeishuCardRegistration() : api.startFeishuRegistration()));
    } catch (reason) {
      if (mounted.current) setReadError(errorMessage(reason));
    } finally {
      startingRef.current = false;
      if (mounted.current) setStarting(false);
    }
  }

  async function cancel() {
    if (!cards || cancellingRef.current) return;
    cancellingRef.current = true;
    setCancelling(true);
    setReadError('');
    try {
      accept(await api.cancelFeishuCardRegistration());
    } catch (reason) {
      if (mounted.current) setReadError(errorMessage(reason));
    } finally {
      cancellingRef.current = false;
      if (mounted.current) setCancelling(false);
    }
  }

  if (!cards && configured && registration?.state !== 'complete') return null;

  const scanAction = <Button onClick={() => void start()} disabled={starting || reading}>
    <QrCode className="h-4 w-4" />{starting ? '正在准备二维码…' : registration?.state === 'error' || expired ? '重新生成二维码' : cards ? '扫码启用学习卡片' : '扫码连接飞书'}
  </Button>;
  const titleId = cards ? 'feishu-card-registration-title' : 'feishu-registration-title';

  return <section aria-labelledby={titleId} className="rounded-lg border border-accent/25 bg-accent/5 p-5">
    <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="max-w-2xl">
        <h3 id={titleId} className="text-lg">{cards ? '启用学习卡片' : '扫码设置飞书应用'}</h3>
        <p className="mt-2 text-sm leading-6 text-muted">{cards ? '为当前飞书应用授权学习卡片按钮，无需创建新应用或填写凭据。' : '无需先填写 App ID 或 App Secret。使用飞书扫码并按页面提示授权。'}</p>
      </div>
      {(!registration || registration.state === 'idle') && <div className="shrink-0">{scanAction}</div>}
    </div>

    <div className="mt-4 space-y-4">
      {readError && <Notice tone="error">{readError}</Notice>}
      {!registration && reading && <Loading label={cards ? '正在读取学习卡片授权状态…' : '正在读取扫码设置状态…'} />}
      {!registration && !reading && <Button variant="secondary" onClick={() => void refresh()}><RefreshCw className="h-4 w-4" />{cards ? '重试读取学习卡片授权状态' : '重试读取扫码设置状态'}</Button>}
      {registration?.state === 'starting' && <p role="status" className="text-sm text-muted">{registration.message || '正在准备二维码，请稍候…'}</p>}
      {registration?.state === 'waiting' && <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-start">
        <div className="min-w-0">
          <p role="status" className="text-sm">{registration.message || '请使用飞书扫描二维码。'}</p>
          {registration.url && <a className="mt-3 block break-all text-sm font-medium text-accent underline underline-offset-4" href={registration.url} target="_blank" rel="noreferrer">{registration.url}</a>}
          {registration.expiresAt && <p className="mt-3 text-sm text-muted">二维码有效期至 <time dateTime={registration.expiresAt}>{expiryText(registration.expiresAt)}</time></p>}
          {cards && <Button variant="secondary" className="mt-3" onClick={() => void cancel()} disabled={cancelling || starting}>{cancelling ? '正在取消…' : '取消扫码授权'}</Button>}
          {expired && <Notice tone="error"><p>二维码已过期，请重新生成。系统不会自动创建新的二维码。</p><div className="mt-3">{scanAction}</div></Notice>}
          {readError && !expired && <Button variant="secondary" className="mt-3" onClick={() => void refresh()} disabled={reading}><RefreshCw className="h-4 w-4" />重试读取扫码进度</Button>}
        </div>
        {registration.qrDataUrl && <img className="h-[180px] w-[180px] max-w-full rounded-md border border-line bg-white p-2" src={registration.qrDataUrl} alt={cards ? '学习卡片授权二维码' : '飞书应用授权二维码'} />}
      </div>}
      {registration?.state === 'error' && <div>
        <Notice tone="error">{registration.error?.message || registration.message || '二维码创建失败，请重试。'}</Notice>
        <div className="mt-4">{scanAction}</div>
      </div>}
      {registration?.state === 'complete' && <Notice tone="success">
        <p>{registration.message || '扫码授权已完成。'}</p>
        <p className="mt-1">{cards ? '授权完成不代表卡片按钮已可用，请等待首次按钮操作确认。' : '授权完成不代表飞书已经连接，请查看当前连接状态，并按提示完成账号绑定。'}</p>
      </Notice>}
      {!cards && (registration?.state === 'waiting' || registration?.state === 'complete') && <p className="text-sm leading-6 text-muted">扫码后，飞书可能仍要求发布应用或由管理员审核，完成后才能正常连接。</p>}
    </div>
  </section>;
}
