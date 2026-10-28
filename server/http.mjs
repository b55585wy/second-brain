import { createServer } from 'node:http';
import { existsSync, statSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname, sep } from 'node:path';
import { ApiError, fail, publicError, requireValue } from './errors.mjs';
import { digest, object, operationId } from './validation.mjs';

function plainJson(value, depth = 0) {
  requireValue(depth <= 40, 'JSON 嵌套过深。');
  if (typeof value === 'number') requireValue(Number.isFinite(value), 'JSON 数字必须有限。');
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    requireValue(!['__proto__', 'prototype', 'constructor'].includes(key), 'JSON 含不允许的对象键。');
    plainJson(item, depth + 1);
  }
}

async function jsonBody(request, limit) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) fail(415, 'UNSUPPORTED_MEDIA_TYPE', '写请求必须使用 application/json。');
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') fail(415, 'UNSUPPORTED_MEDIA_TYPE', '不支持压缩请求体。');
  if (Number(request.headers['content-length']) > limit) { request.resume(); fail(413, 'PAYLOAD_TOO_LARGE', '请求体超过大小限制。'); }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) fail(413, 'PAYLOAD_TOO_LARGE', '请求体超过大小限制。');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'INVALID_JSON', '请求体必须是有效 JSON。'); }
  object(body); plainJson(body); return body;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export const response = (data, status = 200, headers = {}) => ({ data, status, headers });

export class Http {
  constructor(store, secrets, { root, frontendDir, port = 18997, origin } = {}) {
    this.store = store; this.secrets = secrets; this.root = root; this.frontendDir = frontendDir;
    this.port = port; this.configuredOrigin = origin; this.origin = origin ?? `http://127.0.0.1:${port}`;
    this.routes = []; this.inflight = new Map();
    this.server = createServer((req, res) => this.handle(req, res));
    this.server.requestTimeout = 30000; this.server.headersTimeout = 10000; this.server.keepAliveTimeout = 5000;
  }

