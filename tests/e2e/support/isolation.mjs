import { access, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyntheticRpcFactory } from '../scripts/synthetic-rpc-fixture.mjs';

export const E2E_DIR = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const PROJECT_DIR = resolve(E2E_DIR, '../..');
export const ARTIFACTS_DIR = join(E2E_DIR, 'artifacts');
export const DATA_ROOT = join(ARTIFACTS_DIR, 'isolated-data');
export const EMPTY_ROOT = join(ARTIFACTS_DIR, 'isolated-root');
export const WORKER_ARTIFACTS = join(ARTIFACTS_DIR, 'workers');
export const FRONTEND_DIR = resolve(PROJECT_DIR, 'frontend/dist');
export const OWNED_ORIGIN = 'http://127.0.0.1:18998';

export function validateWorkerRequest(env) {
  if (env.SECOND_BRAIN_E2E_PARENT_READY !== 'BOTH-READY') {
    throw new Error('Worker execution is PENDING parent BOTH-READY; SECOND_BRAIN_E2E_PARENT_READY must equal BOTH-READY.');
  }
  if (env.BASE_URL !== OWNED_ORIGIN) throw new Error(`Worker BASE_URL must be exactly ${OWNED_ORIGIN}.`);
  if (env.SECOND_BRAIN_E2E_ISOLATED !== '1') throw new Error('SECOND_BRAIN_E2E_ISOLATED=1 is required.');
  return OWNED_ORIGIN;
}

export function workerPaths(runId) {
  if (typeof runId !== 'string' || !/^worker-[A-Za-z0-9_-]{1,112}$/.test(runId)) {
    throw new Error('Worker run ID must be a single bounded worker- directory name.');
  }
  const dataDir = join(DATA_ROOT, runId);
  return Object.freeze({
    runId, dataDir, root: join(EMPTY_ROOT, runId), evidenceDir: join(WORKER_ARTIFACTS, runId),
    dbPath: join(dataDir, 'second-brain.sqlite'), secretsPath: join(dataDir, 'secrets', 'credentials.json'),
  });
}

export function assertOwnedPaths(paths) {
  const expected = workerPaths(paths?.runId);
  for (const [key, value] of Object.entries(expected)) {
    if (paths[key] !== value) throw new Error(`Worker ${key} must equal its owned artifact path.`);
  }
}

export function validatePhysicalPath(expected, { actual, symbolicLink, kind }, requiredKind = 'directory') {
  if (symbolicLink || kind !== requiredKind || !isAbsolute(actual || '') || relative(resolve(expected), resolve(actual))) {
    throw new Error(`Physical ${requiredKind} must match the owned path without symlinks or junctions: ${expected}`);
  }
  return actual;
}

async function physicalPath(path, requiredKind = 'directory') {
  const stat = await lstat(path);
  return validatePhysicalPath(path, {
    actual: await realpath(path), symbolicLink: stat.isSymbolicLink(),
    kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
  }, requiredKind);
}

async function ensureDirectory(path) {
  try { await mkdir(path); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await physicalPath(path);
}

export function assertFreshStorage(rootEntries, dataEntries) {
  if (!Array.isArray(rootEntries) || !Array.isArray(dataEntries) || rootEntries.length || dataEntries.length) {
    throw new Error('Worker root and dataDir must be fresh and empty; no reused DB or runtime files.');
  }
}

export async function allocateWorkerPaths(workerInfo, env) {
  validateWorkerRequest(env);
  for (const path of [PROJECT_DIR, join(PROJECT_DIR, 'tests'), E2E_DIR, join(PROJECT_DIR, 'frontend'), FRONTEND_DIR]) {
    await physicalPath(path);
  }
  await physicalPath(join(FRONTEND_DIR, 'index.html'), 'file');
  await access(join(FRONTEND_DIR, 'index.html'), constants.R_OK);
  for (const path of [ARTIFACTS_DIR, DATA_ROOT, EMPTY_ROOT, WORKER_ARTIFACTS]) await ensureDirectory(path);
  const project = workerInfo.project.name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
  const paths = workerPaths(`worker-${project}-${workerInfo.workerIndex}-${randomUUID()}`);
  // Non-recursive mkdir refuses collisions; prior worker data is never reused or removed.
  for (const path of [paths.evidenceDir, paths.root, paths.dataDir]) {
    await mkdir(path);
    await physicalPath(path);
  }
  assertFreshStorage(await readdir(paths.root), await readdir(paths.dataDir));
  return paths;
}

export async function rejectProviderFetch() {
  throw new Error('E2E-SB: provider transport is disabled; no upstream request was sent.');
}

export function buildIsolatedOptions(paths, env) {
  const origin = validateWorkerRequest(env);
  assertOwnedPaths(paths);
  return {
    root: paths.root, dataDir: paths.dataDir, dbPath: paths.dbPath, secretsPath: paths.secretsPath,
    frontendDir: FRONTEND_DIR, scheduler: false, origin, port: 18998,
    rpcFactory: createSyntheticRpcFactory({ projectPath: join(paths.root, 'E2E-SB-synthetic-project') }),
    transport: { fetch: rejectProviderFetch },
  };
}

export function validateMainDatabase(rows, expected) {
  const main = Array.isArray(rows) ? rows.filter(row => row?.name === 'main') : [];
  if (main.length !== 1 || typeof main[0].file !== 'string' || !isAbsolute(main[0].file) || relative(resolve(expected), resolve(main[0].file))) {
    throw new Error('PRAGMA database_list main file must equal the fresh worker-owned dbPath.');
  }
  return main[0].file;
}

export async function verifyOwnedDatabase(app, paths) {
  assertOwnedPaths(paths);
  for (const path of [ARTIFACTS_DIR, DATA_ROOT, EMPTY_ROOT, paths.root, paths.dataDir]) await physicalPath(path);
  const rows = app.store.db.prepare('PRAGMA database_list').all();
  const mainFile = validateMainDatabase(rows, paths.dbPath);
  await physicalPath(mainFile, 'file');
  return { pragma: 'PRAGMA database_list', expected: paths.dbPath, mainFile, verified: true };
}
