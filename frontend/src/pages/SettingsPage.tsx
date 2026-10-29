import { Check, Download, Plug, Save } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { FeishuChatSettings } from '../components/FeishuChatSettings';
import { Badge, Button, ErrorState, Field, Input, Loading, Notice, PageHeader, Section, Select, Textarea } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api, ApiError } from '../services/api';
import type { Automation, Settings, SettingsInput } from '../types';
import { errorMessage, joinLines, lines } from '../utils/text';

const initialSettings: Settings = {
  revision: 0,
  model: { enabled: false, provider: 'openai-compatible', endpoint: null, model: null, allowExternalProcessing: false, apiKeyConfigured: false },
  feishu: { enabled: false, appId: null, apiBase: 'https://open.feishu.cn', appSecretConfigured: false },
  scheduler: { enabled: false, codexSyncEnabled: false, dailyPlanEnabled: false, codexSyncIntervalMinutes: 60, dailyPlanLocalTime: '09:00', catchUpEnabled: false },
};

export function SettingsPage() {
  const resource = useApi(() => Promise.all([api.profile(), api.connections(), api.settings(), api.automation()]), []);
  const [profile, setProfile] = useState({ goals: '', careerDirection: '', skills: '', dailyBudgetMinutes: 15, timeZone: 'Asia/Shanghai', revision: 0 });
  const [siyuan, setSiyuan] = useState({ useRuntimeConnection: false, baseUrl: '', notebookTitle: '第二大脑', token: '', deleteToken: false });
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [automation, setAutomation] = useState<Automation | null>(null);
  const [modelOpen, setModelOpen] = useState(() => window.location.hash === '#model');
  const [feishuOpen, setFeishuOpen] = useState(() => window.location.hash === '#feishu');
  const [modelKey, setModelKey] = useState('');
  const [deleteModelKey, setDeleteModelKey] = useState(false);
  const [feishuSecret, setFeishuSecret] = useState('');
  const [deleteFeishuSecret, setDeleteFeishuSecret] = useState(false);
  const [notebooks, setNotebooks] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refreshRegistrationSettings = useCallback(async () => {
    setSettings(await api.settings());
  }, []);

  useEffect(() => {
    function openHashTarget() {
      if (window.location.hash === '#model') setModelOpen(true);
      if (window.location.hash === '#feishu') setFeishuOpen(true);
    }
    window.addEventListener('hashchange', openHashTarget);
    return () => window.removeEventListener('hashchange', openHashTarget);
  }, []);

  useEffect(() => {
    if (!resource.data) return;
    const [profileData, connections, settingsData, automationData] = resource.data;
    setProfile({ goals: joinLines(profileData.goals), careerDirection: profileData.careerDirection, skills: joinLines(profileData.skills), dailyBudgetMinutes: profileData.dailyBudgetMinutes, timeZone: profileData.timeZone, revision: profileData.revision });
    setSettings(settingsData);
    setAutomation(automationData);
    const connection = connections.find((item) => item.provider === 'siyuan');
    if (connection) setSiyuan((current) => ({ ...current, useRuntimeConnection: connection.configurationSource !== 'manual', baseUrl: connection.baseUrl || '', notebookTitle: connection.notebookTitle || '第二大脑' }));
  }, [resource.data]);

  async function run(key: string, action: () => Promise<unknown>, success: string) {
    setBusy(key); setError(''); setMessage('');
    try { await action(); setMessage(success); return true; }
    catch (reason) { setError(errorMessage(reason)); return false; }
    finally { setBusy(''); }
  }
  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (!Number.isInteger(profile.dailyBudgetMinutes) || profile.dailyBudgetMinutes < 0 || profile.dailyBudgetMinutes > 120 || !profile.timeZone.trim()) { setError('每日预算需为 0–120 分钟的整数，并填写有效时区；0 表示暂停计划。'); return; }
    const saved = await run('profile', () => api.saveProfile({ goals: lines(profile.goals), careerDirection: profile.careerDirection.trim(), skills: lines(profile.skills), dailyBudgetMinutes: profile.dailyBudgetMinutes, timeZone: profile.timeZone.trim() }, profile.revision), '学习档案已保存，今日计划会使用新的时间预算。');
    if (saved) resource.reload();
  }
  async function saveSettings() {
    const body: SettingsInput = {
      model: {
        enabled: settings.model.enabled,
        provider: 'openai-compatible',
        endpoint: settings.model.endpoint?.trim() || null,
        model: settings.model.model?.trim() || null,
        allowExternalProcessing: settings.model.allowExternalProcessing,
        ...(deleteModelKey ? { apiKey: null } : modelKey.trim() ? { apiKey: modelKey } : {}),
      },
      feishu: {
        enabled: settings.feishu.enabled,
        appId: settings.feishu.appId?.trim() || null,
        apiBase: settings.feishu.apiBase,
        ...(deleteFeishuSecret ? { appSecret: null } : feishuSecret.trim() ? { appSecret: feishuSecret } : {}),
      },
      scheduler: { ...settings.scheduler },
    };
    const saved = await api.saveSettings(body, settings.revision);
    setSettings(saved); setModelKey(''); setFeishuSecret(''); setDeleteModelKey(false); setDeleteFeishuSecret(false); resource.reload();
  }
  async function exportData() {
    await run('export', async () => {
      const artifact = await api.exportDownload();
      if (!/^[A-Za-z0-9._-]+\.json$/.test(artifact.filename)) throw new ApiError('UNSAFE_EXPORT_FILENAME', '服务返回了不安全的文件名，已阻止下载。');
      const blob = new Blob([artifact.content], { type: 'application/json;charset=utf-8' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href; anchor.download = artifact.filename; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 0);
    }, '导出文件已按服务端内容下载；不包含设置、连接或秘密字段。');
  }

  if (resource.loading) return <Loading />;
  if (resource.error) return <><PageHeader title="设置" /><ErrorState error={resource.error} retry={resource.reload} /></>;
  const connections = resource.data?.[1] ?? [];
  const siyuanConnection = connections.find((item) => item.provider === 'siyuan');
  const modelConnection = connections.find((item) => item.provider === 'model');
  return <div className="mx-auto max-w-5xl">
    <PageHeader eyebrow="本地工作区" title="设置" description="管理学习档案、真实连接状态和可选服务。密钥只提交到本地后端，保存后立即从表单清除。" actions={<Button variant="secondary" onClick={exportData} disabled={busy === 'export'}><Download className="h-4 w-4" />导出数据</Button>} />
    {message && <div className="mb-4"><Notice tone="success">{message}</Notice></div>}{error && <div className="mb-4"><Notice tone="error">{error}<div className="mt-2"><Button variant="secondary" onClick={resource.reload}>重新加载最新设置</Button></div></Notice></div>}
    <div className="space-y-12">
      <div id="profile" className="scroll-mt-24"><Section title="学习档案" description="只填写你的真实方向与目标；每日预算为 0 时暂停计划。"><form onSubmit={saveProfile} className="grid gap-5 sm:grid-cols-2"><Field label="当前目标（每行一条）"><Textarea value={profile.goals} onChange={(e) => setProfile({ ...profile, goals: e.target.value })} /></Field><Field label="技能（每行一项）"><Textarea value={profile.skills} onChange={(e) => setProfile({ ...profile, skills: e.target.value })} /></Field><Field label="职业方向（可选）"><Input value={profile.careerDirection} onChange={(e) => setProfile({ ...profile, careerDirection: e.target.value })} /></Field><div className="grid grid-cols-2 gap-4"><Field label="每日预算（分钟）"><Input type="number" min={0} max={120} value={profile.dailyBudgetMinutes} onChange={(e) => setProfile({ ...profile, dailyBudgetMinutes: Number(e.target.value) })} required /></Field><Field label="时区"><Input value={profile.timeZone} onChange={(e) => setProfile({ ...profile, timeZone: e.target.value })} required /></Field></div><div className="sm:col-span-2"><Button type="submit" disabled={busy === 'profile'}><Save className="h-4 w-4" />保存学习档案</Button></div></form></Section></div>
      {automation && <Section title="自动整理" description="独立控制自动整理，不改变定时任务或 Codex 对话读取权限。"><div className="flex flex-col gap-4 border-y border-line py-5 sm:flex-row sm:items-center sm:justify-between"><p role="status" className="text-sm text-muted">{automation.message}</p><Button variant="secondary" role="switch" aria-checked={automation.enabled} disabled={busy === 'automation'} onClick={() => void run('automation', async () => setAutomation(await api.saveAutomation(!automation.enabled, automation.revision)), automation.enabled ? '自动整理已停用。' : '自动整理已开启。')}>{automation.enabled ? '停用自动整理' : '开启自动整理'}</Button></div></Section>}
      <FeishuChatSettings onRegistrationComplete={refreshRegistrationSettings} />
      <Section title="思源笔记" description="同步不可用时会显示真实错误，不影响本地知识与写作。" action={<Badge className={siyuanConnection?.connected ? 'text-accent' : ''}><span className="status-dot" />{siyuanConnection?.connected ? '已连接' : siyuanConnection?.configured ? '已配置 · 未确认连接' : '未配置'}</Badge>}><form onSubmit={(event) => { event.preventDefault(); void run('siyuan', async () => { await api.saveSiyuan({ useRuntimeConnection: siyuan.useRuntimeConnection, baseUrl: siyuan.useRuntimeConnection ? null : siyuan.baseUrl.trim(), notebookTitle: siyuan.notebookTitle.trim(), ...(siyuan.deleteToken ? { token: null } : siyuan.token.trim() ? { token: siyuan.token } : {}) }, siyuanConnection?.revision); setSiyuan({ ...siyuan, token: '', deleteToken: false }); resource.reload(); }, '思源配置已保存；未填写的秘密保持原值。'); }} className="grid gap-4 sm:grid-cols-2"><label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="h-4 w-4 accent-accent" checked={siyuan.useRuntimeConnection} onChange={(e) => setSiyuan({ ...siyuan, useRuntimeConnection: e.target.checked })} />使用本地运行时连接清单</label><Field label="服务地址"><Input type="url" placeholder="http://127.0.0.1:6806" value={siyuan.baseUrl} onChange={(e) => setSiyuan({ ...siyuan, baseUrl: e.target.value })} disabled={siyuan.useRuntimeConnection} required={!siyuan.useRuntimeConnection} /></Field><Field label="专用笔记本名称"><Input value={siyuan.notebookTitle} onChange={(e) => setSiyuan({ ...siyuan, notebookTitle: e.target.value })} required /></Field><Field label="访问令牌" hint={siyuanConnection?.tokenConfigured ? '已配置；留空保留，不会读取或显示已有令牌。' : '密码输入，留空不提交。'}><Input type="password" autoComplete="new-password" value={siyuan.token} onChange={(e) => setSiyuan({ ...siyuan, token: e.target.value })} disabled={siyuan.deleteToken} /></Field><label className="flex items-center gap-2 self-end pb-3 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={siyuan.deleteToken} onChange={(e) => setSiyuan({ ...siyuan, deleteToken: e.target.checked })} />明确删除已保存的手工令牌</label><div className="flex flex-wrap gap-2 sm:col-span-2"><Button type="submit" disabled={busy === 'siyuan'}><Save className="h-4 w-4" />保存思源配置</Button><Button variant="secondary" disabled={busy === 'check' || !siyuanConnection?.configured} onClick={() => run('check', async () => { await api.checkSiyuan(); resource.reload(); }, '连接检查完成，连接状态已刷新。')}><Plug className="h-4 w-4" />检查连接</Button><Button variant="ghost" disabled={busy === 'notebooks' || !siyuanConnection?.configured} onClick={() => run('notebooks', async () => { const result = await api.notebooks(); setNotebooks(result.items); }, '笔记本列表已更新。')}>查看笔记本</Button></div></form>{notebooks.length > 0 && <ul className="mt-4 flex flex-wrap gap-2">{notebooks.map((notebook) => <Badge key={notebook.id}>{notebook.name}</Badge>)}</ul>}</Section>
      <details id="model" className="scroll-mt-24" open={modelOpen} onToggle={(event) => setModelOpen(event.currentTarget.open)}><summary className="cursor-pointer rounded-md border-y border-line py-4 font-serif text-xl font-semibold">模型服务（高级）</summary><div className="pt-6"><Section title="可选模型服务" description="保存配置不代表模型已验证可用；没有配置时仍可使用本地模板。" action={<Badge>{modelConnection?.configured ? '已配置' : '未配置'}</Badge>}><form onSubmit={(event) => { event.preventDefault(); void run('model', saveSettings, '模型设置已保存，密钥已从表单清除。'); }} className="grid gap-4 sm:grid-cols-2"><Field label="API Base URL"><Input type="url" value={settings.model.endpoint || ''} onChange={(e) => setSettings({ ...settings, model: { ...settings.model, endpoint: e.target.value } })} /></Field><Field label="模型名称"><Input value={settings.model.model || ''} onChange={(e) => setSettings({ ...settings, model: { ...settings.model, model: e.target.value } })} /></Field><Field label="API Key" hint={settings.model.apiKeyConfigured ? '已配置；留空保留，不会读取或显示已有密钥。' : '留空不提交密钥。'}><Input type="password" autoComplete="new-password" value={modelKey} onChange={(e) => setModelKey(e.target.value)} disabled={deleteModelKey} /></Field><label className="flex items-center gap-2 self-end pb-3 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={deleteModelKey} onChange={(e) => setDeleteModelKey(e.target.checked)} />明确删除已保存的 API Key</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={settings.model.enabled} onChange={(e) => setSettings({ ...settings, model: { ...settings.model, enabled: e.target.checked } })} />启用模型处理</label><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-accent" checked={settings.model.allowExternalProcessing} onChange={(e) => setSettings({ ...settings, model: { ...settings.model, allowExternalProcessing: e.target.checked } })} /><span>我明确允许把练习、反馈等任务内容发送到上述模型服务进行处理</span></label><div className="sm:col-span-2"><Button type="submit" disabled={busy === 'model'}>保存模型设置</Button></div></form></Section></div></details>
      <details id="feishu" className="scroll-mt-24" open={feishuOpen} onToggle={(event) => setFeishuOpen(event.currentTarget.open)}><summary className="cursor-pointer rounded-md border-y border-line py-4 font-serif text-xl font-semibold">飞书与定时任务（高级）</summary><div className="pt-6"><Section title="飞书与定时任务" description="飞书可作为文档来源，也可通过独立的学习私聊设置进行练习对话；定时任务只执行已明确启用的采集与模板计划。"><form onSubmit={(event) => { event.preventDefault(); void run('settings', saveSettings, '可选连接与定时设置已保存，秘密字段已清除。'); }} className="grid gap-4 sm:grid-cols-2"><Field label="飞书 App ID"><Input value={settings.feishu.appId || ''} onChange={(e) => setSettings({ ...settings, feishu: { ...settings.feishu, appId: e.target.value } })} /></Field><Field label="飞书服务区域"><Select value={settings.feishu.apiBase} onChange={(e) => setSettings({ ...settings, feishu: { ...settings.feishu, apiBase: e.target.value as Settings['feishu']['apiBase'] } })}><option value="https://open.feishu.cn">飞书（中国）</option><option value="https://open.larksuite.com">Lark（国际）</option></Select></Field><Field label="飞书 App Secret" hint={settings.feishu.appSecretConfigured ? '已配置；留空保留。' : '密码输入，留空不提交。'}><Input type="password" autoComplete="new-password" value={feishuSecret} onChange={(e) => setFeishuSecret(e.target.value)} disabled={deleteFeishuSecret} /></Field><label className="flex items-center gap-2 self-end pb-3 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={deleteFeishuSecret} onChange={(e) => setDeleteFeishuSecret(e.target.checked)} />明确删除已保存的 App Secret</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={settings.feishu.enabled} onChange={(e) => setSettings({ ...settings, feishu: { ...settings.feishu, enabled: e.target.checked } })} />启用飞书连接</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={settings.scheduler.enabled} onChange={(e) => setSettings({ ...settings, scheduler: { ...settings.scheduler, enabled: e.target.checked } })} />启用定时任务</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={settings.scheduler.codexSyncEnabled} onChange={(e) => setSettings({ ...settings, scheduler: { ...settings.scheduler, codexSyncEnabled: e.target.checked } })} />定时同步 Codex</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-accent" checked={settings.scheduler.dailyPlanEnabled} onChange={(e) => setSettings({ ...settings, scheduler: { ...settings.scheduler, dailyPlanEnabled: e.target.checked } })} />定时生成模板日计划</label><Field label="Codex 同步间隔（分钟）"><Input type="number" min={5} max={1440} value={settings.scheduler.codexSyncIntervalMinutes} onChange={(e) => setSettings({ ...settings, scheduler: { ...settings.scheduler, codexSyncIntervalMinutes: Number(e.target.value) } })} /></Field><Field label="每日计划时间"><Input type="time" value={settings.scheduler.dailyPlanLocalTime} onChange={(e) => setSettings({ ...settings, scheduler: { ...settings.scheduler, dailyPlanLocalTime: e.target.value } })} /></Field><label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="h-4 w-4 accent-accent" checked={settings.scheduler.catchUpEnabled} onChange={(e) => setSettings({ ...settings, scheduler: { ...settings.scheduler, catchUpEnabled: e.target.checked } })} />补做最近一个错过周期</label><div className="flex items-end"><Button type="submit" disabled={busy === 'settings'}><Check className="h-4 w-4" />保存可选设置</Button></div></form><p className="mt-3 text-sm text-muted">当前状态：{settings.scheduler.enabled ? `服务已启用定时任务，每日计划时间 ${settings.scheduler.dailyPlanLocalTime}` : '定时任务未启用'}</p></Section></div></details>
    </div>
  </div>;
}
