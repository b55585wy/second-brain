import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PROJECT_ROOT, APP_URL, runApp } from './launch.mjs';
import { NATIVE_PORT, NATIVE_URL, probeService, acquireStartupLock, workspaceOwners, startNative, ensureNative, launchDesktop } from './desktop-launch.mjs';

const workspace = resolve(PROJECT_ROOT, 'runtime/zhixing1c2af369');
const owner = (port = NATIVE_PORT, path = workspace) => ({ ProcessId: 123, CommandLine: 'SiYuan.exe "--workspace=' + path + '" --port=' + port });
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('desktop Windows entry stays in one foreground console and uses its own directory', () => {
  const script = readFileSync(resolve(PROJECT_ROOT, 'start-all.cmd'), 'utf8');
  assert.match(script, /cd \/d "%~dp0"/);
  assert.match(script, /node scripts\\desktop-launch\.mjs %\*/);
  assert.doesNotMatch(script, /Start-Process|taskkill|schtasks|start \/b/i);
});

test('health probes require product readiness and compatible native identity', async () => {
  const calls = [];
  assert.equal(await probeService('product', async (...args) => {
    calls.push(args); return jsonResponse({ data: { status: 'ok', apiVersion: 'v1', stage: 'ready', dependencies: { database: 'ok' } } });
  }), 'ready');
  assert.equal(calls[0][0], APP_URL + '/api/health');
  assert.equal(calls[0][1].redirect, 'error');
  for (const data of ['3.8.8', { version: '3.8.8' }]) {
    assert.equal(await probeService('native', async (url, request) => {
      assert.equal(url, NATIVE_URL + '/api/system/version'); assert.equal(request.method, 'POST'); assert.equal(request.body, '{}');
      return jsonResponse({ code: 0, data });
    }), 'ready');
  }
  assert.equal(await probeService('native', async () => jsonResponse({ code: 0, data: '9.0.0' })), 'wrong');
  assert.equal(await probeService('product', async () => jsonResponse({ data: { status: 'ok' } })), 'wrong');
  assert.equal(await probeService('product', async () => new Response('unrelated', { status: 404 })), 'wrong');
  assert.equal(await probeService('native', async () => new Response('{')), 'wrong');
  assert.equal(await probeService('product', async () => { throw new Error('refused', { cause: { code: 'ECONNREFUSED' } }); }), 'closed');
  assert.equal(await probeService('product', async () => { throw new Error('timeout'); }), 'wrong');
});

test('startup lock is exclusive and can be reacquired after release without a stale file', async t => {
  const server = createServer();
  let release = await acquireStartupLock(0, () => server);
  t.after(async () => { if (release) await release(); });
  const port = server.address().port;
  assert.equal(await acquireStartupLock(port), null);
  await release(); release = null;
  release = await acquireStartupLock(port);
  assert.equal(typeof release, 'function');
});

test('native ownership uses the exact quoted workspace and both argument forms', () => {
  const records = [owner(), owner(19007, workspace + '-other'), { ProcessId: 456, CommandLine: 'SiYuan-Kernel.exe --workspace "' + workspace + '" --port 19007' }];
  assert.deepEqual(workspaceOwners(records, workspace), [{ pid: 123, port: 19006 }, { pid: 456, port: 19007 }]);
  assert.deepEqual(workspaceOwners([{ ProcessId: 1, CommandLine: null }], workspace), []);
});

test('native spawn receives only installed executable, existing workspace and fixed port', async () => {
  let call; let unreferenced = false;
  await startNative('installed.exe', workspace, (...args) => {
    call = args; const child = new EventEmitter(); child.unref = () => { unreferenced = true; };
    queueMicrotask(() => child.emit('spawn')); return child;
  });
  assert.deepEqual(call, ['installed.exe', ['--workspace=' + workspace, '--port=19006'], { detached: true, windowsHide: true, stdio: 'ignore' }]);
  assert.equal(unreferenced, true);
  await assert.rejects(startNative('missing.exe', workspace, () => {
    const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('missing'))); return child;
  }), /missing/);
});

