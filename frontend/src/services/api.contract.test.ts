// @vitest-environment node
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { api, sourceRefInputs } from './api';
import { dateInTimeZone } from '../utils/text';

type TestApp = {
  origin: string;
  listen(port: number): Promise<unknown>;
  close(): Promise<void>;
};

let app: TestApp;
let nativeFetch: typeof fetch;
let externalAttempts = 0;
const originalPath = { Path: process.env.Path, PATH: process.env.PATH };

beforeAll(async () => {
  if (process.platform === 'win32') {
    const systemTools = `${process.env.SystemRoot}/System32`;
    process.env.Path = systemTools; process.env.PATH = systemTools;
  }
  const require = createRequire(import.meta.url);
  const { createApp } = require('../../../server/app.mjs') as { createApp(options: Record<string, unknown>): TestApp };
  const { scratch } = require('../../../tests/backend/helpers.mjs') as { scratch(): string };
  const root = scratch();
  app = createApp({
    root,
    dataDir: join(root, 'data'),
    frontendDir: join(root, 'dist'),
    scheduler: false,
    transport: { fetch: async () => { externalAttempts++; throw new Error('测试禁止外部传输'); } },
    rpcFactory: () => ({
      start: async () => { externalAttempts++; throw new Error('测试禁止 Codex RPC'); },
      request: async () => { externalAttempts++; throw new Error('测试禁止 Codex RPC'); },
      close: async () => undefined,
    }),
  });
  await app.listen(0);
  nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    return nativeFetch(path.startsWith('/api/') ? `${app.origin}${path}` : path, init);
  }));
}, 30000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  for (const key of ['Path', 'PATH'] as const) {
    const value = originalPath[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

it('以前端 API 方法完成真实后端核心合约，测试传输不补 operationId 或修订', async () => {
  const initialProfile = await api.profile();
  const savedProfile = await api.saveProfile({
    goals: ['验证真实前后端合约'], careerDirection: '本地工具工程', skills: ['契约测试'],
    dailyBudgetMinutes: 20, timeZone: 'Asia/Shanghai',
  }, initialProfile.revision);
  expect(savedProfile.revision).toBeGreaterThan(initialProfile.revision);

  const project = await api.createProject({ title: '合约项目', goal: '验证真实项目与检查点', status: 'active' });
  const checkpoint = await api.createCheckpoint(project.id, { progress: '已创建项目', nextAction: '验证知识流程', openQuestion: '' });
  expect(checkpoint.projectId).toBe(project.id);

  const draft = await api.createKnowledge({
    projectId: project.id, question: '客户端是否发送真实结构化来源？', answer: '是，已有来源保留 sourceId，手工摘录使用 manual 对象。',
    sourceRefs: [{ kind: 'manual', title: '合约讨论', url: null, excerpt: '来源必须是对象。' }],
  });
  expect(draft.sourceRefs[0]).toMatchObject({ kind: 'manual', title: '合约讨论' });
  expect(draft.sourceRefs[0].sourceId).toBeTruthy();
  const initiallyAccepted = await api.knowledgeDecision(draft.id, 'accept', draft.revision);
  expect(initiallyAccepted.status).toBe('accepted');
  const edited = await api.updateKnowledge(initiallyAccepted.id, {
    question: initiallyAccepted.question, answer: `${initiallyAccepted.answer} 编辑后需要复核。`,
    sourceRefs: sourceRefInputs(initiallyAccepted.sourceRefs, '新增的手工摘录'),
  }, initiallyAccepted.revision);
  expect(edited.status).toBe('needs_recheck');
  expect(edited.sourceRefs).toHaveLength(2);
  const accepted = await api.knowledgeDecision(edited.id, 'accept', edited.revision);
  expect(accepted.status).toBe('accepted');

  const dashboard = await api.dashboard();
  const date = dashboard.date || dateInTimeZone(savedProfile.timeZone);
  const currentPlan = await api.dailyPlan(date);
  const generated = await api.generateDailyPlan(date, savedProfile.revision, currentPlan.revision);
  expect(generated.status).not.toBe('not_generated');
  expect(generated.items.length).toBeGreaterThan(0);
  expect(generated.reviewDueCount).toBeNull();

  const practices = await api.practices();
  const practice = practices.items.find((candidate) => generated.items.some((item) => item.practiceId === candidate.id));
  expect(practice).toBeDefined();
  expect(practice!.rubric[0]).toMatchObject({ label: expect.any(String), description: expect.any(String), expectedEvidence: expect.any(Array) });
  const attempt = await api.attemptPractice(practice!.id, { output: '我通过真实 HTTP 验证了请求体和任务结果。', assistanceLevel: 'none', evidenceRefs: [] });
  const feedback = await api.feedback(attempt.id, practice!.id, 'template');
  expect(feedback.mode).toBe('template');
  expect(feedback.observations.every((item) => item.finding === 'not_assessed')).toBe(true);
  expect(feedback.limitations.join('')).toContain('不判断正确性');

  const output = await api.createOutput({
    projectId: project.id, practiceId: practice!.id, title: '真实合约输出', content: '保存真实内容',
    goal: '验证输出 DTO', status: 'draft', sourceRefs: sourceRefInputs(accepted.sourceRefs), evidenceRefs: [],
  });
  const finalOutput = await api.updateOutput(output.id, { status: 'final' }, output.revision);
  expect(finalOutput.status).toBe('final');

  const initialSettings = await api.settings();
  const settingsInput = {
    model: { enabled: false, provider: 'openai-compatible' as const, endpoint: null, model: null, allowExternalProcessing: false, apiKey: 'isolated-contract-secret' },
    feishu: { enabled: false, appId: null, apiBase: 'https://open.feishu.cn' as const },
    scheduler: { enabled: false, codexSyncEnabled: false, dailyPlanEnabled: false, codexSyncIntervalMinutes: 60, dailyPlanLocalTime: '09:00', catchUpEnabled: false },
  };
  const withSecret = await api.saveSettings(settingsInput, initialSettings.revision);
  expect(withSecret.model.apiKeyConfigured).toBe(true);
  expect(withSecret.model).not.toHaveProperty('apiKey');
  const { apiKey: _apiKey, ...modelWithoutSecret } = settingsInput.model;
  const omittedSecret = await api.saveSettings({ ...settingsInput, model: modelWithoutSecret }, withSecret.revision);
  expect(omittedSecret.model.apiKeyConfigured).toBe(true);
  expect(omittedSecret.feishu.appSecretConfigured).toBe(false);
  expect(omittedSecret.model).not.toHaveProperty('apiKey');
  expect(omittedSecret.feishu).not.toHaveProperty('appSecret');

  const artifact = await api.exportDownload();
  expect(artifact.filename).toMatch(/^second-brain-[A-Za-z0-9]+\.json$/);
  const exported = JSON.parse(artifact.content);
  expect(exported.schemaVersion).toBe('second-brain.export.v1');
  expect(exported.data).not.toHaveProperty('settings');
  expect(exported.data).not.toHaveProperty('connections');
  expect(artifact.content).not.toContain('isolated-contract-secret');
  const blob = new Blob([artifact.content], { type: artifact.mediaType });
  expect(await blob.text()).toBe(artifact.content);
  expect(externalAttempts).toBe(0);
}, 30000);
