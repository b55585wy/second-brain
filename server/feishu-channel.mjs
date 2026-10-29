import { ApiError } from './errors.mjs';

const QUIET_LOGGER = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

export function channelError(error) {
  const code = error?.response?.data?.code ?? error?.code;
  if ([99991663, 99991664, 99991668, 99991672, 99991679].includes(code)) {
    return new ApiError(403, 'SCOPE_FORBIDDEN', '请在飞书应用中开通私聊收发权限并发布应用。');
  }
  if ([99991400, 99991403].includes(code)) {
    const result = new ApiError(429, 'RATE_LIMITED', '飞书请求频率受限，稍后再试。', true);
    result.uncertain = false; return result;
  }
  return new ApiError(503, 'CONNECTION_UNAVAILABLE', '飞书暂未连接，请检查网络及应用的机器人、长连接和发布状态。', true);
}

export async function createFeishuTransport({ appId, appSecret, apiBase, onMessage, onState, onError, loadSdk = () => import('@larksuiteoapi/node-sdk') }) {
  const sdk = await loadSdk();
  const channel = sdk.createLarkChannel({ appId, appSecret,
    domain: apiBase === 'https://open.larksuite.com' ? sdk.Domain.Lark : sdk.Domain.Feishu,
    logger: QUIET_LOGGER, policy: { dmMode: 'open', groupAllowlist: [] } });
  channel.on('message', onMessage);
  channel.on('reconnecting', () => onState('connecting'));
  channel.on('reconnected', () => onState('connected'));
  channel.on('error', onError);
  return {
    connect: () => channel.connect(), disconnect: () => channel.disconnect(),
    async send({ chatId, text, uuid }) {
      let result;
      try {
        result = await channel.rawClient.im.v1.message.create({ params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid } });
      } catch (error) { throw channelError(error); }
      if (result.code !== 0) {
        const error = channelError({ code: result.code });
        error.uncertain = false; throw error;
      }
      if (!result.data?.message_id) throw channelError(null);
      return { messageId: result.data.message_id };
    },
  };
}

export class FeishuChannel {
  constructor(chat, settings, secrets, { factory = createFeishuTransport, clock = () => new Date() } = {}) {
    Object.assign(this, { chat, settings, secrets, factory, clock });
    this.stopped = true; this.state = 'off'; this.lastError = null; this.transport = null;
    this.activeIdentity = null; this.pending = null; this.nextConnectAt = 0; this.generation = 0;
  }

  public() {
    let state = this.state;
    if (this.stopped || !this.chat.config().enabled) state = 'off';
    else if (!this.chat.public().configured) state = 'setup';
    else if (this.activeIdentity !== this.chat.identity()) state = 'connecting';
    const messages = { off: '飞书学习连接已关闭。', setup: '先扫码创建并授权飞书应用。',
      connecting: '正在连接飞书，请保持知行运行。', connected: '飞书已连接，可在私聊中绑定并回答练习。',
      error: '飞书暂未连接，请检查网络、应用权限和发布状态。' };
    return { state, message: messages[state], lastError: state === 'error' ? this.lastError : null };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), 15000); this.timer.unref(); this.wake();
  }

  wake() {
    if (this.stopped || this.pending) return this.pending ?? Promise.resolve();
    this.pending = this.refresh().catch(error => this.recordError(error)).finally(() => { this.pending = null; });
    return this.pending;
  }

  recordError(error) {
    const safe = channelError(error);
    this.state = 'error'; this.lastError = { code: safe.code, message: safe.message, retryable: safe.retryable };
    this.nextConnectAt = +this.clock() + 60000;
  }

  current(identity, generation) {
    return !this.stopped && generation === this.generation && this.chat.config().enabled && this.chat.public().configured && this.chat.identity() === identity;
  }

  async disconnect() {
    this.generation++;
    const transport = this.transport; this.transport = null; this.activeIdentity = null;
    if (transport) { try { await transport.disconnect(); } catch {} }
  }

  async refresh() {
    if (this.stopped) return;
    if (!this.chat.config().enabled || !this.chat.public().configured) {
      await this.disconnect(); this.state = this.chat.config().enabled ? 'setup' : 'off'; this.lastError = null; return;
    }
    const identity = this.chat.identity();
    if (this.activeIdentity !== identity || this.state === 'error') {
      if (this.activeIdentity === identity && +this.clock() < this.nextConnectAt) return;
      await this.disconnect();
      this.activeIdentity = identity; this.state = 'connecting'; this.lastError = null;
      const generation = ++this.generation;
      const config = this.settings.raw().feishu;
      const transport = await this.factory({ ...config, appSecret: this.secrets.get('feishu.appSecret'),
        onMessage: message => {
          if (!this.current(identity, generation)) return;
          this.chat.receive(message, identity); this.wake();
        },
        onState: state => { if (this.current(identity, generation)) this.state = state; },
        onError: error => { if (this.current(identity, generation)) this.recordError(error); },
      });
      if (!this.current(identity, generation)) { await transport.disconnect(); return; }
      this.transport = transport;
      try { await transport.connect(); }
      catch (error) { this.recordError(error); return; }
      if (!this.current(identity, generation)) { await this.disconnect(); return; }
      this.state = 'connected'; this.lastError = null;
    }
    if (this.state !== 'connected' || !this.transport) return;
    const generation = this.generation;
    this.chat.tick(this.clock());
    await this.chat.drain(input => {
      if (!this.current(identity, generation) || this.state !== 'connected') {
        const error = new ApiError(409, 'INVALID_STATE', '飞书连接已变化，本条消息未发送。', true);
        error.uncertain = false; throw error;
      }
      return this.transport.send(input);
    });
  }

  async stop() {
    this.stopped = true; clearInterval(this.timer);
    await this.disconnect(); await this.pending;
    this.state = 'off'; this.lastError = null;
  }
}
