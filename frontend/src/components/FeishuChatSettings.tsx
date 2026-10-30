import { RefreshCw, Send } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import type { FeishuChatEntry, FeishuChatInput, FeishuChatPair, FeishuChatStatus } from '../types';
import { errorMessage, formatDate } from '../utils/text';
import { FeishuRegistration } from './FeishuRegistration';
import { Badge, Button, Field, Input, Loading, Notice, Section } from './ui';

const stateLabels: Record<FeishuChatStatus['connection']['state'], string> = {
  off: '已停用',
  setup: '待配置',
  connecting: '连接中',
  connected: '已连接',
  error: '连接错误',
};

function draftFrom(status: FeishuChatStatus): FeishuChatInput {
  return { enabled: status.enabled, remindersEnabled: status.remindersEnabled, reminderLocalTime: status.reminderLocalTime };
}

function expiryText(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
}

function officialEntryUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const params = [...url.searchParams.entries()];
    if (!['https://applink.feishu.cn', 'https://applink.larksuite.com'].includes(url.origin)) return null;
    if (url.pathname !== '/client/bot/open' || url.username || url.password || url.hash) return null;
    if (params.length !== 1 || params[0][0] !== 'appId' || !params[0][1].trim()) return null;
    return value;
  } catch {
    return null;
  }
}

