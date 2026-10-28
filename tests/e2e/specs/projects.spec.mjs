import { test, expect } from '../support/fixtures.mjs';
import { apiData, createProject, formWith, keyboardActivate, mutation, openProjectForm, screenshot, synthetic } from '../support/ui.mjs';

test('PROJECT-01: project and three checkpoint fields survive reload', async ({ page }, testInfo) => {
  const project = await createProject(page);
  await keyboardActivate(page, page.getByRole('link', { name: project.title, exact: true }));
  const checkpoint = { progress: synthetic('progress'), nextAction: synthetic('next-action'), openQuestion: synthetic('open-question') };
  const form = formWith(page, '本次进展');
  await form.getByLabel('本次进展', { exact: true }).fill(checkpoint.progress);
  await form.getByLabel('下一步', { exact: true }).fill(checkpoint.nextAction);
  await form.getByLabel('未决问题（可选）', { exact: true }).fill(checkpoint.openQuestion);
  await mutation(page, 'POST', `/api/v1/projects/${project.id}/checkpoints`, () => keyboardActivate(page, form.getByRole('button', { name: '保存节点', exact: true })));
  await expect(page.getByRole('status').filter({ hasText: '接续节点已保存' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: project.title, exact: true })).toBeVisible();
  const history = page.getByRole('list').filter({ hasText: checkpoint.progress });
  await expect(history).toContainText(checkpoint.progress);
  await expect(history).toContainText(checkpoint.nextAction);
  await expect(history).toContainText(checkpoint.openQuestion);
  await screenshot(page, testInfo, 'synthetic-project-checkpoint');
});

test('PROJECT-02: required empty fields and the 120-character UI name boundary', async ({ page }) => {
  const form = await openProjectForm(page);
  const title = form.getByLabel('项目名称', { exact: true });
  const goal = form.getByLabel('要完成什么', { exact: true });
  await keyboardActivate(page, form.getByRole('button', { name: '创建项目', exact: true }));
  expect(await title.evaluate(input => input.validity.valueMissing)).toBeTruthy();
  await expect(form).toBeVisible();
  const maximum = `E2E-SB-${'边'.repeat(113)}`;
  await title.pressSequentially(`${maximum}超限`);
  await expect(title).toHaveValue(maximum);
  await keyboardActivate(page, form.getByRole('button', { name: '创建项目', exact: true }));
  expect(await goal.evaluate(input => input.validity.valueMissing)).toBeTruthy();
  await expect(title).toHaveValue(maximum);
  await goal.fill(synthetic('boundary-goal'));
  await mutation(page, 'POST', '/api/v1/projects', () => keyboardActivate(page, form.getByRole('button', { name: '创建项目', exact: true })));
  await expect(page.getByRole('link', { name: maximum, exact: true })).toBeVisible();
});

test('SAVE-FAIL-01: boundary injected save 500 preserves input; real retry creates one record', async ({ page, audit }, testInfo) => {
  testInfo.annotations.push({ type: 'boundary-fault-injection', description: 'Exactly one POST /api/v1/projects returns synthetic 500. Retry and reads use the real isolated backend.' });
  const form = await openProjectForm(page);
  const title = synthetic('retry-project');
  const goal = synthetic('retry-goal');
  await form.getByLabel('项目名称', { exact: true }).fill(title);
  await form.getByLabel('要完成什么', { exact: true }).fill(goal);
  const message = 'E2E-SB: simulated isolated project save failure.';
  await audit.injectFailure(page, { path: '/api/v1/projects', method: 'POST', status: 500, code: 'E2E_PROJECT_SAVE_UNAVAILABLE', message });
  const failed = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/projects');
  await keyboardActivate(page, form.getByRole('button', { name: '创建项目', exact: true }));
  expect((await failed).status()).toBe(500);
  await expect(page.getByRole('alert')).toContainText(message);
  await expect(form.getByLabel('项目名称', { exact: true })).toHaveValue(title);
  await expect(form.getByLabel('要完成什么', { exact: true })).toHaveValue(goal);
  expect((await apiData(page, '/api/v1/projects')).items.filter(item => item.title === title)).toHaveLength(0);
  await screenshot(page, testInfo, 'synthetic-failed-save-preserves-input');
  await mutation(page, 'POST', '/api/v1/projects', () => keyboardActivate(page, form.getByRole('button', { name: '创建项目', exact: true })));
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
  expect((await apiData(page, '/api/v1/projects')).items.filter(item => item.title === title)).toHaveLength(1);
});
