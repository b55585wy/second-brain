export function lines(value: string): string[] {
  return value.split('\n').map((item) => item.trim()).filter(Boolean);
}

export function joinLines(value?: string[]): string {
  return value?.join('\n') ?? '';
}

export function formatDate(value?: string): string {
  if (!value) return '时间未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

export function dateInTimeZone(timeZone: string, instant = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return dateInTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone, instant);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

export const projectStatusLabels = { active: '进行中', maintenance: '维护中', paused: '已暂停', archived: '已归档' } as const;
export const knowledgeStatusLabels = { draft: '待确认', accepted: '已接受', rejected: '已拒绝', needs_recheck: '待复核', archived: '已归档' } as const;
