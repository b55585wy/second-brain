import { ArrowRight, Eye, Play, RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { SourceRefs } from '../components/SourceRefs';
import { Button, EmptyState, Field, Input, Notice, PageHeader, SafeText, Select, Textarea } from '../components/ui';
import { api, ApiError, operationId } from '../services/api';
import type { ReviewAnswer, ReviewPrompt, ReviewSession } from '../types';
import { errorMessage } from '../utils/text';

const ratings = [
  { value: 'again', label: '忘记了', hint: '没有回忆起来' },
  { value: 'hard', label: '很困难', hint: '勉强记起' },
  { value: 'good', label: '记得', hint: '顺利回忆' },
  { value: 'easy', label: '很轻松', hint: '毫无困难' },
] as const;
type Rating = typeof ratings[number]['value'];
type PendingRating = { sessionId: string; presentationId: string; cardId: string; rating: Rating; operationId: string; elapsedMs: number; answer?: string };
const pendingKey = 'zhixing.reviewPendingRating';
function recoveredPending(): PendingRating | null {
  try { return JSON.parse(localStorage.getItem(pendingKey) || 'null') as PendingRating | null; }
  catch { return null; }
}

function definiteSessionEnd(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.code === 'NOT_FOUND' || error.code.includes('EXPIRED'));
}
function uncertainWrite(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code.includes('UNCERTAIN') || error.code === 'RECONCILIATION_REQUIRED';
}

