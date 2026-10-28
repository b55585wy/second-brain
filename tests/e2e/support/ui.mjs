import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { assertNoPublicSecret, safeReadURL, validateTarget } from './safety.mjs';

export const synthetic = label => `E2E-SB-${label}-${randomUUID().slice(0, 8)}`;
export const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function section(page, title) {
  return page.getByRole('main').locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

export function formWith(page, label) {
  return page.getByRole('main').locator('form').filter({ has: page.getByLabel(label, { exact: true }) });
}

export function knowledgeCard(page, question) {
  return page.getByRole('article').filter({ has: page.getByRole('heading', { name: question, exact: true }) });
}

export async function keyboardFocus(page, control) {
  await expect(control).toBeVisible();
  for (let index = 0; index < 100; index += 1) {
    if (await control.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(control, 'Control must be reachable using Tab within one bounded focus traversal.').toBeFocused();
}

export async function keyboardActivate(page, control) {
  await keyboardFocus(page, control);
  await page.keyboard.press('Enter');
}

export async function apiData(page, path) {
  const origin = validateTarget(process.env);
  const response = await page.request.get(safeReadURL(origin, path), { maxRedirects: 0, timeout: 10_000 });
  expect(response.ok(), `Read-only verification ${path}: HTTP ${response.status()}`).toBeTruthy();
  const payload = await response.json();
  expect(payload.error, `Read-only verification ${path} must succeed.`).toBeUndefined();
  expect(Object.hasOwn(payload, 'data'), `${path} must return a data envelope.`).toBeTruthy();
  assertNoPublicSecret(payload.data);
  return payload.data;
}

export async function mutation(page, method, path, action) {
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
  await action();
  const response = await waiting;
  const payload = await response.json().catch(() => null);
  expect(response.request().headers()['x-second-brain-client'], `${method} ${path} must originate from the real UI client.`).toBe('local-ui');
  expect(response.request().postDataJSON().operationId, `${method} ${path} must carry the operationId produced by the UI.`).toEqual(expect.any(String));
  expect(response.ok(), `${method} ${path}: HTTP ${response.status()}, error code ${payload?.error?.code || 'none'}; inspect current UI/backend contract.`).toBeTruthy();
  expect(payload && Object.hasOwn(payload, 'data'), `${method} ${path} must return a data envelope.`).toBeTruthy();
  expect(payload.error, `${method} ${path} must not return an error envelope.`).toBeUndefined();
  assertNoPublicSecret(payload.data);
  return { data: payload.data, request: response.request(), response };
}

export async function screenshot(page, testInfo, label) {
  const path = testInfo.outputPath(`${label}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(label, { path, contentType: 'image/png' });
}

export async function noHorizontalOverflow(page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), { message: 'Viewport must not scroll horizontally.' }).toBeLessThanOrEqual(1);
}

export async function saveProfile(page, { goal = synthetic('learning-goal'), career = synthetic('career-direction'), budget = 15 } = {}) {
  await page.goto('/settings');
  const form = formWith(page, '当前目标（每行一条）');
  await form.getByLabel('当前目标（每行一条）', { exact: true }).fill(goal);
  await form.getByLabel('职业方向（可选）', { exact: true }).fill(career);
  await form.getByLabel('技能（每行一项）', { exact: true }).fill(synthetic('skill'));
  await form.getByLabel('每日预算（分钟）', { exact: true }).fill(String(budget));
  await form.getByLabel('时区', { exact: true }).fill('Asia/Shanghai');
  await mutation(page, 'PUT', '/api/v1/learning-profile', () => keyboardActivate(page, form.getByRole('button', { name: '保存学习档案', exact: true })));
  await expect(page.getByRole('status').filter({ hasText: '学习档案已保存' })).toBeVisible();
  return { goal, career, budget };
}

export async function openProjectForm(page) {
  await page.goto('/projects');
  await keyboardActivate(page, page.getByRole('button', { name: '新建项目', exact: true }));
  return formWith(page, '项目名称');
}

export async function createProject(page, { title = synthetic('project'), goal = synthetic('project-goal') } = {}) {
  const form = await openProjectForm(page);
  await form.getByLabel('项目名称', { exact: true }).fill(title);
  await form.getByLabel('要完成什么', { exact: true }).fill(goal);
  const result = await mutation(page, 'POST', '/api/v1/projects', () => keyboardActivate(page, form.getByRole('button', { name: '创建项目', exact: true })));
  const link = page.getByRole('link', { name: title, exact: true });
  await expect(link).toBeVisible();
  return { title, goal, ...result.data };
}

export async function createKnowledge(page, { question = synthetic('question'), answer = synthetic('answer'), sources = [synthetic('source-A'), synthetic('source-B')], accept = false } = {}) {
  await page.goto('/knowledge');
  await keyboardActivate(page, page.getByRole('button', { name: '手动记录', exact: true }));
  const form = formWith(page, '问题');
  await form.getByLabel('问题', { exact: true }).fill(question);
  await form.getByLabel('答案', { exact: true }).fill(answer);
  await form.getByLabel('手工来源（每行一条 URL 或摘录）', { exact: true }).fill(sources.join('\n'));
  const created = await mutation(page, 'POST', '/api/v1/knowledge', () => keyboardActivate(page, form.getByRole('button', { name: '保存草稿', exact: true })));
  expect(created.data.status, 'Manual knowledge must start as an unaccepted draft.').toBe('draft');
  expect(created.data.sourceRefs).toHaveLength(sources.length);
  for (const [index, ref] of created.data.sourceRefs.entries()) {
    expect(ref).toMatchObject({ sourceId: expect.any(String), kind: 'manual', excerpt: sources[index] });
  }
  const card = knowledgeCard(page, question);
  await expect(card).toBeVisible();
  if (accept) {
    const decision = await mutation(page, 'POST', `/api/v1/knowledge/${created.data.id}/decision`, () => keyboardActivate(page, card.getByRole('button', { name: '接受', exact: true })));
    expect(decision.data.status).toBe('accepted');
    expect(decision.request.postDataJSON().operationId).toEqual(expect.any(String));
    await expect(card.getByRole('button', { name: '同步到思源', exact: true })).toBeVisible();
  }
  return { ...created.data, question, answer, sources };
}

export async function searchKnowledge(page, query) {
  await page.getByRole('textbox', { name: '搜索知识', exact: true }).fill(query);
  const waiting = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/v1/knowledge' && url.searchParams.get('q') === query;
  });
  await keyboardActivate(page, page.getByRole('button', { name: '搜索', exact: true }));
  expect((await waiting).ok()).toBeTruthy();
}

export async function openOutputs(page) {
  await page.goto('/practice');
  await keyboardActivate(page, page.getByRole('button', { name: '我的成果', exact: true }));
  return formWith(page, '标题');
}

export async function createOutput(page, { title = synthetic('output'), content = synthetic('output-content'), goal = synthetic('output-goal') } = {}) {
  const form = await openOutputs(page);
  await form.getByLabel('标题', { exact: true }).fill(title);
  await form.getByLabel('内容', { exact: true }).fill(content);
  await form.getByLabel('目标（可选）', { exact: true }).fill(goal);
  await form.getByLabel('状态', { exact: true }).selectOption('draft');
  const saved = await mutation(page, 'POST', '/api/v1/outputs', () => keyboardActivate(page, form.getByRole('button', { name: '保存成果', exact: true })));
  await expect(section(page, '已保存成果').getByRole('button', { name: title, exact: true })).toBeVisible();
  return { title, content, goal, ...saved.data };
}

export async function waitForJob(page, acknowledgement) {
  const id = acknowledgement.jobId || acknowledgement.id;
  expect(id, 'Real asynchronous response must identify a job; no fabricated completion.').toBeTruthy();
  let job;
  await expect.poll(async () => {
    job = await apiData(page, `/api/v1/jobs/${encodeURIComponent(id)}`);
    if (['failed', 'uncertain', 'cancelled'].includes(job.status)) throw new Error(`Real isolated job ended ${job.status}; inspect job ${id} on this disposable instance.`);
    return job.status;
  }, { timeout: 25_000, intervals: [100, 250, 500, 1000], message: 'Wait for actual isolated backend job completion.' }).toBe('succeeded');
  return job;
}

export async function preparePractice(page) {
  const { goal } = await saveProfile(page, { goal: synthetic('practice-goal') });
  await createKnowledge(page, { question: synthetic('practice-question'), accept: true });
  await page.goto('/');
  const generated = await mutation(page, 'POST', '/api/v1/daily-plan/generate', () => keyboardActivate(page, page.getByRole('button', { name: '重新安排今天', exact: true })));
  await waitForJob(page, generated.data);
  const { items } = await apiData(page, '/api/v1/practices');
  const practice = items.find(item => item.goal === goal || item.prompt?.includes(goal));
  expect(practice, 'PRACTICE prerequisite: template generation must expose its real synthetic practice in GET /practices.').toBeTruthy();
  await page.goto('/practice');
  const name = practice.title || practice.goal;
  expect(name, 'PRACTICE prerequisite: the generated practice needs an accessible title or explicit synthetic goal.').toBeTruthy();
  const select = section(page, '选择练习').getByRole('button', { name: new RegExp(escapePattern(name)) });
  await expect(select, 'PRACTICE UI contract gap: the practice selector must expose its real title/goal as its accessible name.').toHaveCount(1);
  await keyboardActivate(page, select);
  return { practice, select, form: formWith(page, '你的输出'), name };
}
