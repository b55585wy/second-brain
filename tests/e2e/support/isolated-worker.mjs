import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { allocateWorkerPaths, buildIsolatedOptions, FRONTEND_DIR, OWNED_ORIGIN, validateWorkerRequest, verifyOwnedDatabase } from './isolation.mjs';

const attestations = new WeakMap();

export function permitsSyntheticListing(attestation, origin) {
  const owner = attestations.get(attestation);
  if (!owner || origin !== OWNED_ORIGIN || owner.origin !== origin || !owner.app.server.listening) return false;
  const address = owner.app.server.address();
  return address?.address === '127.0.0.1' && address.port === 18998;
}

export async function useAndClose(app, work, teardown = {}) {
  try { return await work(); }
  finally {
    teardown.attempted = true;
    try { await app.close(); teardown.status = 'closed'; }
    catch (error) { teardown.status = 'failed'; teardown.error = error.message; throw error; }
  }
}

async function runWorker({ app, paths, origin, preflight, use, report, save }) {
  let attestation;
  try {
    report.phase = 'constructed';
    report.database = await verifyOwnedDatabase(app, paths);
    report.phase = 'database-verified';
    await app.listen(18998);
    const address = app.server.address();
    if (!app.server.listening || address?.address !== '127.0.0.1' || address.port !== 18998) {
      throw new Error('Owned app did not bind exactly 127.0.0.1:18998.');
    }
    report.address = address;
    report.phase = 'listening';
    await save();
    await preflight({ origin, evidenceDir: paths.evidenceDir });
    report.preflight = { status: 'passed', evidence: join(paths.evidenceDir, 'preflight.json') };
    // No exported mint function or environment switch can grant this capability.
    attestation = Object.freeze(Object.create(null));
    attestations.set(attestation, { origin, app });
    report.attestation = 'active after owned DB, listen and preflight';
    report.phase = 'ready';
    await save();
    await use(Object.freeze({ origin, attestation, paths }));
    report.status = 'completed';
  } catch (error) {
    report.failurePhase = report.phase;
    report.error = error.message;
    throw error;
  } finally {
    if (attestation) attestations.delete(attestation);
    report.attestation = 'revoked';
    report.phase = 'closing';
  }
}

export async function withIsolatedWorker(workerInfo, env, preflight, use) {
  const origin = validateWorkerRequest(env);
  const paths = await allocateWorkerPaths(workerInfo, env);
  const report = {
    runId: paths.runId, project: workerInfo.project.name, workerIndex: workerInfo.workerIndex,
    origin, ...paths, startedAt: new Date().toISOString(), status: 'setting-up', phase: 'allocated',
    integration: 'Real UI/HTTP/SQLite + fixture upstream; NOT true external integration.',
    frontendDir: FRONTEND_DIR, port: 18998, scheduler: false, rpc: 'controlled synthetic read-only factory; no Codex process',
    providerTransport: 'always throws before egress', teardown: { attempted: false, status: 'not-constructed' },
  };
  const save = () => writeFile(join(paths.evidenceDir, 'isolation.json'), `${JSON.stringify(report, null, 2)}\n`);
  try {
    await save();
    // The actual factory is imported only inside the gated worker lifecycle, never on collection.
    const { createApp } = await import('../../../server/app.mjs');
    const app = createApp(buildIsolatedOptions(paths, env));
    await useAndClose(app, () => runWorker({ app, paths, origin, preflight, use, report, save }), report.teardown);
  } catch (error) {
    report.status = 'failed';
    report.error ??= error.message;
    throw error;
  } finally {
    report.phase = report.teardown.status === 'closed' ? 'closed' : report.phase;
    report.finishedAt = new Date().toISOString();
    await save();
  }
}
