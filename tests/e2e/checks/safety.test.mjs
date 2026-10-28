import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNoPublicSecret, isRedirect, requestViolation, safeDownloadURL, safeReadURL, validateFaultInjection, validateTarget } from '../support/safety.mjs';

const origin = 'http://127.0.0.1:18998';
const env = { BASE_URL: origin, SECOND_BRAIN_E2E_ISOLATED: '1' };

test('SAFE-01: explicit URL and exact isolated acknowledgement are mandatory', () => {
  for (const candidate of [{}, { BASE_URL: origin }, { ...env, BASE_URL: '' }, { ...env, SECOND_BRAIN_E2E_ISOLATED: 'true' }, { ...env, SECOND_BRAIN_E2E_ISOLATED: '0' }]) {
    assert.throws(() => validateTarget(candidate));
  }
});

for (const url of [origin, `${origin}/`, 'http://localhost:18998', 'http://[::1]:18998', 'https://127.0.0.1:19443']) {
  test(`SAFE-02: accept explicitly isolated loopback ${url}`, () => assert.equal(validateTarget({ ...env, BASE_URL: url }), new URL(url).origin));
}

for (const url of [
  'http://127.0.0.1:18997', 'http://localhost:18997', 'http://[::1]:18997',
  'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:0',
  'http://127.0.0.1', 'http://localhost:80', 'https://example.com:18998',
  'http://192.168.1.10:18998', 'http://localhost.e2e.invalid:18998', 'http://localhost.:18998',
  'http://user:password@127.0.0.1:18998', `${origin}/api`, `${origin}?key=synthetic`, `${origin}#fragment`,
  'ftp://127.0.0.1:18998', 'file:///E:/second-brain', 'not a URL',
]) {
  test(`SAFE-02: reject unsafe target ${url}`, () => assert.throws(() => validateTarget({ ...env, BASE_URL: url })));
}

test('SAFE-03: HTTP requests and redirects cannot leave the explicit isolated origin', () => {
  assert.equal(requestViolation({ url: `${origin}/projects` }, origin), null);
  for (const url of ['https://e2e.invalid/image.png', 'http://127.0.0.1:18997/api/v1/projects', 'http://localhost:18998/projects', 'http://user@127.0.0.1:18998/projects', 'ws://127.0.0.1:18998/socket']) {
    assert.match(requestViolation({ url }, origin), /forbidden|Unsafe/);
  }
});

test('SAFE-03: real Codex discovery and automatic sync are prohibited', () => {
  for (const path of ['/api/v1/codex/threads', '/api/v1/codex/threads?page=1', '/api/v1/codex/sync']) {
    assert.match(requestViolation({ url: `${origin}${path}` }, origin), /forbidden/);
  }
});

test('WORKER-06 / SAFE-03: readiness flags do not relax discovery or sync guards', () => {
  const forged = { ...env, SECOND_BRAIN_E2E_PARENT_READY: 'BOTH-READY', origin, verified: true };
  for (const path of ['/api/v1/codex/threads', '/api/v1/codex/threads?cursor=x', '/api/v1/codex/threads/', '/api/v1/codex/sync', '/api/v1/codex/sync/']) {
    for (const method of ['GET', 'HEAD', 'POST']) assert.match(requestViolation({ url: `${origin}${path}`, method }, origin, forged), /forbidden/);
  }
  assert.match(requestViolation({ url: `${origin}/api/v1/connections/codex/scope`, method: 'PUT', headers: { 'x-second-brain-client': 'local-ui' }, body: { enabled: true } }, origin), /disabled/);
});

test('FAULT-01: only the two named failure boundaries can be injected', () => {
  const listing = { path: '/api/v1/codex/threads', method: 'GET', status: 503, code: 'E2E_CODEX_LIST_UNAVAILABLE', max: 2 };
  const save = { path: '/api/v1/projects', method: 'POST', status: 500, code: 'E2E_PROJECT_SAVE_UNAVAILABLE', max: 1 };
  assert.doesNotThrow(() => validateFaultInjection(listing));
  assert.doesNotThrow(() => validateFaultInjection({ ...listing, max: 1 }));
  assert.doesNotThrow(() => validateFaultInjection(save));
  for (const value of [{ ...listing, status: 200 }, { ...listing, max: 3 }, { ...listing, method: 'POST' },
    { ...save, max: 2 }, { ...save, path: '/api/v1/outputs' }, { ...save, code: 'OTHER' }, { ...save, status: 503 }, { ...save, status: 5000 }]) {
    assert.throws(() => validateFaultInjection(value), /Only the named/);
  }
});

