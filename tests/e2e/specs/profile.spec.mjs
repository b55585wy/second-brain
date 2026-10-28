import { test, expect } from '../support/fixtures.mjs';
import { apiData, formWith, keyboardActivate, mutation, saveProfile, screenshot, section, synthetic } from '../support/ui.mjs';

test('PROFILE-01: explicit goal, career direction and 15-minute budget survive reload', async ({ page }, testInfo) => {
  const profile = await saveProfile(page);
  await page.reload();
  const form = formWith(page, '当前目标（每行一条）');
  await expect(form.getByLabel('当前目标（每行一条）', { exact: true })).toHaveValue(profile.goal);
  await expect(form.getByLabel('职业方向（可选）', { exact: true })).toHaveValue(profile.career);
  await expect(form.getByLabel('每日预算（分钟）', { exact: true })).toHaveValue('15');
  await expect(form.getByLabel('时区', { exact: true })).toHaveValue('Asia/Shanghai');
  await screenshot(page, testInfo, 'synthetic-profile-persisted');

  testInfo.annotations.push({ type: 'scenario', description: 'PROFILE-01: local SiYuan settings roundtrip; connection and Riff remain unverified.' });
  const siyuanSection = section(page, '思源笔记');
  const siyuanForm = siyuanSection.locator('form').filter({ has: page.getByLabel('服务地址', { exact: true }) });
  const runtime = siyuanForm.getByRole('checkbox', { name: '使用本地运行时连接清单', exact: true });
  const baseUrl = siyuanForm.getByLabel('服务地址', { exact: true });
  const notebook = siyuanForm.getByLabel('专用笔记本名称', { exact: true });
  const password = siyuanForm.getByLabel('访问令牌', { exact: true });
  const deleteToken = siyuanForm.getByRole('checkbox', { name: '明确删除已保存的手工令牌', exact: true });
  const fakeToken = synthetic('FAKE-SECRET-SIYUAN');
  const manualFields = { useRuntimeConnection: false, baseUrl: 'http://127.0.0.1:6806', notebookTitle: synthetic('siyuan-notebook') };
  const inactive = { configured: false, baseUrl: null, configurationSource: 'none', status: 'not_configured', tokenConfigured: false, version: null, riff: { status: 'unavailable' } };
  const manual = { configured: true, baseUrl: manualFields.baseUrl, notebookTitle: manualFields.notebookTitle, configurationSource: 'manual', status: 'unchecked', tokenConfigured: true, version: null, riff: { status: 'unchecked' } };
  const operationIds = [];

  function expectConnection(connection, expected) {
    expect(connection).toMatchObject({ kind: 'siyuan', ...expected });
    expect(Number.isInteger(connection.revision)).toBeTruthy();
    expect(connection.revision).toBeGreaterThanOrEqual(0);
    expect(connection).not.toHaveProperty('token');
    expect(JSON.stringify(connection)).not.toContain(fakeToken);
  }

  async function readConnection() {
    const connections = await apiData(page, '/api/v1/connections');
    expect(connections).toMatchObject({ items: expect.any(Array), total: expect.any(Number) });
    expect(JSON.stringify(connections)).not.toContain(fakeToken);
    const matches = connections.items.filter(connection => connection.kind === 'siyuan');
    expect(matches).toHaveLength(1);
    return matches[0];
  }

  async function saveConnection(previous, expectedFields, expectedConnection, { unchanged = false } = {}) {
    const saved = await mutation(page, 'PUT', '/api/v1/connections/siyuan', () => keyboardActivate(page, siyuanForm.getByRole('button', { name: '保存思源配置', exact: true })));
    const body = saved.request.postDataJSON();
    expect(body).toEqual({ ...expectedFields, operationId: expect.any(String), expectedRevision: previous.revision });
    expect(body.operationId).toMatch(/\S/);
    expect(operationIds).not.toContain(body.operationId);
    operationIds.push(body.operationId);
    if (!Object.hasOwn(expectedFields, 'token')) expect(body).not.toHaveProperty('token');
    expectConnection(saved.data, expectedConnection);
    if (unchanged) expect(saved.data.revision).toBe(previous.revision);
    else expect(saved.data.revision).toBeGreaterThan(previous.revision);
    await expect(password).toHaveValue('');
    await expect(page.getByRole('main')).not.toContainText(fakeToken);
    return saved.data;
  }

  const requests = [];
  const observeRequest = request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/v1/')) requests.push(`${request.method()} ${path}`);
  };
  page.on('request', observeRequest);
  try {
    const initial = await readConnection();
    expectConnection(initial, inactive);
    const originalNotebookTitle = initial.notebookTitle;
    expect(originalNotebookTitle).toEqual(expect.any(String));
    expect(originalNotebookTitle.trim()).not.toBe('');
    await expect(runtime).toBeChecked();
    await expect(baseUrl).toBeDisabled();
    await expect(baseUrl).toHaveValue('');
    await expect(notebook).toHaveValue(originalNotebookTitle);
    await expect(password).toHaveAttribute('type', 'password');
    await expect(password).toHaveValue('');
    await expect(deleteToken).not.toBeChecked();

    await runtime.uncheck();
    await baseUrl.fill(manualFields.baseUrl);
    await notebook.fill(manualFields.notebookTitle);
    await password.fill(fakeToken);
    await expect(deleteToken).not.toBeChecked();
    const saved = await saveConnection(initial, { ...manualFields, token: fakeToken }, manual);
    await expect(siyuanSection.getByText('已配置 · 未确认连接', { exact: true })).toBeVisible();

    await page.reload();
    await expect(runtime).not.toBeChecked();
    await expect(baseUrl).toBeEnabled();
    await expect(baseUrl).toHaveValue(manualFields.baseUrl);
    await expect(notebook).toHaveValue(manualFields.notebookTitle);
    await expect(password).toHaveValue('');
    await expect(deleteToken).not.toBeChecked();
    await expect(page.getByRole('main')).not.toContainText(fakeToken);
    const afterManualReload = await readConnection();
    expectConnection(afterManualReload, { ...manual, revision: saved.revision });

    const retained = await saveConnection(afterManualReload, manualFields, manual, { unchanged: true });
    await page.reload();
    await expect(runtime).not.toBeChecked();
    await expect(baseUrl).toHaveValue(manualFields.baseUrl);
    await expect(notebook).toHaveValue(manualFields.notebookTitle);
    await expect(password).toHaveValue('');
    await expect(deleteToken).not.toBeChecked();
    const afterRetainReload = await readConnection();
    expectConnection(afterRetainReload, { ...manual, revision: retained.revision });

    await runtime.check();
    await notebook.fill(originalNotebookTitle);
    await expect(password).toHaveValue('');
    await expect(deleteToken).not.toBeChecked();
    const restored = await saveConnection(afterRetainReload, { useRuntimeConnection: true, baseUrl: null, notebookTitle: originalNotebookTitle }, { ...inactive, notebookTitle: originalNotebookTitle });
    await page.reload();
    await expect(runtime).toBeChecked();
    await expect(baseUrl).toBeDisabled();
    await expect(baseUrl).toHaveValue('');
    await expect(notebook).toHaveValue(originalNotebookTitle);
    await expect(password).toHaveValue('');
    await expect(deleteToken).not.toBeChecked();
    await expect(page.getByRole('main')).not.toContainText(fakeToken);
    expectConnection(await readConnection(), { ...inactive, notebookTitle: originalNotebookTitle, revision: restored.revision });
    await expect(siyuanSection.getByText('未配置', { exact: true })).toBeVisible();
    await expect(siyuanForm.getByRole('button', { name: '检查连接', exact: true })).toBeDisabled();
    await expect(siyuanForm.getByRole('button', { name: '查看笔记本', exact: true })).toBeDisabled();
    await expect(form.getByLabel('当前目标（每行一条）', { exact: true })).toHaveValue(profile.goal);
    await expect(form.getByLabel('职业方向（可选）', { exact: true })).toHaveValue(profile.career);
    await expect(form.getByLabel('每日预算（分钟）', { exact: true })).toHaveValue('15');
    await expect(form.getByLabel('时区', { exact: true })).toHaveValue('Asia/Shanghai');

    const allowedRequests = ['GET /api/v1/learning-profile', 'GET /api/v1/connections', 'GET /api/v1/settings', 'PUT /api/v1/connections/siyuan'];
    expect(requests.filter(request => !allowedRequests.includes(request)), 'Only Settings UI reads/saves; no probes, notebook lists, imports, sync or reviews. This is not a server transport-attempt counter.').toEqual([]);
    expect(requests.filter(request => request === 'PUT /api/v1/connections/siyuan')).toHaveLength(3);
  } finally {
    page.off('request', observeRequest);
  }
});

