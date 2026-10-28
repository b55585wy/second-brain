import { Plus, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Field, Input, Loading, Notice, PageHeader, Section, Select, Textarea } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api } from '../services/api';
import type { CodexScope, CodexScopeInput, CodexThread, Job } from '../types';
import { errorMessage, formatDate, joinLines, lines } from '../utils/text';

const emptyScope: CodexScope = { enabled: false, allowedThreadIds: [], allowedProjectPaths: [], excludedThreadIds: [], excludedProjectPaths: [], includeArchived: false, allowManualImports: true, revision: 0 };

function scopeInput(scope: CodexScope): CodexScopeInput {
  return {
    enabled: scope.enabled,
    allowedThreadIds: scope.allowedThreadIds,
    allowedProjectPaths: scope.allowedProjectPaths,
    excludedThreadIds: scope.excludedThreadIds,
    excludedProjectPaths: scope.excludedProjectPaths,
    includeArchived: scope.includeArchived,
    allowManualImports: scope.allowManualImports,
  };
}

function sameScope(left: CodexScope, right: CodexScope): boolean {
  return JSON.stringify(scopeInput(left)) === JSON.stringify(scopeInput(right));
}

function hasEligibleThreads(scope: CodexScope): boolean {
  return scope.enabled && (scope.allowedThreadIds.some((id) => !scope.excludedThreadIds.includes(id)) || scope.allowedProjectPaths.length > 0);
}

function isPartialSync(job: Job | null): boolean {
  return job?.status === 'succeeded' && job.type === 'codex_sync' && job.result?.hasMore === true;
}

