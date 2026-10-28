import { test as base, expect } from '@playwright/test';
import { createAudit } from './audit.mjs';
import { withIsolatedWorker } from './isolated-worker.mjs';
import { runPreflight } from './preflight.mjs';

export const test = base.extend({
  isolatedWorker: [async ({}, use, workerInfo) => {
    await withIsolatedWorker(workerInfo, process.env, runPreflight, use);
  }, { scope: 'worker', auto: true, timeout: 90_000 }],
  audit: [async ({ context, isolatedWorker }, use, testInfo) => {
    const audit = createAudit(context, isolatedWorker);
    await audit.install();
    try { await use(audit); }
    finally { await audit.finish(testInfo); }
  }, { auto: true }],
});
export { expect };