export function ReviewPage() {
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [prompt, setPrompt] = useState<ReviewPrompt | null>(null);
  const [answer, setAnswer] = useState<ReviewAnswer | null>(null);
  const [recall, setRecall] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [limit, setLimit] = useState(10);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingRating | null>(recoveredPending);
  const [savedSessionId, setSavedSessionId] = useState(() => localStorage.getItem('zhixing.reviewSessionId') || '');
  const submitting = useRef(false);
  const revealedAt = useRef(0);

  useEffect(() => {
    if (session) localStorage.setItem(`zhixing.reviewRecall.${session.id}`, recall);
  }, [recall, session]);

  function clearPending() {
    setPending(null); localStorage.removeItem(pendingKey);
  }
  async function loadNext(id: string): Promise<boolean> {
    const next = await api.reviewNext(id);
    if (next.session) setSession(next.session);
    if (next.state === 'rating_pending' && next.jobId) {
      await api.waitForJob({ jobId: next.jobId, operationId: pending?.operationId || '' });
      return loadNext(id);
    }
    if (next.state === 'uncertain' || next.state === 'rating_pending') {
      setFinished(false); setPrompt(null); setAnswer(null);
      setError('服务报告有评分等待确认，已阻止新的评分。请核对任务状态，不要重复提交。');
      return false;
    }
    if (next.state === 'blocked') throw new ApiError(next.failure?.code || 'INVALID_STATE', next.failure?.message || '当前卡片已失效，请重新审核。');
    if (next.done || !next.prompt) {
      setFinished(true); setPrompt(null); setAnswer(null); clearPending();
      localStorage.removeItem('zhixing.reviewSessionId'); setSavedSessionId('');
    } else {
      setError(''); setFinished(false); setPrompt(next); setAnswer(null);
      setRecall(localStorage.getItem(`zhixing.reviewRecall.${id}`) || ''); setAttempted(false);
    }
    return true;
  }
  function handleSessionError(reason: unknown, id: string) {
    setError(errorMessage(reason));
    if (definiteSessionEnd(reason)) {
      localStorage.removeItem('zhixing.reviewSessionId'); setSavedSessionId(''); setSession(null); setPrompt(null); setAnswer(null);
      if (pending?.sessionId === id) clearPending();
    } else {
      localStorage.setItem('zhixing.reviewSessionId', id); setSavedSessionId(id);
    }
  }
  async function start(id?: string) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError(''); setFinished(false);
    let activeId = id || '';
    try {
      const active = id ? { id } : await api.createReviewSession({ projectId: projectId || null, limit });
      activeId = active.id;
      if (pending && pending.sessionId !== active.id) clearPending();
      setSession(active); localStorage.setItem('zhixing.reviewSessionId', active.id); setSavedSessionId(active.id);
      await loadNext(active.id);
    } catch (reason) {
      if (activeId) handleSessionError(reason, activeId);
      else setError(errorMessage(reason));
    } finally { submitting.current = false; setBusy(false); }
  }
  async function reveal() {
    if (!session || !prompt || !attempted || submitting.current || pending) return;
    submitting.current = true; setBusy(true); setError('');
    try { setAnswer(await api.revealReview(session.id, prompt.presentationId, prompt.cardId)); revealedAt.current = Date.now(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { submitting.current = false; setBusy(false); }
  }
  async function submitRating(rating: Rating, existing?: PendingRating) {
    if (!session || submitting.current || (pending && !existing)) return;
    const submission: PendingRating = existing || { sessionId: session.id, presentationId: prompt!.presentationId, cardId: prompt!.cardId, rating, operationId: operationId(), elapsedMs: Math.max(0, Date.now() - revealedAt.current), ...(recall ? { answer: recall } : {}) };
    submitting.current = true; setBusy(true); setError(''); setPending(submission); localStorage.setItem(pendingKey, JSON.stringify(submission));
    try {
      await api.rateReview(session.id, submission.presentationId, submission.cardId, submission.rating, submission.operationId, submission.elapsedMs, submission.answer);
      clearPending();
      await loadNext(session.id);
    } catch (reason) {
      if (uncertainWrite(reason)) {
        setPending(submission); localStorage.setItem(pendingKey, JSON.stringify(submission));
        setError(`评分结果尚未确认：${errorMessage(reason)}`);
      } else {
        clearPending(); setError(errorMessage(reason));
      }
    } finally { submitting.current = false; setBusy(false); }
  }
  async function reconcile() {
    if (!session || submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try { if (await loadNext(session.id)) clearPending(); }
    catch (reason) { handleSessionError(reason, session.id); }
    finally { submitting.current = false; setBusy(false); }
  }
  function returnToStart() {
    setSession(null); setPrompt(null); setAnswer(null); setFinished(false); setError('');
  }

  return <div className="mx-auto max-w-4xl">
    <PageHeader eyebrow="主动回忆" title="复习" description="先尝试回忆，再揭示答案。评分只表达你的记忆感受，不等同于实际应用能力。" />
    {error && <div className="mb-6"><Notice tone="error">{error}</Notice></div>}
    {pending && <div className="mb-6"><Notice tone="info">评分处于待确认状态，已阻止新的评分。可以复用同一操作 ID 重试，或刷新会话进行调和。<div className="mt-3 flex flex-wrap gap-2"><Button variant="secondary" onClick={() => submitRating(pending.rating, pending)} disabled={busy}>用同一操作重试</Button><Button variant="ghost" onClick={reconcile} disabled={busy}><RefreshCw className="h-4 w-4" />刷新会话</Button></div></Notice></div>}
    {!session && !finished && <div className="grid gap-8 sm:grid-cols-[minmax(0,1fr)_240px]"><section><h2 className="text-2xl">准备一次短复习</h2><p className="mt-3 text-sm leading-6 text-muted">题目与答案分两次从服务获取。复习可用性和后续安排由后端决定；思源未连接时不会显示虚假的同步状态。</p><div className="mt-6 flex flex-wrap gap-3"><Button onClick={() => start()} disabled={busy}><Play className="h-4 w-4" />{busy ? '正在准备…' : '开始复习'}</Button>{savedSessionId && <Button variant="secondary" onClick={() => start(savedSessionId)} disabled={busy}><RotateCcw className="h-4 w-4" />继续上次会话</Button>}</div></section><aside className="space-y-4"><Field label="项目 ID（可选）" hint="留空复习全部可用知识。"><Input value={projectId} onChange={(e) => setProjectId(e.target.value)} /></Field><Field label="本次最多题数"><Select value={limit} onChange={(e) => setLimit(Number(e.target.value))}><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option></Select></Field></aside></div>}
    {finished && <EmptyState title="本次复习已完成" description="没有更多可展示的题目。你可以结束，或稍后按实际安排再来复习。" action={<div className="flex gap-2"><Button onClick={returnToStart}>返回</Button><Link to="/practice" className="btn-secondary">去做应用练习</Link></div>} />}
    {session && !prompt && !finished && <EmptyState title={error ? '会话暂未恢复' : '当前没有可复习内容'} description={error ? '会话 ID 已保留。网络或服务暂时失败不会丢弃进度；可以重试，或返回后稍后恢复。' : '请先检查知识库和实际复习安排。'} action={<div className="flex flex-wrap gap-2"><Button onClick={() => start(session.id)} disabled={busy}><RefreshCw className="h-4 w-4" />重试读取</Button><Button variant="secondary" onClick={returnToStart}>返回</Button></div>} />}
    {session && prompt && !finished && <section aria-live="polite"><div className="mb-4 flex justify-between text-xs text-muted"><span>会话 {session.id}</span><span>{prompt.remaining !== undefined ? `剩余 ${prompt.remaining} 题` : '按实际返回进度'}</span></div><div className="border-y border-line py-8"><p className="eyebrow mb-3">问题</p><h2 className="text-2xl leading-relaxed sm:text-3xl">{prompt.prompt}</h2></div>{!answer ? <div className="mt-6"><Field label="先写下你记得的内容（可选）" hint="也可以口头回忆，完成后勾选下方确认。"><Textarea value={recall} onChange={(e) => setRecall(e.target.value)} /></Field><label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1.5 h-4 w-4 accent-accent" checked={attempted} onChange={(e) => setAttempted(e.target.checked)} />我已经独立尝试过回忆</label><Button className="mt-5" onClick={reveal} disabled={!attempted || busy || !!pending}><Eye className="h-4 w-4" />{busy ? '正在读取…' : '揭示答案'}</Button></div> : <div className="answer-reveal mt-6"><div className="bg-accent/5 p-5 sm:p-6"><p className="eyebrow mb-3">参考答案</p><SafeText>{answer.answer}</SafeText><div className="mt-4 border-t border-accent/15 pt-4"><SourceRefs refs={answer.sourceRefs} /></div></div><fieldset className="mt-6" disabled={busy || !!pending}><legend className="mb-3 text-sm font-medium">这次回忆怎么样？</legend><div className="grid gap-2 sm:grid-cols-4">{ratings.map((rating) => <Button key={rating.value} variant="secondary" className="h-auto flex-col py-3" disabled={busy || !!pending} onClick={() => submitRating(rating.value)}><span>{rating.label}</span><span className="text-xs font-normal text-muted">{rating.hint}</span></Button>)}</div></fieldset><p className="mt-3 flex items-center gap-2 text-xs text-muted"><ArrowRight className="h-3 w-3" />评分绑定当前卡片，重复点击不会创建新操作。</p></div>}</section>}
  </div>;
}