export function CodexPage() {
  const threadsResource = useApi(api.codexThreads);
  const projectsResource = useApi(api.projects);
  const scopeResource = useApi(api.codexScope);
  const [savedScope, setSavedScope] = useState<CodexScope>(emptyScope);
  const [scope, setScope] = useState<CodexScope>(emptyScope);
  const [allowedThreads, setAllowedThreads] = useState('');
  const [excludedThreads, setExcludedThreads] = useState('');
  const [allowedPaths, setAllowedPaths] = useState('');
  const [excludedPaths, setExcludedPaths] = useState('');
  const [discovery, setDiscovery] = useState<{ status: 'initial' | 'loading' | 'success' | 'error'; items: CodexThread[]; error: string }>({ status: 'initial', items: [], error: '' });
  const [job, setJob] = useState<Job | null>(null);
  const [manual, setManual] = useState({ title: '', externalSourceId: '', projectId: '' });
  const [messages, setMessages] = useState([{ sourceMessageId: 'message-1', role: 'user' as 'user' | 'assistant', content: '' }]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!scopeResource.data) return;
    const saved = { ...emptyScope, ...scopeResource.data };
    if (saved.revision !== savedScope.revision && isPartialSync(job)) setJob(null);
    setSavedScope(saved);
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

  async function discoverThreads() {
    if (discovery.status === 'loading') return;
    setDiscovery((current) => ({ ...current, status: 'loading', error: '' }));
    try {
      const result = await api.discoverCodexThreads();
      setDiscovery({ status: 'success', items: result.items, error: '' });
    } catch (reason) {
      setDiscovery((current) => ({ ...current, status: 'error', error: errorMessage(reason) }));
    }
  }

  async function saveScope(primary = false) {
    setBusy(true); setError(''); setMessage('');
    try {
      const allowedThreadIds = lines(allowedThreads);
      const saved = await api.saveCodexScope({
        ...scopeInput(scope),
        enabled: primary ? allowedThreadIds.length > 0 : scope.enabled,
        allowedThreadIds,
        allowedProjectPaths: lines(allowedPaths),
        excludedThreadIds: lines(excludedThreads),
        excludedProjectPaths: lines(excludedPaths),
      }, savedScope.revision);
      const adopted = { ...emptyScope, ...saved };
      if (adopted.revision !== savedScope.revision && isPartialSync(job)) setJob(null);
      setSavedScope(adopted); setScope(adopted);
      setAllowedThreads(joinLines(adopted.allowedThreadIds)); setExcludedThreads(joinLines(adopted.excludedThreadIds));
      setAllowedPaths(joinLines(adopted.allowedProjectPaths)); setExcludedPaths(joinLines(adopted.excludedProjectPaths));
      setMessage(primary ? '所选对话已保存，现在可以同步。' : '采集范围已保存。');
      threadsResource.reload();
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  async function sync() {
    if (hasUnsavedChanges || !canSync) return;
    setBusy(true); setError(''); setMessage('');
    try { setJob(await api.syncCodex(savedScope.allowedThreadIds)); setMessage('同步任务已提交，状态来自后端任务进度。'); }
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

  const authorizedThreads = threadsResource.data?.items ?? [];
  const threadMap = new Map<string, CodexThread>();
  for (const thread of [...authorizedThreads, ...discovery.items]) threadMap.set(thread.id, thread);
  const threads = [...threadMap.values()];
  const hiddenSelectedCount = scope.allowedThreadIds.filter((id) => !threadMap.has(id)).length;
  const projects = projectsResource.data?.items ?? [];
  const hasUnsavedChanges = !sameScope(scope, savedScope);
  const canSync = !!scopeResource.data && !scopeResource.error && !hasUnsavedChanges && hasEligibleThreads(savedScope);
  const syncDisabled = busy || !canSync || ['queued', 'running'].includes(job?.status || '');
  const saveDisabled = busy || !!scopeResource.error || !scopeResource.data;
  const partialSync = isPartialSync(job);
  return <div className="mx-auto max-w-6xl">
    <PageHeader eyebrow="只读采集" title="Codex 对话" description="按标题选择并保存授权，再同步已保存的对话。自动发现不可用时仍可手动导入。采集器只读取授权来源，不执行对话中的任何指令。" actions={<Button onClick={sync} disabled={syncDisabled}><RefreshCw className="h-4 w-4" />同步授权对话</Button>} />
    {hasUnsavedChanges && <div className="mb-4"><Notice>有未保存的范围修改，请先保存后再同步。</Notice></div>}
    <div className="mb-6"><Notice><ShieldCheck className="mr-2 inline h-4 w-4" />查看列表和勾选不会自动采集；保存所选对话后，再点击“同步授权对话”读取正文。</Notice></div>
    {message && <div className="mb-4"><Notice tone="success">{message}</Notice></div>}{error && <div className="mb-4"><Notice tone="error">{error}<div className="mt-2"><Button variant="secondary" onClick={scopeResource.reload}>重新加载最新范围</Button></div></Notice></div>}
    {job && <div className="panel mb-6 p-4" aria-live="polite"><div className="flex flex-wrap items-center gap-3"><Badge>{partialSync ? '本批完成（还有更多）' : job.status === 'succeeded' ? '任务完成' : job.status === 'failed' ? '任务失败' : job.status === 'running' ? '任务进行中' : job.status === 'uncertain' ? '结果待确认' : '等待处理'}</Badge><span className="text-sm text-muted">任务 {job.id}</span></div>{partialSync && <><p className="mt-2 text-sm">本批已保存，还有内容待采集，点击继续采集接着处理。</p><Button className="mt-3" onClick={sync} disabled={syncDisabled}>继续采集</Button></>}{job.error && <p className="mt-2 text-sm text-danger">{job.error}</p>}<p className="mt-2 text-sm">新建来源 {job.syncedCount ?? '—'} · 更新来源 {job.skippedCount ?? '—'}</p></div>}
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-10"><Section title="选择授权对话" description="勾选只修改草稿；保存所选对话后，才能同步。排除规则始终优先。" action={<Button variant="secondary" onClick={discoverThreads} disabled={discovery.status === 'loading'}>{discovery.status === 'loading' ? '正在查看近期对话…' : discovery.status === 'initial' ? '查看近期对话' : '刷新近期对话'}</Button>}>
        <p className="mb-4 text-sm leading-6 text-muted">点击后查看最近 7 天最多 20 条对话的标题、项目和更新时间，不读取完整对话内容。元数据可能包含敏感信息。</p>
        {discovery.status === 'loading' && <Loading label="正在读取近期对话元数据…" />}
        {discovery.status === 'error' && <div className="mb-4"><Notice tone="error">{discovery.error || '近期对话读取失败。'}<div className="mt-2"><Button variant="secondary" onClick={discoverThreads}>重试查看近期对话</Button></div></Notice></div>}
        {discovery.status === 'success' && !discovery.items.length && <p className="mb-4 text-sm text-muted">最近 7 天没有发现对话。已授权对话和手动导入不受影响。</p>}
        {threadsResource.error && <div className="mb-4"><Notice tone="error">授权对话列表不可用，手动导入不受影响。{errorMessage(threadsResource.error)}<div className="mt-2"><Button variant="secondary" onClick={threadsResource.reload}>重试授权列表</Button></div></Notice></div>}
        {threadsResource.loading && <Loading label="正在读取授权对话…" />}
        {threads.length ? <>
          <div className="divide-y divide-line border-y border-line">{threads.map((thread) => {
            const excluded = scope.excludedThreadIds.includes(thread.id) || !!thread.projectPath && scope.excludedProjectPaths.includes(thread.projectPath);
            return <label key={thread.id} className="flex cursor-pointer items-start gap-3 py-4"><input type="checkbox" className="mt-1.5 h-4 w-4 shrink-0 accent-accent" checked={scope.allowedThreadIds.includes(thread.id)} onChange={() => toggleThread(thread.id)} disabled={!scopeResource.data || !!scopeResource.error} /><span className="min-w-0 flex-1 break-words"><span className="block font-medium">{thread.title}</span><span className="mt-1 block break-all text-xs text-muted">{thread.projectPath || 'app-server 只读来源'} · {formatDate(thread.updatedAt)}</span>{excluded && <span className="mt-2 block text-xs text-danger"><Badge>排除规则生效</Badge><span className="mt-1 block">保存不会清除排除设置；请在高级设置中调整。</span></span>}</span></label>;
          })}</div>
          {hiddenSelectedCount > 0 && <p className="mt-3 text-sm text-muted">另有 {hiddenSelectedCount} 条已选对话不在当前列表，保存时会保留。</p>}
        </> : discovery.status === 'initial' ? <EmptyState title="尚未查看近期对话" description="点击“查看近期对话”读取元数据，或直接使用手动导入。" /> : null}
        <div className="mt-4"><Button onClick={() => saveScope(true)} disabled={saveDisabled || !scope.allowedThreadIds.length}><Save className="h-4 w-4" />保存所选对话</Button>{!scope.allowedThreadIds.length && <p className="mt-2 text-sm text-muted">请选择至少一条对话；清空选择、仅修改路径或停用采集请使用高级设置。</p>}</div>
      </Section>
      <Section title="手动导入对话" description="使用稳定来源 ID 和逐条消息。文本仅作为不受信任的学习材料，不会执行。">
        <form onSubmit={manualImport} className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><Field label="对话标题"><Input value={manual.title} onChange={(e) => setManual({ ...manual, title: e.target.value })} required /></Field><Field label="稳定来源 ID" hint="同一来源重复导入时保持不变。"><Input value={manual.externalSourceId} onChange={(e) => setManual({ ...manual, externalSourceId: e.target.value })} required /></Field></div><Field label="关联产品项目"><Select value={manual.projectId} onChange={(e) => setManual({ ...manual, projectId: e.target.value })}><option value="">不关联</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</Select></Field><div className="space-y-4">{messages.map((item, index) => <div key={item.sourceMessageId} className="panel space-y-3 p-4"><div className="flex items-center justify-between gap-3"><Badge>{item.sourceMessageId}</Badge><Select aria-label={`第 ${index + 1} 条消息角色`} value={item.role} onChange={(e) => setMessages(messages.map((current) => current.sourceMessageId === item.sourceMessageId ? { ...current, role: e.target.value as 'user' | 'assistant' } : current))} className="w-32"><option value="user">用户</option><option value="assistant">助手</option></Select></div><Field label={`第 ${index + 1} 条消息内容`}><Textarea value={item.content} onChange={(e) => setMessages(messages.map((current) => current.sourceMessageId === item.sourceMessageId ? { ...current, content: e.target.value } : current))} /></Field></div>)}</div><Button variant="ghost" onClick={() => setMessages([...messages, { sourceMessageId: `message-${messages.length + 1}`, role: 'assistant', content: '' }])}><Plus className="h-4 w-4" />添加消息</Button><div><Button type="submit" disabled={busy || !savedScope.allowManualImports}>提交手动导入</Button></div></form>
      </Section></div>
      <aside><Section title="采集范围" description={scopeResource.error ? '范围读取失败；未保存控件不会覆盖服务器配置。' : '线程与本地路径分别授权，排除规则优先。'}><details className="panel p-4"><summary className="cursor-pointer text-sm font-medium">高级设置</summary>{scopeResource.loading ? <Loading /> : <div className="mt-4"><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={scope.enabled} onChange={(e) => setScope({ ...scope, enabled: e.target.checked })} />启用自动采集</label><div className="mt-4 space-y-4"><Field label="授权线程 ID（每行一条）"><Textarea value={allowedThreads} onChange={(e) => { setAllowedThreads(e.target.value); setScope({ ...scope, allowedThreadIds: lines(e.target.value) }); }} /></Field><Field label="排除线程 ID（每行一条）"><Textarea value={excludedThreads} onChange={(e) => { setExcludedThreads(e.target.value); setScope({ ...scope, excludedThreadIds: lines(e.target.value) }); }} /></Field><Field label="授权项目绝对路径（每行一条）"><Textarea value={allowedPaths} onChange={(e) => { setAllowedPaths(e.target.value); setScope({ ...scope, allowedProjectPaths: lines(e.target.value) }); }} /></Field><Field label="排除项目绝对路径（每行一条）"><Textarea value={excludedPaths} onChange={(e) => { setExcludedPaths(e.target.value); setScope({ ...scope, excludedProjectPaths: lines(e.target.value) }); }} /></Field><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={scope.includeArchived} onChange={(e) => setScope({ ...scope, includeArchived: e.target.checked })} />包含已归档对话</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={scope.allowManualImports} onChange={(e) => setScope({ ...scope, allowManualImports: e.target.checked })} />允许手动导入</label></div><Button variant="secondary" className="mt-4 w-full" onClick={() => saveScope(false)} disabled={saveDisabled}><Save className="h-4 w-4" />保存采集范围</Button>{scopeResource.error && <p className="mt-3 text-sm text-danger">{errorMessage(scopeResource.error)}</p>}</div>}</details></Section></aside>
    </div>
  </div>;
}
