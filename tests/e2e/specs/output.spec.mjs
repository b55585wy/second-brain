import { test, expect } from '../support/fixtures.mjs';
import { apiData, createOutput, formWith, keyboardActivate, mutation, openOutputs, screenshot, section, synthetic } from '../support/ui.mjs';

test('OUTPUT-01: save and edit user output without creating a duplicate, then reload', async ({ page }, testInfo) => {
  const output = await createOutput(page);
  await openOutputs(page);
  await keyboardActivate(page, section(page, '已保存成果').getByRole('button', { name: output.title, exact: true }));
  const form = formWith(page, '标题');
  await expect(form.getByLabel('内容', { exact: true })).toHaveValue(output.content);
  await expect(form.getByLabel('目标（可选）', { exact: true })).toHaveValue(output.goal);
  const editedTitle = synthetic('edited-output');
  const editedContent = `${output.content}\n${synthetic('revised-evidence')}`;
  await form.getByLabel('标题', { exact: true }).fill(editedTitle);
  await form.getByLabel('内容', { exact: true }).fill(editedContent);
  await form.getByLabel('状态', { exact: true }).selectOption('final');
  const changed = await mutation(page, 'PATCH', `/api/v1/outputs/${output.id}`, () => keyboardActivate(page, form.getByRole('button', { name: '保存更改', exact: true })));
  expect(changed.data.id).toBe(output.id);
  await expect(section(page, '已保存成果').getByRole('button', { name: editedTitle, exact: true })).toBeVisible();
  await page.reload();
  await keyboardActivate(page, page.getByRole('button', { name: '我的成果', exact: true }));
  await keyboardActivate(page, section(page, '已保存成果').getByRole('button', { name: editedTitle, exact: true }));
  await expect(form.getByLabel('内容', { exact: true })).toHaveValue(editedContent);
  await expect(form.getByLabel('标题', { exact: true })).toHaveValue(editedTitle);
  await expect(form.getByLabel('目标（可选）', { exact: true })).toHaveValue(output.goal);
  await expect(form.getByLabel('状态', { exact: true })).toHaveValue('final');
  expect((await apiData(page, '/api/v1/outputs')).items.filter(item => [output.title, editedTitle].includes(item.title))).toHaveLength(1);
  await screenshot(page, testInfo, 'synthetic-output-edited-and-reloaded');
});
