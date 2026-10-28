import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWorkerRequest } from './support/isolation.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const listing = process.argv.includes('--list');
const baseURL = listing ? undefined : validateWorkerRequest(process.env);
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export default defineConfig({
  testDir: join(root, 'specs'),
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  globalTimeout: 240_000,
  expect: { timeout: 10_000 },
  outputDir: join(root, 'artifacts/test-results'),
  reporter: listing ? [['list']] : [
    ['list'],
    ['html', { outputFolder: join(root, 'artifacts/report'), open: 'never' }],
    ['json', { outputFile: join(root, 'artifacts/results.json') }],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    headless: process.env.SECOND_BRAIN_E2E_HEADED !== '1',
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    serviceWorkers: 'block',
    acceptDownloads: true,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: existsSync(edge) ? edge : chrome,
      downloadsPath: join(root, 'artifacts/downloads'),
    },
  },
  projects: [
    { name: 'empty-desktop', testMatch: '**/empty.spec.mjs' },
    {
      name: 'desktop',
      testIgnore: ['**/empty.spec.mjs', '**/layout.mobile.spec.mjs'],
    },
    {
      name: 'mobile',
      testMatch: '**/layout.mobile.spec.mjs',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
