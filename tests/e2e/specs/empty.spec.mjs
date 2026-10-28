import { test, expect } from '../support/fixtures.mjs';
import { formWith, keyboardActivate, screenshot } from '../support/ui.mjs';
import { SYNTHETIC_THREAD_TITLE } from '../scripts/synthetic-rpc-fixture.mjs';

test('EMPTY-01 / NAV-01: fresh manual workspace and keyboard navigation', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: '跳到主要内容', exact: true });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await expect(page.getByRole('heading', { name: '今天，从这里继续', level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '先设置学习目标', exact: true })).toBeVisible();
  const goalCta = page.getByRole('link', { name: '设置学习目标', exact: true });
  await expect(goalCta).toHaveCount(1);
  await expect(goalCta).toHaveAttribute('href', '/settings');
  await expect(page.getByRole('button', { name: /^(生成今日计划|重新安排今天)$/ })).toHaveCount(0);
  await screenshot(page, testInfo, 'empty-today-desktop');
  await keyboardActivate(page, goalCta);
  await expect(page).toHaveURL(/\/settings$/);
  await expect(formWith(page, '当前目标（每行一条）').getByLabel('当前目标（每行一条）', { exact: true })).toHaveValue('');

  const navigation = page.getByRole('navigation', { name: '主导航', exact: true });
  const routes = [
    { name: '项目', url: '/projects', heading: '从第一个项目开始' },
    { name: '知识', url: '/knowledge', heading: '知识库还是空的' },
    { name: '练习与输出', url: '/practice', heading: '选择一项练习' },
    { name: '设置', url: '/settings', heading: '设置' },
    { name: '复习', url: '/review', heading: '准备一次短复习' },
  ];
  for (const route of routes) {
    await keyboardActivate(page, navigation.getByRole('link', { name: route.name, exact: true }));
    await expect(page).toHaveURL(new RegExp(`${route.url}$`));
    await expect(page.getByRole('heading', { name: route.heading, exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    if (route.url === '/settings') {
      await expect(formWith(page, '当前目标（每行一条）').getByLabel('当前目标（每行一条）', { exact: true })).toHaveValue('');
      await expect(page.getByLabel('职业方向（可选）', { exact: true })).toHaveValue('');
      await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
    }
  }
  const listed = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/v1/codex/threads');
  await page.goto('/codex');
  const response = await listed;
  expect(response.status(), 'Disabled scope must expose an empty catalog without leaking thread titles.').toBe(200);
  expect((await response.json()).data).toEqual({ items: [], total: 0 });
  await expect(page.getByText(SYNTHETIC_THREAD_TITLE, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '没有可自动采集的对话', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '启用自动采集', exact: true })).not.toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await screenshot(page, testInfo, 'disabled-scope-empty-codex-catalog');
});
