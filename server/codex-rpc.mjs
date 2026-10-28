import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve, isAbsolute, extname } from 'node:path';
import { ApiError, fail, requireValue } from './errors.mjs';

export const READ_ONLY_METHODS = new Set(['initialize', 'thread/list', 'thread/read', 'thread/turns/list', 'thread/items/list']);
export class RpcError extends Error {
  constructor(code) { super('Codex RPC request failed.'); this.rpcCode = code; }
}

export function codexCommand(cliPath) {
  const candidates = cliPath ? [cliPath] : [
    resolve(dirname(process.execPath), 'node_modules/@openai/codex/bin/codex.js'),
    ...(process.env.APPDATA ? [resolve(process.env.APPDATA, 'npm/node_modules/@openai/codex/bin/codex.js')] : []),
  ];
  const selected = candidates.find(file => isAbsolute(file) && existsSync(file) && statSync(file).isFile());
  if (!selected) fail(503, 'CONNECTION_UNAVAILABLE', '未找到 Codex CLI，请配置 codex.js 或 codex.exe 的绝对路径，或手工导入对话。');
  const extension = extname(selected).toLowerCase();
  requireValue(['.js', '.mjs', '.exe'].includes(extension), 'Codex 路径必须指向 JavaScript 入口或可执行文件，不支持 PowerShell/CMD shim。');
  const args = ['app-server', '-c', 'mcp_servers={}', '--listen', 'stdio://'];
  return extension === '.exe' ? { command: selected, args } : { command: process.execPath, args: [selected, ...args] };
}

export class CodexRpc {
  constructor({ cliPath, timeoutMs = 12000, root } = {}) {
    this.config = { cliPath, timeoutMs, root };
    this.pending = new Map();
    this.sequence = 0;
    this.child = null;
    this.buffer = '';
    this.totalBytes = 0;
  }

  async start() {
    const { command, args } = codexCommand(this.config.cliPath);
    this.child = spawn(command, args, { cwd: this.config.root, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => this.rejectAll(new ApiError(503, 'CONNECTION_UNAVAILABLE', 'Codex app-server 无法启动。')));
    this.child.on('exit', () => this.rejectAll(new ApiError(503, 'CONNECTION_UNAVAILABLE', 'Codex app-server 已退出。', true)));
    this.child.stdin.on('error', () => this.rejectAll(new ApiError(503, 'CONNECTION_UNAVAILABLE', 'Codex app-server 通道已关闭。', true)));
    let result;
    try {
      result = await this.request('initialize', { clientInfo: { name: 'second_brain', title: 'Second Brain read-only collector', version: '0.0.0' }, capabilities: { experimentalApi: true } });
    } catch (error) {
      if (error.rpcCode !== -32602) { await this.close(); throw error; }
      result = await this.request('initialize', { clientInfo: { name: 'second_brain', title: 'Second Brain read-only collector', version: '0.0.0' } });
    }
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    // These exact releases have schema-verified non-repairing state-DB listing.
    const agent = result?.userAgent ?? result?.serverInfo?.version ?? '';
    // Later user-agent tokens may contain the client's version rather than the server's.
    const version = typeof agent === 'string'
      ? /^(?:[\w.-]+\/|codex-cli )?(\d+\.\d+\.\d+)(?= |$)/.exec(agent)?.[1] : null;
    this.verifiedStateDbOnly = ['0.164.0', '0.165.0'].includes(version) || result?.capabilities?.useStateDbOnly === true;
    this.negotiated = { server: result, protocol: 'jsonrpc-stdio', readOnly: true };
    return this;
  }

  receive(chunk) {
    this.totalBytes += Buffer.byteLength(chunk);
    this.buffer += chunk;
    if (this.buffer.length > 8 * 1024 * 1024 || this.totalBytes > 64 * 1024 * 1024) {
      this.rejectAll(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Codex 历史响应超过本次采集上限。'));
      this.child.kill();
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.rejectAll(new ApiError(502, 'UPSTREAM_ERROR', 'Codex 返回了无效 RPC 消息。')); this.child.kill(); return; }
      this.handle(message);
    }
  }

  handle(message) {
    if (message.method) {
      if (message.id !== undefined) this.child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only collector does not implement server requests.' } })}\n`);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new RpcError(message.error.code));
    else pending.resolve(message.result);
  }

  request(method, params) {
    if (!READ_ONLY_METHODS.has(method)) fail(403, 'SCOPE_FORBIDDEN', '采集器只允许只读 RPC。');
    if (!this.child || this.child.killed) fail(503, 'CONNECTION_UNAVAILABLE', 'Codex app-server 未连接。');
    const requestId = ++this.sequence;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ApiError(504, 'UPSTREAM_TIMEOUT', 'Codex 只读请求超时。', true));
      }, this.config.timeoutMs);
      this.pending.set(requestId, { resolve: resolveRequest, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  async close() {
    if (this.closing) return this.closing;
    this.rejectAll(new ApiError(503, 'CONNECTION_UNAVAILABLE', '采集连接已关闭。'));
    if (!this.child) return;
    const child = this.child;
    this.closing = new Promise(resolveClose => {
      let timer;
      const done = () => { clearTimeout(timer); resolveClose(); };
      child.once('close', done);
      timer = setTimeout(done, 2000);
      child.stdin.end();
      if (child.exitCode === null) child.kill();
      else if (child.stdout.destroyed && child.stderr.destroyed) done();
    });
    await this.closing;
    this.child = null;
  }
}
