import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { APP_PORT, APP_URL, PROJECT_ROOT, checkRuntime, checkFiles, openBrowser, runApp } from './launch.mjs';

const read = file => readFileSync(resolve(PROJECT_ROOT, file), 'utf8');

test('root package routes commands to real entry points and suites', () => {
  const pkg = JSON.parse(read('package.json'));
  const frontend = JSON.parse(read('frontend/package.json'));
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=24.22.0');
  assert.equal(pkg.scripts.start, 'node server/main.mjs');
  assert.equal(pkg.scripts.server, pkg.scripts.start);
  assert.equal(pkg.scripts.build, 'npm --prefix frontend run build');
  assert.equal(pkg.scripts.typecheck, 'npm --prefix frontend run typecheck');
  assert.equal(pkg.scripts['test:frontend'], 'npm --prefix frontend run test');
  for (const name of ['build', 'typecheck', 'test']) assert.ok(frontend.scripts[name]);
  assert.equal(pkg.scripts['test:backend'], 'node --test tests/backend/*.test.mjs');
  assert.equal(pkg.scripts.test, 'npm run test:packaging && npm run test:backend && npm run test:frontend');
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /BOOTSTRAP_ONLY/);
});

test('Windows entry stays in the foreground and uses its own directory', () => {
  const script = read('start.cmd');
  assert.match(script, /cd \/d "%~dp0"/);
  assert.match(script, /node scripts\\launch\.mjs %\*/);
  assert.match(script, /exit \/b %launch_exit%/);
  assert.doesNotMatch(script, /Start-Process|taskkill|schtasks|ExecutionPolicy|start \/b/i);
});

test('Node version guard covers minimum, future versions, older and invalid input', () => {
  for (const version of ['24.22.0', '24.22.1', '24.23.0', '25.0.0']) assert.doesNotThrow(() => checkRuntime(version));
  for (const version of ['24.21.99', '23.99.0', '22.22.0', '', 'invalid']) assert.throws(() => checkRuntime(version), /24\.22\.0/);
});

test('file guard uses actual project paths regardless of the caller directory', () => {
  const checked = [];
  checkFiles(PROJECT_ROOT, target => { checked.push(target); return { isFile: () => true }; });
  assert.deepEqual(checked, [resolve(PROJECT_ROOT, 'server/main.mjs'), resolve(PROJECT_ROOT, 'frontend/dist/index.html')]);
  assert.doesNotThrow(() => checkFiles());
});

test('missing backend or frontend and directory impostors fail before startup', () => {
  for (const file of ['server/main.mjs', 'frontend/dist/index.html']) {
    const target = resolve(PROJECT_ROOT, file);
    assert.throws(() => checkFiles(PROJECT_ROOT, path => {
      if (path === target) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      return { isFile: () => true };
    }), /Missing file/);
    assert.throws(() => checkFiles(PROJECT_ROOT, path => ({ isFile: () => path !== target })), /Missing file/);
  }
});

test('filesystem permission failures remain errors', () => {
  const denied = Object.assign(new Error('access denied'), { code: 'EACCES' });
  assert.throws(() => checkFiles(PROJECT_ROOT, () => { throw denied; }), error => error === denied);
});

function fixture(listenError = null) {
  const calls = [];
  const signals = new EventEmitter();
  const warnings = [];
  const app = {
    async listen(port) { calls.push(['listen', port]); if (listenError) throw listenError; },
    async close() { calls.push(['close']); },
  };
  const options = { signals, open: async () => { calls.push(['open']); }, log: () => {}, warn: text => warnings.push(text) };
  return { app, options, calls, signals, warnings };
}

test('browser opens only after this app successfully owns the fixed port', async () => {
  const f = fixture();
  const controller = await runApp(f.app, f.options);
  assert.deepEqual(f.calls, [['listen', APP_PORT], ['open']]);
  await controller.stop();
});

test('foreign port collision closes only this app and never opens a browser', async () => {
  const collision = Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
  const f = fixture(collision);
  await assert.rejects(runApp(f.app, f.options), /already in use.*No existing process was stopped/);
  assert.deepEqual(f.calls, [['listen', APP_PORT], ['close']]);
  assert.equal(f.signals.eventNames().length, 0);
});

test('other listen errors retain the original failure and close owned resources', async () => {
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const f = fixture(denied);
  await assert.rejects(runApp(f.app, f.options), error => error === denied);
  assert.deepEqual(f.calls, [['listen', APP_PORT], ['close']]);
});

test('each supported stop signal closes once despite repeated signals', async () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    const f = fixture();
    const controller = await runApp(f.app, f.options);
    f.signals.emit(signal);
    f.signals.emit(signal);
    await controller.stop();
    assert.equal(f.calls.filter(([name]) => name === 'close').length, 1);
    assert.equal(f.signals.eventNames().length, 0);
  }
});

test('manual stop is idempotent and close errors are not hidden', async () => {
  const f = fixture();
  const failure = new Error('close failed');
  f.app.close = async () => { throw failure; };
  const controller = await runApp(f.app, f.options);
  const first = controller.stop();
  assert.equal(controller.stop(), first);
  await assert.rejects(first, error => error === failure);
  assert.equal(f.signals.eventNames().length, 0);
});

test('browser failure leaves the foreground server available with a manual URL', async () => {
  const f = fixture();
  f.options.open = async () => { throw new Error('no browser'); };
  const controller = await runApp(f.app, f.options);
  assert.deepEqual(f.calls, [['listen', APP_PORT]]);
  assert.match(f.warnings[0], /Open http:\/\/127\.0\.0\.1:18997 manually/);
  await controller.stop();
});

test('browser helper is hidden and receives only the fixed loopback URL', async () => {
  let call;
  await openBrowser((...args) => {
    call = args;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  });
  assert.match(call[0], /System32[\\/]rundll32\.exe$/);
  assert.deepEqual(call[1], ['url.dll,FileProtocolHandler', APP_URL]);
  assert.deepEqual(call[2], { windowsHide: true, stdio: 'ignore' });
});

test('browser process error, nonzero exit and interrupted exit are reported', async () => {
  for (const [event, ...values] of [['error', new Error('spawn failed')], ['exit', 1], ['exit', null, 'SIGTERM']]) {
    await assert.rejects(openBrowser(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit(event, ...values));
      return child;
    }));
  }
});

test('check mode works from another directory without importing the backend', () => {
  const hadData = existsSync(resolve(PROJECT_ROOT, 'data'));
  const result = spawnSync(process.execPath, [resolve(PROJECT_ROOT, 'scripts/launch.mjs'), '--check'], { cwd: resolve(PROJECT_ROOT, '..'), encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No server was started/);
  assert.equal(existsSync(resolve(PROJECT_ROOT, 'data')), hadData);
});

test('unknown arguments fail rather than starting a server', () => {
  const result = spawnSync(process.execPath, [resolve(PROJECT_ROOT, 'scripts/launch.mjs'), '--unknown'], { encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});
