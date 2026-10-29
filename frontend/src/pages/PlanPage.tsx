import { ArrowRight, Check, Clock3, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorState, Loading, Notice, PageHeader, SafeText, Section, Button } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api } from '../services/api';
import { dateInTimeZone, errorMessage } from '../utils/text';

export function PlanPage() {
  const resource = useApi(async () => {
    const dashboard = await api.dashboard();
    const date = dashboard.date || dateInTimeZone(dashboard.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone);
    const plan = dashboard.dailyPlan || await api.dailyPlan(date);
    return { dashboard, plan, date };
  }, []);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const dashboard = resource.data?.dashboard;
  const plan = resource.data?.plan;
  const paused = plan?.budgetMinutes === 0 || dashboard?.dailyBudgetMinutes === 0;
  const hasGoals = Boolean(dashboard?.profile.goals.length);

  async function generate() {
    if (!resource.data || paused || !hasGoals) return;
    setBusy(true); setActionError('');
    try {
      await api.generateDailyPlan(resource.data.date, resource.data.dashboard.profile.revision, resource.data.plan.revision);
      resource.reload();
    } catch (error) { setActionError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  if (resource.loading) return <Loading />;
  if (resource.error || !resource.data) return <><PageHeader title="今天" /><ErrorState error={resource.error} retry={resource.reload} /></>;
  const next = plan?.items.find((item) => item.state !== 'completed');
  const siyuan = dashboard?.connections?.find((item) => item.provider === 'siyuan');
  const reviewText = typeof dashboard?.reviewDueCount === 'number'
    ? dashboard.reviewDueCount > 0 ? `有 ${dashboard.reviewDueCount} 条知识等待回顾。` : '当前没有待复习知识。'
    : `尚未获得真实到期数量。思源状态：${siyuan?.configured ? '已配置，连接未确认或不可用' : '未配置'}。`;

  return <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_300px]">
    <div>
      <PageHeader eyebrow={new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full' }).format(new Date(`${resource.data.date}T12:00:00`))} title="今天，从这里继续" description="只保留当前目标、下一步和需要回顾的内容。" actions={hasGoals ? <Button variant="secondary" onClick={generate} disabled={busy || paused}><RefreshCw className="h-4 w-4" />{paused ? '今日计划已暂停' : busy ? '任务执行中…' : '重新安排今天'}</Button> : undefined} />
      {actionError && <div className="mb-6"><Notice tone="error">{actionError}<div className="mt-2"><Button variant="secondary" onClick={resource.reload}>重新加载最新计划</Button></div></Notice></div>}
      {dashboard?.limitations.length ? <div className="mb-6"><Notice>{dashboard.limitations.join('；')}</Notice></div> : null}
      <section className="border-l-2 border-accent pl-5 sm:pl-8">
        <p className="eyebrow mb-3">下一步</p>
        {paused ? <EmptyState title="今日学习已暂停" description="每日预算为 0 分钟。需要恢复时，请到学习档案设置新的时间预算。" action={<Link to="/settings" className="btn-secondary">编辑时间预算</Link>} /> : !hasGoals ? <EmptyState title="先设置学习目标" description="今日计划只会围绕你保存的真实目标生成。" action={<Link to="/settings" className="btn-primary">设置学习目标<ArrowRight className="h-4 w-4" /></Link>} /> : next ? <><h2 className="max-w-3xl text-2xl leading-relaxed sm:text-3xl">{next.title}</h2>{next.goal && <SafeText className="mt-4 max-w-3xl text-muted">{next.goal}</SafeText>}<div className="mt-5 flex flex-wrap gap-3"><Link className="btn-primary" to={next.kind === 'review' ? '/review' : next.kind === 'practice' ? '/practice' : '/practice'}>开始处理<ArrowRight className="h-4 w-4" /></Link><span className="inline-flex items-center gap-2 text-sm text-muted"><Clock3 className="h-4 w-4" />今日预算 {plan?.budgetMinutes ?? dashboard?.dailyBudgetMinutes ?? 15} 分钟</span></div></> : <EmptyState title="还没有下一步" description="根据已保存的目标生成今日计划。" action={<Button onClick={generate} disabled={busy}>生成今日计划</Button>} />}
      </section>
      <Section title="今日安排" description={`${plan?.items.length ?? 0} 项 · 完成后由后端记录进度`} className="mt-12">
        {paused ? <EmptyState title="没有计划项" description="暂停期间不生成学习任务。" /> : plan?.items.length ? <ol className="divide-y divide-line border-y border-line">{plan.items.map((item, index) => {
          const completed = item.state === 'completed';
          const reason = item.relevance?.reason || item.selectionReason;
          return <li key={item.id} className="flex items-start gap-4 py-4"><span className="mt-1 w-6 text-sm text-muted">{String(index + 1).padStart(2, '0')}</span><div className="min-w-0 flex-1"><p className={completed ? 'text-muted line-through' : ''}>{item.title}</p><p className="mt-1 text-xs text-muted">{item.kind === 'review' ? '记忆复习' : item.kind === 'practice' ? '应用练习' : '成果写作'} · {item.estimatedMinutes} 分钟</p>{reason && <p className="mt-2 text-xs text-accent">入选理由：{reason}</p>}</div>{completed && <Check className="h-5 w-5 text-accent" aria-label="已完成" />}</li>;
        })}</ol> : <EmptyState title="今天尚未安排" description="计划只会使用已经保存的目标、知识和项目，不会补造学习内容。" />}
      </Section>
    </div>
    <aside className="space-y-8 xl:border-l xl:border-line xl:pl-8">
      <Section title="当前目标" action={<Link to="/settings" className="text-sm text-accent hover:underline">编辑</Link>}>
        {dashboard?.goals.length ? <ul className="space-y-3">{dashboard.goals.map((goal) => <li key={goal} className="border-b border-line pb-3 text-sm leading-6">{goal}</li>)}</ul> : <p className="text-sm text-muted">尚未设置目标。到学习档案中写下真实目标。</p>}
      </Section>
      <Section title="回顾与练习">
        <p className="text-sm text-muted">{reviewText}</p>
        {dashboard?.reviewDueCount === null && <Link to="/settings" className="mt-2 inline-block text-sm text-accent hover:underline">查看思源连接设置</Link>}
        <div className="mt-4 flex flex-col items-start gap-2"><Link to="/review" className="btn-secondary w-full">开始复习<ArrowRight className="h-4 w-4" /></Link><Link to="/practice" className="btn-ghost w-full justify-start px-0">做一次输出练习</Link></div>
      </Section>
      <Section title="最近项目节点">
        {dashboard?.recentCheckpoint ? <div><p className="text-xs text-muted">{dashboard.recentCheckpoint.projectTitle || '最近项目'}</p><SafeText className="mt-2 text-sm">{dashboard.recentCheckpoint.progress}</SafeText><p className="mt-3 text-sm"><span className="text-muted">下一步：</span>{dashboard.recentCheckpoint.nextAction}</p><Link to="/projects" className="mt-3 inline-block text-sm text-accent hover:underline">查看项目</Link></div> : <p className="text-sm text-muted">完成一次项目推进后，在这里留下进度与下一步。</p>}
      </Section>
    </aside>
  </div>;
}
