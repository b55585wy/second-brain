import { Archive, ArrowRight, Plus } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, EmptyState, ErrorState, Field, Input, Loading, Notice, PageHeader, SafeText, Select, Textarea } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api } from '../services/api';
import type { ProjectStatus } from '../types';
import { errorMessage, projectStatusLabels } from '../utils/text';

export function ProjectsPage() {
  const resource = useApi(api.projects);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [status, setStatus] = useState<ProjectStatus>('active');

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !goal.trim()) { setError('请填写项目名称和具体目标。'); return; }
    setBusy(true); setError('');
    try { await api.createProject({ title: title.trim(), goal: goal.trim(), status }); setTitle(''); setGoal(''); setCreating(false); resource.reload(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  if (resource.loading) return <Loading />;
  if (resource.error) return <><PageHeader title="项目" /><ErrorState error={resource.error} retry={resource.reload} /></>;
  const projects = resource.data?.items ?? [];
  return <div className="mx-auto max-w-5xl">
    <PageHeader eyebrow="工作上下文" title="项目" description="以项目承接知识、练习和阶段节点，让每次切换都有明确的接续位置。" actions={<Button onClick={() => setCreating(!creating)}><Plus className="h-4 w-4" />新建项目</Button>} />
    {creating && <form onSubmit={create} className="panel mb-8 space-y-4 p-5 sm:p-6"><h2 className="text-xl">新建项目</h2>{error && <Notice tone="error">{error}</Notice>}<Field label="项目名称"><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required /></Field><Field label="要完成什么" hint="写成可验证的结果，而不是宽泛主题。"><Textarea value={goal} onChange={(e) => setGoal(e.target.value)} required /></Field><Field label="状态"><Select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>{Object.entries(projectStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field><div className="flex gap-2"><Button type="submit" disabled={busy}>{busy ? '正在保存…' : '创建项目'}</Button><Button variant="ghost" onClick={() => setCreating(false)}>取消</Button></div></form>}
    {projects.length ? <div className="divide-y divide-line border-y border-line">{projects.map((project) => <article key={project.id} className="group grid gap-4 py-6 sm:grid-cols-[minmax(0,1fr)_180px_32px] sm:items-center"><div><div className="mb-2 flex items-center gap-3"><h2 className="text-2xl"><Link className="hover:text-accent" to={`/projects/${project.id}`}>{project.title}</Link></h2><Badge>{projectStatusLabels[project.status]}</Badge></div><SafeText className="text-sm text-muted">{project.goal}</SafeText>{project.lastCheckpoint && <p className="mt-3 text-sm"><span className="text-muted">上次停在：</span>{project.lastCheckpoint.nextAction}</p>}</div><div className="text-sm text-muted">{project.lastCheckpoint ? '已有接续节点' : '尚未记录节点'}</div><Link to={`/projects/${project.id}`} aria-label={`打开${project.title}`} className="rounded p-2 text-muted group-hover:text-accent"><ArrowRight className="h-5 w-5" /></Link></article>)}</div> : <EmptyState title="从第一个项目开始" description="项目保存你的目标、进展与未决问题，不需要先准备完整的学习体系。" action={<Button onClick={() => setCreating(true)}><Archive className="h-4 w-4" />创建项目</Button>} />}
  </div>;
}
