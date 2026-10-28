import test from 'node:test';
import assert from 'node:assert/strict';
import { request as rawRequest } from 'node:http';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { appFor, request, ok, operation, scratch } from './helpers.mjs';

test('health and empty collections work without frontend or optional credentials', async t => {
  const app = await appFor(t);
  const health = await ok(app, 'GET', '/api/health');
  assert.equal(health.status, 'ok');
  assert.equal(health.dependencies.database, 'ok');
  assert.equal(health.apiVersion, 'v1');
  for (const path of ['/projects', '/knowledge', '/outputs', '/practices', '/sources', '/jobs', '/codex/threads']) {
    assert.deepEqual(await ok(app, 'GET', path), { items: [], total: 0 });
  }
  const dashboard = await ok(app, 'GET', '/dashboard');
  assert.equal(dashboard.summary.reviewDue, null);
  assert.equal(dashboard.dailyPlan.status, 'not_generated');
  assert.equal(dashboard.connections.length, 4);
  assert.equal(dashboard.connections[0].notebookTitle, '第二大脑');
});

test('same-origin boundary requires the exact Host, Origin, and client marker', async t => {
  const app = await appFor(t);
  for (const headers of [{ Origin: 'https://evil.example' }, { 'X-Second-Brain-Client': '' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const result = await request(app, 'POST', '/projects', { title: 'test', goal: '' }, { headers });
    assert.equal(result.status, 403); assert.equal(result.error.code, 'ORIGIN_FORBIDDEN');
  }
  const hostStatus = await new Promise(resolveResult => {
    const req = rawRequest(app.origin, { path: '/api/health', headers: { Host: 'evil.example' } }, res => { res.resume(); res.on('end', () => resolveResult(res.statusCode)); }); req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await request(app, 'POST', '/projects', { title: 'test', goal: '' }, { headers: { Origin: app.origin } })).status, 201);
});

test('bad JSON, content type, unknown fields, prototype keys and body limits are rejected', async t => {
  const app = await appFor(t);
  assert.equal((await request(app, 'POST', '/projects', {}, { raw: '{' })).error.code, 'INVALID_JSON');
  assert.equal((await request(app, 'POST', '/projects', {}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request(app, 'POST', '/projects', { title: 'x', goal: '', status: 'active', arbitrary: true })).status, 422);
  const pollution = await request(app, 'POST', '/projects', {}, { raw: `{"operationId":"${operation()}","__proto__":{"polluted":true},"title":"x","goal":""}` });
  assert.equal(pollution.status, 422); assert.equal({}.polluted, undefined);
  const huge = await request(app, 'POST', '/projects', { title: 'x', goal: 'x'.repeat(1024 * 1024) });
  assert.equal(huge.status, 413);
  assert.equal((await request(app, 'POST', '/projects', { title: 'x', goal: '' }, { noOperation: true })).status, 422);
});

test('pagination, unknown queries and raw traversal attempts cannot bypass validation', async t => {
  const app = await appFor(t);
  for (const query of ['?limit=0', '?limit=101', '?offset=-1', '?offset=1.5', '?q=a&q=b', '?sql=SELECT']) {
    assert.ok((await request(app, 'GET', '/projects' + query)).status >= 400);
  }
  const raw = await new Promise(resolveResult => {
    const req = rawRequest(app.origin, { path: '/assets/%2e%2e/server/main.mjs' }, res => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolveResult({ status: res.statusCode, body })); }); req.end();
  });
  assert.equal(raw.status, 403); assert.ok(!raw.body.includes('createApp'));
  assert.equal((await request(app, 'GET', '/not-an-api')).status, 404);
});

test('all writes replay across revisions and reject reused operation IDs with changed requests', async t => {
  const app = await appFor(t);
  const op = operation();
  const body = { operationId: op, title: 'one', goal: '' };
  const first = await ok(app, 'POST', '/projects', body, 201);
  await ok(app, 'PATCH', '/projects/' + first.id, { expectedRevision: first.revision, title: 'two' });
  assert.deepEqual(await ok(app, 'POST', '/projects', body, 201), first);
  const conflict = await request(app, 'POST', '/projects', { ...body, title: 'different' });
  assert.equal(conflict.status, 409); assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await ok(app, 'GET', '/projects')).total, 1);
});

test('built frontend assets and SPA routes serve safely with no directory or symlink escape', async t => {
  const root = scratch(); const frontendDir = resolve(root, 'assets'); mkdirSync(frontendDir);
  writeFileSync(resolve(frontendDir, 'index.html'), '<!doctype html><title>Fixture</title>');
  writeFileSync(resolve(frontendDir, 'app.js'), 'export const fixture = true;');
  const privateDir = resolve(root, 'private'); mkdirSync(privateDir); writeFileSync(resolve(privateDir, 'secret.txt'), 'private-file-sentinel');
  symlinkSync(privateDir, resolve(frontendDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const app = await appFor(t, { root, frontendDir });
  const index = await fetch(app.origin + '/projects/local-route'); assert.equal(index.status, 200); assert.ok((await index.text()).includes('Fixture'));
  const script = await fetch(app.origin + '/app.js'); assert.equal(script.status, 200); assert.ok(script.headers.get('content-type').startsWith('text/javascript'));
  const blocked = await fetch(app.origin + '/escape/secret.txt'); assert.equal(blocked.status, 404); assert.ok(!(await blocked.text()).includes('private-file-sentinel'));
  assert.equal((await fetch(app.origin + '/unknown.js')).status, 404); assert.equal((await ok(app, 'GET', '/api/health')).status, 'ok');
});
