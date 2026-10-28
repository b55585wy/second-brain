import { AlertCircle, Inbox, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { cloneElement, useId } from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { errorMessage } from '../utils/text';

export function Button({ variant = 'primary', className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button type={type} className={`btn-${variant} ${className}`} {...props} />;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${props.className || ''}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`input min-h-28 resize-y ${props.className || ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`input ${props.className || ''}`} />;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactElement }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const control = cloneElement(children, {
    id: children.props.id || id,
    'aria-describedby': hint || error ? hintId : children.props['aria-describedby'],
    'aria-invalid': error ? true : children.props['aria-invalid'],
  });
  return <div className="block"><label className="label" htmlFor={children.props.id || id}>{label}</label>{control}{(hint || error) && <span id={hintId} role={error ? 'alert' : undefined} className={`mt-1 block ${error ? 'text-sm text-danger' : 'text-xs text-muted'}`}>{error || hint}</span>}</div>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="mb-8 flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
    <div className="max-w-2xl">{eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}<h1 className="text-3xl leading-tight sm:text-4xl">{title}</h1>{description && <p className="mt-3 text-sm leading-6 text-muted">{description}</p>}</div>
    {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
  </header>;
}

export function Notice({ tone = 'info', children, onDismiss }: { tone?: 'info' | 'error' | 'success'; children: ReactNode; onDismiss?: () => void }) {
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-3 rounded-md border px-4 py-3 text-sm ${tone === 'error' ? 'border-danger/30 bg-danger/5 text-danger' : tone === 'success' ? 'border-accent/30 bg-accent/5 text-accent' : 'border-line bg-surface text-muted'}`}>
    {tone === 'error' && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}<div className="min-w-0 flex-1">{children}</div>{onDismiss && <button className="rounded p-1 hover:bg-ink/5" onClick={onDismiss} aria-label="关闭提示"><X className="h-4 w-4" /></button>}
  </div>;
}

export function Loading({ label = '正在读取你的学习内容…' }: { label?: string }) {
  return <div role="status" className="flex min-h-40 items-center justify-center gap-3 text-sm text-muted"><LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />{label}</div>;
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return <div className="py-12"><Notice tone="error">{errorMessage(error)}</Notice>{retry && <Button variant="secondary" className="mt-4" onClick={retry}><RefreshCw className="h-4 w-4" />重新加载</Button>}</div>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="flex min-h-44 flex-col items-start justify-center border-y border-dashed border-line py-8"><Inbox className="mb-3 h-6 w-6 text-muted" aria-hidden="true" /><h2 className="text-xl">{title}</h2><p className="mt-2 max-w-lg text-sm text-muted">{description}</p>{action && <div className="mt-4">{action}</div>}</div>;
}

export function Section({ title, description, action, children, className = '' }: { title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={className}><div className="mb-4 flex items-start justify-between gap-4"><div><h2 className="text-xl">{title}</h2>{description && <p className="mt-1 text-sm text-muted">{description}</p>}</div>{action}</div>{children}</section>;
}

export function Badge({ children, className = '', ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} className={`inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs text-muted ${className}`}>{children}</span>;
}

export function SafeText({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`prose-safe ${className}`}>{children}</div>;
}