function nativeFixture(states = ['closed', 'ready']) {
  const calls = []; const warnings = []; let clock = 0;
  const options = {
    root: PROJECT_ROOT, localAppData: resolve(PROJECT_ROOT, 'fixture-local'),
    probe: async () => { calls.push('probe'); return states.length > 1 ? states.shift() : states[0]; },
    inspect: async () => [], available: () => true,
    start: async (...args) => { calls.push(['start', ...args]); }, warn: message => warnings.push(message),
    sleep: async ms => { clock += ms; }, now: () => clock, timeoutMs: 500, pollMs: 250,
  };
  return { calls, warnings, options };
}

test('cold native startup waits for readiness at the fixed existing workspace', async () => {
  const f = nativeFixture(['closed', 'closed', 'ready']);
  assert.equal(await ensureNative(f.options), true);
  assert.deepEqual(f.calls.filter(Array.isArray), [['start', join(f.options.localAppData, 'Programs', 'SiYuan', 'SiYuan.exe'), workspace]]);
  assert.equal(f.calls.filter(call => call === 'probe').length, 3);
});

test('healthy native is reused and an already starting native is not duplicated', async () => {
  for (const states of [['ready'], ['closed', 'ready']]) {
    const f = nativeFixture(states); f.options.inspect = async () => [owner()];
    assert.equal(await ensureNative(f.options), true);
    assert.equal(f.calls.some(Array.isArray), false);
  }
});

test('missing executable or workspace permits manual/template use without creating anything', async () => {
  for (const missing of ['file', 'directory']) {
    const f = nativeFixture(['closed']); f.options.available = (_path, kind) => kind !== missing;
    assert.equal(await ensureNative(f.options), false);
    assert.equal(f.calls.some(Array.isArray), false); assert.match(f.warnings[0], /Nothing was installed or created.*template practice/);
  }
});

test('workspace open on another port and failed process inspection prevent duplicate native startup', async () => {
  const wrongPort = nativeFixture(['closed']); wrongPort.options.inspect = async () => [owner(19007)];
  assert.equal(await ensureNative(wrongPort.options), false);
  assert.equal(wrongPort.calls.some(Array.isArray), false); assert.match(wrongPort.warnings[0], /already open on another port/);
  const denied = nativeFixture(['closed']); denied.options.inspect = async () => { throw new Error('access denied'); };
  assert.equal(await ensureNative(denied.options), false);
  assert.equal(denied.calls.some(Array.isArray), false); assert.match(denied.warnings[0], /Cannot verify/);
});

test('wrong native service or workspace fails clearly without starting another copy', async () => {
  const wrongService = nativeFixture(['wrong']);
  await assert.rejects(ensureNative(wrongService.options), /Port 19006.*unexpected/);
  assert.equal(wrongService.calls.some(Array.isArray), false);
  const wrongWorkspace = nativeFixture(['ready']); wrongWorkspace.options.inspect = async () => [owner(19006, workspace + '-other')];
  await assert.rejects(ensureNative(wrongWorkspace.options), /does not belong/);
  assert.equal(wrongWorkspace.calls.some(Array.isArray), false);
});

test('native timeout or spawn error warns about limited functionality without duplicate launches', async () => {
  const timeout = nativeFixture(['closed']);
  assert.equal(await ensureNative(timeout.options), false);
  assert.equal(timeout.calls.filter(Array.isArray).length, 1); assert.match(timeout.warnings[0], /did not become ready.*Do not start another copy/);
  const failed = nativeFixture(['closed']); failed.options.start = async () => { throw new Error('spawn denied'); };
  assert.equal(await ensureNative(failed.options), false); assert.match(failed.warnings[0], /could not start.*spawn denied/);
});

function desktopFixture(initial = 'closed') {
  const calls = []; const warnings = []; let state = initial; let locked = false; let clock = 0;
  const options = {
    acquire: async () => {
      if (locked) return null;
      locked = true; calls.push('lock'); return async () => { locked = false; calls.push('unlock'); };
    },
    product: async () => { calls.push('product'); return state; },
    native: async () => { calls.push('native'); return true; },
    create: async () => { calls.push('create'); return {}; },
    run: async () => { calls.push('run'); state = 'ready'; return { stop: async () => {} }; },
    open: async () => { calls.push('open'); }, warn: message => warnings.push(message),
    sleep: async ms => { clock += ms; await new Promise(done => setImmediate(done)); }, now: () => clock,
    timeoutMs: 1000, pollMs: 1,
  };
  return { calls, warnings, options };
}

