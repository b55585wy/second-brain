import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, isAbsolute, relative } from 'node:path';
import { providerUrl } from './transport.mjs';
import { boolean, integer, onlyFields, text, choice } from './validation.mjs';
import { requireValue, fail } from './errors.mjs';
import { codexCommand } from './codex-rpc.mjs';
import { selectSiyuanInstance } from './siyuan-state.mjs';

const DEFAULTS = {
  model: { enabled: false, provider: 'openai-compatible', endpoint: null, model: null, allowExternalProcessing: false },
  feishu: { enabled: false, appId: null, apiBase: 'https://open.feishu.cn' },
  scheduler: { enabled: false, codexSyncEnabled: false, dailyPlanEnabled: false, codexSyncIntervalMinutes: 60, dailyPlanLocalTime: '09:00', catchUpEnabled: false },
};

function credential(value, name) {
  if (value === null) return null;
  const result = text(value, name, 8192);
  requireValue(!/[\r\n\0]/.test(result), '秘密字段不能包含控制字符。');
  return result;
}

export class Settings {
  constructor(store, secrets, root) {
    this.store = store; this.secrets = secrets; this.root = root;
    this.discoveryError = null;
    if (!store.get('config', 'settings')) store.put('config', DEFAULTS, 'settings');
    if (!store.get('config', 'siyuan')) store.put('config', { useRuntimeConnection: true, baseUrl: null, notebookTitle: '第二大脑', configurationSource: 'none' }, 'siyuan');
    const current = store.get('config', 'siyuan');
    if (current.baseUrl && !store.get('config', 'siyuan-instance')) {
      const instance = selectSiyuanInstance(store, providerUrl(current.baseUrl, 'siyuan'));
      store.put('config', { ...current, connectionEpoch: instance.epoch }, 'siyuan');
    }
    this.discoverRuntime();
  }

  raw() { return this.store.get('config', 'settings'); }

  public() {
    const saved = this.raw();
    return {
      revision: saved.revision, createdAt: saved.createdAt, updatedAt: saved.updatedAt,
      model: { ...saved.model, apiKeyConfigured: !!this.secrets.get('model.apiKey') },
      feishu: { ...saved.feishu, appSecretConfigured: !!this.secrets.get('feishu.appSecret') },
      scheduler: { ...saved.scheduler },
    };
  }

  update(body) {
    onlyFields(body, ['model', 'feishu', 'scheduler']);
    requireValue(body.model && body.feishu && body.scheduler, '三个配置对象均为必填。');
    const model = body.model;
    const feishu = body.feishu;
    const scheduler = body.scheduler;
    onlyFields(model, ['enabled', 'provider', 'endpoint', 'model', 'allowExternalProcessing', 'apiKey']);
    onlyFields(feishu, ['enabled', 'appId', 'apiBase', 'appSecret']);
    onlyFields(scheduler, Object.keys(DEFAULTS.scheduler));
    for (const key of Object.keys(DEFAULTS.model)) requireValue(Object.hasOwn(model, key), '模型配置缺少字段。');
    for (const key of Object.keys(DEFAULTS.feishu)) requireValue(Object.hasOwn(feishu, key), '飞书配置缺少字段。');
    for (const key of Object.keys(DEFAULTS.scheduler)) requireValue(Object.hasOwn(scheduler, key), '调度配置缺少字段。');
    const next = {
      model: {
        enabled: boolean(model.enabled, 'model.enabled'),
        provider: choice(model.provider, ['openai-compatible'], 'model.provider'),
        endpoint: model.endpoint === null ? null : providerUrl(text(model.endpoint, 'endpoint', 2048), 'model'),
        model: model.model === null ? null : text(model.model, 'model', 200),
        allowExternalProcessing: boolean(model.allowExternalProcessing, 'allowExternalProcessing'),
      },
      feishu: {
        enabled: boolean(feishu.enabled, 'feishu.enabled'),
        appId: feishu.appId === null ? null : text(feishu.appId, 'appId', 200),
        apiBase: providerUrl(text(feishu.apiBase, 'apiBase', 200), 'feishu'),
      },
      scheduler: {
        enabled: boolean(scheduler.enabled, 'scheduler.enabled'),
        codexSyncEnabled: boolean(scheduler.codexSyncEnabled, 'codexSyncEnabled'),
        dailyPlanEnabled: boolean(scheduler.dailyPlanEnabled, 'dailyPlanEnabled'),
        codexSyncIntervalMinutes: integer(scheduler.codexSyncIntervalMinutes, 'codexSyncIntervalMinutes', 5, 1440),
        dailyPlanLocalTime: text(scheduler.dailyPlanLocalTime, 'dailyPlanLocalTime', 5),
        catchUpEnabled: boolean(scheduler.catchUpEnabled, 'catchUpEnabled'),
      },
    };
    requireValue(/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(next.scheduler.dailyPlanLocalTime), 'dailyPlanLocalTime 必须为 HH:mm。');
    requireValue(!next.model.enabled || next.model.endpoint && next.model.model, '启用模型时必须填写 endpoint 和 model。');
    const nextSecret = feishu.appSecret === undefined ? this.secrets.get('feishu.appSecret') : credential(feishu.appSecret, 'appSecret');
    requireValue(!next.feishu.enabled || next.feishu.appId && nextSecret, '启用飞书时必须填写 appId 和 appSecret。');
    if (model.apiKey !== undefined) this.secrets.set('model.apiKey', credential(model.apiKey, 'apiKey'));
    if (feishu.appSecret !== undefined) {
      this.secrets.set('feishu.appSecret', nextSecret);
      this.secrets.set('feishu.accessToken', null);
    }
    this.store.put('config', next, 'settings');
    return this.public();
  }

