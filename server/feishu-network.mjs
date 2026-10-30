import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';

const HOSTS = new Set(['open.feishu.cn', 'accounts.feishu.cn', 'open.larksuite.com', 'accounts.larksuite.com']);
const WARNING = 'Feishu network configuration is invalid; local learning remains available.\n';

export function parseFeishuProxy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || typeof value.proxyUrl !== 'string'
    || value.proxyUrl !== value.proxyUrl.trim() || value.proxyUrl.length > 200) throw new Error('INVALID_FEISHU_PROXY');
  const url = new URL(value.proxyUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('INVALID_FEISHU_PROXY');
  return { protocol: 'http', host: url.hostname === '[::1]' ? '::1' : url.hostname, port: Number(url.port || 80) };
}

export function installFeishuNetwork(root, { http = defaultHttpInstance, warn = value => process.stderr.write(value) } = {}) {
  const file = resolve(root, 'runtime/feishu-network.json');
  let proxy;
  try {
    if (statSync(file).size > 4096) throw new Error('INVALID_FEISHU_PROXY');
    proxy = parseFeishuProxy(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') warn(WARNING);
    return () => {};
  }
  const interceptor = http.interceptors.request.use(config => {
    let url;
    try { url = new URL(config.url, config.baseURL); } catch { return config; }
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname)) return config;
    return { ...config, proxy: { ...proxy }, timeout: Math.min(config.timeout || 15000, 15000) };
  });
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    http.interceptors.request.eject(interceptor);
  };
}
