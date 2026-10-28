import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const [root, mode] = process.argv.slice(2);
const systemRoot = process.env.SystemRoot;
const originalSpawn = childProcess.spawnSync;
const observed = [];
let injectFailure = false;
let aclWrites = 0; let aclVerifications = 0;
const trustedTools = new Map([
  ['whoami.exe', resolve(systemRoot, 'System32/whoami.exe')],
  ['icacls.exe', resolve(systemRoot, 'System32/icacls.exe')],
  ['powershell.exe', resolve(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')],
]);
childProcess.spawnSync = (command, args, options) => {
  const name = basename(command).toLowerCase();
  observed.push({ name, trusted: command === trustedTools.get(name),
    shell: options.shell, hidden: options.windowsHide });
  if (injectFailure && name === 'powershell.exe') aclWrites++;
  if (injectFailure && name === 'icacls.exe' && args.includes('/verify')) aclVerifications++;
  const ownerFailure = mode === 'owner-error' && name === 'whoami.exe';
  const aclFailure = name === 'powershell.exe' && (mode === 'acl-error' || mode === 'acl-error-temp' && aclWrites === 2);
  const verifyFailure = name === 'icacls.exe' && args.includes('/verify') && (mode === 'verify-error' || mode === 'verify-error-temp' && aclVerifications === 2);
  if (injectFailure && (ownerFailure || aclFailure || verifyFailure)) return { status: 1, stdout: '', stderr: '' };
  return originalSpawn(command, args, options);
};
syncBuiltinESMExports();
const { createApp } = await import('../../../server/app.mjs');
const { Secrets } = await import('../../../server/secrets.mjs');
const app = createApp({ root, scheduler: false });
let summary;
try {
  await app.listen(0);
  app.secrets.set('model.apiKey', 'synthetic-original-credential');
  const filename = resolve(root, 'data/secrets/credentials.json');
  const before = readFileSync(filename, 'utf8');
  injectFailure = true;
  if (mode === 'missing-tool') process.env.SystemRoot = resolve(root, 'missing-windows');
  const current = app.settings.public();
  const raw = app.settings.raw();
  const candidate = 'synthetic-candidate-credential';
  const response = await fetch(app.origin + '/api/v1/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Second-Brain-Client': 'local-ui' },
    body: JSON.stringify({ operationId: randomUUID(), expectedRevision: current.revision, model: { ...raw.model, apiKey: candidate }, feishu: raw.feishu, scheduler: raw.scheduler }) });
  const body = await response.json();
  const shouldFail = ['missing-tool', 'owner-error', 'acl-error', 'verify-error', 'acl-error-temp', 'verify-error-temp'].includes(mode);
  const exported = app.backup.export({ scope: 'all', projectIds: [] }).artifact.content;
  summary = { status: response.status, shouldFail, memoryRetained: app.secrets.get('model.apiKey') === (shouldFail ? 'synthetic-original-credential' : candidate),
    diskRetained: shouldFail ? readFileSync(filename, 'utf8') === before : new Secrets(filename).get('model.apiKey') === candidate,
    noEcho: !JSON.stringify(body).includes(candidate) && !exported.includes(candidate) && !JSON.stringify(body).includes(filename),
    onlyTrustedTools: observed.every(item => item.trusted && item.shell === false && item.hidden === true),
    realSeedCalls: observed.filter(item => item.name.toLowerCase() === 'icacls.exe').length >= 2,
    realAclWrites: observed.filter(item => item.name === 'powershell.exe').length >= 2,
    temporaryRemoved: readdirSync(dirname(filename)).every(name => !name.endsWith('.tmp')),
    poisonMarkerAbsent: !existsSync(resolve(root, 'poison-invoked')), toolCalls: observed.length };
} finally {
  process.env.SystemRoot = systemRoot;
  await app.close();
}
process.stdout.write(JSON.stringify(summary));
