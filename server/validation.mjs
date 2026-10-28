import { createHash, randomUUID } from 'node:crypto';
import { requireValue, fail } from './errors.mjs';

export const OWNER_ID = 'local';
export const id = () => randomUUID();
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const now = () => new Date().toISOString();
export const truncate = (value, length) => [...value].slice(0, length).join('');

export function object(value, label = 'body') {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} 必须是对象。`);
  return value;
}

export function text(value, label, max = 10000, allowEmpty = false) {
  requireValue(typeof value === 'string', `${label} 必须是文本。`);
  requireValue((allowEmpty || value.trim().length > 0) && [...value].length <= max, `${label} 长度必须在 ${allowEmpty ? 0 : 1}–${max} 之间。`);
  return value;
}

export function integer(value, label, min, max) {
  requireValue(Number.isInteger(value) && value >= min && value <= max, `${label} 必须为 ${min}–${max} 的整数。`);
  return value;
}

export function choice(value, values, label) {
  requireValue(values.includes(value), `${label} 必须为 ${values.join(', ')}。`);
  return value;
}

export function strings(value, label, maxItems = 50, maxLength = 1000) {
  requireValue(Array.isArray(value) && value.length <= maxItems, `${label} 最多 ${maxItems} 项。`);
  return [...new Set(value.map(item => text(item, label, maxLength)))];
}

export function boolean(value, label) {
  requireValue(typeof value === 'boolean', `${label} 必须为布尔值。`);
  return value;
}

export function timeZone(value) {
  const zone = text(value, 'timeZone', 100);
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); }
  catch { requireValue(false, 'timeZone 必须是有效的 IANA 时区。'); }
  return zone;
}

export function dateInZone(date, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function dateString(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'date 必须为 YYYY-MM-DD。');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  requireValue(!Number.isNaN(+parsed) && parsed.toISOString().slice(0, 10) === value, 'date 无效。');
  return value;
}

export function pagination(query) {
  const limit = query.get('limit') === null ? 20 : Number(query.get('limit'));
  const offset = query.get('offset') === null ? 0 : Number(query.get('offset'));
  return { limit: integer(limit, 'limit', 1, 100), offset: integer(offset, 'offset', 0, 100000) };
}

export function list(items, query) {
  const { limit, offset } = pagination(query);
  return { items: items.slice(offset, offset + limit), total: items.length };
}

export function sourceRefs(value = []) {
  requireValue(Array.isArray(value) && value.length <= 30, 'sourceRefs 最多 30 项。');
  return value.map(ref => {
    if (typeof ref === 'string') return { provider: 'manual', sourceRef: text(ref, 'sourceRef', 2000) };
    object(ref, 'sourceRef');
    const result = {
      provider: choice(ref.provider ?? 'manual', ['manual', 'codex', 'siyuan', 'feishu'], 'provider'),
      sourceRef: text(ref.sourceRef ?? ref.id ?? ref.url, 'sourceRef', 2000),
    };
    for (const key of ['excerpt', 'threadId', 'messageId', 'digest', 'origin']) {
      if (ref[key] !== undefined) result[key] = text(ref[key], key, key === 'excerpt' ? 4000 : 2000, true);
    }
    return result;
  });
}

export function onlyFields(body, allowed) {
  object(body);
  const extra = Object.keys(body).filter(key => !allowed.includes(key));
  requireValue(extra.length === 0, `不支持的字段：${extra.join(', ')}。`);
}

export function operationId(value) {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value), 'operationId 必须为 8–128 个字母、数字、下划线或连字符。');
  return value;
}

export function expectedRevision(value, record) {
  integer(value, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER);
  if (value !== record.revision) fail(409, 'REVISION_CONFLICT', '记录已更新，请重新读取后提交。');
}
