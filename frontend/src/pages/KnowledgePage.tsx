import { Check, CloudUpload, Plus, Search, X } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { SourceRefs } from '../components/SourceRefs';
import { Badge, Button, EmptyState, ErrorState, Field, Input, Loading, Notice, PageHeader, SafeText, Select, Textarea } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api, manualSourceInputs, sourceRefInputs } from '../services/api';
import type { Knowledge } from '../types';
import { errorMessage, knowledgeStatusLabels } from '../utils/text';

const blank = { question: '', answer: '', projectId: '', sourceRefs: '' };
type ImportKind = 'siyuan_document' | 'siyuan_block' | 'feishu_document';
const factualStatus = {
  unverified: { label: '未核验', title: '未事实核验：尚未进行证据核查，不代表内容正确或错误。' },
  supported: { label: '证据支持', title: '证据支持：现有证据支持此内容，但不保证绝对正确。' },
  contradicted: { label: '存在反证', title: '存在相反证据：现有证据与此内容相矛盾。' },
  mixed: { label: '证据不一', title: '混合证据：现有证据结论不一致，不代表内容已得到证实。' },
} as const;

export function KnowledgePage() {
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [status, setStatus] = useState('');
  const query = new URLSearchParams({ ...(appliedSearch ? { q: appliedSearch } : {}), ...(status ? { status } : {}) }).toString();
  const resource = useApi(() => Promise.all([api.knowledge(query), api.projects()]), [query]);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [form, setForm] = useState(blank);
  const [importForm, setImportForm] = useState<{ kind: ImportKind; identifier: string; projectId: string }>({ kind: 'siyuan_document', identifier: '', projectId: '' });
  const [editing, setEditing] = useState<Knowledge | null>(null);
  const [editSources, setEditSources] = useState('');
  const [busyId, setBusyId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const items = resource.data?.[0].items ?? [];
  const projects = resource.data?.[1].items ?? [];

  async function run(id: string, action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusyId(id); setError(''); setMessage('');
    try { await action(); setMessage(success); resource.reload(); return true; }
    catch (reason) { setError(errorMessage(reason)); return false; }
    finally { setBusyId(''); }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!form.question.trim() || !form.answer.trim()) { setError('问题和答案不能为空。'); return; }
    const saved = await run('new', () => api.createKnowledge({ question: form.question.trim(), answer: form.answer.trim(), projectId: form.projectId || null, sourceRefs: manualSourceInputs(form.sourceRefs) }), '已保存为待确认草稿。');
    if (saved) { setForm(blank); setCreating(false); }
  }
  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const saved = await run(editing.id, () => api.updateKnowledge(editing.id, { question: editing.question, answer: editing.answer, projectId: editing.projectId || null, sourceRefs: sourceRefInputs(editing.sourceRefs, editSources) }, editing.revision), '知识内容已更新；已有来源身份已保留。');
    if (saved) { setEditing(null); setEditSources(''); }
  }
  async function importSource(event: FormEvent) {
    event.preventDefault();
    const identifier = importForm.identifier.trim();
    const body = importForm.kind === 'feishu_document'
      ? { kind: importForm.kind, url: identifier, projectId: importForm.projectId || null, extractCandidates: true }
      : importForm.kind === 'siyuan_block'
        ? { kind: importForm.kind, blockId: identifier, projectId: importForm.projectId || null, extractCandidates: true }
        : { kind: importForm.kind, documentId: identifier, projectId: importForm.projectId || null, extractCandidates: true };
    const saved = await run('import', () => api.importSource(body), '导入任务已提交；请在任务完成后刷新，候选内容仍需逐条确认。');
    if (saved) setImporting(false);
  }

  if (resource.loading) return <Loading />;
  if (resource.error) return <><PageHeader title="知识" /><ErrorState error={resource.error} retry={resource.reload} /></>;
  const importLabel = importForm.kind === 'feishu_document' ? '飞书文档 URL' : importForm.kind === 'siyuan_block' ? '思源块 ID' : '思源文档 ID';
  return <div className="mx-auto max-w-6xl">
    <PageHeader eyebrow="个人知识库" title="知识" description="模型建议始终是草稿；只有经过你确认的内容才进入已接受知识。" actions={<><Button variant="secondary" onClick={() => setImporting(!importing)}><CloudUpload className="h-4 w-4" />导入来源</Button><Button onClick={() => setCreating(!creating)}><Plus className="h-4 w-4" />手动记录</Button></>} />
    {message && <div className="mb-4"><Notice tone="success" onDismiss={() => setMessage('')}>{message}</Notice></div>}{error && <div className="mb-4"><Notice tone="error">{error}<div className="mt-2"><Button variant="secondary" onClick={resource.reload}>重新加载最新数据</Button></div></Notice></div>}
    {creating && <form onSubmit={create} className="panel mb-8 space-y-4 p-5"><h2 className="text-xl">记录一条知识</h2><Field label="问题"><Input autoFocus value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} required /></Field><Field label="答案"><Textarea className="min-h-40" value={form.answer} onChange={(e) => setForm({ ...form, answer: e.target.value })} required /></Field><div className="grid gap-4 sm:grid-cols-2"><Field label="所属项目"><Select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}><option value="">不关联项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</Select></Field><Field label="手工来源（每行一条 URL 或摘录）" hint="每行会保存为独立的手工来源；URL 只作为引用，不会自动抓取。"><Textarea value={form.sourceRefs} onChange={(e) => setForm({ ...form, sourceRefs: e.target.value })} /></Field></div><div className="flex gap-2"><Button type="submit" disabled={busyId === 'new'}>保存草稿</Button><Button variant="ghost" onClick={() => setCreating(false)}>取消</Button></div></form>}
    {importing && <form onSubmit={importSource} className="panel mb-8 space-y-4 p-5"><h2 className="text-xl">导入来源</h2><Notice>只导入你明确指定的思源或飞书文档；手工摘录可直接填写在“手动记录”中。</Notice><Field label="来源类型"><Select value={importForm.kind} onChange={(e) => setImportForm({ ...importForm, kind: e.target.value as ImportKind, identifier: '' })}><option value="siyuan_document">思源文档</option><option value="siyuan_block">思源块</option><option value="feishu_document">飞书文档</option></Select></Field><Field label={importLabel} hint={importForm.kind === 'feishu_document' ? '填写租户下的 docx 或 wiki 完整地址。' : '格式示例：20261027090000-abcdefg'}><Input value={importForm.identifier} onChange={(e) => setImportForm({ ...importForm, identifier: e.target.value })} required /></Field><Field label="关联项目"><Select value={importForm.projectId} onChange={(e) => setImportForm({ ...importForm, projectId: e.target.value })}><option value="">不关联</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</Select></Field><Button type="submit" disabled={busyId === 'import' || !importForm.identifier.trim()}>提交导入</Button></form>}
    <div className="mb-6 flex flex-col gap-3 sm:flex-row"><form className="flex flex-1 gap-2" onSubmit={(event) => { event.preventDefault(); setAppliedSearch(search.trim()); }}><Input aria-label="搜索知识" placeholder="搜索问题或答案" value={search} onChange={(e) => setSearch(e.target.value)} /><Button variant="secondary" type="submit" aria-label="搜索"><Search className="h-4 w-4" /></Button></form><Select aria-label="按状态筛选" value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-44"><option value="">全部状态</option>{Object.entries(knowledgeStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></div>
    {items.length ? <div className="space-y-5">{items.map((item) => {
      const reason = item.relevance?.reason || item.selectionReason;
      const validation = factualStatus[item.validation?.status as keyof typeof factualStatus] || factualStatus.unverified;
      return <article key={item.id} className="panel p-5 sm:p-6"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 flex-wrap gap-2"><Badge title="接受状态仅表示是否保留，不代表事实正确。" className={item.status === 'accepted' ? 'border-accent/30 text-accent' : ''}>{knowledgeStatusLabels[item.status]}</Badge><Badge title={validation.title} className="max-w-full whitespace-normal">{validation.label}</Badge></div><span className="text-xs text-muted">{projects.find((project) => project.id === item.projectId)?.title || '未关联项目'}{item.siyuanBlockId ? ' · 已关联思源块' : ''}</span></div>{editing?.id === item.id ? <form onSubmit={saveEdit} className="space-y-4"><Field label="问题"><Input value={editing.question} onChange={(e) => setEditing({ ...editing, question: e.target.value })} required /></Field><Field label="答案"><Textarea className="min-h-40" value={editing.answer} onChange={(e) => setEditing({ ...editing, answer: e.target.value })} required /></Field><div><p className="label">已有来源（保留原始身份）</p><SourceRefs refs={editing.sourceRefs} /></div><Field label="新增手工来源（每行一条 URL 或摘录）"><Textarea value={editSources} onChange={(e) => setEditSources(e.target.value)} /></Field><div className="flex gap-2"><Button type="submit" disabled={busyId === item.id}>保存</Button><Button variant="ghost" onClick={() => { setEditing(null); setEditSources(''); }}>取消</Button></div></form> : <><h2 className="text-xl leading-relaxed">{item.question}</h2><SafeText className="mt-3 text-muted">{item.answer}</SafeText>{reason && <p className="mt-3 text-sm text-accent">入选理由：{reason}</p>}<details className="mt-4"><summary className="cursor-pointer text-sm text-accent">查看来源（{item.sourceRefs.length}）</summary><div className="mt-3 border-l border-line pl-4"><SourceRefs refs={item.sourceRefs} /></div></details><div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">{['draft', 'needs_recheck'].includes(item.status) && <Button onClick={() => run(item.id, () => api.knowledgeDecision(item.id, 'accept', item.revision), item.status === 'needs_recheck' ? '已重新接受这条知识。' : '已接受这条知识。')} disabled={busyId === item.id}><Check className="h-4 w-4" />{item.status === 'needs_recheck' ? '复核并接受' : '接受'}</Button>}{['draft', 'needs_recheck', 'accepted'].includes(item.status) && <Button variant="secondary" onClick={() => run(item.id, () => api.knowledgeDecision(item.id, 'reject', item.revision), '已拒绝这条知识。')} disabled={busyId === item.id}><X className="h-4 w-4" />拒绝</Button>}<Button variant="ghost" onClick={() => { setEditing({ ...item }); setEditSources(''); }}>编辑</Button>{item.status === 'accepted' && <Button variant="secondary" onClick={() => run(item.id, () => api.syncKnowledge(item.id, item.revision), '同步任务已提交，实际结果以任务状态为准。')} disabled={busyId === item.id}><CloudUpload className="h-4 w-4" />{busyId === item.id ? '处理中…' : '同步到思源'}</Button>}</div></>}</article>;
    })}</div> : <EmptyState title={appliedSearch || status ? '没有匹配的知识' : '知识库还是空的'} description={appliedSearch || status ? '尝试更换关键词或状态筛选。' : '手动记录一条真正理解的知识，或从已配置的来源导入候选草稿。'} action={!appliedSearch && !status ? <Button onClick={() => setCreating(true)}>记录第一条知识</Button> : undefined} />}
  </div>;
}
