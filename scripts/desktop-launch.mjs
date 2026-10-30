import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { APP_URL, PROJECT_ROOT, checkRuntime, checkFiles, openBrowser, runApp } from './launch.mjs';
import { riffCompatible } from '../server/siyuan-version.mjs';

export const NATIVE_PORT = 19006;
export const NATIVE_URL = 'http://127.0.0.1:' + NATIVE_PORT;
export const STARTUP_PORT = 18998;
const execute = promisify(execFile);
const pause = ms => new Promise(done => setTimeout(done, ms));
const manualWarning = 'Manual records and template practice remain available; SiYuan sync/review is unavailable.';
const unverifiedWarning = 'SiYuan is running on an unverified version. Core learning and Feishu remain available; SiYuan sync/review are unavailable until compatibility is verified.';

function validVersion(version) {
  if (typeof version !== 'string' || version.length > 64) return false;
  const match = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return false;
  const prerelease = match[1]?.split('.') ?? []; const build = match[2]?.split('.') ?? [];
  return [...prerelease, ...build].every(Boolean) && prerelease.every(part => !/^0\d+$/.test(part));
}

function nativeState(packet) {
  const data = packet?.data;
  const version = typeof data === 'string' ? data : data?.version;
  if (packet?.code !== 0 || !validVersion(version)) return 'wrong';
  return riffCompatible(version) ? 'ready' : 'unverified';
}

function nativeCompatible(state, warn) {
  if (state === 'ready') return true;
  warn(unverifiedWarning); return false;
}

export async function probeService(kind, fetcher = globalThis.fetch) {
  const url = kind === 'product' ? APP_URL + '/api/health' : NATIVE_URL + '/api/system/version';
  const request = kind === 'product' ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
  try {
    const response = await fetcher(url, { ...request, redirect: 'error', signal: AbortSignal.timeout(1500) });
    if (!response.ok) return 'wrong';
    const packet = await response.json();
    const data = packet?.data;
    if (kind === 'native') return nativeState(packet);
    const ready = data?.status === 'ok' && data.apiVersion === 'v1' && data.stage === 'ready' && data.dependencies?.database === 'ok';
    return ready ? 'ready' : 'wrong';
  } catch (error) { return error.cause?.code === 'ECONNREFUSED' ? 'closed' : 'wrong'; }
}

// Binding is atomic, and the OS releases this startup-only lock even after an interrupted launch.
export async function acquireStartupLock(port = STARTUP_PORT, create = createServer) {
  const lock = create();
  try {
    await new Promise((done, reject) => { lock.once('error', reject); lock.listen(port, '127.0.0.1', done); });
  } catch (error) { if (error.code === 'EADDRINUSE') return null; throw error; }
  return () => new Promise((done, reject) => lock.close(error => error ? reject(error) : done()));
}

export async function inspectNativeProcesses() {
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = '@(Get-CimInstance Win32_Process -Filter "Name=\'SiYuan.exe\' OR Name=\'SiYuan-Kernel.exe\'" | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress';
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
  const records = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(records) ? records : [records];
}

function argument(commandLine, name) {
  const args = (commandLine || '').match(/(?:[^\s"]+|"[^"]*")+/g)?.map(value => value.replaceAll('"', '')) || [];
  const position = args.indexOf('--' + name);
  if (position >= 0) return args[position + 1] || null;
  return args.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3) || null;
}

export function workspaceOwners(records, workspace) {
  return records.filter(record => {
    const path = argument(record.CommandLine, 'workspace');
    return path && resolve(path).toLowerCase() === resolve(workspace).toLowerCase();
  }).map(record => ({ pid: record.ProcessId, port: Number(argument(record.CommandLine, 'port')) }));
}

function exists(path, kind) {
  try { const info = statSync(path); return kind === 'file' ? info.isFile() : info.isDirectory(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function startNative(executable, workspace, start = spawn) {
  return new Promise((done, reject) => {
    const child = start(executable, ['--workspace=' + workspace, '--port=' + NATIVE_PORT], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); done(); });
  });
}

export async function ensureNative({ root = PROJECT_ROOT, localAppData = process.env.LOCALAPPDATA || '', probe = () => probeService('native'), inspect = inspectNativeProcesses,
  available = exists, start = startNative, warn = console.error, sleep = pause, now = Date.now, timeoutMs = 30000, pollMs = 250 } = {}) {
  const workspace = resolve(root, 'runtime/zhixing1c2af369');
  const executable = join(localAppData, 'Programs', 'SiYuan', 'SiYuan.exe');
  const state = await probe();
  if (state === 'wrong') throw new Error('Port 19006 is occupied by an unexpected or incompatible service. No program was stopped.');
  let records;
  try { records = await inspect(); }
  catch (error) { warn('Cannot verify the SiYuan workspace (' + error.message + '). ' + manualWarning); return false; }
  const owners = workspaceOwners(records, workspace);
  const expectedOwner = owners.some(owner => owner.port === NATIVE_PORT);
  if (['ready', 'unverified'].includes(state)) {
    if (!expectedOwner) throw new Error('Port 19006 does not belong to the dedicated SiYuan workspace. No program was stopped.');
    return nativeCompatible(state, warn);
  }
  if (owners.length && !expectedOwner) {
    warn('The dedicated SiYuan workspace is already open on another port. Close that window normally before retrying. ' + manualWarning);
    return false;
  }
  if (!owners.length) {
    if (!localAppData || !available(executable, 'file') || !available(workspace, 'directory')) {
      warn('The installed SiYuan application or dedicated workspace is missing. Nothing was installed or created. ' + manualWarning);
      return false;
    }
    try { await start(executable, workspace); }
    catch (error) { warn('SiYuan could not start (' + error.message + '). ' + manualWarning); return false; }
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollMs);
    const next = await probe();
    if (['ready', 'unverified'].includes(next)) return nativeCompatible(next, warn);
    if (next === 'wrong') throw new Error('Port 19006 did not return the expected SiYuan service. No program was stopped.');
  }
  warn('SiYuan did not become ready in time. Do not start another copy. ' + manualWarning);
  return false;
}

async function createProduct() {
  const { createApp } = await import('../server/main.mjs');
  return createApp({ root: PROJECT_ROOT, port: 18997 });
}

export async function launchDesktop({ acquire = acquireStartupLock, product = () => probeService('product'), native = ensureNative, create = createProduct,
  run = runApp, open = openBrowser, warn = console.error, sleep = pause, now = Date.now, timeoutMs = 45000, pollMs = 250 } = {}) {
  const deadline = now() + timeoutMs;
  let release;
  while (!(release = await acquire())) {
    if (now() >= deadline) throw new Error('Another launch is still starting, or startup port 18998 is occupied. No duplicate was started.');
    await sleep(pollMs);
  }
  try {
    if (await product() === 'wrong') throw new Error('Port 18997 is occupied by another service. No program was stopped.');
    const nativeReady = await native();
    const state = await product();
    if (state === 'wrong') throw new Error('Port 18997 is occupied by another service. No program was stopped.');
    if (state === 'closed') return { reused: false, nativeReady, controller: await run(await create()) };
    try { await open(); }
    catch (error) { warn('Could not open the browser (' + error.message + '). Open ' + APP_URL + ' manually.'); }
    return { reused: true, nativeReady };
  } finally { await release(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && args[0] !== '--check') throw new Error('Usage: start-all.cmd [--check]');
  checkRuntime(); checkFiles();
  process.chdir(PROJECT_ROOT);
  if (args[0] === '--check') { console.log('Desktop startup prerequisites OK. No programs were started.'); return; }
  await launchDesktop();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