  siyuan() { this.discoverRuntime(); return this.store.get('config', 'siyuan'); }
  siyuanToken(config = this.siyuan()) {
    if (!config.baseUrl) return '';
    return config.useRuntimeConnection ? config.configurationSource === 'runtime' ? this.secrets.get('siyuan.runtimeToken') : '' : this.secrets.get('siyuan.token');
  }

  assertSiyuanEpoch(epoch) {
    const config = this.siyuan();
    if (!epoch || config.connectionEpoch !== epoch) fail(409, 'INVALID_STATE', 'SiYuan 连接已变更，此操作已过期。');
    if (!config.baseUrl) fail(503, 'CONNECTION_UNAVAILABLE', '尚未配置 SiYuan。');
    return config;
  }

  configureSiyuan(body) {
    onlyFields(body, ['useRuntimeConnection', 'baseUrl', 'notebookTitle', 'token']);
    const useRuntimeConnection = boolean(body.useRuntimeConnection, 'useRuntimeConnection');
    const notebookTitle = text(body.notebookTitle, 'notebookTitle', 200);
    requireValue(useRuntimeConnection ? body.baseUrl === null : typeof body.baseUrl === 'string', '运行时连接的 baseUrl 必须为 null，手工连接必须填写 URL。');
    const baseUrl = useRuntimeConnection ? null : providerUrl(text(body.baseUrl, 'baseUrl', 2048), 'siyuan');
    const token = body.token === undefined ? undefined : credential(body.token, 'token');
    const runtime = useRuntimeConnection ? this.readRuntime() : null;
    // Resolve and guard the effective instance before touching either credential store.
    const effectiveBaseUrl = useRuntimeConnection ? runtime?.baseUrl ?? null : baseUrl;
    return this.store.transaction(() => {
      const instance = effectiveBaseUrl ? selectSiyuanInstance(this.store, effectiveBaseUrl, runtime?.stableId) : this.store.get('config', 'siyuan-instance');
      if (token !== undefined) this.secrets.set('siyuan.token', token);
      if (useRuntimeConnection && runtime?.token !== this.secrets.get('siyuan.runtimeToken')) this.secrets.set('siyuan.runtimeToken', runtime?.token ?? null);
      this.store.put('config', { useRuntimeConnection, baseUrl: effectiveBaseUrl, notebookTitle, runtimeBaseUrl: runtime?.baseUrl ?? null,
        runtimeVersion: runtime?.version ?? null, connectionEpoch: instance?.epoch ?? null, configurationSource: useRuntimeConnection ? runtime ? 'runtime' : 'none' : 'manual' }, 'siyuan');
      this.store.remove('config', 'siyuan-check');
      if (!useRuntimeConnection) this.discoveryError = null;
      return this.connectionStatus(this.store.get('config', 'siyuan')).siyuan;
    });
  }

  readRuntime() {
    const file = resolve(this.root, 'runtime/connection.json');
    if (!existsSync(file)) {
      this.discoveryError = null;
      return null;
    }
    try {
      requireValue(statSync(file).size < 16000, '运行时连接文件过大。');
      const runtime = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const baseUrl = providerUrl(runtime.baseUrl, 'siyuan');
      const marker = {};
      for (const key of ['instanceId', 'workspaceId']) {
        if (runtime[key] !== undefined && runtime[key] !== null) marker[key] = text(runtime[key], key, 200);
      }
      let token = '';
      if (runtime.tokenFile) {
        const tokenFile = isAbsolute(runtime.tokenFile) ? resolve(runtime.tokenFile) : resolve(dirname(file), runtime.tokenFile);
        const inside = relative(this.root, tokenFile);
        requireValue(inside && !inside.startsWith('..') && !isAbsolute(inside) && statSync(tokenFile).size < 8192, '运行时凭据路径无效。');
        token = credential(readFileSync(tokenFile, 'utf8').trim(), 'runtimeToken');
      }
      this.discoveryError = null;
      return { baseUrl, token, version: runtime.version ?? null, stableId: Object.keys(marker).length ? JSON.stringify(marker) : null };
    } catch {
      this.discoveryError = 'runtime_connection_invalid';
      return null;
    }
  }

