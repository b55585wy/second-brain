import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appFor, ok, removeScratch, scratch, SCRATCH } from './helpers.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const isolated = path => {
  const part = relative(SCRATCH, path);
  return !!part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
};

function fixtureRoot(t) {
  const root = scratch();
  t.after(() => removeScratch(root));
  return root;
}

test('undefined path overrides are resolved inside scratch before the constructor receives them', async t => {
  let captured;
  const app = await appFor(t, { root: undefined, dataDir: undefined, dbPath: undefined, secretsPath: undefined }, options => {
    captured = options;
    for (const key of ['root', 'dataDir', 'dbPath', 'secretsPath']) assert.ok(typeof options[key] === 'string' && isolated(options[key]), key);
    return { async listen(port) { assert.equal(port, 0); }, async close() {} };
  });
  assert.ok(app); assert.equal(captured.scheduler, false);
  assert.equal(captured.dataDir, resolve(captured.root, 'data'));
  assert.equal(captured.dbPath, resolve(captured.dataDir, 'second-brain.sqlite'));
  assert.equal(captured.secretsPath, resolve(captured.dataDir, 'secrets/credentials.json'));
});

test('invalid and production-root paths are rejected before any application constructor call', async t => {
  const root = fixtureRoot(t); let constructed = 0;
  const forbidden = () => { constructed++; throw new Error('Application constructor must never be reached.'); };
  const cases = [
    { root: projectRoot }, { root: SCRATCH }, { root: dirname(SCRATCH) }, { root: '' }, { root: null }, { root: 'relative-root' },
    { root, dataDir: resolve(projectRoot, 'data') }, { root, dbPath: resolve(projectRoot, 'data/second-brain.sqlite') },
    { root, secretsPath: resolve(projectRoot, 'data/secrets/credentials.json') },
    ...['dataDir', 'dbPath', 'secretsPath'].flatMap(key => ['', null, 'relative-path'].map(value => ({ root, [key]: value }))),
    { root, dbPath: resolve(SCRATCH, '../escaped.sqlite') },
  ];
  for (const options of cases) await assert.rejects(appFor(t, options, forbidden), /Test .*(?:scratch|absolute path)/);
  assert.equal(constructed, 0);
});

test('existing physical fixture directories may use explicit isolated data and file locations', async t => {
  const root = fixtureRoot(t); const dataDir = resolve(root, 'custom-data'); mkdirSync(dataDir);
  const dbPath = resolve(dataDir, 'custom.sqlite'); const secretsPath = resolve(root, 'custom-secrets/credentials.json');
  let captured;
  await appFor(t, { root, dataDir, dbPath, secretsPath, keep: true }, options => {
    captured = options; return { async listen() {}, async close() {} };
  });
  assert.deepEqual([captured.root, captured.dataDir, captured.dbPath, captured.secretsPath], [root, dataDir, dbPath, secretsPath]);
});

test('junction or symlink ancestors cannot redirect root, database or credentials outside scratch', async t => {
  const root = scratch(); const link = resolve(root, 'outside-link');
  t.after(() => { if (existsSync(link)) unlinkSync(link); removeScratch(root); });
  symlinkSync(projectRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  let constructed = 0;
  const forbidden = () => { constructed++; throw new Error('Application constructor must never be reached.'); };
  for (const options of [
    { root: link }, { root, dataDir: resolve(link, 'data') },
    { root, dbPath: resolve(link, 'guard-never-open.sqlite') },
    { root, secretsPath: resolve(link, 'guard-never-open-credentials.json') },
  ]) await assert.rejects(appFor(t, options, forbidden), /Test .*(?:symlink|junction|physical path)/);
  assert.equal(constructed, 0);
});

test('recursive cleanup checks physical boundaries before invoking removal', t => {
  const root = scratch(); const link = resolve(root, 'cleanup-link');
  t.after(() => { if (existsSync(link)) unlinkSync(link); removeScratch(root); });
  symlinkSync(projectRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  let removed = 0;
  for (const path of [projectRoot, SCRATCH, dirname(SCRATCH), '', link]) {
    assert.throws(() => removeScratch(path, () => { removed++; }), /Test .*(?:scratch|absolute path|symlink|junction|physical path)/);
  }
  assert.equal(removed, 0);
});

test('valid scratch cleanup removes only its owned fixture directory', () => {
  const root = scratch();
  assert.ok(existsSync(root)); removeScratch(root); assert.equal(existsSync(root), false);
  removeScratch(root);
});

test('intentional fixture restart keeps and reopens the same isolated database', async t => {
  const root = scratch();
  const first = await appFor(t, { root, keep: true });
  const created = await ok(first, 'POST', '/projects', { title: 'Isolated restart fixture', goal: '' }, 201);
  await first.close();
  const second = await appFor(t, { root });
  const saved = await ok(second, 'GET', '/projects/' + created.id);
  assert.equal(saved.title, 'Isolated restart fixture'); assert.equal(second.collector.root, root);
});
