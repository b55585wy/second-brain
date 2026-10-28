import { permitsSyntheticListing } from './isolated-worker.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const EXCLUDED_PORTS = new Set(['18997', '5173', '4173']);
const CRITICAL_WRITE = /\/(?:decision|sync|manual-import|import|exports|review-sessions)(?:\/|$)|\/review-sessions\/[^/]+\/(?:reveal|responses)$/;

export function validateTarget(env) {
  if (!env.BASE_URL) throw new Error('BASE_URL is required; there is no default E2E server.');
  if (env.SECOND_BRAIN_E2E_ISOLATED !== '1') {
    throw new Error('SECOND_BRAIN_E2E_ISOLATED=1 must acknowledge a fresh isolated disposable instance.');
  }
  let url;
  try { url = new URL(env.BASE_URL); }
  catch { throw new Error('BASE_URL must be an explicit absolute loopback HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('BASE_URL only permits literal 127.0.0.1, localhost or [::1] over HTTP(S).');
  }
  if (!url.port || url.port === '0' || EXCLUDED_PORTS.has(url.port)) {
    throw new Error('BASE_URL requires an explicit isolated port; 18997, 5173 and 4173 are excluded.');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('BASE_URL must be an origin without credentials, path, query or fragment.');
  }
  return url.origin;
}

export function requestViolation({ url, method = 'GET', headers = {}, body }, origin, attestation) {
  let target;
  try { target = new URL(url); }
  catch { return 'Malformed request URL.'; }
  if (target.origin !== origin) return 'Cross-origin request or redirect is forbidden.';
  if (target.username || target.password || EXCLUDED_PORTS.has(target.port)) return 'Unsafe request target.';
  if (/^\/api\/v1\/codex\/sync(?:\/|$)/.test(target.pathname)) return 'Automatic Codex sync is forbidden in this harness.';
  if (/^\/api\/v1\/codex\/threads(?:\/|$)/.test(target.pathname) && (method !== 'GET' || !permitsSyntheticListing(attestation, origin))) {
    return 'Real Codex listing is forbidden without the actual worker-owned instance attestation.';
  }
  if (['GET', 'HEAD'].includes(method)) return null;
  if (headers['x-second-brain-client'] !== 'local-ui') return 'UI write is missing X-Second-Brain-Client: local-ui.';
  if (CRITICAL_WRITE.test(target.pathname) && (typeof body?.operationId !== 'string' || !body.operationId.trim())) {
    return 'Critical UI write is missing operationId.';
  }
  if (target.pathname === '/api/v1/settings') {
    if (body?.model?.enabled !== false || body?.model?.allowExternalProcessing || body?.feishu?.enabled !== false || body?.scheduler?.enabled !== false || body?.scheduler?.codexSyncEnabled !== false || body?.scheduler?.dailyPlanEnabled || body?.scheduler?.catchUpEnabled) {
      return 'Optional providers and automatic jobs must stay disabled.';
    }
    if (body.model.apiKey !== undefined && (typeof body.model.apiKey !== 'string' || !body.model.apiKey.startsWith('E2E-SB-FAKE-SECRET-'))) {
      return 'Only a synthetic E2E fake credential may be written.';
    }
  }
  if (target.pathname === '/api/v1/connections/codex/scope' && body?.enabled !== false) {
    return 'Automatic collector scope must stay disabled.';
  }
  return null;
}

export function validateFaultInjection({ path, method, status, code, max }) {
  const listing = path === '/api/v1/codex/threads' && method === 'GET' && status === 503 && code === 'E2E_CODEX_LIST_UNAVAILABLE' && [1, 2].includes(max);
  const save = path === '/api/v1/projects' && method === 'POST' && status === 500 && code === 'E2E_PROJECT_SAVE_UNAVAILABLE' && max === 1;
  if (!listing && !save) throw new Error('Only the named GET threads 503 and single project save 500 faults are permitted.');
}

export function safeDownloadURL(origin, value, { api = false } = {}) {
  const url = new URL(value, origin);
  if (url.origin !== origin || url.username || url.password || !['http:', 'blob:'].includes(url.protocol)) {
    throw new Error('Export download must have the owned same origin, including blob URLs.');
  }
  if (api && (url.protocol !== 'http:' || !/^\/api\/v1\/exports\/[^/]+$/.test(url.pathname))) {
    throw new Error('API download must be a same-origin /api/v1/exports/:id HTTP URL.');
  }
  return url.href;
}

export function safeReadURL(origin, path) {
  if (!path.startsWith('/api/v1/')) throw new Error('Read helper only accepts an /api/v1/ path.');
  const url = new URL(path, origin).href;
  if (!new URL(url).pathname.startsWith('/api/v1/')) throw new Error('Read helper path must remain inside /api/v1/.');
  const violation = requestViolation({ url }, origin);
  if (violation) throw new Error(violation);
  return url;
}

export function isRedirect(status) {
  return status >= 300 && status < 400 && status !== 304;
}

export function assertNoPublicSecret(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(apiKey|token|accessToken|appSecret)$/i.test(key) && typeof item === 'string' && item) {
      throw new Error('A public API response exposed a credential value; response body intentionally omitted.');
    }
    if (item && typeof item === 'object') assertNoPublicSecret(item);
  }
}
