import { ApiError, fail } from './errors.mjs';
import { requireValue } from './errors.mjs';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MODEL_HOSTS = new Set(['api.openai.com', 'api.deepseek.com', 'api.moonshot.cn', 'api.moonshot.ai', 'openrouter.ai', 'api.siliconflow.cn']);
export const FEISHU_HOSTS = new Set(['open.feishu.cn', 'open.larksuite.com']);

export function providerUrl(value, provider) {
  let url;
  try { url = new URL(value); } catch { fail(400, 'UNSAFE_PROVIDER_URL', '连接地址无效。'); }
  requireValue(!url.username && !url.password && !url.search && !url.hash, '连接地址不得包含凭据、查询或片段。', 'UNSAFE_PROVIDER_URL');
  const local = LOCAL_HOSTS.has(url.hostname);
  const secure = url.protocol === 'https:' && (!url.port || url.port === '443');
  let allowed = false;
  if (provider === 'siyuan') allowed = local && ['http:', 'https:'].includes(url.protocol) && url.pathname === '/';
  if (provider === 'feishu') allowed = secure && FEISHU_HOSTS.has(url.hostname) && url.pathname === '/';
  if (provider === 'model') allowed = (secure && MODEL_HOSTS.has(url.hostname) || local && url.protocol === 'http:') && /^\/(?:v1\/?|api\/v1\/?)?$/.test(url.pathname);
  requireValue(allowed, '连接地址不在该服务的允许范围内。', 'UNSAFE_PROVIDER_URL');
  return url.href.replace(/\/$/, '');
}

export async function boundedJson(response, maxBytes = 2 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > maxBytes) fail(502, 'UPSTREAM_TOO_LARGE', '上游响应超过大小限制。');
  const reader = response.body?.getReader();
  if (!reader) fail(502, 'UPSTREAM_INVALID_RESPONSE', '上游没有返回 JSON。');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) fail(502, 'UPSTREAM_TOO_LARGE', '上游响应超过大小限制。');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ApiError || error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
    fail(502, 'UPSTREAM_INVALID_RESPONSE', '上游返回了无效 JSON。');
  } finally { reader.releaseLock(); }
}

export class Transport {
  constructor({ fetch = globalThis.fetch, timeoutMs = 8000 } = {}) {
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
  }

  async json(url, { method = 'POST', body, headers = {}, readOnly = false } = {}) {
    const attempts = readOnly ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await this.fetch(url, {
          method, redirect: 'error', headers: { 'Content-Type': 'application/json', ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.status === 401) fail(401, 'UPSTREAM_UNAUTHORIZED', '上游凭据失效或未授权。');
        if (response.status === 403) fail(403, 'UPSTREAM_FORBIDDEN', '上游未授予该文档或操作的权限。');
        if (response.status === 429) fail(429, 'UPSTREAM_RATE_LIMITED', '上游请求频率受限，请稍后重试。', true);
        if (!response.ok) fail(502, 'UPSTREAM_HTTP_ERROR', `上游请求失败（HTTP ${response.status}）。`, response.status >= 500);
        return await boundedJson(response);
      } catch (error) {
        const transient = !(error instanceof ApiError) || error.retryable && error.code !== 'UPSTREAM_RATE_LIMITED';
        if (transient && attempt + 1 < attempts) continue;
        if (error instanceof ApiError) {
          if (!readOnly && !['UPSTREAM_UNAUTHORIZED', 'UPSTREAM_FORBIDDEN', 'UPSTREAM_RATE_LIMITED'].includes(error.code)) error.uncertain = true;
          if (!readOnly) error.retryable = false;
          throw error;
        }
        const timeout = ['TimeoutError', 'AbortError'].includes(error.name);
        const wrapped = new ApiError(timeout && readOnly ? 504 : 502, timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', timeout ? '上游请求超时。' : '无法连接上游服务。', readOnly);
        wrapped.uncertain = !readOnly;
        throw wrapped;
      }
    }
  }
}