  route(method, path, handler, { query = [], asyncRead = false, status = 200 } = {}) {
    const keys = [];
    const pattern = path.split('/').map(part => {
      if (part.startsWith(':')) { keys.push(part.slice(1)); return '([A-Za-z0-9_-]{1,128})'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    this.routes.push({ method, path, pattern: new RegExp(`^${pattern}$`), keys, handler, query, asyncRead, status });
  }

  async listen(port = this.port) {
    await new Promise((resolveListen, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', resolveListen); });
    this.port = this.server.address().port;
    this.origin = this.configuredOrigin ?? `http://127.0.0.1:${this.port}`;
    return this.server.address();
  }

  guard(request) {
    const expected = new URL(this.origin);
    if (request.headers.host !== expected.host) fail(403, 'ORIGIN_FORBIDDEN', 'Host 不属于本地应用。');
    const origin = request.headers.origin;
    if (origin && origin !== this.origin) fail(403, 'ORIGIN_FORBIDDEN', '请求来源不属于本地应用。');
    if (request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'ORIGIN_FORBIDDEN', '拒绝跨站请求。');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-second-brain-client'] !== 'local-ui') fail(403, 'ORIGIN_FORBIDDEN', '写请求缺少本地应用标记。');
  }

  async handle(request, reply) {
    reply.setHeader('X-Content-Type-Options', 'nosniff');
    reply.setHeader('Cache-Control', 'no-store');
    reply.setHeader('Referrer-Policy', 'no-referrer');
    reply.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      this.guard(request);
      const rawPath = request.url.split('?')[0];
      let decoded;
      try { decoded = decodeURIComponent(rawPath); } catch { fail(400, 'INVALID_QUERY', 'URL 编码无效。'); }
      if (decoded.includes('\\') || decoded.includes(':') || decoded.includes('\0') || decoded.split('/').some(part => part === '..' || part === '.') || /%(?:2e|2f|5c|00)/i.test(decoded)) fail(403, 'ORIGIN_FORBIDDEN', '拒绝路径穿越。');
      const url = new URL(request.url, this.origin);
      const route = this.routes.find(item => item.method === request.method && item.pattern.test(decoded));
      if (!route) {
        if (!decoded.startsWith('/api') && ['GET', 'HEAD'].includes(request.method)) return await this.static(decoded, request, reply);
        fail(404, 'NOT_FOUND', '接口不存在。');
      }
      for (const [key] of url.searchParams) {
        if (!route.query.includes(key) || url.searchParams.getAll(key).length !== 1) fail(400, 'INVALID_QUERY', '查询参数无效或未声明。');
      }
      const match = decoded.match(route.pattern);
      const params = Object.fromEntries(route.keys.map((key, index) => [key, match[index + 1]]));
      const write = !['GET', 'HEAD'].includes(request.method);
      const body = write ? await jsonBody(request, decoded === '/api/v1/imports' ? 10 * 1024 * 1024 : 1024 * 1024) : {};
      const invoke = () => route.handler({ params, query: url.searchParams, body });
      const result = write ? await this.mutate(request.method, decoded, body, route, invoke) : await invoke();
      const packet = result?.status && Object.hasOwn(result, 'data') ? result : response(result, route.status);
      reply.writeHead(packet.status, { 'Content-Type': 'application/json; charset=utf-8', ...packet.headers });
      reply.end(JSON.stringify({ data: this.secrets.clean(packet.data) }));
    } catch (error) {
      const failure = publicError(error);
      if (!reply.headersSent) reply.writeHead(failure.status, { 'Content-Type': 'application/json; charset=utf-8' });
      reply.end(JSON.stringify(this.secrets.clean(failure.body)));
    }
  }

  async mutate(method, path, body, route, invoke) {
    const opId = operationId(body.operationId);
    const fingerprint = digest(JSON.stringify(stable({ method, path, body })));
    const previous = this.store.operation('http', opId);
    if (previous?.fingerprint !== undefined && previous.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'operationId 已用于不同请求。');
    if (previous?.state === 'confirmed') return previous.result;
    if (this.inflight.has(opId)) return this.inflight.get(opId);
    if (!route.asyncRead) return this.store.transaction(() => {
      const result = invoke();
      if (result && typeof result.then === 'function') throw new Error('Async mutation requires a safe-read descriptor.');
      const packet = result?.status && Object.hasOwn(result, 'data') ? result : response(result, route.status);
      this.store.saveOperation('http', opId, { fingerprint, state: 'confirmed', result: packet });
      return packet;
    });
    this.store.saveOperation('http', opId, { fingerprint, state: 'inflight' });
    const work = (async () => {
      try {
        const result = await invoke();
        const packet = result?.status && Object.hasOwn(result, 'data') ? result : response(result, route.status);
        this.store.saveOperation('http', opId, { fingerprint, state: 'confirmed', result: packet });
        return packet;
      } catch (error) { this.store.removeOperation('http', opId); throw error; }
      finally { this.inflight.delete(opId); }
    })();
    this.inflight.set(opId, work);
    return work;
  }

  async static(path, request, reply) {
    if (!this.frontendDir || !existsSync(this.frontendDir)) fail(404, 'NOT_FOUND', '前端尚未构建；API 已可用。');
    const base = realpathSync(this.frontendDir);
    let file = resolve(base, `.${path === '/' ? '/index.html' : path}`);
    const safe = target => { const part = relative(base, target); return !part || !part.startsWith('..' + sep) && part !== '..' && !isAbsolute(part); };
    if (!safe(file)) fail(403, 'ORIGIN_FORBIDDEN', '拒绝路径穿越。');
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (extname(path)) fail(404, 'NOT_FOUND', '文件不存在。');
      file = resolve(base, 'index.html');
    }
    if (!existsSync(file) || !safe(realpathSync(file))) fail(404, 'NOT_FOUND', '前端文件不可用。');
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' }[extname(file)] ?? 'application/octet-stream';
    const content = await readFile(file);
    reply.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length });
    reply.end(request.method === 'HEAD' ? undefined : content);
  }

  async close() {
    if (this.server.listening) await new Promise(resolveClose => { this.server.close(resolveClose); this.server.closeIdleConnections(); });
    await Promise.allSettled([...this.inflight.values()]);
  }
}