test('PROFILE-02 / PROFILE-03: 0 and 120 persist; invalid 121 and empty timezone preserve saved data', async ({ page }) => {
  const profile = await saveProfile(page, { budget: 0 });
  await page.reload();
  await expect(page.getByLabel('每日预算（分钟）', { exact: true })).toHaveValue('0');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日学习已暂停', exact: true })).toBeVisible();
  await page.goto('/settings');
  const form = formWith(page, '当前目标（每行一条）');
  const budget = form.getByLabel('每日预算（分钟）', { exact: true });
  const save = form.getByRole('button', { name: '保存学习档案', exact: true });
  await budget.fill('120');
  await mutation(page, 'PUT', '/api/v1/learning-profile', () => keyboardActivate(page, save));
  await page.reload();
  await expect(budget).toHaveValue('120');

  const writes = [];
  page.on('request', req => {
    if (req.method() === 'PUT' && new URL(req.url()).pathname === '/api/v1/learning-profile') writes.push(req);
  });
  await budget.fill('121');
  await keyboardActivate(page, save);
  expect(await budget.evaluate(input => input.validity.rangeOverflow)).toBeTruthy();
  await expect(form.getByLabel('当前目标（每行一条）', { exact: true })).toHaveValue(profile.goal);
  await budget.fill('120');
  const zone = form.getByLabel('时区', { exact: true });
  await zone.fill('');
  await keyboardActivate(page, save);
  expect(await zone.evaluate(input => input.validity.valueMissing)).toBeTruthy();
  expect(writes).toHaveLength(0);
  await page.reload();
  await expect(budget).toHaveValue('120');
  await budget.fill('15');
  await mutation(page, 'PUT', '/api/v1/learning-profile', () => keyboardActivate(page, save));
});