test('cold desktop starts native before creating one foreground product and always releases startup lock', async () => {
  const f = desktopFixture(); const result = await launchDesktop(f.options);
  assert.equal(result.reused, false); assert.equal(result.nativeReady, true);
  assert.deepEqual(f.calls, ['lock', 'product', 'native', 'product', 'create', 'run', 'unlock']);
});

test('warm desktop starts/reuses native then opens existing product without creating a backend', async () => {
  const f = desktopFixture('ready'); const result = await launchDesktop(f.options);
  assert.equal(result.reused, true);
  assert.deepEqual(f.calls, ['lock', 'product', 'native', 'product', 'open', 'unlock']);
});

test('concurrent desktop clicks start only one native instance and one product', async () => {
  const f = desktopFixture();
  const native = nativeFixture(); let nativeState = 'closed'; let nativeStarts = 0;
  native.options.probe = async () => nativeState;
  native.options.inspect = async () => nativeStarts ? [owner()] : [];
  native.options.start = async () => { nativeStarts++; nativeState = 'ready'; };
  f.options.native = () => ensureNative(native.options);
  const results = await Promise.all([launchDesktop(f.options), launchDesktop(f.options)]);
  assert.deepEqual(results.map(result => result.reused), [false, true]);
  assert.equal(nativeStarts, 1);
  assert.equal(f.calls.filter(call => call === 'create').length, 1);
  assert.equal(f.calls.filter(call => call === 'run').length, 1);
  assert.equal(f.calls.filter(call => call === 'unlock').length, 2);
});

test('native unavailability retains manual/template product and browser failures retain the healthy service', async () => {
  const cold = desktopFixture(); cold.options.native = async () => false;
  assert.equal((await launchDesktop(cold.options)).nativeReady, false);
  assert.equal(cold.calls.filter(call => call === 'run').length, 1);
  const warm = desktopFixture('ready'); warm.options.open = async () => { throw new Error('no browser'); };
  assert.equal((await launchDesktop(warm.options)).reused, true);
  assert.match(warm.warnings[0], /Open http:\/\/127\.0\.0\.1:18997 manually/);
  assert.equal(warm.calls.at(-1), 'unlock');
});

test('foreign product port and startup failures never open a browser and release the owned lock', async () => {
  const foreign = desktopFixture('wrong');
  await assert.rejects(launchDesktop(foreign.options), /Port 18997.*another service/);
  assert.deepEqual(foreign.calls, ['lock', 'product', 'unlock']);
  for (const phase of ['native', 'create', 'run']) {
    const f = desktopFixture(); f.options[phase] = async () => { throw new Error(phase + ' failed'); };
    await assert.rejects(launchDesktop(f.options), new RegExp(phase + ' failed'));
    assert.equal(f.calls.includes('open'), false); assert.equal(f.calls.at(-1), 'unlock');
  }
});

test('startup lock contention times out without starting any product or native process', async () => {
  const f = desktopFixture(); f.options.acquire = async () => null;
  await assert.rejects(launchDesktop(f.options), /startup port 18998.*No duplicate/);
  assert.deepEqual(f.calls, []);
});

test('owned product retains existing Ctrl+C close semantics after releasing startup lock', async () => {
  const f = desktopFixture(); const signals = new EventEmitter(); let closed = 0;
  f.options.create = async () => ({ listen: async () => {}, close: async () => { closed++; } });
  f.options.run = app => runApp(app, { signals, open: async () => {}, log: () => {} });
  const result = await launchDesktop(f.options);
  assert.equal(f.calls.at(-1), 'unlock');
  signals.emit('SIGINT'); await result.controller.stop();
  assert.equal(closed, 1); assert.equal(signals.eventNames().length, 0);
});

test('desktop preflight and invalid arguments start no programs or backend state', () => {
  const entry = resolve(PROJECT_ROOT, 'scripts/desktop-launch.mjs');
  const checked = spawnSync(process.execPath, [entry, '--check'], { cwd: resolve(PROJECT_ROOT, '..'), encoding: 'utf8', windowsHide: true });
  assert.ifError(checked.error); assert.equal(checked.status, 0, checked.stderr); assert.match(checked.stdout, /No programs were started/);
  const invalid = spawnSync(process.execPath, [entry, '--unknown'], { encoding: 'utf8', windowsHide: true });
  assert.ifError(invalid.error); assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Usage: start-all.cmd/);
});
