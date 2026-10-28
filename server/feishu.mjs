import { fail, requireValue } from './errors.mjs';
import { referenceUrl } from './sources.mjs';
import { text, digest } from './validation.mjs';

export const FEISHU_API_REFERENCES = [
  'https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content',
  'https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal',
  'https://open.feishu.cn/document/server-docs/docs/wiki-v2/space/get_node',
];

export class Feishu {
  constructor(settings, secrets, transport) {
    this.settings = settings; this.secrets = secrets; this.transport = transport;
    this.cachedToken = null; this.expiresAt = 0;
  }

  selectedDocument(value) {
    const url = new URL(referenceUrl(text(value, 'url', 2000)));
    requireValue(url.protocol === 'https:' && /^[a-z0-9-]+\.(?:feishu\.cn|larksuite\.com)$/.test(url.hostname) && !url.search, '只允许用户明确选择的飞书/Lark 文档链接。');
    const match = /^\/(docx|wiki)\/([A-Za-z0-9_-]{5,200})\/?$/.exec(url.pathname);
    requireValue(match, '仅支持 docx 或 wiki 文档链接。');
    return { type: match[1], token: match[2], url: url.href };
  }

  checkCode(response) {
    if (response?.code === 0) return response;
    const code = response?.code;
    if ([99991663, 99991664, 99991668, 99991672, 1770032, 1770013].includes(code)) fail(403, 'SCOPE_FORBIDDEN', '飞书授权不包含该文档或操作。');
    if ([99991400, 99991403].includes(code)) fail(429, 'RATE_LIMITED', '飞书请求频率受限，请稍后重试。', true);
    fail(502, 'UPSTREAM_ERROR', '飞书服务拒绝了请求。');
  }

  async accessToken() {
    const config = this.settings.raw().feishu;
    if (!config.enabled || !config.appId || !this.secrets.get('feishu.appSecret')) fail(503, 'CONNECTION_UNAVAILABLE', '尚未启用或配置飞书服务。');
    const identity = digest([config.apiBase, config.appId, this.secrets.get('feishu.appSecret')]);
    if (identity !== this.tokenIdentity) { this.cachedToken = null; this.expiresAt = 0; }
    if (this.cachedToken && this.expiresAt > Date.now()) return this.cachedToken;
    const response = this.checkCode(await this.transport.json(config.apiBase + '/open-apis/auth/v3/tenant_access_token/internal', {
      body: { app_id: config.appId, app_secret: this.secrets.get('feishu.appSecret') }, readOnly: true,
    }));
    if (typeof response.tenant_access_token !== 'string' || !Number.isFinite(response.expire)) fail(502, 'UPSTREAM_ERROR', '飞书授权响应无效。');
    this.cachedToken = response.tenant_access_token;
    this.tokenIdentity = identity;
    this.expiresAt = Date.now() + Math.max(0, response.expire - 60) * 1000;
    this.secrets.set('feishu.accessToken', this.cachedToken);
    return this.cachedToken;
  }

  async source(sourceRef) {
    const selected = this.selectedDocument(typeof sourceRef === 'string' ? sourceRef : sourceRef?.url);
    const config = this.settings.raw().feishu;
    const token = await this.accessToken();
    const headers = { Authorization: 'Bearer ' + token };
    let documentId = selected.token;
    if (selected.type === 'wiki') {
      const node = this.checkCode(await this.transport.json(config.apiBase + '/open-apis/wiki/v2/spaces/get_node?token=' + encodeURIComponent(selected.token), {
        method: 'GET', readOnly: true, headers,
      }));
      requireValue(node?.data?.node?.obj_type === 'docx', '该知识库节点不是可读取的 docx 文档。');
      documentId = node.data.node.obj_token;
      requireValue(typeof documentId === 'string' && /^[A-Za-z0-9_-]{5,200}$/.test(documentId), '飞书文档标识无效。');
    }
    const response = this.checkCode(await this.transport.json(config.apiBase + '/open-apis/docx/v1/documents/' + encodeURIComponent(documentId) + '/raw_content', {
      method: 'GET', readOnly: true, headers,
    }));
    if (typeof response?.data?.content !== 'string') fail(502, 'UPSTREAM_ERROR', '飞书文档内容格式无效。');
    return { kind: 'feishu', externalId: documentId, documentId, title: '飞书文档 ' + documentId, url: selected.url, content: response.data.content };
  }
}
