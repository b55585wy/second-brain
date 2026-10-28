import { request } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNoPublicSecret, safeReadURL } from './safety.mjs';
import { OWNED_ORIGIN } from './isolation.mjs';
import { connectionItems } from './connections.mjs';

function requireState(condition, message) {
  if (!condition) throw new Error(`ISOLATION PREFLIGHT: ${message}`);
}

export async function runPreflight({ origin, evidenceDir }) {
  requireState(origin === OWNED_ORIGIN, 'preflight is restricted to the worker-owned origin.');
  const report = { status: 'pending', origin, checkedAt: new Date().toISOString(), network: 'Read-only isolated API preflight; no Codex listing or sync.' };
  let context;
  async function read(path) {
    const response = await context.get(safeReadURL(origin, path), { maxRedirects: 0 });
    requireState(response.ok(), `${path} returned HTTP ${response.status()} on the owned instance.`);
    const payload = await response.json();
    requireState(payload && Object.hasOwn(payload, 'data') && !payload.error, `${path} lacks the API data envelope.`);
    assertNoPublicSecret(payload.data);
    return payload.data;
  }
  try {
    context = await request.newContext({ baseURL: origin, timeout: 10_000, maxRedirects: 0 });
    const settings = await read('/api/v1/settings');
    requireState(settings.model?.enabled === false && settings.feishu?.enabled === false && settings.scheduler?.enabled === false, 'model, Feishu and scheduler must be explicitly disabled.');
    requireState(!settings.scheduler.codexSyncEnabled && !settings.scheduler.dailyPlanEnabled && !settings.scheduler.catchUpEnabled, 'all automatic jobs must be disabled.');
    requireState(!settings.model.apiKeyConfigured && !settings.feishu.accessTokenConfigured && !settings.feishu.appSecretConfigured, 'fresh instance must contain no pre-existing credentials.');
    const scope = await read('/api/v1/connections/codex/scope');
    requireState(scope.enabled === false, 'collector scope must be disabled.');
    for (const key of ['allowedThreadIds', 'selectedThreadIds', 'allowedProjectPaths']) {
      requireState(scope[key] === undefined || Array.isArray(scope[key]) && scope[key].length === 0, `collector ${key} must be empty.`);
    }
    const connections = await read('/api/v1/connections');
    const entries = connectionItems(connections);
    const siyuan = entries.find(item => (item.provider || item.kind) === 'siyuan');
    requireState(siyuan?.configured === false && siyuan.status === 'not_configured', 'SiYuan must be genuinely unconfigured, including runtime discovery.');
    const profile = await read('/api/v1/learning-profile');
    requireState(Array.isArray(profile.goals) && profile.goals.length === 0 && !profile.careerDirection && Array.isArray(profile.skills) && profile.skills.length === 0, 'learning profile must be fresh and empty.');
    for (const path of ['/projects', '/knowledge', '/outputs', '/practices']) {
      const result = await read(`/api/v1${path}`);
      requireState(Array.isArray(result.items) && result.items.length === 0 && result.total === 0, `${path} must be empty; use a new disposable DB for every run.`);
    }
    report.status = 'passed';
    report.conditions = ['fresh core lists/profile', 'no pre-existing credential flags', 'no SiYuan runtime', 'optional services and collector disabled'];
  } catch (error) {
    report.status = 'blocked';
    report.reason = error.message;
    throw error;
  } finally {
    try { await context?.dispose(); }
    finally { await writeFile(join(evidenceDir, 'preflight.json'), `${JSON.stringify(report, null, 2)}\n`); }
  }
}