test('EXPORT-01: blob embedded origin and HTTP API download origin must both be owned', () => {
  const blob = `blob:${origin}/11111111-1111-4111-8111-111111111111`;
  assert.equal(safeDownloadURL(origin, blob), blob);
  assert.equal(new URL(blob).origin, origin);
  assert.equal(safeDownloadURL(origin, '/api/v1/exports/synthetic', { api: true }), `${origin}/api/v1/exports/synthetic`);
  for (const value of ['blob:null/abc', 'blob:http://127.0.0.1:18997/abc', 'blob:https://e2e.invalid/abc',
    'https://e2e.invalid/export.json', 'http://localhost:18998/api/v1/exports/x', 'http://user@127.0.0.1:18998/export', 'data:application/json,{}']) {
    assert.throws(() => safeDownloadURL(origin, value), /same origin/);
  }
  for (const value of [blob, '/api/v1/jobs/synthetic', '/api/v1/exports', '//e2e.invalid/api/v1/exports/x']) {
    assert.throws(() => safeDownloadURL(origin, value, { api: true }));
  }
});

test('SAFE-03: reject redirect responses before the browser can follow another origin', () => {
  for (const status of [300, 301, 302, 303, 305, 307, 308]) assert.equal(isRedirect(status), true);
  for (const status of [200, 201, 204, 304, 400, 503]) assert.equal(isRedirect(status), false);
});

test('SAFE-03: successful UI writes require the local client header and critical operation ID', () => {
  const base = { url: `${origin}/api/v1/knowledge/synthetic/decision`, method: 'POST' };
  assert.match(requestViolation(base, origin), /local-ui/);
  const headers = { 'x-second-brain-client': 'local-ui' };
  assert.match(requestViolation({ ...base, headers }, origin), /operationId/);
  assert.equal(requestViolation({ ...base, headers, body: { operationId: 'E2E-SB-operation' } }, origin), null);
  for (const path of ['/api/v1/exports', '/api/v1/review-sessions', '/api/v1/codex/manual-import', '/api/v1/sources/import']) {
    assert.match(requestViolation({ ...base, url: `${origin}${path}`, headers, body: {} }, origin), /operationId/);
  }
});

test('SAFE-03: fake credentials are allowed only while optional services and jobs remain disabled', () => {
  const base = { url: `${origin}/api/v1/settings`, method: 'PUT', headers: { 'x-second-brain-client': 'local-ui' } };
  const body = { model: { enabled: false }, feishu: { enabled: false }, scheduler: { enabled: false, codexSyncEnabled: false } };
  assert.equal(requestViolation({ ...base, body }, origin), null);
  assert.equal(requestViolation({ ...base, body: { ...body, model: { enabled: false, apiKey: 'E2E-SB-FAKE-SECRET-synthetic' } } }, origin), null);
  for (const apiKey of ['', 'not-a-test-credential', null, 1]) {
    assert.match(requestViolation({ ...base, body: { ...body, model: { enabled: false, apiKey } } }, origin), /synthetic/);
  }
  assert.match(requestViolation({ ...base, body: { ...body, model: { enabled: true } } }, origin), /disabled/);
  assert.match(requestViolation({ ...base, body: { ...body, scheduler: { ...body.scheduler, dailyPlanEnabled: true } } }, origin), /disabled/);
  assert.match(requestViolation({ ...base, body: { ...body, scheduler: { ...body.scheduler, codexSyncEnabled: true } } }, origin), /disabled/);
});

test('SAFE-03: read-only verifier cannot turn into an external fetch or real collector call', () => {
  assert.equal(safeReadURL(origin, '/api/v1/projects'), `${origin}/api/v1/projects`);
  for (const path of ['https://e2e.invalid/api/v1/projects', '//e2e.invalid/api/v1/projects', '/api/v1/../../settings', '/api/v1/codex/threads']) {
    assert.throws(() => safeReadURL(origin, path));
  }
});

test('SECRET-01 / EXPORT-01: public credential flags are safe; nested credential values are rejected', () => {
  assert.doesNotThrow(() => assertNoPublicSecret({ model: { apiKeyConfigured: true }, token: null }));
  for (const key of ['apiKey', 'token', 'accessToken', 'appSecret']) {
    assert.throws(() => assertNoPublicSecret({ nested: [{ [key]: 'E2E-SB-FAKE-SECRET-offline' }] }), /exposed/);
  }
});
