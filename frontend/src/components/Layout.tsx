import { BookOpen, BrainCircuit, CalendarDays, Menu, MessageSquareText, PenLine, Settings, X } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

const navigation = [
  { to: '/', label: '今日', icon: CalendarDays },
  { to: '/projects', label: '项目', icon: BookOpen },
  { to: '/knowledge', label: '知识', icon: BrainCircuit },
  { to: '/review', label: '复习', icon: MessageSquareText },
  { to: '/practice', label: '练习与输出', icon: PenLine },
  { to: '/codex', label: '对话采集', icon: MessageSquareText },
  { to: '/settings', label: '设置', icon: Settings },
];

export function Layout() {
  const [open, setOpen] = useState(false);
  return <div className="min-h-screen lg:grid lg:grid-cols-[224px_minmax(0,1fr)]">
    <a href="#main-content" className="fixed left-4 top-2 z-50 -translate-y-20 bg-accent px-4 py-2 text-white focus:translate-y-0">跳到主要内容</a>
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-line bg-paper/95 px-4 backdrop-blur lg:hidden">
      <NavLink to="/" className="font-serif text-2xl font-semibold">知行</NavLink>
      <button className="btn-ghost -mr-2" aria-expanded={open} aria-controls="primary-navigation" aria-label={open ? '关闭导航' : '打开导航'} onClick={() => setOpen(!open)}>{open ? <X /> : <Menu />}</button>
    </header>
    {open && <button className="fixed inset-0 z-30 bg-ink/20 lg:hidden" aria-label="关闭导航" onClick={() => setOpen(false)} />}
    <aside className={`${open ? 'translate-x-0' : '-translate-x-full'} fixed inset-y-0 left-0 z-40 w-64 border-r border-line bg-paper px-5 py-6 transition-transform lg:sticky lg:top-0 lg:h-screen lg:w-auto lg:translate-x-0`} id="primary-navigation">
      <div className="mb-10 hidden lg:block"><NavLink to="/" className="font-serif text-3xl font-semibold tracking-wide">知行</NavLink><p className="mt-1 text-xs tracking-widest text-muted">个人学习工作台</p></div>
      <nav aria-label="主导航"><ul className="space-y-1">{navigation.map(({ to, label, icon: Icon }) => <li key={to}><NavLink to={to} end={to === '/'} onClick={() => setOpen(false)} className={({ isActive }) => `flex min-h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors ${isActive ? 'bg-accent/10 font-medium text-accent' : 'text-muted hover:bg-ink/5 hover:text-ink'}`}><Icon className="h-[18px] w-[18px]" aria-hidden="true" />{label}</NavLink></li>)}</ul></nav>
      <p className="absolute bottom-6 left-8 right-8 hidden text-xs leading-5 text-muted lg:block">每天留下一个可继续的节点。</p>
    </aside>
    <main id="main-content" tabIndex={-1} className="min-w-0 px-4 py-6 sm:px-8 sm:py-8 xl:px-12"><div className="page-enter mx-auto max-w-[1440px]"><Outlet /></div></main>
  </div>;
}
