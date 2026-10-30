import { ArrowRight, Check, Send } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AdviceFeedback } from '../components/AdviceFeedback';
import { SourceRefs } from '../components/SourceRefs';
import { Badge, Button, EmptyState, ErrorState, Field, Loading, Notice, PageHeader, SafeText, Section, Textarea } from '../components/ui';
import { api, evidenceRefInputs, operationId } from '../services/api';
import type { AdviceState, Automation, Feedback, PracticeAttempt, TodayData } from '../types';
import { advicePending, preferReadyAdvice } from '../utils/advice';
import { errorMessage } from '../utils/text';

const draftKey = (id: string) => `zhixing.todayDraft.${id}`;
const fallbackStatuses = new Set<AdviceState['status']>(['off', 'limited', 'unavailable', 'failed', 'uncertain', 'stale']);

function setupEntry(automation: Automation) {
  if (!automation.setup.profile) return { to: '/settings#profile', label: '先完善学习档案' };
  if (!automation.setup.scope) return { to: '/codex', label: '选择可读取的对话' };
  if (!automation.setup.model) return { to: '/settings#model', label: '配置模型服务' };
  return null;
}

function TemplateFeedback({ feedback }: { feedback: Feedback }) {
  return <details className="mt-5 border-t border-line pt-5">
    <summary className="cursor-pointer text-sm text-accent">核对要点</summary>
    <div className="mt-4">
      <p className="text-sm text-muted">这是自查提示，未自动判分</p>
      <div className="mt-3"><Badge>{feedback.mode === 'template' ? '模板反馈 · 未核验正确性' : feedback.mode === 'model' ? '模型建议 · 需要核验' : '人工反馈'}</Badge></div>
      <SafeText className="mt-3">{feedback.summary}</SafeText>
      {feedback.observations.length > 0 && <ul className="mt-4 space-y-3">{feedback.observations.map((observation) => <li key={observation.criterionId} className="border-l border-line pl-4 text-sm"><span className="font-medium">{observation.finding === 'not_assessed' ? '未评估' : observation.finding === 'met' ? '已达到' : observation.finding === 'partial' ? '部分达到' : '未达到'}</span><SafeText className="mt-1 text-muted">{observation.comment}</SafeText></li>)}</ul>}
      {feedback.nextActions.length > 0 && <div className="mt-4"><h3 className="text-sm font-medium">可继续核对的方向</h3><ul className="mt-2 list-disc pl-5 text-sm text-muted">{feedback.nextActions.map((action) => <li key={action}>{action}</li>)}</ul></div>}
      {feedback.limitations.length > 0 && <ul className="mt-4 list-disc pl-5 text-sm text-muted">{feedback.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>}
    </div>
  </details>;
}

export function TodayPage() {
  const [data, setData] = useState<TodayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState('');
  const [automationError, setAutomationError] = useState('');
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [adviceErrors, setAdviceErrors] = useState<Record<string, string>>({});
  const [output, setOutput] = useState('');
  const [automationBusy, setAutomationBusy] = useState(false);
  const [practiceBusy, setPracticeBusy] = useState<Record<string, 'attempt' | 'feedback' | 'advice'>>({});
  const [pollCompletion, setPollCompletion] = useState(0);
  const dataRef = useRef<TodayData | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const pendingActions = useRef(new Set<string>());
  const confirmedAttempts = useRef(new Map<string, PracticeAttempt>());
  const confirmedAdvice = useRef(new Map<string, AdviceState>());
  const ambiguousOperations = useRef(new Map<string, { id: string; retry: boolean }>());

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (!dataRef.current) setLoading(true);
    try {
      const next = await api.today();
      if (!mounted.current) return;
      const previous = dataRef.current;
      const nextAutomation = previous && next.automation.revision < previous.automation.revision ? previous.automation : next.automation;
      const nextAdviceSettings = previous?.adviceSettings && next.adviceSettings && next.adviceSettings.revision < previous.adviceSettings.revision ? previous.adviceSettings : next.adviceSettings ?? previous?.adviceSettings;
      const nextPractice = next.practice;
      const samePractice = nextPractice?.id === previous?.practice?.id;
      const returnedAttempt = next.attempt?.practiceId === nextPractice?.id ? next.attempt : null;
      let nextAttempt = returnedAttempt ?? (nextPractice ? confirmedAttempts.current.get(nextPractice.id) ?? (samePractice ? previous?.attempt ?? null : null) : null);
      if (nextAttempt && previous?.attempt?.id === nextAttempt.id && previous.attempt.feedback && !nextAttempt.feedback) nextAttempt = { ...nextAttempt, feedback: previous.attempt.feedback };
      const previousAdvice = previous && previous.attempt?.id === nextAttempt?.id ? previous.advice : undefined;
      const incomingAdvice = next.advice?.attemptId === nextAttempt?.id ? next.advice : nextAttempt ? confirmedAdvice.current.get(nextAttempt.id) : undefined;
      const nextAdvice = nextAttempt ? preferReadyAdvice(previousAdvice, incomingAdvice) : null;
      if (nextAdvice) confirmedAdvice.current.set(nextAdvice.attemptId, nextAdvice);
      const merged: TodayData = { ...next, automation: nextAutomation, adviceSettings: nextAdviceSettings, practice: nextPractice, attempt: nextAttempt, advice: nextAdvice };
      dataRef.current = merged;
      setData(merged);
      setRefreshError('');
    } catch (reason) {
      if (mounted.current) setRefreshError(errorMessage(reason));
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setLoading(false);
        setPollCompletion((value) => value + 1);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  useEffect(() => {
    if (!pollCompletion) return;
    const state = dataRef.current?.automation.state;
    const delay = advicePending(dataRef.current?.advice) || state && ['collecting', 'organizing'].includes(state) ? 4000 : 60000;
    const timer = window.setTimeout(() => void refresh(), delay);
    return () => window.clearTimeout(timer);
  }, [pollCompletion, refresh, data?.advice?.status, data?.automation.state]);

  const practice = data?.practice ?? null;
  const practiceId = practice?.id ?? '';
  const attempt = data?.attempt ?? null;
  const advice = attempt && data?.advice?.attemptId === attempt.id ? data.advice : null;
  const busy = practiceBusy[practiceId] ?? '';
  const actionError = actionErrors[practiceId] ?? '';
  const adviceError = attempt ? adviceErrors[attempt.id] ?? '' : '';
  useEffect(() => {
    setOutput(practiceId ? localStorage.getItem(draftKey(practiceId)) || '' : '');
  }, [practiceId]);

  function setPracticeError(id: string, message: string) {
    setActionErrors((current) => {
      const next = { ...current };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });
  }

  function setAdviceError(id: string, message: string) {
    setAdviceErrors((current) => {
      const next = { ...current };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });
  }

  function setPracticeAction(id: string, action: 'attempt' | 'feedback' | 'advice' | null) {
    setPracticeBusy((current) => {
      const next = { ...current };
      if (action) next[id] = action;
      else delete next[id];
      return next;
    });
  }

  function adoptAttempt(saved: PracticeAttempt) {
    confirmedAttempts.current.set(saved.practiceId, saved);
    const current = dataRef.current;
    if (current?.practice?.id !== saved.practiceId) return;
    const savedAdvice = current.advice?.attemptId === saved.id ? current.advice : confirmedAdvice.current.get(saved.id);
    const merged = { ...current, attempt: saved, advice: savedAdvice };
    dataRef.current = merged;
    setData(merged);
  }

  function adoptAdvice(incoming: AdviceState) {
    const currentAdvice = confirmedAdvice.current.get(incoming.attemptId);
    const saved = preferReadyAdvice(currentAdvice, incoming) ?? incoming;
    confirmedAdvice.current.set(saved.attemptId, saved);
    const current = dataRef.current;
    if (current?.attempt?.id !== saved.attemptId || current.practice?.id !== current.attempt.practiceId) return;
    let currentAttempt = current.attempt;
    if (saved.feedback) {
      currentAttempt = { ...currentAttempt, feedback: saved.feedback };
      confirmedAttempts.current.set(currentAttempt.practiceId, currentAttempt);
    }
    const merged = { ...current, attempt: currentAttempt, advice: saved };
    dataRef.current = merged;
    setData(merged);
  }

  async function toggleAutomation() {
    const current = dataRef.current;
    if (!current || pendingActions.current.has('automation')) return;
    pendingActions.current.add('automation');
    setAutomationBusy(true); setAutomationError('');
    try {
      const saved = await api.saveAutomation(!current.automation.enabled, current.automation.revision);
      if (!mounted.current) return;
      const latest = dataRef.current;
      if (latest) {
        const merged = { ...latest, automation: saved.revision >= latest.automation.revision ? saved : latest.automation };
        dataRef.current = merged;
        setData(merged);
      }
      await refresh();
    } catch (reason) {
      if (mounted.current) setAutomationError(errorMessage(reason));
    } finally {
      pendingActions.current.delete('automation');
      if (mounted.current) setAutomationBusy(false);
    }
  }

  async function requestFeedback(savedAttempt: PracticeAttempt) {
    const id = savedAttempt.practiceId;
    const key = `feedback:${savedAttempt.id}`;
    if (pendingActions.current.has(key)) return;
    pendingActions.current.add(key);
    setPracticeAction(id, 'feedback'); setPracticeError(id, '');
    try {
      const feedback = await api.feedback(savedAttempt.id, id, 'template');
      if (mounted.current) adoptAttempt({ ...savedAttempt, feedback });
    } catch (reason) {
      if (mounted.current) setPracticeError(id, `本次输出已保存。核对要点暂不可用：${errorMessage(reason)}`);
    } finally {
      pendingActions.current.delete(key);
      if (mounted.current) setPracticeAction(id, null);
    }
  }

  async function readAdvice(savedAttempt: PracticeAttempt) {
    const key = `advice:${savedAttempt.id}`;
    if (pendingActions.current.has(key)) return;
    pendingActions.current.add(key);
    setPracticeAction(savedAttempt.practiceId, 'advice');
    setAdviceError(savedAttempt.id, '');
    try {
      const next = await api.advice(savedAttempt.id);
      ambiguousOperations.current.delete(savedAttempt.id);
      if (mounted.current) adoptAdvice(next);
    } catch (reason) {
      if (mounted.current) setAdviceError(savedAttempt.id, `AI 建议读取失败：${errorMessage(reason)}`);
    } finally {
      pendingActions.current.delete(key);
      if (mounted.current) setPracticeAction(savedAttempt.practiceId, null);
    }
  }

  async function requestModelAdvice(savedAttempt: PracticeAttempt, retry: boolean) {
    const key = `advice:${savedAttempt.id}`;
    if (pendingActions.current.has(key)) return;
    const ambiguous = ambiguousOperations.current.get(savedAttempt.id);
    const known = confirmedAdvice.current.get(savedAttempt.id);
    if (!ambiguous && (retry ? !known?.canRetry : !known?.canRequest)) return;
    const id = ambiguous?.id ?? operationId();
    const operationRetry = ambiguous?.retry ?? retry;
    pendingActions.current.add(key);
    setPracticeAction(savedAttempt.practiceId, 'advice');
    setAdviceError(savedAttempt.id, '');
    try {
      const next = await api.requestAdvice(savedAttempt.id, id, operationRetry);
      ambiguousOperations.current.delete(savedAttempt.id);
      if (mounted.current) adoptAdvice(next);
    } catch (reason) {
      ambiguousOperations.current.set(savedAttempt.id, { id, retry: operationRetry });
      if (mounted.current) setAdviceError(savedAttempt.id, `请求结果尚未确认：${errorMessage(reason)} 可使用同一操作安全重试，不会主动创建新请求。`);
    } finally {
      pendingActions.current.delete(key);
      if (mounted.current) setPracticeAction(savedAttempt.practiceId, null);
    }
  }

  async function submitAttempt(event: FormEvent) {
    event.preventDefault();
    const selectedPractice = practice;
    if (!selectedPractice || attempt || pendingActions.current.has(`attempt:${selectedPractice.id}`)) return;
    if (!output.trim()) { setPracticeError(selectedPractice.id, '请先写下你的解释、应用过程或成果。'); return; }
    const id = selectedPractice.id;
    const key = `attempt:${id}`;
    pendingActions.current.add(key);
    setPracticeAction(id, 'attempt'); setPracticeError(id, '');
    try {
      const saved = await api.attemptPractice(id, { output: output.trim(), assistanceLevel: 'none', evidenceRefs: evidenceRefInputs(selectedPractice.sourceRefs) });
      if (!mounted.current) return;
      adoptAttempt(saved);
      if (dataRef.current?.practice?.id === saved.practiceId) setOutput(saved.output);
      localStorage.removeItem(draftKey(saved.practiceId));
      if (dataRef.current?.adviceSettings?.enabled === true) await readAdvice(saved);
      else await requestFeedback(saved);
    } catch (reason) {
      if (mounted.current) setPracticeError(id, errorMessage(reason));
    } finally {
      pendingActions.current.delete(key);
      if (mounted.current) setPracticeAction(id, null);
    }
  }

  if (loading && !data) return <Loading label="正在读取今天的内容…" />;
  if (!data) return <><PageHeader title="今天" /><ErrorState error={refreshError} retry={() => void refresh()} /></>;

  const automation = data.automation;
  const setup = setupEntry(automation);
  const paused = data.profile.dailyBudgetMinutes === 0 && !practice;
  const editorVisible = !!practice && !attempt;
  const enablePrimary = !setup && !automation.enabled && !practice;
  const hasIndependentPracticeTitle = !!practice && practice.title.trim().length > 0 && practice.title !== practice.goal && practice.title !== practice.prompt.slice(0, 60);
  const modelFeedback = attempt?.feedback?.mode === 'model' ? attempt.feedback : advice?.feedback?.mode === 'model' ? advice.feedback : null;
  const ambiguousOperation = attempt ? ambiguousOperations.current.get(attempt.id) : undefined;
  return <div className="mx-auto max-w-5xl">
    <PageHeader eyebrow={data.date} title="今天" description="只看与当前目标相关的重点，以及一项练习。" />
    <section aria-labelledby="automation-status" className="mb-10 border-l-2 border-accent pl-5 sm:pl-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 id="automation-status" className="text-lg">自动整理</h2><p role="status" className="mt-1 text-sm text-muted">{automation.message}</p></div>
        {setup ? <Link to={setup.to} className={editorVisible ? 'btn-secondary' : 'btn-primary'}>{setup.label}<ArrowRight className="h-4 w-4" /></Link> : <Button variant={enablePrimary ? 'primary' : 'secondary'} onClick={toggleAutomation} disabled={automationBusy}>{automationBusy ? '正在保存…' : automation.enabled ? '停用自动整理' : '开启自动整理'}</Button>}
      </div>
    </section>
    {refreshError && <div className="mb-6"><Notice tone="error">{refreshError} 已保留最近一次成功读取的内容。<div className="mt-2"><Button variant="secondary" onClick={() => void refresh()} disabled={inFlight.current}>重试读取</Button></div></Notice></div>}
    {automationError && <div className="mb-6"><Notice tone="error">{automationError}</Notice></div>}
    {actionError && <div className="mb-6"><Notice tone="error">{actionError}{attempt && !attempt.feedback && <div className="mt-2"><Button variant="secondary" onClick={() => void requestFeedback(attempt)} disabled={busy === 'feedback'}>{busy === 'feedback' ? '正在准备核对要点…' : '仅重试核对要点'}</Button></div>}</Notice></div>}

    <Section title="与你目标相关的重点" description="最多展示三项；展开可核对来源。">
      {data.highlights.length ? <div className="divide-y divide-line border-y border-line">{data.highlights.slice(0, 3).map((highlight) => <article key={highlight.id} className="py-6">
        <p className="text-xs text-accent">{highlight.goal}</p><h3 className="mt-2 text-xl">{highlight.title}</h3><SafeText className="mt-2 text-muted">{highlight.summary}</SafeText><p className="mt-3 text-sm"><span className="text-muted">为什么相关：</span>{highlight.whyRelevant}</p>
        <details className="mt-3"><summary className="cursor-pointer text-sm text-accent">查看来源</summary><div className="mt-3"><SourceRefs refs={highlight.sourceRefs} /></div></details>
      </article>)}</div> : <EmptyState title="今天还没有可展示的重点" description="有值得回顾的内容时，会出现在这里" />}
    </Section>

    <Section title="今日练习" className="mt-12">
      {practice ? <article>
        {practice.skill && <p className="eyebrow">{practice.skill}</p>}{hasIndependentPracticeTitle && <h3 className="mt-2 text-2xl">{practice.title}</h3>}<SafeText className="mt-4">{practice.prompt}</SafeText>{practice.goal && <p className="mt-3 text-sm text-muted">目标：{practice.goal}</p>}
        <details className="mt-4"><summary className="cursor-pointer text-sm text-accent">评价要点与来源</summary><div className="mt-4 grid gap-6 sm:grid-cols-2"><div><h4 className="mb-2 text-sm font-medium">评价要点</h4>{practice.rubric.length ? <ol className="space-y-3 text-sm text-muted">{practice.rubric.map((criterion) => <li key={criterion.id}><p className="font-medium text-ink">{criterion.label}</p><SafeText>{criterion.description}</SafeText>{criterion.expectedEvidence.length > 0 && <p className="text-xs">需要的证据：{criterion.expectedEvidence.join('、')}</p>}</li>)}</ol> : <p className="text-sm text-muted">未提供评价要点。</p>}</div><div><h4 className="mb-2 text-sm font-medium">来源</h4><SourceRefs refs={practice.sourceRefs} /></div></div></details>
        {attempt ? <div className="mt-6 border-t border-line pt-6"><div className="flex items-center gap-2 text-accent"><Check className="h-5 w-5" aria-hidden="true" /><h4 className="font-medium">本次输出已保存</h4></div><SafeText className="mt-4 rounded-md bg-surface p-4">{attempt.output}</SafeText>
          {busy === 'feedback' && <p role="status" className="mt-3 text-sm text-muted">正在准备核对要点…</p>}
          {modelFeedback && <AdviceFeedback feedback={modelFeedback} />}
          {attempt.feedback && attempt.feedback.mode !== 'model' && <TemplateFeedback feedback={attempt.feedback} />}
          {advice && <p role="status" className="mt-3 text-sm text-muted">{advice.message || (advicePending(advice) ? '正在准备 AI 建议…' : 'AI 建议当前不可用；已保存的输出不受影响。')}</p>}
          {advice?.lastError && advice.lastError.message !== advice.message && <p className="mt-2 text-sm text-danger">{advice.lastError.message}</p>}
          {adviceError && <div className="mt-3"><Notice tone="error">{adviceError}<div className="mt-2"><Button variant="secondary" onClick={() => ambiguousOperation ? void requestModelAdvice(attempt, ambiguousOperation.retry) : void readAdvice(attempt)} disabled={busy === 'advice'}>{ambiguousOperation ? '安全重试请求' : '重新读取建议'}</Button></div></Notice></div>}
          <div className="mt-3 flex flex-wrap gap-2">
            {!ambiguousOperation && advice?.canRetry && <Button variant="secondary" onClick={() => void requestModelAdvice(attempt, true)} disabled={busy === 'advice'}>{busy === 'advice' ? '正在请求点评…' : '重新请求点评'}</Button>}
            {!ambiguousOperation && !advice?.canRetry && advice?.canRequest && <Button variant="secondary" onClick={() => void requestModelAdvice(attempt, false)} disabled={busy === 'advice'}>{busy === 'advice' ? '正在请求建议…' : '获取AI建议'}</Button>}
            {(!advice || fallbackStatuses.has(advice.status)) && <Button variant="ghost" onClick={() => void requestFeedback(attempt)} disabled={busy === 'feedback'}>{busy === 'feedback' ? '正在准备核对要点…' : '使用本地模板自查'}</Button>}
          </div>
          {!advice && !adviceError && !actionError && <p className="mt-3 text-sm text-muted">核对要点尚未准备好；已保存的输出不受影响。</p>}
        </div> : <form onSubmit={submitAttempt} className="mt-6"><Field label="你的输出" hint="草稿会自动保留。先用自己的话回答，再对照要点检查。"><Textarea className="min-h-56" value={output} onChange={(event) => { setOutput(event.target.value); localStorage.setItem(draftKey(practice.id), event.target.value); }} placeholder="用自己的话写下答案、过程或成果…" /></Field><Button type="submit" className="mt-4" disabled={busy === 'attempt' || !output.trim()}><Send className="h-4 w-4" />{busy === 'attempt' ? '正在保存…' : '保存输出'}</Button></form>}
      </article> : <EmptyState title={paused ? '今日练习因预算暂停' : '今天还没有练习'} description={paused ? '每日预算为 0 分钟，因此没有生成练习。可在学习档案中调整预算。' : '相关重点准备好后，这里会安排一个练习'} action={paused ? <Link to="/settings#profile" className="btn-secondary">编辑时间预算</Link> : undefined} />}
    </Section>
    <p className="mt-12 border-t border-line pt-5 text-sm text-muted">模型整理的内容需要你结合原始来源核对事实。</p>
  </div>;
}
