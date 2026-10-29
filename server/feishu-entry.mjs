import QRCode from 'qrcode';

export async function feishuBotEntry(settings) {
  const config = settings.public().feishu;
  const empty = { url: null, qrDataUrl: null };
  if (!config.enabled || !config.appSecretConfigured || config.apiBase !== 'https://open.feishu.cn'
    || typeof config.appId !== 'string' || !/^cli_[A-Za-z0-9_-]{1,196}$/.test(config.appId)) return empty;
  const url = `https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(config.appId)}`;
  return { url, qrDataUrl: await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 320 }) };
}
