import { mkdtempSync, mkdirSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, sep, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app.mjs';

const BACKEND = dirname(fileURLToPath(import.meta.url));
assert.equal(relative(BACKEND, realpathSync(BACKEND)), '', 'Test source directory must not redirect elsewhere.');
export const SCRATCH = resolve(BACKEND, '.scratch');

function ensureScratch() {
  try { mkdirSync(SCRATCH); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = lstatSync(SCRATCH);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Test scratch must be a physical directory.');
  assert.equal(relative(SCRATCH, realpathSync(SCRATCH)), '', 'Test scratch must not redirect elsewhere.');
}

function insideScratch(path, allowBase = false) {
  const part = relative(SCRATCH, path);
  return !part ? allowBase : part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}

function isolatedPath(value, label, kind) {
  assert.ok(typeof value === 'string' && value.trim() && isAbsolute(value), 'Test ' + label + ' must be a nonempty absolute path.');
  const actual = resolve(value);
  assert.ok(insideScratch(actual), 'Test ' + label + ' must stay strictly inside test scratch.');
  ensureScratch();
  for (let ancestor = actual; ; ancestor = dirname(ancestor)) {
    try {
      const info = lstatSync(ancestor);
      assert.ok(!info.isSymbolicLink(), 'Test ' + label + ' must not use a symlink or junction ancestor.');
      assert.ok(insideScratch(realpathSync(ancestor), true), 'Test ' + label + ' physical path escapes test scratch.');
      if (!relative(actual, ancestor) && kind) assert.ok(kind === 'directory' ? info.isDirectory() : info.isFile(), 'Test ' + label + ' has an invalid file type.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!relative(SCRATCH, ancestor)) return actual;
  }
}

ensureScratch();
export const operation = () => randomUUID();

export function scratch() { ensureScratch(); return mkdtempSync(resolve(SCRATCH, 'case-')); }
export function removeScratch(path, remove = rmSync) {
  const actual = isolatedPath(path, 'cleanup root', 'directory');
  remove(actual, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 });
}

export async function appFor(t, options = {}, factory = createApp) {
  assert.ok(options && typeof options === 'object' && !Array.isArray(options), 'Test options must be an object.');
  const root = isolatedPath(options.root === undefined ? scratch() : options.root, 'root', 'directory');
  const dataDir = isolatedPath(options.dataDir === undefined ? resolve(root, 'data') : options.dataDir, 'dataDir', 'directory');
  const dbPath = isolatedPath(options.dbPath === undefined ? resolve(dataDir, 'second-brain.sqlite') : options.dbPath, 'dbPath', 'file');
  const secretsPath = isolatedPath(options.secretsPath === undefined ? resolve(dataDir, 'secrets/credentials.json') : options.secretsPath, 'secretsPath', 'file');
  const app = factory({ scheduler: false, ...options, dataDir, dbPath, secretsPath, root });
  await app.listen(0);
  t.after(async () => { await app.close(); if (!options.keep) removeScratch(root); });
  return app;
}

export async function request(app, method, path, body, options = {}) {
  const headers = { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Second-Brain-Client': 'local-ui' }), ...options.headers };
  const payload = body === undefined ? undefined : options.noOperation ? body : { operationId: operation(), ...body };
  const result = await fetch(app.origin + (path.startsWith('/api/') ? path : '/api/v1' + path), {
    method, headers, ...(payload === undefined ? {} : { body: options.raw ?? JSON.stringify(payload) }),
  });
  const json = await result.json();
  return { status: result.status, headers: result.headers, ...json };
}

export async function ok(app, method, path, body, expected = 200) {
  const result = await request(app, method, path, body);
  assert.equal(result.status, expected, JSON.stringify(result.error));
  assert.ok(Object.hasOwn(result, 'data'));
  assert.equal(result.error, undefined);
  return result.data;
}

export async function jobDone(app, ack, expected = 'succeeded') {
  const end = Date.now() + 8000;
  for (;;) {
    const job = await ok(app, 'GET', '/jobs/' + ack.jobId);
    if (['succeeded', 'failed', 'uncertain', 'blocked', 'cancelled'].includes(job.status)) {
      assert.equal(job.status, expected, JSON.stringify(job));
      return job;
    }
    if (Date.now() > end) assert.fail('Job did not finish in eight seconds.');
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
}

export async function profile(app, values = {}) {
  const current = await ok(app, 'GET', '/learning-profile');
  const { revision, createdAt, updatedAt, ...fields } = current;
  return ok(app, 'PUT', '/learning-profile', { ...fields, ...values, expectedRevision: revision });
}

export async function knowledge(app, values = {}, accept = false) {
  let record = await ok(app, 'POST', '/knowledge', { projectId: null, question: '怎样确认提交状态？', answer: '读取能关联该操作的证据。', sourceRefs: [], ...values }, 201);
  if (accept) record = await ok(app, 'POST', `/knowledge/${record.id}/decision`, { expectedRevision: record.revision, decision: 'accept' });
  return record;
}

export async function output(app, values = {}) {
  return ok(app, 'POST', '/outputs', { projectId: null, practiceId: null, title: '我的产物', content: '', goal: '', status: 'draft', sourceRefs: [], evidenceRefs: [], ...values }, 201);
}

export async function settings(app, change = {}) {
  const current = await ok(app, 'GET', '/settings');
  const { apiKeyConfigured, ...model } = current.model;
  const { appSecretConfigured, ...feishu } = current.feishu;
  return ok(app, 'PUT', '/settings', { expectedRevision: current.revision, model: { ...model, ...change.model }, feishu: { ...feishu, ...change.feishu }, scheduler: { ...current.scheduler, ...change.scheduler } });
}

export async function scope(app, values = {}) {
  const current = await ok(app, 'GET', '/connections/codex/scope');
  const { revision, createdAt, updatedAt, ...fields } = current;
  return ok(app, 'PUT', '/connections/codex/scope', { ...fields, ...values, expectedRevision: revision });
}

export async function fakeServer(t, handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url, method: req.method, headers: req.headers, body });
    try {
      const result = await handler(req, body, calls);
      if (res.destroyed) return;
      res.writeHead(result?.status ?? 200, { 'Content-Type': 'application/json', ...result?.headers });
      res.end(JSON.stringify(result?.json ?? result));
    } catch {
      if (!res.destroyed) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"code":-1}'); }
    }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); }));
  return { origin: `http://127.0.0.1:${server.address().port}`, calls, server };
}

