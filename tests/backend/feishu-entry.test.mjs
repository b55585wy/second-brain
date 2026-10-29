import test from 'node:test';
import assert from 'node:assert/strict';
import { feishuBotEntry } from '../../server/feishu-entry.mjs';

const config = { enabled: true, appSecretConfigured: true, apiBase: 'https://open.feishu.cn', appId: 'cli_owned_fixture' };
const settings = value => ({ public: () => ({ feishu: value }) });

test('configured app entry uses its own official bot link and a locally generated QR', async () => {
  const original = JSON.stringify(config); const entry = await feishuBotEntry(settings(config));
  assert.equal(entry.url, 'https://applink.feishu.cn/client/bot/open?appId=cli_owned_fixture');
  assert.ok(entry.qrDataUrl.startsWith('data:image/png;base64,'));
  assert.equal(JSON.stringify(config), original); assert.ok(!JSON.stringify(entry).includes('appSecret'));
});

test('disabled or incomplete configuration does not advertise a usable bot entry', async () => {
  for (const value of [{ ...config, enabled: false }, { ...config, appSecretConfigured: false }, { ...config, appId: null }, { ...config, appId: '' }]) {
    assert.deepEqual(await feishuBotEntry(settings(value)), { url: null, qrDataUrl: null });
  }
});

test('entry refuses unsafe identities and origins instead of constructing arbitrary redirects', async () => {
  for (const value of [{ ...config, appId: 'cli_owned&redirect=evil' }, { ...config, appId: '../another' },
    { ...config, apiBase: 'https://open.feishu.cn.evil.example' }, { ...config, apiBase: 'https://open.larksuite.com' }]) {
    assert.deepEqual(await feishuBotEntry(settings(value)), { url: null, qrDataUrl: null });
  }
});

test('switching the configured app returns the new app entry without stale identity reuse', async () => {
  const first = await feishuBotEntry(settings(config));
  const second = await feishuBotEntry(settings({ ...config, appId: 'cli_second_fixture' }));
  assert.notEqual(second.url, first.url); assert.notEqual(second.qrDataUrl, first.qrDataUrl);
  assert.ok(second.url.endsWith('appId=cli_second_fixture'));
});
