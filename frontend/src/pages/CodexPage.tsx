import { Plus, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Field, Input, Loading, Notice, PageHeader, Section, Select, Textarea } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api } from '../services/api';
import type { CodexScope, Job } from '../types';
import { errorMessage, formatDate, joinLines, lines } from '../utils/text';

const emptyScope: CodexScope = { enabled: false, allowedThreadIds: [], allowedProjectPaths: [], excludedThreadIds: [], excludedProjectPaths: [], includeArchived: false, allowManualImports: true, revision: 0 };

export function CodexPage() {
  const threadsResource = useApi(api.codexThreads);
  const projectsResource = useApi(api.projects);
  const scopeResource = useApi(api.codexScope);
  const [scope, setScope] = useState<CodexScope>(emptyScope);
  const [allowedThreads, setAllowedThreads] = useState('');
  const [excludedThreads, setExcludedThreads] = useState('');
  const [allowedPaths, setAllowedPaths] = useState('');
  const [excludedPaths, setExcludedPaths] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [manual, setManual] = useState({ title: '', externalSourceId: '', projectId: '' });
  const [messages, setMessages] = useState([{ sourceMessageId: 'message-1', role: 'user' as 'user' | 'assistant', content: '' }]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!scopeResource.data) return;
    const saved = { ...emptyScope, ...scopeResource.data };
    setScope(saved);
    setAllowedThreads(joinLines(saved.allowedThreadIds)); setExcludedThreads(joinLines(saved.excludedThreadIds));
    setAllowedPaths(joinLines(saved.allowedProjectPaths)); setExcludedPaths(joinLines(saved.excludedProjectPaths));
  }, [scopeResource.data]);
  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return;
    const timer = window.setTimeout(async () => {
      try {
        const latest = await api.job(job.id); setJob(latest);
        if (latest.status === 'succeeded') { threadsResource.reload(); projectsResource.reload(); }
      } catch (reason) { setError(errorMessage(reason)); }
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [job]);

  async function saveScope() {
    setBusy(true); setError('');
    try {
      const allowedThreadIds = lines(allowedThreads);
      const saved = await api.saveCodexScope({ enabled: scope.enabled, allowedThreadIds, allowedProjectPaths: lines(allowedPaths), excludedThreadIds: lines(excludedThreads), excludedProjectPaths: lines(excludedPaths), includeArchived: scope.includeArchived, allowManualImports: scope.allowManualImports }, scope.revision);
      setScope(saved); setMessage('采集范围已保存。'); scopeResource.reload(); threadsResource.reload();
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  async function sync() {
    setBusy(true); setError(''); setMessage('');
    try { setJob(await api.syncCodex(scope.allowedThreadIds)); setMessage('同步任务已提交，状态来自后端任务进度。'); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  async function manualImport(event: FormEvent) {
    event.preventDefault();
    if (!manual.title.trim() || !manual.externalSourceId.trim() || messages.some((item) => !item.content.trim())) { setError('请填写标题、稳定来源 ID，并确保每条消息都有内容。'); return; }
    setBusy(true); setError('');
    try {
      setJob(await api.importManualDialogue({ projectId: manual.projectId || null, title: manual.title.trim(), externalSourceId: manual.externalSourceId.trim(), messages: messages.map((item) => ({ ...item, occurredAt: null })) }));
      setMessage('手动对话导入任务已提交；不会显示为自动采集，产生的内容仍需确认。');
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  function toggleThread(id: string) {
    const selected = scope.allowedThreadIds.includes(id);
    const allowedThreadIds = selected ? scope.allowedThreadIds.filter((item) => item !== id) : [...scope.allowedThreadIds, id];
    setScope({ ...scope, allowedThreadIds }); setAllowedThreads(joinLines(allowedThreadIds));
  }

  const threads = threadsResource.data?.items ?? [];
  const projects = projectsResource.data?.items ?? [];
  return <div className="mx-auto max-w-6xl">
    <PageHeader eyebrow="只读采集" title="Codex 对话" description="自动发现不可用时仍可手动导入。采集器只读取授权来源，不执行对话中的任何指令。" actions={<Button onClick={sync} disabled={busy || !scope.enabled || !scope.allowedThreadIds.length && !scope.allowedProjectPaths.length || ['queued', 'running'].includes(job?.status || '')}><RefreshCw className="h-4 w-4" />同步授权对话</Button>} />
    <div className="mb-6"><Notice><ShieldCheck className="mr-2 inline h-4 w-4" />浏览器不会访问用户主目录。项目关联不等于文件系统授权，路径范围需单独明确填写。</Notice></div>
    {message && <div className="mb-4"><Notice tone="success">{message}</Notice></div>}{error && <div className="mb-4"><Notice tone="error">{error}<div className="mt-2"><Button variant="secondary" onClick={scopeResource.reload}>重新加载最新范围</Button></div></Notice></div>}
    {job && <div className="panel mb-6 p-4" aria-live="polite"><div className="flex flex-wrap items-center gap-3"><Badge>{job.status === 'succeeded' ? '任务完成' : job.status === 'failed' ? '任务失败' : job.status === 'running' ? '任务进行中' : job.status === 'uncertain' ? '结果待确认' : '等待处理'}</Badge><span className="text-sm text-muted">任务 {job.id}</span></div>{job.error && <p className="mt-2 text-sm text-danger">{job.error}</p>}<p className="mt-2 text-sm">新建来源 {job.syncedCount ?? '—'} · 更新来源 {job.skippedCount ?? '—'}</p></div>}
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-10"><Section title="自动发现" description={threadsResource.error ? '自动列表不可用，手动导入不受影响。' : `${threads.length} 条可用记录 · 已授权 ${scope.allowedThreadIds.length} 条线程`}>
        {threadsResource.loading ? <Loading label="正在读取授权对话…" /> : threadsResource.error ? <Notice tone="error">{errorMessage(threadsResource.error)}<div className="mt-2"><Button variant="secondary" onClick={threadsResource.reload}>重试自动发现</Button></div></Notice> : threads.length ? <div className="divide-y divide-line border-y border-line">{threads.map((thread) => <label key={thread.id} className="flex cursor-pointer items-start gap-3 py-4"><input type="checkbox" className="mt-1.5 h-4 w-4 accent-accent" checked={scope.allowedThreadIds.includes(thread.id)} onChange={() => toggleThread(thread.id)} /><span className="min-w-0 flex-1"><span className="block font-medium">{thread.title}</span><span className="mt-1 block text-xs text-muted">{thread.projectPath || 'app-server 只读来源'} · {formatDate(thread.updatedAt)}</span></span></label>)}</div> : <EmptyState title="没有可自动采集的对话" description="检查授权范围，或使用下方的手动导入后备。" />}
      </Section>
      <Section title="手动导入对话" description="使用稳定来源 ID 和逐条消息。文本仅作为不受信任的学习材料，不会执行。">
        <form onSubmit={manualImport} className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><Field label="对话标题"><Input value={manual.title} onChange={(e) => setManual({ ...manual, title: e.target.value })} required /></Field><Field label="稳定来源 ID" hint="同一来源重复导入时保持不变。"><Input value={manual.externalSourceId} onChange={(e) => setManual({ ...manual, externalSourceId: e.target.value })} required /></Field></div><Field label="关联产品项目"><Select value={manual.projectId} onChange={(e) => setManual({ ...manual, projectId: e.target.value })}><option value="">不关联</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</Select></Field><div className="space-y-4">{messages.map((item, index) => <div key={item.sourceMessageId} className="panel space-y-3 p-4"><div className="flex items-center justify-between gap-3"><Badge>{item.sourceMessageId}</Badge><Select aria-label={`第 ${index + 1} 条消息角色`} value={item.role} onChange={(e) => setMessages(messages.map((current) => current.sourceMessageId === item.sourceMessageId ? { ...current, role: e.target.value as 'user' | 'assistant' } : current))} className="w-32"><option value="user">用户</option><option value="assistant">助手</option></Select></div><Field label={`第 ${index + 1} 条消息内容`}><Textarea value={item.content} onChange={(e) => setMessages(messages.map((current) => current.sourceMessageId === item.sourceMessageId ? { ...current, content: e.target.value } : current))} /></Field></div>)}</div><Button variant="ghost" onClick={() => setMessages([...messages, { sourceMessageId: `message-${messages.length + 1}`, role: 'assistant', content: '' }])}><Plus className="h-4 w-4" />添加消息</Button><div><Button type="submit" disabled={busy || !scope.allowManualImports}>提交手动导入</Button></div></form>
      </Section></div>
      <aside><Section title="采集范围" description={scopeResource.error ? '范围读取失败；未保存控件不会覆盖服务器配置。' : '线程与本地路径分别授权，排除规则优先。'}>{scopeResource.loading ? <Loading /> : <><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={scope.enabled} onChange={(e) => setScope({ ...scope, enabled: e.target.checked })} />启用自动采集</label><div className="mt-4 space-y-4"><Field label="授权线程 ID（每行一条）"><Textarea value={allowedThreads} onChange={(e) => { setAllowedThreads(e.target.value); setScope({ ...scope, allowedThreadIds: lines(e.target.value) }); }} /></Field><Field label="排除线程 ID（每行一条）"><Textarea value={excludedThreads} onChange={(e) => setExcludedThreads(e.target.value)} /></Field><Field label="授权项目绝对路径（每行一条）"><Textarea value={allowedPaths} onChange={(e) => { setAllowedPaths(e.target.value); setScope({ ...scope, allowedProjectPaths: lines(e.target.value) }); }} /></Field><Field label="排除项目绝对路径（每行一条）"><Textarea value={excludedPaths} onChange={(e) => setExcludedPaths(e.target.value)} /></Field><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={scope.includeArchived} onChange={(e) => setScope({ ...scope, includeArchived: e.target.checked })} />包含已归档对话</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={scope.allowManualImports} onChange={(e) => setScope({ ...scope, allowManualImports: e.target.checked })} />允许手动导入</label></div><Button variant="secondary" className="mt-4 w-full" onClick={saveScope} disabled={busy || !!scopeResource.error}><Save className="h-4 w-4" />保存采集范围</Button>{scopeResource.error && <p className="mt-3 text-sm text-danger">{errorMessage(scopeResource.error)}</p>}</>}</Section></aside>
    </div>
  </div>;
}
