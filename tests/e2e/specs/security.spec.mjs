import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/fixtures.mjs';
import { apiData, createKnowledge, createOutput, formWith, keyboardActivate, knowledgeCard, mutation, noHorizontalOverflow, openOutputs, screenshot, section, synthetic } from '../support/ui.mjs';
import { assertNoPublicSecret, safeDownloadURL, validateTarget } from '../support/safety.mjs';

test('TEXT-01 / VIEW-01: HTML-like knowledge/output stay inert at 1440×1000', async ({ page }, testInfo) => {
  await page.addInitScript(() => { window.__SECOND_BRAIN_E2E_XSS__ = false; });
  const token = synthetic('literal-html');
  const payload = `${token}\n<script>window.__SECOND_BRAIN_E2E_XSS__=true</script>\n<img src="https://e2e.invalid/${token}.png" onerror="window.__SECOND_BRAIN_E2E_XSS__=true">`;
  const item = await createKnowledge(page, { question: token, answer: payload });
  await expect(knowledgeCard(page, token)).toContainText(payload);
  await page.reload();
  await expect(knowledgeCard(page, token)).toContainText(payload);
  expect(await page.evaluate(() => window.__SECOND_BRAIN_E2E_XSS__)).toBe(false);
  await expect(page.locator('img[src^="https://e2e.invalid/"]')).toHaveCount(0);
  expect(await page.locator('script').evaluateAll(elements => elements.some(element => element.textContent.includes('__SECOND_BRAIN_E2E_XSS__=true')))).toBe(false);
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, 'synthetic-inert-html-knowledge-desktop');
  const output = await createOutput(page, { title: `${token} <script>literal</script>`, content: payload });
  await openOutputs(page);
  await keyboardActivate(page, section(page, '已保存成果').getByRole('button', { name: output.title, exact: true }));
  await expect(formWith(page, '标题').getByLabel('内容', { exact: true })).toHaveValue(payload);
  expect(await page.evaluate(() => window.__SECOND_BRAIN_E2E_XSS__)).toBe(false);
  await expect(page.locator('img[src^="https://e2e.invalid/"]')).toHaveCount(0);
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, 'synthetic-inert-output-desktop');
  expect(item.id).toBeTruthy();
});

test('SECRET-01 / SECRET-02 / EXPORT-01: empty credential roundtrip and JSON export redaction', async ({ page }, testInfo) => {
  const origin = validateTarget(process.env);
  const sentinel = `E2E-SB-FAKE-SECRET-${synthetic('unique-sentinel')}`;
  await page.goto('/settings');
  const form = formWith(page, 'API Key');
  const key = form.getByLabel('API Key', { exact: true });
  await expect(key).toHaveAttribute('type', 'password');
  await expect(key).toHaveValue('');
  await expect(form.getByRole('checkbox', { name: '启用模型处理', exact: true })).not.toBeChecked();
  await form.getByLabel('API Base URL', { exact: true }).fill(`${origin}/v1`);
  await form.getByLabel('模型名称', { exact: true }).fill('E2E-SB-disabled-model');
  await key.fill(sentinel);
  const first = await mutation(page, 'PUT', '/api/v1/settings', () => keyboardActivate(page, form.getByRole('button', { name: '保存模型设置', exact: true })));
  expect(first.request.postDataJSON().model.apiKey).toBe(sentinel);
  await expect(key).toHaveValue('');
  expect((await apiData(page, '/api/v1/settings')).model.apiKeyConfigured).toBe(true);
  await page.reload();
  await expect(key).toHaveValue('');
  const second = await mutation(page, 'PUT', '/api/v1/settings', () => keyboardActivate(page, form.getByRole('button', { name: '保存模型设置', exact: true })));
  expect(Object.hasOwn(second.request.postDataJSON().model, 'apiKey'), 'Blank credential must be omitted rather than clearing/replacing the configured secret.').toBe(false);
  await page.reload();
  await expect(key).toHaveValue('');
  expect((await apiData(page, '/api/v1/settings')).model.apiKeyConfigured).toBe(true);
  await screenshot(page, testInfo, 'synthetic-secret-configured-field-empty');

  // Register before the click: the UI creates a blob from the synchronous POST artifact.
  const waiting = page.waitForEvent('download');
  const [exported, download] = await Promise.all([
    mutation(page, 'POST', '/api/v1/exports', () => keyboardActivate(page, page.getByRole('button', { name: '导出数据', exact: true }))),
    waiting,
  ]);
  expect(exported.request.postDataJSON().operationId).toEqual(expect.any(String));
  expect(exported.response.status()).toBe(200);
  const location = exported.response.headers().location;
  expect(location).toEqual(expect.any(String));
  safeDownloadURL(origin, location, { api: true });
  const artifact = exported.data;
  expect(artifact.filename).toEqual(expect.any(String));
  expect(artifact.content).toEqual(expect.any(String));
  expect(artifact.schemaVersion).toBe('second-brain.export.v1');
  const downloadURL = new URL(safeDownloadURL(origin, download.url()));
  expect(downloadURL.protocol).toBe('blob:');
  expect(downloadURL.origin).toBe(origin);
  expect(download.suggestedFilename()).toBe(artifact.filename);
  const file = testInfo.outputPath('synthetic-export.json');
  await download.saveAs(file);
  expect(await download.failure()).toBeNull();
  const bytes = await readFile(file);
  expect(bytes, 'Downloaded bytes must equal the actual POST artifact content.').toEqual(Buffer.from(artifact.content, 'utf8'));
  const text = bytes.toString('utf8');
  expect(text, 'JSON export must never contain the unique fake-secret sentinel.').not.toContain(sentinel);
  const document = JSON.parse(text);
  expect(document.schemaVersion).toBe('second-brain.export.v1');
  expect(JSON.stringify(document), 'JSON export must omit credential fields.').not.toMatch(/"(?:apiKey|token|accessToken|appSecret)":/i);
  assertNoPublicSecret(document);
  await testInfo.attach('synthetic-json-export', { path: file, contentType: 'application/json' });
});
