import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const APP_PORT = 18997;
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;

export function checkRuntime(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) < 24 || Number(match[1]) === 24 && Number(match[2]) < 22) {
    throw new Error('Node.js 24.22.0 or later is required.');
  }
}

export function checkFiles(root = PROJECT_ROOT, inspect = statSync) {
  const files = [
    ['server/main.mjs', 'Restore the backend entry point.'],
    ['frontend/dist/index.html', 'Run npm.cmd run build after preparing frontend dependencies.'],
  ];
  for (const [file, help] of files) {
    const target = resolve(root, file);
    let exists;
    try { exists = inspect(target).isFile(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!exists) throw new Error(`Missing file: ${target}. ${help}`);
  }
}

export function openBrowser(start = spawn) {
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe');
  return new Promise((resolveOpen, reject) => {
    const child = start(executable, ['url.dll,FileProtocolHandler', APP_URL], { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveOpen() : reject(new Error(`Browser opener exited: ${signal ?? code}.`)));
  });
}

export async function runApp(app, { signals = process, open = openBrowser, log = console.log, warn = console.error } = {}) {
  let closing;
  const stop = () => {
    closing ??= Promise.resolve().then(() => app.close()).finally(() => {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) signals.removeListener(signal, onSignal);
    });
    return closing;
  };
  const onSignal = () => {
    void stop().catch(error => { process.exitCode = 1; warn(`Shutdown failed: ${error.message}`); });
  };
  try { await app.listen(APP_PORT); }
  catch (error) {
    await stop();
    if (error.code === 'EADDRINUSE') throw new Error(`Port ${APP_PORT} is already in use. No existing process was stopped.`, { cause: error });
    throw error;
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) signals.on(signal, onSignal);
  log(`Second Brain: ${APP_URL}\nKeep this window open. Press Ctrl+C to stop.`);
  try { await open(); }
  catch (error) { warn(`Could not open the browser (${error.message}). Open ${APP_URL} manually.`); }
  return { stop };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && args[0] !== '--check') throw new Error('Usage: start.cmd [--check]');
  checkRuntime();
  checkFiles();
  process.chdir(PROJECT_ROOT);
  if (args[0] === '--check') {
    console.log(`Startup prerequisites OK: ${PROJECT_ROOT}. No server was started.`);
    return;
  }
  const { createApp } = await import('../server/main.mjs');
  await runApp(createApp({ root: PROJECT_ROOT, port: APP_PORT }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