export async function fakeSiyuan(t, options = {}) {
  let sequence = 0;
  const namespace = options.namespace ?? '';
  assert.match(namespace, /^[a-z0-9]{0,3}$/);
  const nextId = () => `20261027090000-${namespace}${(++sequence).toString(36).padStart(7 - namespace.length, '0')}`;
  const state = { version: '3.8.8', notebooks: [], decks: [], docs: [], attrs: {}, cards: [], grades: [], sourceText: '真实来源：记录身份，再检查提交证据。', originalId: '20261027080000-source1', ...options };
  const upstream = await fakeServer(t, async (req, body) => {
    if (state.gates?.[req.url]) await state.gates[req.url]();
    if (state.codes?.[req.url] !== undefined) return { code: state.codes[req.url], msg: 'upstream rejected', data: null };
    let data = null;
    switch (req.url) {
      case '/api/system/version': data = state.version; break;
      case '/api/notebook/lsNotebooks': data = { notebooks: state.notebooks }; break;
      case '/api/notebook/createNotebook': { const notebook = { id: nextId(), name: body.name, closed: false }; if (state.notebookDelay) await new Promise(resolveWait => setTimeout(resolveWait, state.notebookDelay)); state.notebooks.push(notebook); data = { notebook }; break; }
      case '/api/riff/getRiffDecks': data = state.decks; break;
      case '/api/riff/createRiffDeck': { data = { id: nextId(), name: body.name }; state.decks.push(data); break; }
      case '/api/filetree/createDocWithMd': { const doc = { id: nextId(), notebook: body.notebook, path: body.path, markdown: body.markdown, children: [{ id: nextId(), type: 'code' }] }; state.docs.push(doc); data = doc.id; break; }
      case '/api/block/getChildBlocks': data = state.docs.find(doc => doc.id === body.id)?.children ?? []; break;
      case '/api/attr/setBlockAttrs': state.attrs[body.id] = { ...state.attrs[body.id], ...body.attrs }; break;
      case '/api/attr/getBlockAttrs': data = state.attrs[body.id] ?? {}; break;
      case '/api/block/getBlockKramdown': data = { id: body.id, kramdown: body.id === state.originalId ? state.sourceText : state.docs.find(doc => doc.id === body.id)?.markdown ?? '' }; break;
      case '/api/block/updateBlock': { const doc = state.docs.find(item => item.children.some(child => child.id === body.id)); if (!doc) return { code: -1, data: null }; doc.markdown = body.data; data = []; break; }
      case '/api/query/sql': {
        const box = /box='((?:''|[^'])*)'/.exec(body.stmt)?.[1]?.replaceAll("''", "'");
        const path = /hpath='((?:''|[^'])*)'/.exec(body.stmt)?.[1]?.replaceAll("''", "'");
        data = state.docs.filter(doc => doc.notebook === box && doc.path === path).map(doc => ({ id: doc.id })); break;
      }
      case '/api/sqlite/flushTransaction': break;
      case '/api/riff/addRiffCards':
        for (const blockID of body.blockIDs) if (!state.cards.some(card => card.blockID === blockID && card.deckID === body.deckID)) state.cards.push({ deckID: body.deckID, cardID: nextId(), blockID, lapses: 0, reps: 0, state: 0, lastReview: 0, nextDues: { 1: '1 min', 2: '2 min', 3: '3 min', 4: '4 min' } });
        data = state.decks.find(deck => deck.id === body.deckID); break;
      case '/api/riff/getRiffDueCards': { const cards = state.cards.filter(card => card.deckID === body.deckID && !card.hidden); data = { cards, unreviewedCount: cards.length, unreviewedNewCardCount: cards.filter(card => !card.reps).length, unreviewedOldCardCount: cards.filter(card => card.reps).length }; break; }
      case '/api/riff/reviewRiffCard': {
        assert.ok([1, 2, 3, 4].includes(body.rating)); assert.ok(Array.isArray(body.reviewedCards));
        const card = state.cards.find(item => item.cardID === body.cardID && item.deckID === body.deckID);
        assert.ok(card); card.reps++; card.lastReview = Date.now(); state.grades.push(body);
        if (state.gradeGate) await state.gradeGate;
        if (state.gradeDelay) await new Promise(resolveWait => setTimeout(resolveWait, state.gradeDelay));
        break;
      }
      default: return { status: 404, json: { code: -1, data: null } };
    }
    return { code: 0, msg: '', data };
  });
  return { ...upstream, state };
}

export async function configureSiyuan(app, upstream, token = 'test-siyuan-token') {
  const connections = await ok(app, 'GET', '/connections');
  const current = connections.items.find(item => item.kind === 'siyuan');
  return ok(app, 'PUT', '/connections/siyuan', { expectedRevision: current.revision, useRuntimeConnection: false, baseUrl: upstream.origin, notebookTitle: '第二大脑', token });
}

export async function syncedKnowledge(app, upstream, values = {}) {
  await configureSiyuan(app, upstream);
  const record = await knowledge(app, values, true);
  await jobDone(app, await ok(app, 'POST', `/knowledge/${record.id}/sync`, { expectedRevision: record.revision }, 202));
  return ok(app, 'GET', `/knowledge/${record.id}`);
}