export function FeishuChatSettings({ onRegistrationComplete }: { onRegistrationComplete?: () => Promise<void> } = {}) {
  const [status, setStatus] = useState<FeishuChatStatus | null>(null);
  const [draft, setDraft] = useState<FeishuChatInput | null>(null);
  const [entry, setEntry] = useState<FeishuChatEntry | null>(null);
  const [entryError, setEntryError] = useState('');
  const [pair, setPair] = useState<FeishuChatPair | null>(null);
  const [pairExpired, setPairExpired] = useState(false);
  const [reading, setReading] = useState(true);
  const [pending, setPending] = useState<'save' | 'pair' | 'send' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sendUncertain, setSendUncertain] = useState(false);
  const mounted = useRef(true);
  const readingPromiseRef = useRef<Promise<void> | null>(null);
  const pendingRef = useRef(false);
  const statusRef = useRef<FeishuChatStatus | null>(null);

  const refresh = useCallback(() => {
    if (readingPromiseRef.current) return readingPromiseRef.current;
    const task = (async () => {
      setReading(true);
      setError('');
      setEntry(null);
      setEntryError('');
      try {
        const next = await api.feishuChat();
        if (!mounted.current || (statusRef.current && next.revision < statusRef.current.revision)) return;
        statusRef.current = next;
        setStatus(next);
        setDraft((current) => current ? { ...current, enabled: next.enabled } : draftFrom(next));
        try {
          const nextEntry = await api.feishuChatEntry();
          if (mounted.current) setEntry(nextEntry);
        } catch (reason) {
          if (mounted.current) {
            setEntry(null);
            setEntryError(errorMessage(reason));
          }
        }
      } catch (reason) {
        if (mounted.current) setError(errorMessage(reason));
      } finally {
        readingPromiseRef.current = null;
        if (mounted.current) setReading(false);
      }
    })();
    readingPromiseRef.current = task;
    return task;
  }, []);

  const registrationComplete = useCallback(async () => {
    await readingPromiseRef.current;
    if (!mounted.current) return;
    await Promise.all([refresh(), onRegistrationComplete?.()]);
  }, [refresh, onRegistrationComplete]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!pair) return;
    const expiresAt = Date.parse(pair.expiresAt);
    if (Number.isNaN(expiresAt)) return;
    const delay = expiresAt - Date.now();
    if (delay <= 0) {
      setPairExpired(true);
      return;
    }
    const timer = window.setTimeout(() => setPairExpired(true), delay);
    return () => window.clearTimeout(timer);
  }, [pair]);

  async function save(next: FeishuChatInput) {
    if (!status || pendingRef.current) return;
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(next.reminderLocalTime)) {
      setError('提醒时间需使用有效的 HH:mm 格式。');
      return;
    }
    pendingRef.current = true;
    setPending('save');
    setError('');
    setNotice('');
    try {
      const saved = await api.saveFeishuChat(next, status.revision);
      if (!mounted.current) return;
      statusRef.current = saved;
      setStatus(saved);
      setDraft(draftFrom(saved));
      setNotice('飞书学习设置已保存。');
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(null);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft) void save(draft);
  }

  async function requestPair() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending('pair');
    setError('');
    setNotice('');
    try {
      const result = await api.pairFeishuChat();
      if (!mounted.current) return;
      setPairExpired(false);
      setPair(result);
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(null);
    }
  }

  async function sendToday() {
    if (!status || sendUncertain || pendingRef.current || !status.bound || !status.enabled || status.connection.state !== 'connected') return;
    pendingRef.current = true;
    setPending('send');
    setError('');
    setNotice('');
    try {
      const result = await api.sendFeishuToday();
      if (!mounted.current) return;
      if (result.completed) setNotice('今日已作答，无需重复发送。');
      else if (result.alreadySent || result.deliveryState === 'sent') setNotice('今日练习已发送，未重复排队。');
      else if (result.deliveryState === 'uncertain') {
        setSendUncertain(true);
        setNotice('上次投递未确认，请检查飞书，或回网页“今天”继续。为避免重复投递，不会再次自动发送。');
      } else if (result.queued || result.deliveryState === 'pending' || result.deliveryState === 'sending') setNotice('今日练习正在排队或发送中，尚不代表已经送达。');
      else if (result.deliveryState === 'failed' || result.deliveryState === 'cancelled') setNotice('今日练习暂未送达。');
      else if (!result.practiceId) setNotice('当前没有可发送的今日练习。');
      else setNotice('今日练习未进入发送队列。');
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(null);
    }
  }

  const busy = pending !== null;
  const canSend = !!status && status.bound && status.enabled && status.connection.state === 'connected' && !busy && !sendUncertain;
  const entryUrl = entry?.url ? officialEntryUrl(entry.url) : null;

  return <Section title="飞书学习" description="独立配置学习私聊与提醒，不改变飞书文档来源或定时任务。" action={status && <Badge className={status.connection.state === 'connected' ? 'text-accent' : ''}><span className="status-dot" />{stateLabels[status.connection.state]}</Badge>}>
    <p className="mb-5 max-w-3xl text-sm leading-6 text-muted">连接只在本程序运行时有效。你可以直接在飞书回复，同一份输出会出现在网页“今天”；这里不提供另一套网页聊天。</p>
    {error && <div className="mb-4"><Notice tone="error">{error}</Notice></div>}
    {notice && <div className="mb-4"><Notice tone={sendUncertain ? 'info' : 'success'}>{notice}{sendUncertain && <a className="ml-2 font-medium text-accent underline underline-offset-4" href="/">回网页“今天”继续</a>}</Notice></div>}
    {!status && reading ? <Loading label="正在读取飞书学习状态…" /> : !status ? <Button variant="secondary" onClick={() => void refresh()} disabled={reading}><RefreshCw className="h-4 w-4" />重试读取飞书学习状态</Button> : draft && <div className="space-y-6">
      <div className="flex flex-col gap-4 border-y border-line py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm">
          <p role="status">{status.connection.message}</p>
          <p className="mt-1 text-muted">{status.configured ? '应用凭据已配置' : '应用凭据未配置'} · {status.bound ? '已绑定自己的飞书账号' : '尚未绑定飞书账号'}</p>
          {status.connection.lastError && <p className="mt-2 text-danger">{status.connection.lastError.message}{status.connection.lastError.retryable ? '（可重试）' : ''}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void refresh()} disabled={reading || busy}><RefreshCw className="h-4 w-4" />{reading ? '正在刷新…' : '刷新状态'}</Button>
          <Button variant="secondary" role="switch" aria-checked={status.enabled} onClick={() => void save({ ...draft, enabled: !status.enabled })} disabled={busy || reading}>{status.enabled ? '停用飞书学习' : '启用飞书学习'}</Button>
        </div>
      </div>

      {!(status.configured && typeof status.cardsEnabled === 'boolean') && <FeishuRegistration configured={status.configured} onComplete={registrationComplete} />}

      {typeof status.cardsEnabled === 'boolean' && status.configured && (status.cardsEnabled
        ? <section aria-labelledby="feishu-cards-status-title" className="rounded-lg border border-line px-5 py-4">
          <h3 id="feishu-cards-status-title" className="text-lg">学习卡片</h3>
          <p role="status" className="mt-2 text-sm text-muted">{status.lastCardActionAt ? '已收到按钮操作' : '等待首次按钮确认'}</p>
        </section>
        : <FeishuRegistration purpose="cards" configured={status.configured} onComplete={registrationComplete} />)}

      {!status.configured && <Notice>已有飞书应用？可在高级设置中手动填写 <a className="font-medium text-accent underline underline-offset-4" href="#feishu">飞书 App ID 与 App Secret</a>。无需手动填写时，直接扫码即可。</Notice>}

      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px_auto] sm:items-end">
        <label className="flex items-center gap-2 pb-3 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={draft.remindersEnabled} onChange={(event) => setDraft({ ...draft, remindersEnabled: event.target.checked })} />启用飞书学习提醒</label>
        <Field label="每日提醒时间" hint="使用本地时间 HH:mm。"><Input type="time" required value={draft.reminderLocalTime} onChange={(event) => setDraft({ ...draft, reminderLocalTime: event.target.value })} /></Field>
        <Button type="submit" disabled={busy || reading}>保存学习提醒</Button>
      </form>

      <div className="grid gap-6 border-t border-line pt-6 lg:grid-cols-2">
        <section aria-labelledby="feishu-pair-title">
          <h3 id="feishu-pair-title" className="text-lg">绑定自己的飞书</h3>
          <p className="mt-2 text-sm leading-6 text-muted">绑定后会自动收到当前练习。直接回复，网页‘今天’也会显示同一份输出。</p>
          <p className="mt-2 text-sm leading-6 text-muted">仅发送给你已绑定的飞书账号，无需填写接收人 ID。</p>
          {entryUrl && <div className="mt-4 rounded-lg border border-accent/25 bg-accent/5 p-4">
            <a className="btn-primary inline-flex" href={entryUrl} target="_blank" rel="noopener noreferrer">打开飞书私聊</a>
            <p className="mt-3 text-sm leading-6 text-muted">无需创建群聊；获取绑定码后，在机器人私聊中发送该码即可绑定。手机扫码也能打开机器人，无需电脑客户端。</p>
            {entry?.qrDataUrl && <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium text-accent">手机扫码打开</summary>
              <img className="mt-3 h-44 w-44 max-w-full rounded-md border border-line bg-white p-2" src={entry.qrDataUrl} alt="飞书私聊入口二维码" />
            </details>}
          </div>}
          {entryError && <div className="mt-4"><Notice tone="error"><p>{entryError}</p><Button variant="secondary" className="mt-3" onClick={() => void refresh()} disabled={reading}><RefreshCw className="h-4 w-4" />重试读取私聊入口</Button></Notice></div>}
          {!status.bound && <div className="mt-4">
            <Button variant="secondary" onClick={() => void requestPair()} disabled={busy || !status.configured || !status.enabled}>{pair ? '重新获取绑定码' : '获取绑定码'}</Button>
            {pair && <div className="mt-4 rounded-md border border-line bg-surface p-4">
              <p className="text-sm">在飞书私聊机器人发送：绑定 <strong className="font-mono text-lg tracking-wide">{pair.code}</strong></p>
              <p className="mt-2 text-sm text-muted">绑定码有效期至 <time dateTime={pair.expiresAt}>{expiryText(pair.expiresAt)}</time></p>
              {pairExpired && <p role="alert" className="mt-2 text-sm text-danger">绑定码已过期，请重新获取；系统不会自动申请新码。</p>}
            </div>}
          </div>}
          {status.bound && <p className="mt-4 text-sm text-accent">已完成绑定。如果刚在飞书完成绑定，可刷新状态查看最新结果。</p>}
        </section>

        <section aria-labelledby="feishu-send-title">
          <h3 id="feishu-send-title" className="text-lg">发送当前练习</h3>
          <p className="mt-2 text-sm leading-6 text-muted">仅当学习连接已启用、已连接且已绑定时可发送。加入队列不代表已经送达。</p>
          <Button className="mt-4" onClick={() => void sendToday()} disabled={!canSend}><Send className="h-4 w-4" />发送今日练习</Button>
          <p className="mt-3 text-xs text-muted">最近接收：{formatDate(status.lastReceivedAt || undefined)} · 最近发送：{formatDate(status.lastSentAt || undefined)}</p>
        </section>
      </div>
    </div>}
  </Section>;
}
