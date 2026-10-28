import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApiError } from '../../server/errors.mjs';
import { appFor, scratch, ok, scope, jobDone } from './helpers.mjs';

for (const display of ['title', 'name', 'preview']) {
  for (const failure of ['UPSTREAM_ERROR', 'UPSTREAM_TIMEOUT']) {
    test(`frozen ${display} is secret-free before ${failure}, and authorized queue resume survives reopen`, async t => {
      const root = scratch(); const project = resolve(root, 'project-token=authorization-input'); mkdirSync(project);
      const sentinel = 'sk-frozenQueueSyntheticCredential123456789'; const methods = []; let broken = true;
      const rpcFactory = () => ({ verifiedStateDbOnly: true, async start() {}, async close() {}, async request(method, params) {
        methods.push(method);
        if (method === 'thread/list') return { data: [{ id: 'authorized-thread', [display]: `api_key=${sentinel} ${'x'.repeat(250)}`, cwd: project, updatedAt: Date.now(), unused: sentinel }], nextCursor: null };
        assert.equal(params.threadId, 'authorized-thread');
        if (broken) throw new ApiError(502, failure, 'synthetic history failure', failure === 'UPSTREAM_TIMEOUT');
        return { data: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'synthetic question' }] },
          { type: 'agentMessage', id: 'a', text: 'synthetic answer' }], nextCursor: null };
      } });
      const app = await appFor(t, { root, keep: true, rpcFactory });
      await scope(app, { enabled: true, allowedThreadIds: [], allowedProjectPaths: [project] });
      const failed = await jobDone(app, await ok(app, 'POST', '/codex/sync', { maxThreads: 1, maxMessages: 1 }, 202), 'failed');
      assert.equal(methods.filter(method => method === 'thread/items/list').length, failure === 'UPSTREAM_TIMEOUT' ? 2 : 1);
      const pending = app.store.all('collector-cursor')[0].pendingThreads[0];
      assert.equal(pending.cwd, project); assert.equal(pending.id, 'authorized-thread'); assert.match(pending.title, /REDACTED/);
      assert.deepEqual(Object.keys(pending).sort(), ['archived', 'cwd', 'id', 'title', 'updatedAt']);
      const assertClean = async current => {
        const records = current.store.db.prepare('SELECT body FROM records').all();
        const operations = current.store.db.prepare('SELECT body FROM operations').all();
        const response = await ok(current, 'GET', '/codex/threads');
        const artifact = await ok(current, 'POST', '/exports', { scope: 'all', projectIds: [], includeSourceContent: true });
        assert.ok(!JSON.stringify([records, operations, failed, response, artifact, methods]).includes(sentinel));
        const data = resolve(root, 'data');
        for (const name of readdirSync(data).filter(name => name.startsWith('second-brain.sqlite'))) assert.ok(!readFileSync(resolve(data, name)).includes(Buffer.from(sentinel)));
      };
      await assertClean(app); await app.close(); broken = false;
      const next = await appFor(t, { root, rpcFactory }); const before = methods.length;
      const first = await jobDone(next, await ok(next, 'POST', '/codex/sync', { maxThreads: 1, maxMessages: 1 }, 202));
      assert.equal(methods[before], 'thread/items/list'); assert.equal(first.result.sourcesCreated, 1); assert.equal(first.result.hasMore, true);
      const second = await jobDone(next, await ok(next, 'POST', '/codex/sync', { maxThreads: 1, maxMessages: 1 }, 202));
      assert.equal(second.result.sourcesCreated, 1); assert.equal(second.result.candidatesCreated, 1);
      assert.equal(next.store.all('source').length, 2); assert.equal(next.store.all('knowledge').length, 1);
      await assertClean(next);
    });
  }
}
