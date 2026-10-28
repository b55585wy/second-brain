import { test, expect } from '../support/fixtures.mjs';
import { formWith, keyboardActivate, mutation, screenshot, synthetic, waitForJob } from '../support/ui.mjs';

test('REVIEW-01: real unconfigured SiYuan explains failure without inventing a review queue', async ({ page, audit }, testInfo) => {
  audit.expectFailure({ path: '/api/v1/review-sessions', method: 'POST', status: 503, code: 'CONNECTION_UNAVAILABLE' });
  await page.goto('/review');
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/review-sessions' && response.request().method() === 'POST');
  await keyboardActivate(page, page.getByRole('button', { name: '开始复习', exact: true }));
  const response = await waiting;
  expect(response.status(), 'Unconfigured SiYuan must return its real service-unavailable error, not a fabricated empty session.').toBe(503);
  expect((await response.json()).error.code).toBe('CONNECTION_UNAVAILABLE');
  expect(response.request().postDataJSON().operationId).toEqual(expect.any(String));
  await expect(page.getByRole('alert')).toContainText(/尚未配置|未配置.*思源|思源.*未配置|SiYuan.*未配置/);
  await expect(page.getByRole('button', { name: '揭示答案', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '本次复习已完成', exact: true })).toHaveCount(0);
  for (const name of ['忘记了', '很困难', '记得', '很轻松']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await screenshot(page, testInfo, 'real-unconfigured-siyuan-error');
});

test('CODEX-01: boundary injected GET threads 503 keeps real synthetic manual import usable', async ({ page, audit }, testInfo) => {
  testInfo.annotations.push({ type: 'boundary-fault-injection', description: 'Only GET /api/v1/codex/threads returns 503 (up to two mount requests). Scope, projects, manual import and jobs are real. This is not actual Codex integration verification.' });
  await audit.injectFailure(page, {
    path: '/api/v1/codex/threads', method: 'GET', max: 2,
    code: 'E2E_CODEX_LIST_UNAVAILABLE', message: 'E2E-SB: synthetic automatic listing unavailable.',
  });
  await page.goto('/codex');
  await expect(page.getByRole('alert')).toContainText('E2E-SB: synthetic automatic listing unavailable.');
  const form = formWith(page, '对话标题');
  await expect(form).toBeVisible();
  const title = synthetic('manual-transcript');
  await form.getByLabel('对话标题', { exact: true }).fill(title);
  await form.getByLabel('稳定来源 ID', { exact: true }).fill(synthetic('manual-source'));
  await form.getByLabel('第 1 条消息内容', { exact: true }).fill(synthetic('manual-user-question'));
  await keyboardActivate(page, form.getByRole('button', { name: '添加消息', exact: true }));
  await form.getByRole('combobox', { name: '第 2 条消息角色', exact: true }).selectOption('assistant');
  await form.getByLabel('第 2 条消息内容', { exact: true }).fill(synthetic('manual-assistant-unverified-material'));
  await screenshot(page, testInfo, 'synthetic-manual-fallback-during-listing-failure');
  const submitted = await mutation(page, 'POST', '/api/v1/codex/manual-import', () => keyboardActivate(page, form.getByRole('button', { name: '提交手动导入', exact: true })));
  expect(submitted.request.postDataJSON().operationId).toEqual(expect.any(String));
  await waitForJob(page, submitted.data);
  await expect(page.getByText('任务完成', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('status').filter({ hasText: '手动对话导入任务已提交' })).toBeVisible();
  await expect(form.getByLabel('对话标题', { exact: true })).toHaveValue(title);
});
