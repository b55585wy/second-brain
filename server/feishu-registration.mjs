import { createHash } from 'node:crypto';
import { registerApp } from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';

// The user-facing QR host differs from the registration polling API host.
const REGISTRATION_HOSTS = new Set(['accounts.feishu.cn', 'accounts.larksuite.com', 'open.feishu.cn', 'open.larksuite.com']);
const PREPARATION_TIMEOUT_MS = 30000;
const IDLE = { state: 'idle', url: null, qrDataUrl: null, expiresAt: null, message: '尚未开始扫码。', error: null };
const ERRORS = {
  REGISTRATION_EXPIRED: ['二维码已过期，请重新开始扫码。', true],
  REGISTRATION_DENIED: ['飞书授权未完成，请重新扫码并确认授权。', true],
  REGISTRATION_CANCELLED: ['扫码已取消，可重新开始。', true],
  REGISTRATION_NETWORK: ['暂时无法连接飞书，请检查网络后重试。', true],
  REGISTRATION_URL_INVALID: ['飞书返回的注册链接无法验证，请稍后重试。', true],
  REGISTRATION_RESPONSE_INVALID: ['飞书未返回完整应用凭据，请重新扫码。', true],
  REGISTRATION_CONFIG_CHANGED: ['飞书配置已被修改，本次扫码结果未保存，请重新开始。', true],
  REGISTRATION_SAVE_FAILED: ['无法保存飞书应用凭据，请检查本地存储后重试。', true],
  REGISTRATION_FAILED: ['暂时无法完成飞书注册，请稍后重试。', true],
};

function errorCode(error) {
  if (error?.registrationCode && Object.hasOwn(ERRORS, error.registrationCode)) return error.registrationCode;
  if (error?.code === 'expired_token') return 'REGISTRATION_EXPIRED';
  if (error?.code === 'access_denied') return 'REGISTRATION_DENIED';
  if (error?.code === 'abort' || error?.name === 'AbortError') return 'REGISTRATION_CANCELLED';
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(error?.code ?? error?.cause?.code)) return 'REGISTRATION_NETWORK';
  return 'REGISTRATION_FAILED';
}

function registrationError(code) {
  return Object.assign(new Error(code), { registrationCode: code });
}

function registrationUrl(value) {
  if (typeof value !== 'string' || value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) throw registrationError('REGISTRATION_URL_INVALID');
  let url;
  try { url = new URL(value); } catch { throw registrationError('REGISTRATION_URL_INVALID'); }
  if (url.protocol !== 'https:' || !REGISTRATION_HOSTS.has(url.hostname) || url.username || url.password || url.port) throw registrationError('REGISTRATION_URL_INVALID');
  return value;
}

function configurationFingerprint(settings, secrets) {
  return createHash('sha256').update(JSON.stringify([settings.raw().feishu, secrets.get('feishu.appSecret')])).digest('hex');
}

function credentialsValid(result) {
  return typeof result?.client_id === 'string' && /^cli_[A-Za-z0-9_-]{1,196}$/.test(result.client_id)
    && typeof result.client_secret === 'string' && result.client_secret.length > 0 && result.client_secret.length <= 8192
    && !/[\r\n\0]/.test(result.client_secret);
}

export class FeishuRegistration {
  #session = null;
  #view = { ...IDLE };

  constructor(settings, secrets, { registerAppFactory = registerApp, clock = Date.now, onConfigured } = {}) {
    this.settings = settings;
    this.secrets = secrets;
    this.registerAppFactory = registerAppFactory;
    this.clock = clock;
    this.onConfigured = onConfigured;
  }

