import type { Feedback, FeedbackObservation } from '../types';
import { Badge, SafeText } from './ui';

function ObservationList({ items, empty }: { items: FeedbackObservation[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-muted">{empty}</p>;
  return <ul className="space-y-3">{items.slice(0, 2).map((observation, index) => <li key={`${observation.criterionId}-${index}`}>
    <p className="text-sm font-medium">{observation.finding === 'met' ? '已达到' : observation.finding === 'partial' ? '部分达到' : observation.finding === 'not_met' ? '未达到' : '未评估'}</p>
    <SafeText className="mt-1 text-sm text-muted">{observation.comment || '未提供具体说明。'}</SafeText>
  </li>)}</ul>;
}

export function AdviceFeedback({ feedback }: { feedback: Feedback }) {
  const met = feedback.observations.filter((item) => item.finding === 'met');
  const improve = feedback.observations.filter((item) => item.finding !== 'met');
  return <div className="mt-5 border-t border-line pt-5">
    <div className="flex flex-wrap items-center gap-3"><Badge className="text-accent">AI建议</Badge><span className="text-xs text-muted">建议需结合原文核对，不代表掌握程度</span></div>
    <SafeText className="mt-3 text-sm">{feedback.summary || '已返回建议，请结合依据与限制核对。'}</SafeText>
    <div className="mt-5 grid gap-6 sm:grid-cols-3">
      <section aria-labelledby={`advice-met-${feedback.id}`}><h4 id={`advice-met-${feedback.id}`} className="mb-3 text-sm font-medium">已做到</h4><ObservationList items={met} empty="暂无已确认达到的评价要点。" /></section>
      <section aria-labelledby={`advice-improve-${feedback.id}`}><h4 id={`advice-improve-${feedback.id}`} className="mb-3 text-sm font-medium">待改进</h4><ObservationList items={improve} empty="暂无待改进的评价要点。" /></section>
      <section aria-labelledby={`advice-next-${feedback.id}`}><h4 id={`advice-next-${feedback.id}`} className="mb-3 text-sm font-medium">下一步</h4>{feedback.nextActions.length ? <SafeText className="text-sm text-muted">{feedback.nextActions[0]}</SafeText> : <p className="text-sm text-muted">暂无下一步建议。</p>}</section>
    </div>
    <details className="mt-5 border-t border-line pt-4"><summary className="cursor-pointer text-sm text-accent">查看依据与限制</summary><div className="mt-4 space-y-4 text-sm">
      {feedback.observations.length > 0 && <ul className="space-y-3">{feedback.observations.map((observation, index) => <li key={`${observation.criterionId}-evidence-${index}`} className="border-l border-line pl-4"><SafeText className="text-muted">{observation.comment || '未提供具体说明。'}</SafeText>{observation.evidenceRefs.length > 0 && <ul className="mt-1 text-xs text-muted">{observation.evidenceRefs.map((ref, refIndex) => <li key={`${ref.kind}-${ref.id || ref.url || refIndex}`}>{ref.label}{ref.url ? `：${ref.url}` : ''}</li>)}</ul>}</li>)}</ul>}
      <div><h5 className="font-medium">限制与未验证项</h5>{feedback.limitations.length ? <ul className="mt-2 list-disc pl-5 text-muted">{feedback.limitations.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul> : <p className="mt-2 text-muted">未提供额外限制说明；仍请核对原始来源。</p>}</div>
    </div></details>
  </div>;
}
