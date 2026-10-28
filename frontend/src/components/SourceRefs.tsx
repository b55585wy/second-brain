import { FileText } from 'lucide-react';
import type { SourceRef } from '../types';
import { SafeText } from './ui';

export function SourceRefs({ refs }: { refs?: SourceRef[] }) {
  if (!refs?.length) return <p className="text-sm text-muted">未关联来源。接受前请确认内容依据。</p>;
  return <ul className="space-y-3">{refs.map((ref) => <li key={ref.sourceId} className="flex gap-2 text-sm text-muted"><FileText className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" /><div className="min-w-0"><p className="font-medium text-ink">{ref.title || '未命名来源'}</p>{ref.url && (/^https?:\/\//.test(ref.url) ? <a className="mt-1 block break-all text-accent hover:underline" href={ref.url} target="_blank" rel="noreferrer">{ref.url}</a> : <p className="mt-1 break-all">{ref.url}</p>)}{ref.excerpt && <SafeText className="mt-1">{ref.excerpt}</SafeText>}</div></li>)}</ul>;
}