  public() {
    this.#expire();
    return { ...this.#view, error: this.#view.error ? { ...this.#view.error } : null };
  }

  start() {
    this.#expire();
    if (this.#session) return this.public();
    const session = {
      controller: new AbortController(), timer: null, expiresAt: null,
      preparationDeadline: this.clock() + PREPARATION_TIMEOUT_MS, qrVersion: 0, qrTask: Promise.resolve(),
    };
    this.#session = session;
    this.#view = { ...IDLE, state: 'starting', message: '正在准备飞书注册二维码…' };
    try { session.fingerprint = configurationFingerprint(this.settings, this.secrets); }
    catch { this.#fail(session, 'REGISTRATION_FAILED'); return this.public(); }
    session.timer = setTimeout(() => this.#fail(session, 'REGISTRATION_NETWORK'), PREPARATION_TIMEOUT_MS);
    session.timer.unref?.();
    // Defer work so start() remains synchronous and duplicate calls share one session.
    session.pending = Promise.resolve().then(() => this.#run(session));
    return this.public();
  }

  cancel() {
    const session = this.#session;
    if (!session) return this.public();
    this.#finish(session, 'idle', '已取消扫码，可重新开始。');
    session.controller.abort();
    return this.public();
  }

  async stop() {
    // An injected factory or in-flight HTTP request may ignore abort indefinitely.
    return this.cancel();
  }

  #current(session) { return this.#session === session && !session.controller.signal.aborted; }

  #expire() {
    const session = this.#session;
    if (!session) return;
    const now = this.clock();
    if (session.expiresAt !== null && now >= session.expiresAt) this.#fail(session, 'REGISTRATION_EXPIRED');
    else if (session.preparationDeadline !== null && now >= session.preparationDeadline) this.#fail(session, 'REGISTRATION_NETWORK');
  }

  #finish(session, state, message, error = null) {
    if (!this.#current(session)) return;
    clearTimeout(session.timer);
    this.#session = null;
    this.#view = { ...IDLE, state, message, error };
  }

  #fail(session, code) {
    if (!this.#current(session)) return;
    const [message, retryable] = ERRORS[code] ?? ERRORS.REGISTRATION_FAILED;
    this.#finish(session, 'error', message, { code, message, retryable });
    session.controller.abort();
  }

  async #showQr(session, info) {
    this.#expire();
    if (!this.#current(session)) return;
    const version = ++session.qrVersion;
    try {
      const url = registrationUrl(info?.url);
      const duration = Number(info?.expireIn) * 1000;
      if (!Number.isFinite(duration) || duration <= 0 || duration > 2147483647) throw registrationError('REGISTRATION_EXPIRED');
      session.expiresAt = this.clock() + duration;
      session.preparationDeadline = null;
      const expiresAt = new Date(session.expiresAt).toISOString();
      clearTimeout(session.timer);
      session.timer = setTimeout(() => this.#fail(session, 'REGISTRATION_EXPIRED'), duration);
      session.timer.unref?.();
      const qrDataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
      this.#expire();
      if (!this.#current(session) || version !== session.qrVersion) return;
      this.#view = { state: 'waiting', url, qrDataUrl, expiresAt, message: '请使用飞书扫码，并确认创建应用和授权。', error: null };
    } catch (error) { this.#fail(session, errorCode(error)); }
  }

  async #run(session) {
    if (!this.#current(session)) return;
    try {
      const result = await this.registerAppFactory({
        createOnly: true,
        appPreset: { name: '知行学习', desc: '个人目标学习与练习' },
        addons: {
          preset: false,
          scopes: { tenant: ['im:message.p2p_msg:readonly', 'im:message:send_as_bot'] },
          events: { items: { tenant: ['im.message.receive_v1'] } },
        },
        signal: session.controller.signal,
        onQRCodeReady: (info) => {
          session.qrTask = this.#showQr(session, info);
          return session.qrTask;
        },
      });
      await session.qrTask;
      this.#expire();
      if (!this.#current(session)) return;
      if (configurationFingerprint(this.settings, this.secrets) !== session.fingerprint) throw registrationError('REGISTRATION_CONFIG_CHANGED');
      if (!credentialsValid(result)) throw registrationError('REGISTRATION_RESPONSE_INVALID');
      this.#save(result);
      this.#finish(session, 'complete', '飞书应用已保存，正在连接，请按提示绑定私聊。');
      try { await this.onConfigured?.(); } catch { /* Saved credentials remain valid if connecting fails. */ }
    } catch (error) { this.#fail(session, errorCode(error)); }
  }

  #save(result) {
    const current = this.settings.raw();
    try {
      this.settings.update({
        model: { ...current.model },
        scheduler: { ...current.scheduler },
        feishu: {
          ...current.feishu, enabled: true, appId: result.client_id,
          apiBase: result.user_info?.tenant_brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
          appSecret: result.client_secret,
        },
      });
    } catch { throw registrationError('REGISTRATION_SAVE_FAILED'); }
  }
}
