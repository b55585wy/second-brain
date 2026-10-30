import { RefreshCw, Save } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import type { AdviceSettings, AdviceSettingsInput } from '../types';
import { errorMessage } from '../utils/text';
import { Badge, Button, Field, Input, Loading, Notice, Section } from './ui';

type AdviceDraft = { enabled: boolean; dailyCallLimit: number | '' };
type DirtyField = keyof AdviceSettingsInput;

function draftFrom(settings: AdviceSettings): AdviceDraft {
  return { enabled: settings.enabled, dailyCallLimit: settings.dailyCallLimit };
}

export function AdviceSettingsPanel() {
  const [status, setStatus] = useState<AdviceSettings | null>(null);
  const [draft, setDraft] = useState<AdviceDraft | null>(null);
  const [reading, setReading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const statusRef = useRef<AdviceSettings | null>(null);
  const dirty = useRef(new Set<DirtyField>());
  const readingPromise = useRef<Promise<void> | null>(null);
  const savePending = useRef(false);

  const refresh = useCallback(() => {
    if (readingPromise.current) return readingPromise.current;
    const task = (async () => {
      setReading(true);
      setError('');
      try {
        const next = await api.adviceSettings();
        if (!mounted.current || (statusRef.current && next.revision < statusRef.current.revision)) return;
        statusRef.current = next;
        setStatus(next);
        setDraft((current) => current ? {
          enabled: dirty.current.has('enabled') ? current.enabled : next.enabled,
          dailyCallLimit: dirty.current.has('dailyCallLimit') ? current.dailyCallLimit : next.dailyCallLimit,
        } : draftFrom(next));
      } catch (reason) {
        if (mounted.current) setError(errorMessage(reason));
      } finally {
        readingPromise.current = null;
        if (mounted.current) setReading(false);
      }
    })();
    readingPromise.current = task;
    return task;
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  function change<FieldName extends DirtyField>(field: FieldName, value: AdviceDraft[FieldName]) {
    dirty.current.add(field);
    setDraft((current) => current ? { ...current, [field]: value } : current);
    setNotice('');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const current = statusRef.current;
    if (!current || !draft || savePending.current) return;
    const dailyCallLimit = Number(draft.dailyCallLimit);
    if (draft.dailyCallLimit === '' || !Number.isInteger(dailyCallLimit) || dailyCallLimit < 0 || dailyCallLimit > 20) {
      setError('每日点评上限需为 0–20 的整数；已填写的内容保持不变。');
      return;
    }
    savePending.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const saved = await api.saveAdviceSettings({ enabled: draft.enabled, dailyCallLimit }, current.revision);
      if (!mounted.current) return;
      statusRef.current = saved;
      dirty.current.clear();
      setStatus(saved);
      setDraft(draftFrom(saved));
      setNotice('自动点评设置已保存。');
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
    } finally {
      savePending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return <Section title="自动点评" description="独立控制新回答的 AI 建议；此上限与每日 3 次自动整理互不影响。" action={status && <Badge className={status.modelConfigured ? 'text-accent' : ''}><span className="status-dot" />{status.modelConfigured ? '模型已配置' : '模型未配置'}</Badge>}>
    {error && <div className="mb-4"><Notice tone="error">{error}</Notice></div>}
    {notice && <div className="mb-4"><Notice tone="success">{notice}</Notice></div>}
    {!status && reading ? <Loading label="正在读取自动点评设置…" /> : !status ? <Button variant="secondary" onClick={() => void refresh()} disabled={reading}><RefreshCw className="h-4 w-4" />重试读取自动点评</Button> : draft && <form onSubmit={save} className="space-y-5 border-y border-line py-5">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-end">
        <label className="flex items-center gap-2 pb-3 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={draft.enabled} onChange={(event) => change('enabled', event.target.checked)} />启用新回答自动点评</label>
        <Field label="每日点评上限（0–20 次）"><Input type="number" min={0} max={20} step={1} required value={draft.dailyCallLimit} onChange={(event) => change('dailyCallLimit', event.target.value === '' ? '' : Number(event.target.value))} /></Field>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p role="status" className="text-sm text-muted">今日已用 {status.callsToday} 次 · 剩余 {status.remainingToday} 次</p>
        <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => void refresh()} disabled={reading || saving}><RefreshCw className="h-4 w-4" />{reading ? '正在刷新…' : '刷新自动点评'}</Button><Button type="submit" disabled={saving}><Save className="h-4 w-4" />{saving ? '正在保存…' : '保存自动点评'}</Button></div>
      </div>
    </form>}
  </Section>;
}
