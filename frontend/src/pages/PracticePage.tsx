import { Check, FilePlus2, Save, Send } from 'lucide-react';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { AdviceFeedback } from '../components/AdviceFeedback';
import { SourceRefs } from '../components/SourceRefs';
import { Badge, Button, EmptyState, ErrorState, Field, Input, Loading, Notice, PageHeader, SafeText, Section, Select, Textarea } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api, evidenceRefInputs, operationId, sourceRefInputs } from '../services/api';
import type { AdviceState, AssistanceLevel, Feedback, Output, Practice, PracticeAttempt } from '../types';
import { advicePending, preferReadyAdvice } from '../utils/advice';
import { errorMessage } from '../utils/text';

const draftKey = (id: string) => `zhixing.practiceDraft.${id}`;
const blankArtifact = (): Output => ({ id: '', title: '', content: '', goal: '', status: 'draft', projectId: null, practiceId: null, sourceRefs: [], evidenceRefs: [], revision: 0 });

export function PracticePage() {
  const resource = useApi(() => Promise.all([api.practices(), api.outputs()]), []);
  const [tab, setTab] = useState<'practice' | 'outputs'>('practice');
  const [selected, setSelected] = useState<Practice | null>(null);
  const [output, setOutput] = useState('');
  const [assistanceLevel, setAssistanceLevel] = useState<AssistanceLevel>('none');
  const [evidence, setEvidence] = useState('');
  const [attempt, setAttempt] = useState<PracticeAttempt | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [advice, setAdvice] = useState<AdviceState | null>(null);
  const [adviceBusy, setAdviceBusy] = useState(false);
  const [adviceError, setAdviceError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [artifact, setArtifact] = useState<Output>(blankArtifact);
  const mounted = useRef(true);
  const selectedRef = useRef<Practice | null>(null);
  const attemptRef = useRef<PracticeAttempt | null>(null);
  const selectionVersion = useRef(0);
  const pendingActions = useRef(new Set<string>());
  const adviceCache = useRef(new Map<string, AdviceState>());
  const confirmedAttempts = useRef(new Map<string, PracticeAttempt>());
  const ambiguousOperations = useRef(new Map<string, { id: string; retry: boolean }>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      selectionVersion.current += 1;
    };
  }, []);

  function adoptAttempt(saved: PracticeAttempt) {
    if (selectedRef.current?.id !== saved.practiceId) return;
    const cached = adviceCache.current.get(saved.id);
    const next = cached?.feedback ? { ...saved, feedback: cached.feedback } : saved;
    attemptRef.current = next;
    setAttempt(next);
    setFeedback(next.feedback || null);
    setAdvice(cached ?? null);
  }

  function adoptAdvice(incoming: AdviceState) {
    const cached = adviceCache.current.get(incoming.attemptId);
    const saved = preferReadyAdvice(cached, incoming) ?? incoming;
    adviceCache.current.set(saved.attemptId, saved);
    const current = attemptRef.current;
    if (!current || current.id !== saved.attemptId || selectedRef.current?.id !== current.practiceId) return;
    setAdvice(saved);
    if (saved.feedback) {
      const nextAttempt = { ...current, feedback: saved.feedback };
      attemptRef.current = nextAttempt;
      setAttempt(nextAttempt);
      setFeedback(saved.feedback);
    }
  }

  async function readAdvice(target: PracticeAttempt, showBusy = false) {
    const key = `advice:${target.id}`;
    if (pendingActions.current.has(key)) return;
    pendingActions.current.add(key);
    if (showBusy && attemptRef.current?.id === target.id) setAdviceBusy(true);
    if (attemptRef.current?.id === target.id) setAdviceError('');
    try {
      const next = await api.advice(target.id);
      ambiguousOperations.current.delete(target.id);
      if (mounted.current) adoptAdvice(next);
    } catch (reason) {
      if (mounted.current && attemptRef.current?.id === target.id) setAdviceError(errorMessage(reason));
    } finally {
      pendingActions.current.delete(key);
      if (mounted.current && showBusy && attemptRef.current?.id === target.id) setAdviceBusy(false);
    }
  }

  useEffect(() => {
    selectedRef.current = selected;
    const version = ++selectionVersion.current;
    attemptRef.current = null;
    setOutput(selected ? localStorage.getItem(draftKey(selected.id)) || '' : '');
    setAttempt(null); setFeedback(null); setAdvice(null); setAdviceError(''); setAdviceBusy(false); setEvidence('');
    if (!selected) return;
    void (async () => {
      try {
        const result = await api.practiceAttempts(selected.id);
        if (!mounted.current || version !== selectionVersion.current || selectedRef.current?.id !== selected.id) return;
        const confirmed = confirmedAttempts.current.get(selected.id);
        if (confirmed) {
          if (attemptRef.current?.id !== confirmed.id) adoptAttempt(confirmed);
          return;
        }
        const existing = result.items[0] ?? null;
        if (existing) {
          adoptAttempt(existing);
          await readAdvice(existing);
        }
      } catch (reason) {
        if (mounted.current && version === selectionVersion.current) setAdviceError(`已有尝试读取失败：${errorMessage(reason)}`);
      }
    })();
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const timer = window.setTimeout(() => localStorage.setItem(draftKey(selected.id), output), 250);
    return () => window.clearTimeout(timer);
  }, [output, selected]);

  const attemptId = attempt?.id;
  const adviceStatus = advice?.status;
  useEffect(() => {
    if (!attemptId || !advicePending(advice)) return;
    let active = true;
    let timer = 0;
    const poll = async () => {
      const target = attemptRef.current;
      if (target?.id === attemptId) await readAdvice(target);
      if (active && mounted.current && attemptRef.current?.id === attemptId) timer = window.setTimeout(poll, 4000);
    };
    timer = window.setTimeout(poll, 4000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [attemptId, adviceStatus, selected?.id]);

  async function submitAttempt(event: FormEvent) {
    event.preventDefault();
    const selectedPractice = selected;
    if (!selectedPractice || !output.trim()) { setError('请先写下你的解释、应用过程或成果。'); return; }
    const key = `attempt:${selectedPractice.id}`;
    if (pendingActions.current.has(key)) return;
    pendingActions.current.add(key);
    setBusy(true); setError(''); setMessage('');
    try {
      const saved = await api.attemptPractice(selectedPractice.id, { output: output.trim(), assistanceLevel, evidenceRefs: evidenceRefInputs(selectedPractice.sourceRefs, evidence) });
      confirmedAttempts.current.set(saved.practiceId, saved);
      localStorage.removeItem(draftKey(selectedPractice.id));
      if (mounted.current && selectedRef.current?.id === selectedPractice.id) {
        adoptAttempt(saved);
        setMessage('本次尝试已保存。反馈需单独获取，并会标明未评估部分。');
        await readAdvice(saved, true);
      }
    } catch (reason) {
      if (mounted.current && selectedRef.current?.id === selectedPractice.id) setError(errorMessage(reason));
    } finally {
      pendingActions.current.delete(key);
      if (mounted.current) setBusy(false);
    }
  }

  async function getFeedback() {
    const currentAttempt = attempt;
    const selectedPractice = selected;
    if (!currentAttempt || !selectedPractice || pendingActions.current.has(`feedback:${currentAttempt.id}`)) return;
    pendingActions.current.add(`feedback:${currentAttempt.id}`);
    setBusy(true); setError('');
    try {
      const next = await api.feedback(currentAttempt.id, selectedPractice.id, 'template');
      if (mounted.current && attemptRef.current?.id === currentAttempt.id && selectedRef.current?.id === selectedPractice.id) {
        setFeedback(next);
        setMessage('已读取服务端保存的模板反馈；它不代表正确性已经验证。');
      }
    } catch (reason) {
      if (mounted.current && attemptRef.current?.id === currentAttempt.id) setError(errorMessage(reason));
    } finally {
      pendingActions.current.delete(`feedback:${currentAttempt.id}`);
      if (mounted.current) setBusy(false);
    }
  }

  async function requestModelAdvice(retry: boolean) {
    const target = attemptRef.current;
    if (!target) return;
    const key = `advice:${target.id}`;
    if (pendingActions.current.has(key)) return;
    const ambiguous = ambiguousOperations.current.get(target.id);
    const known = adviceCache.current.get(target.id);
    if (!ambiguous && (retry ? !known?.canRetry : !known?.canRequest)) return;
    const id = ambiguous?.id ?? operationId();
    const operationRetry = ambiguous?.retry ?? retry;
    pendingActions.current.add(key);
    setAdviceBusy(true); setAdviceError('');
    try {
      const next = await api.requestAdvice(target.id, id, operationRetry);
      ambiguousOperations.current.delete(target.id);
      if (mounted.current) adoptAdvice(next);
    } catch (reason) {
      ambiguousOperations.current.set(target.id, { id, retry: operationRetry });
      if (mounted.current && attemptRef.current?.id === target.id) setAdviceError(`请求结果尚未确认：${errorMessage(reason)} 可使用同一操作安全重试。`);
    } finally {
      pendingActions.current.delete(key);
      if (mounted.current && attemptRef.current?.id === target.id) setAdviceBusy(false);
    }
  }

  async function saveArtifact(event: FormEvent) {
    event.preventDefault();
    if (!artifact.title.trim() || artifact.status === 'final' && !artifact.content.trim()) { setError('请填写成果标题；标为完成时还需要正文。'); return; }
    setBusy(true); setError('');
    try {
      const body = { title: artifact.title.trim(), content: artifact.content, goal: artifact.goal, status: artifact.status, projectId: artifact.projectId, practiceId: artifact.practiceId, sourceRefs: sourceRefInputs(artifact.sourceRefs), evidenceRefs: artifact.evidenceRefs };
      const saved = artifact.id ? await api.updateOutput(artifact.id, body, artifact.revision) : await api.createOutput(body);
      setArtifact(saved); setMessage('成果已保存到服务。'); resource.reload();
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }

  function useAsArtifact() {
    setArtifact({ ...blankArtifact(), title: selected ? `${selected.title} · 输出` : '学习输出', content: output, goal: selected?.goal || '', projectId: selected?.projectId || null, practiceId: selected?.id || null, sourceRefs: selected?.sourceRefs || [] });
    setTab('outputs');
  }

  if (resource.loading) return <Loading />;
  if (resource.error) return <><PageHeader title="练习与输出" /><ErrorState error={resource.error} retry={resource.reload} /></>;
  const practices = resource.data?.[0].items ?? [];
  const outputs = resource.data?.[1].items ?? [];
  const reason = selected?.relevance?.reason || selected?.selectionReason;
  const ambiguousOperation = attempt ? ambiguousOperations.current.get(attempt.id) : undefined;
  return <div className="mx-auto max-w-6xl">
    <PageHeader eyebrow="从记忆到应用" title="练习与输出" description="写出解释、完成应用或沉淀成果。自我记忆评分与应用证据分别记录。" actions={<div className="flex rounded-md border border-line p-1"><Button variant={tab === 'practice' ? 'primary' : 'ghost'} className="min-h-8 py-1" onClick={() => setTab('practice')}>练习</Button><Button variant={tab === 'outputs' ? 'primary' : 'ghost'} className="min-h-8 py-1" onClick={() => setTab('outputs')}>我的成果</Button></div>} />
    {message && <div className="mb-4"><Notice tone="success" onDismiss={() => setMessage('')}>{message}</Notice></div>}{error && <div className="mb-4"><Notice tone="error">{error}<div className="mt-2"><Button variant="secondary" onClick={resource.reload}>重新加载最新数据</Button></div></Notice></div>}
    {tab === 'practice' ? <div className="grid gap-8 lg:grid-cols-[260px_minmax(0,1fr)]"><aside><Section title="选择练习">{practices.length ? <div className="space-y-1">{practices.map((practice) => <button key={practice.id} onClick={() => setSelected(practice)} className={`w-full rounded-md px-3 py-3 text-left text-sm ${selected?.id === practice.id ? 'bg-accent/10 text-accent' : 'hover:bg-ink/5'}`}><span className="block font-medium">{practice.title}</span><span className="mt-1 block text-xs text-muted">{practice.kind === 'explanation' ? '解释练习' : practice.kind === 'new_scenario' ? '新情境应用' : '成果练习'}</span></button>)}</div> : <p className="text-sm text-muted">尚未保存练习。可先在今日页生成真实计划。</p>}</Section></aside><div>{selected ? <><section className="mb-6 border-l-2 border-accent pl-5"><Badge>{selected.kind === 'explanation' ? '解释练习' : selected.kind === 'new_scenario' ? '新情境应用' : '成果练习'}</Badge><h2 className="mt-3 text-2xl">{selected.title}</h2><SafeText className="mt-3">{selected.prompt}</SafeText>{reason && <p className="mt-3 text-sm text-accent">入选理由：{reason}</p>}<details className="mt-4"><summary className="cursor-pointer text-sm text-accent">来源与评价要点</summary><div className="mt-3 grid gap-4 sm:grid-cols-2"><div><h3 className="mb-2 text-sm font-medium">来源</h3><SourceRefs refs={selected.sourceRefs} /></div><div><h3 className="text-sm font-medium">评价要点</h3>{selected.rubric.length ? <ol className="space-y-3 text-sm text-muted">{selected.rubric.map((item) => <li key={item.id}><p className="font-medium text-ink">{item.label}</p><SafeText className="mt-1">{item.description}</SafeText>{item.expectedEvidence.length > 0 && <p className="mt-1 text-xs">需要的证据：{item.expectedEvidence.join('、')}</p>}</li>)}</ol> : <p className="text-sm text-muted">未提供评价要点，请自行核对来源。</p>}</div></div></details></section><form onSubmit={submitAttempt} className="space-y-4"><Field label="你的输出" hint="草稿仅保存在当前浏览器，提交后才写入学习服务。"><Textarea className="min-h-64" value={output} onChange={(e) => setOutput(e.target.value)} placeholder="用自己的话写出答案、过程或成果…" /></Field><div className="grid gap-4 sm:grid-cols-2"><Field label="借助程度"><Select value={assistanceLevel} onChange={(e) => setAssistanceLevel(e.target.value as AssistanceLevel)}><option value="none">独立完成</option><option value="hint">只用提示</option><option value="partial">借助部分内容</option><option value="full">主要依赖答案或生成内容</option></Select></Field><Field label="新增 URL 证据（每行一条）" hint="练习已有来源会自动作为证据快照；URL 不会被自动抓取或视为已核查。"><Textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} /></Field></div><div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy || !output.trim()}><Send className="h-4 w-4" />{busy ? '正在提交…' : '提交本次尝试'}</Button><Button variant="secondary" onClick={useAsArtifact} disabled={!output.trim()}><FilePlus2 className="h-4 w-4" />转为成果</Button></div></form>{attempt && <section className="mt-8 border-t border-line pt-6"><div className="mb-5"><h3 className="text-sm font-medium">已保存的回答</h3><SafeText className="mt-2 rounded-md bg-surface p-4">{attempt.output}</SafeText></div><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl">本次反馈</h2><Button variant="secondary" onClick={getFeedback} disabled={busy}>{busy ? '任务执行中…' : feedback ? '重新生成模板反馈' : '获取模板反馈'}</Button></div>
      {advice && <p role="status" className="mt-3 text-sm text-muted">{advice.message || (advicePending(advice) ? '正在准备 AI 建议…' : 'AI 建议状态已更新。')}</p>}
      {feedback ? <div className="mt-4">{feedback.mode === 'model' ? <AdviceFeedback feedback={feedback} /> : <><Badge>{feedback.mode === 'manual' ? '人工判断' : '本地模板 · 未评估正确性'}</Badge><SafeText className="mt-4">{feedback.summary}</SafeText><div className="mt-5 space-y-4">{feedback.observations.map((observation) => { const criterion = selected.rubric.find((item) => item.id === observation.criterionId); return <div key={observation.criterionId} className="border-l border-line pl-4"><p className="text-sm font-medium">{criterion?.label || observation.criterionId} · {observation.finding === 'not_assessed' ? '未评估' : observation.finding === 'met' ? '已达到' : observation.finding === 'partial' ? '部分达到' : '未达到'}</p>{criterion && <p className="mt-1 text-xs text-muted">要求：{criterion.description}；证据：{criterion.expectedEvidence.join('、') || '按说明核对'}</p>}<SafeText className="mt-1 text-sm text-muted">{observation.comment}</SafeText>{observation.evidenceRefs.length > 0 && <ul className="mt-1 text-xs text-muted">{observation.evidenceRefs.map((ref, index) => <li key={`${ref.kind}-${ref.id || ref.url || index}`}>{ref.label}{ref.url ? `：${ref.url}` : ''}</li>)}</ul>}</div>; })}</div><div className="mt-5 grid gap-4 sm:grid-cols-2"><div><h3 className="text-sm font-medium">下一步</h3><ul className="list-disc pl-5 text-sm text-muted">{feedback.nextActions.map((item) => <li key={item}>{item}</li>)}</ul></div><div><h3 className="text-sm font-medium">限制与未验证项</h3><ul className="list-disc pl-5 text-sm text-muted">{feedback.limitations.map((item) => <li key={item}>{item}</li>)}</ul></div></div></>}</div> : <p className="mt-3 text-sm text-muted">尚未获取反馈。无模型配置时使用本地模板，不判断内容正确性。</p>}
      {adviceError && <div className="mt-3"><Notice tone="error">{adviceError}<div className="mt-2"><Button variant="secondary" onClick={() => ambiguousOperation ? void requestModelAdvice(ambiguousOperation.retry) : void readAdvice(attempt, true)} disabled={adviceBusy}>{ambiguousOperation ? '安全重试请求' : '重新读取建议'}</Button></div></Notice></div>}
      <div className="mt-3 flex flex-wrap gap-2">{!ambiguousOperation && advice?.canRetry && <Button variant="secondary" onClick={() => void requestModelAdvice(true)} disabled={adviceBusy}>{adviceBusy ? '正在请求点评…' : '重新请求点评'}</Button>}{!ambiguousOperation && !advice?.canRetry && advice?.canRequest && <Button variant="secondary" onClick={() => void requestModelAdvice(false)} disabled={adviceBusy}>{adviceBusy ? '正在请求建议…' : '获取AI建议'}</Button>}</div>
    </section>}</> : <EmptyState title="选择一项练习" description="练习工作区会保留当前浏览器中的草稿；提交后可获取带证据和限制说明的反馈。" />}</div></div> : <div className="grid gap-8 lg:grid-cols-[280px_minmax(0,1fr)]"><aside><Section title="已保存成果" action={<Button variant="ghost" className="px-2" onClick={() => setArtifact(blankArtifact())}><FilePlus2 className="h-4 w-4" />新建</Button>}>{outputs.length ? <div className="space-y-1">{outputs.map((item) => <button key={item.id} className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-ink/5" onClick={() => setArtifact(item)}>{item.title}</button>)}</div> : <p className="text-sm text-muted">尚无保存成果。</p>}</Section></aside><form onSubmit={saveArtifact} className="panel space-y-4 p-5 sm:p-6"><h2 className="text-xl">{artifact.id ? '编辑成果' : '保存新成果'}</h2><Field label="标题"><Input value={artifact.title} onChange={(e) => setArtifact({ ...artifact, title: e.target.value })} required /></Field><Field label="目标（可选）"><Input value={artifact.goal} onChange={(e) => setArtifact({ ...artifact, goal: e.target.value })} /></Field><Field label="内容"><Textarea className="min-h-72" value={artifact.content} onChange={(e) => setArtifact({ ...artifact, content: e.target.value })} /></Field><Field label="状态"><Select value={artifact.status} onChange={(e) => setArtifact({ ...artifact, status: e.target.value as Output['status'] })}><option value="draft">草稿</option><option value="final">本地完成（不对外发布）</option></Select></Field><Button type="submit" disabled={busy}><Save className="h-4 w-4" />{artifact.id ? '保存更改' : '保存成果'}</Button>{artifact.id && <span className="ml-3 text-sm text-muted"><Check className="mr-1 inline h-4 w-4" />已存在于服务</span>}</form></div>}
  </div>;
}