  discoverRuntime() {
    const current = this.store.get('config', 'siyuan');
    if (!current.useRuntimeConnection) return;
    const runtime = this.readRuntime();
    if (!runtime) { this.clearRuntime(this.discoveryError); return; }
    // Switch rejections must propagate; they are not invalid-manifest failures.
    this.store.transaction(() => {
      const instance = selectSiyuanInstance(this.store, runtime.baseUrl, runtime.stableId);
      if (runtime.token !== this.secrets.get('siyuan.runtimeToken')) this.secrets.set('siyuan.runtimeToken', runtime.token);
      this.store.put('config', { ...current, baseUrl: runtime.baseUrl, runtimeBaseUrl: runtime.baseUrl, runtimeVersion: runtime.version,
        connectionEpoch: instance.epoch, configurationSource: 'runtime' }, 'siyuan');
    });
  }

  clearRuntime(reason) {
    const current = this.store.get('config', 'siyuan');
    if (current.baseUrl || current.runtimeBaseUrl || current.configurationSource !== 'none') {
      this.store.put('config', { ...current, baseUrl: null, runtimeBaseUrl: null, runtimeVersion: null, configurationSource: 'none' }, 'siyuan');
    }
    this.store.remove('config', 'siyuan-check');
    if (this.secrets.get('siyuan.runtimeToken')) this.secrets.set('siyuan.runtimeToken', null);
    this.discoveryError = reason;
  }

  connectionStatus(siyuan = this.siyuan()) {
    const config = this.public();
    const savedCheck = this.store.get('config', 'siyuan-check');
    const check = siyuan.baseUrl && savedCheck?.connectionEpoch === siyuan.connectionEpoch ? savedCheck : null;
    const owned = this.store.get('config', 'siyuan-owned');
    const codex = this.store.get('config', 'codex-check');
    const scope = this.store.get('config', 'codex-scope');
    let codexConfigured = false;
    try { codexCommand(this.store.get('config', 'codex-options')?.cliPath); codexConfigured = true; } catch {}
    const modelConfigured = !!(config.model.endpoint && config.model.model && (new URL(config.model.endpoint).hostname === '127.0.0.1' || new URL(config.model.endpoint).hostname === 'localhost' || new URL(config.model.endpoint).hostname === '[::1]' || config.model.apiKeyConfigured));
    const base = { lastCheckedAt: null, lastError: null };
    return {
      siyuan: {
        ...base, kind: 'siyuan', revision: siyuan.revision, configurationSource: siyuan.configurationSource,
        configured: !!siyuan.baseUrl, baseUrl: siyuan.baseUrl, tokenConfigured: !!this.siyuanToken(siyuan),
        expectedVersion: '3.8.8', version: check?.version ?? null, notebookTitle: siyuan.notebookTitle,
        status: check?.status ?? (siyuan.baseUrl ? 'unchecked' : 'not_configured'),
        lastCheckedAt: check?.checkedAt ?? null, lastError: check?.lastError ?? null,
        compatibility: check?.version ? check.version === '3.8.8' ? 'compatible' : 'incompatible' : 'unchecked',
        notebook: owned?.notebookId ? { id: owned.notebookId, title: owned.notebookTitle ?? siyuan.notebookTitle, appOwned: true } : null,
        riff: { status: check?.version ? check.version === '3.8.8' ? 'compatible' : 'incompatible' : siyuan.baseUrl ? 'unchecked' : 'unavailable', reason: this.discoveryError },
      },
      codex: {
        ...base, kind: 'codex', configured: codexConfigured, status: codex?.status ?? (codexConfigured ? 'unchecked' : 'not_configured'),
        cliVersion: codex?.cliVersion ?? null, protocolVersion: codex?.protocolVersion ?? null,
        capabilities: codex?.capabilities ?? { threadList: false, threadRead: false, visibleMessages: false, forkAncestry: false },
        lastCheckedAt: codex?.lastCheckedAt ?? null, lastError: codex?.lastError ?? null,
        scopeRevision: scope?.revision ?? 1, lastSyncAt: codex?.lastSyncAt ?? null,
      },
      model: {
        ...base, kind: 'model', ...config.model, configured: modelConfigured,
        status: !config.model.enabled ? 'disabled' : modelConfigured ? 'unchecked' : 'not_configured',
      },
      feishu: {
        ...base, kind: 'feishu', ...config.feishu, configured: !!(config.feishu.appId && config.feishu.appSecretConfigured),
        status: !config.feishu.enabled ? 'disabled' : config.feishu.appId && config.feishu.appSecretConfigured ? 'unchecked' : 'not_configured',
      },
    };
  }

  connections() { return Object.values(this.connectionStatus()); }
}
