import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, EmptyState, ErrorState, Field, Input, Loading, Notice, PageHeader, SafeText, Section, Select, Textarea } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api } from '../services/api';
import type { ProjectStatus } from '../types';
import { errorMessage, formatDate, projectStatusLabels } from '../utils/text';

export function ProjectDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const resource = useApi(() => Promise.all([api.projects(), api.checkpoints(id)]), [id]);
  const project = resource.data?.[0].items.find((item) => item.id === id);
  const checkpoints = resource.data?.[1].items ?? [];
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [status, setStatus] = useState<ProjectStatus>('active');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ progress: '', nextAction: '', openQuestion: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { if (project) { setTitle(project.title); setGoal(project.goal); setStatus(project.status); } }, [project]);

  async function saveProject(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    if (!project) return;
    try { await api.updateProject(id, { title: title.trim(), goal: goal.trim(), status }, project.revision); setEditing(false); setMessage('项目已更新。'); resource.reload(); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  async function addCheckpoint(event: FormEvent) {
    event.preventDefault();
    if (!form.progress.trim() && !form.nextAction.trim() && !form.openQuestion.trim()) { setError('进展、下一步和未决问题至少填写一项。'); return; }
    setBusy(true); setError('');
    try { await api.createCheckpoint(id, { ...form, progress: form.progress.trim(), nextAction: form.nextAction.trim() }); setForm({ progress: '', nextAction: '', openQuestion: '' }); setMessage('接续节点已保存。'); resource.reload(); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  async function deleteProject() {
    if (!project || !window.confirm(`确定归档项目“${project.title}”？已有学习记录会保留，之后可编辑恢复。`)) return;
    setBusy(true); setError('');
    try { await api.deleteProject(id, project.revision); navigate('/projects'); } catch (reason) { setError(errorMessage(reason)); setBusy(false); }
  }

  if (resource.loading) return <Loading />;
  if (resource.error) return <ErrorState error={resource.error} retry={resource.reload} />;
  if (!project) return <EmptyState title="没有找到这个项目" description="它可能已被删除，或当前服务返回的数据不同步。" action={<Link to="/projects" className="btn-secondary">返回项目列表</Link>} />;
  return <div className="mx-auto max-w-5xl">
    <Link to="/projects" className="btn-ghost mb-4 -ml-3"><ArrowLeft className="h-4 w-4" />全部项目</Link>
    <PageHeader eyebrow="项目上下文" title={project.title} description={project.goal} actions={<><Button variant="secondary" onClick={() => setEditing(!editing)}>编辑项目</Button><Button variant="danger" onClick={deleteProject} disabled={busy}><Trash2 className="h-4 w-4" />归档</Button></>} />
    {message && <div className="mb-4"><Notice tone="success" onDismiss={() => setMessage('')}>{message}</Notice></div>}{error && <div className="mb-4"><Notice tone="error">{error}</Notice></div>}
    {editing && <form onSubmit={saveProject} className="panel mb-8 space-y-4 p-5"><Field label="项目名称"><Input value={title} onChange={(e) => setTitle(e.target.value)} required /></Field><Field label="项目目标"><Textarea value={goal} onChange={(e) => setGoal(e.target.value)} required /></Field><Field label="状态"><Select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>{Object.entries(projectStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field><Button type="submit" disabled={busy || !title.trim() || !goal.trim()}>保存更改</Button></form>}
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
      <Section title="阶段记录" description="最近的记录置顶；每次结束工作前写清下一步。">
        {checkpoints.length ? <ol className="space-y-8">{checkpoints.map((checkpoint) => <li key={checkpoint.id} className="border-l border-line pl-5"><p className="text-xs text-muted">{formatDate(checkpoint.createdAt)}</p><SafeText className="mt-2">{checkpoint.progress}</SafeText><div className="mt-3 bg-accent/5 p-4 text-sm"><span className="font-medium text-accent">下次继续 </span><SafeText>{checkpoint.nextAction}</SafeText></div>{checkpoint.openQuestion && <p className="mt-3 text-sm text-muted">未决问题：{checkpoint.openQuestion}</p>}</li>)}</ol> : <EmptyState title="还没有阶段记录" description="在右侧记录这次完成了什么，以及下次从哪里继续。" />}
      </Section>
      <aside><form onSubmit={addCheckpoint} className="panel space-y-4 p-5"><h2 className="text-xl"><Plus className="mr-2 inline h-5 w-5" />留下接续节点</h2><Field label="本次进展"><Textarea value={form.progress} onChange={(e) => setForm({ ...form, progress: e.target.value })} required /></Field><Field label="下一步"><Textarea value={form.nextAction} onChange={(e) => setForm({ ...form, nextAction: e.target.value })} required /></Field><Field label="未决问题（可选）"><Textarea value={form.openQuestion} onChange={(e) => setForm({ ...form, openQuestion: e.target.value })} /></Field><Button type="submit" className="w-full" disabled={busy}>{busy ? '正在保存…' : '保存节点'}</Button></form><div className="mt-4 flex items-center gap-2"><Badge>{projectStatusLabels[project.status]}</Badge><Link to="/practice" className="text-sm text-accent hover:underline">记录项目输出</Link></div></aside>
    </div>
  </div>;
}
