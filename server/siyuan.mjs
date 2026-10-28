import { choice, now, text, digest } from './validation.mjs';
import { ApiError, fail, requireValue } from './errors.mjs';

export const RIFF_VERSION = '3.8.8';
// SiYuan v3.8.8 kernel/go.mod pins riff commit 228528e70754; store.go defines these values.
export const RIFF_RATINGS = Object.freeze({ again: 1, forgot: 1, hard: 2, good: 3, easy: 4 });
const sqlLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
const blockId = value => { requireValue(typeof value === 'string' && /^\d{14}-[a-z0-9]{7}$/.test(value), 'SiYuan block ID 无效。'); return value; };
const fenced = value => {
  const runs = String(value).match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  return `${fence}\n${value}\n${fence}`;
};

export class Siyuan {
  constructor(store, settings, secrets, transport) {
    this.store = store; this.settings = settings; this.secrets = secrets; this.transport = transport;
  }

  epoch() { return this.settings.siyuan().connectionEpoch; }
  assertEpoch(epoch) { return this.settings.assertSiyuanEpoch(epoch); }

  async call(path, body = {}, readOnly = true, epoch = null) {
    const config = this.settings.siyuan();
    if (epoch && config.connectionEpoch !== epoch) fail(409, 'INVALID_STATE', 'SiYuan 连接已变更，此操作已过期。');
    if (!config.baseUrl) fail(503, 'CONNECTION_UNAVAILABLE', '尚未配置 SiYuan。');
    const result = await this.transport.json(`${config.baseUrl}${path}`, { body, readOnly,
      headers: { Authorization: `Token ${this.settings.siyuanToken(config)}` } });
    if (epoch) this.assertEpoch(epoch);
    if (!result || typeof result.code !== 'number') fail(502, 'UPSTREAM_ERROR', 'SiYuan 返回格式不兼容。');
    if (result.code !== 0) fail(502, 'UPSTREAM_ERROR', `SiYuan 操作被拒绝（code ${result.code}）。`, readOnly);
    return result.data;
  }

  async check(epoch = this.epoch()) {
    try {
      const data = await this.call('/api/system/version', {}, true, epoch);
      this.assertEpoch(epoch);
      const version = typeof data === 'string' ? data : data?.version;
      requireValue(typeof version === 'string', 'SiYuan 未返回版本。');
      const result = { status: version === RIFF_VERSION ? 'connected' : 'incompatible', version, checkedAt: now(), connectionEpoch: epoch };
      this.store.put('config', result, 'siyuan-check');
      return { ...result, riffCompatible: version === RIFF_VERSION, supportedVersion: RIFF_VERSION };
    } catch (error) {
      const config = this.settings.siyuan();
      if (config.baseUrl && config.connectionEpoch === epoch) this.store.put('config', { status: 'unavailable', version: null, checkedAt: now(), connectionEpoch: epoch }, 'siyuan-check');
      throw error;
    }
  }

  async compatible(epoch = this.epoch()) {
    const result = await this.check(epoch);
    if (!result.riffCompatible) fail(503, 'RIFF_INCOMPATIBLE', `记忆复习要求 SiYuan ${RIFF_VERSION}。`);
    return result;
  }

  async notebooks(epoch = this.epoch()) {
    const data = await this.call('/api/notebook/lsNotebooks', {}, true, epoch);
    const items = data?.notebooks;
    if (!Array.isArray(items)) fail(502, 'UPSTREAM_ERROR', 'SiYuan 笔记本列表无效。');
    const owned = this.store.get('config', 'siyuan-owned');
    return items.map(item => ({ id: item.id, name: item.name, closed: !!item.closed, appOwned: item.id === owned?.notebookId })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async source(sourceRef, epoch = this.epoch()) {
    let target = typeof sourceRef === 'string' ? sourceRef : sourceRef?.blockId ?? sourceRef?.documentId;
    if (target?.startsWith('siyuan://blocks/')) target = target.slice('siyuan://blocks/'.length);
    const targetId = blockId(target);
    const data = await this.call('/api/block/getBlockKramdown', { id: targetId }, true, epoch);
    this.assertEpoch(epoch);
    if (typeof data?.kramdown !== 'string') fail(502, 'UPSTREAM_ERROR', 'SiYuan 文档内容无效。');
    return { kind: 'siyuan', externalId: targetId, blockId: targetId, title: `SiYuan ${targetId}`,
      documentId: targetId, url: `siyuan://blocks/${targetId}`, content: data.kramdown };
  }

  async query(statement, epoch = this.epoch()) {
    await this.call('/api/sqlite/flushTransaction', {}, true, epoch);
    const rows = await this.call('/api/query/sql', { stmt: statement }, true, epoch);
    if (!Array.isArray(rows)) fail(502, 'UPSTREAM_ERROR', 'SiYuan 索引响应无效。');
    return rows;
  }

  async destination(epoch = this.epoch()) {
    this.assertEpoch(epoch);
    let owned = this.store.get('config', 'siyuan-owned');
    if (!owned) owned = this.store.put('config', { identity: digest(`second-brain:${this.store.get('profile', 'learning').createdAt}:${epoch}`).slice(0, 16), connectionEpoch: epoch }, 'siyuan-owned');
    const notebookName = `第二大脑-${owned.identity}`;
    const notebooks = await this.notebooks(epoch);
    this.assertEpoch(epoch);
    if (owned.notebookId && !notebooks.some(item => item.id === owned.notebookId)) fail(409, 'DESTINATION_CONFLICT', '应用专用笔记本已不可用，请检查 SiYuan。');
    let notebookId = owned.notebookId;
    if (!notebookId) {
      const found = notebooks.find(item => item.name === notebookName);
      if (found && !owned.notebookCreationPending) fail(409, 'OWNERSHIP_REQUIRED', '同名笔记本缺少本地创建凭据。');
      if (found) notebookId = found.id;
      else {
        if (owned.notebookCreationPending) fail(409, 'RECONCILIATION_REQUIRED', '上次笔记本创建结果未知，暂不重复创建。');
        owned = this.store.put('config', { ...owned, notebookCreationPending: true }, 'siyuan-owned');
        const data = await this.call('/api/notebook/createNotebook', { name: notebookName }, false, epoch);
        notebookId = data?.notebook?.id ?? data?.id;
        if (!notebookId) fail(502, 'UPSTREAM_ERROR', 'SiYuan 未返回新笔记本 ID。');
      }
      owned = this.store.put('config', { ...owned, notebookId, notebookTitle: this.settings.siyuan().notebookTitle, notebookCreationPending: false }, 'siyuan-owned');
    }
    if (!owned.deckId) {
      const name = `第二大脑-${owned.identity}`;
      const decks = await this.call('/api/riff/getRiffDecks', {}, true, epoch);
      if (!Array.isArray(decks)) fail(502, 'UPSTREAM_ERROR', 'SiYuan 卡包列表无效。');
      let deck = decks.find(item => item.name === name);
      if (deck && !owned.deckCreationPending) fail(409, 'OWNERSHIP_REQUIRED', '同名卡包缺少本地创建凭据。');
      if (!deck) {
        if (owned.deckCreationPending) fail(409, 'RECONCILIATION_REQUIRED', '上次卡包创建结果未知，暂不重复创建。');
        owned = this.store.put('config', { ...owned, deckCreationPending: true }, 'siyuan-owned');
        deck = await this.call('/api/riff/createRiffDeck', { name }, false, epoch);
      }
      if (!deck?.id) fail(502, 'UPSTREAM_ERROR', 'SiYuan 未返回卡包 ID。');
      owned = this.store.put('config', { ...owned, deckId: deck.id, deckCreationPending: false }, 'siyuan-owned');
    }
    return owned;
  }

  async sync(knowledgeId, targetRevision, jobId = null, epoch = this.epoch()) {
    await this.compatible(epoch);
    this.assertEpoch(epoch);
    const record = this.store.require('knowledge', knowledgeId);
    if (record.status !== 'accepted') fail(409, 'INVALID_STATE', '只有已接受的知识可以同步。');
    if (targetRevision && record.revision !== targetRevision) fail(409, 'REVISION_CONFLICT', '知识已改变，请重新审核。');
    const owned = await this.destination(epoch);
    this.assertEpoch(epoch);
    const versionKey = record.id;
    const previous = this.store.get('sync-target', versionKey);
    const path = `/知识-${record.id}`;
    if (record.siyuanBlockId) {
      const attrs = await this.call('/api/attr/getBlockAttrs', { id: blockId(record.siyuanBlockId) }, true, epoch);
      if (attrs?.['custom-second-brain-owner'] !== owned.identity || attrs?.['custom-second-brain-knowledge'] !== record.id) fail(403, 'OWNERSHIP_REQUIRED', '目标块的所有权标记不匹配。');
      await this.call('/api/block/updateBlock', { id: record.siyuanBlockId, dataType: 'markdown', data: fenced(`问题：${record.question}\n\n答案：${record.answer}`) }, false, epoch);
      await this.call('/api/sqlite/flushTransaction', {}, true, epoch);
      return this.finishSync(record, record.siyuanBlockId, owned, targetRevision, jobId, epoch);
    }
    let docId = previous?.docId;
    if (!docId) {
      const rows = await this.query(`SELECT id FROM blocks WHERE box=${sqlLiteral(owned.notebookId)} AND hpath=${sqlLiteral(path)} AND type='d' LIMIT 2`, epoch);
      this.assertEpoch(epoch);
      if (rows.length > 1) fail(409, 'DESTINATION_CONFLICT', '发现重复同步目标，需要人工检查。');
      if (rows[0]) {
        if (!previous?.creationPending) fail(403, 'OWNERSHIP_REQUIRED', '不能写入未经应用创建的文档。');
        docId = rows[0].id;
      } else {
        if (previous?.creationPending) fail(409, 'RECONCILIATION_REQUIRED', '上次创建结果未知，暂不重复创建。');
        this.store.put('sync-target', { knowledgeId, creationPending: true, path, connectionEpoch: epoch }, versionKey);
        const markdown = `# 知识候选（用户已接受）\n\n${fenced(`问题：${record.question}\n\n答案：${record.answer}`)}\n\n来源（保留原文）：\n${record.sourceRefs.map(ref => fenced(`${ref.title}\n${ref.url ?? ref.externalId}\nSHA-256: ${ref.contentDigest}`)).join('\n\n')}`;
        docId = await this.call('/api/filetree/createDocWithMd', { notebook: owned.notebookId, path, markdown }, false, epoch);
        if (typeof docId !== 'string') fail(502, 'UPSTREAM_ERROR', 'SiYuan 未返回文档 ID。');
      }
      this.store.put('sync-target', { knowledgeId, docId, path, creationPending: false, connectionEpoch: epoch }, versionKey);
    }
    await this.call('/api/attr/setBlockAttrs', { id: blockId(docId), attrs: { 'custom-second-brain-owner': owned.identity, 'custom-second-brain-knowledge': record.id } }, false, epoch);
    const children = await this.call('/api/block/getChildBlocks', { id: docId }, true, epoch);
    const cardBlock = Array.isArray(children) && (children.find(item => item.type === 'code') ?? children.find(item => item.type === 'p') ?? children.find(item => item.type !== 'h'));
    if (!cardBlock?.id) fail(502, 'UPSTREAM_ERROR', 'SiYuan 未返回可用卡片块。');
    await this.call('/api/attr/setBlockAttrs', { id: blockId(cardBlock.id), attrs: { 'custom-second-brain-owner': owned.identity, 'custom-second-brain-knowledge': record.id } }, false, epoch);
    await this.call('/api/riff/addRiffCards', { deckID: owned.deckId, blockIDs: [cardBlock.id] }, false, epoch);
    await this.call('/api/sqlite/flushTransaction', {}, true, epoch);
    return this.finishSync(record, cardBlock.id, owned, targetRevision, jobId, epoch);
  }

  async finishSync(record, cardBlockId, owned, targetRevision, jobId, epoch = this.epoch()) {
    const target = this.store.get('sync-target', record.id) ?? {};
    let cardId = target.cardId ?? null;
    try {
      const due = await this.dueCards([], epoch);
      cardId = due.cards.find(card => card.blockID === cardBlockId)?.cardID ?? cardId;
    } catch {} // Card identity is optional enrichment; all required writes have already returned code 0.
    return this.store.transaction(() => {
      this.assertEpoch(epoch);
      const current = this.store.require('knowledge', record.id);
      const syncedAt = now();
      this.store.put('knowledge', { ...current, siyuanBlockId: cardBlockId,
        sync: { ...current.sync, status: current.status === 'accepted' && current.revision === record.revision ? 'synced' : 'stale',
          lastSyncedRevision: targetRevision ?? record.revision, lastSyncedAt: syncedAt, lastError: null, jobId } });
      const receipt = { knowledgeId: record.id, knowledgeRevision: targetRevision ?? record.revision, siyuanBlockId: cardBlockId, notebookId: owned.notebookId, cardId, syncedAt };
      this.store.put('sync-target', { ...target, cardBlockId, cardId, state: 'confirmed', confirmedJobId: jobId, receipt }, record.id);
      return receipt;
    });
  }

  async dueCards(reviewedCards = [], epoch = this.epoch()) {
    await this.compatible(epoch);
    this.assertEpoch(epoch);
    const owned = this.store.get('config', 'siyuan-owned');
    if (!owned?.deckId) return { cards: [], unreviewedCount: 0, scope: 'app-owned' };
    const data = await this.call('/api/riff/getRiffDueCards', { deckID: owned.deckId, reviewedCards }, true, epoch);
    if (!data || data.cards !== null && !Array.isArray(data.cards) || !Number.isInteger(data.unreviewedCount)) fail(502, 'UPSTREAM_ERROR', 'Riff 待复习数据无效。');
    const cards = (data.cards ?? []).map(card => {
      if (!card || !['deckID', 'cardID', 'blockID'].every(key => typeof card[key] === 'string') || !Number.isInteger(card.reps) || !Number.isFinite(card.lastReview)) fail(502, 'UPSTREAM_ERROR', 'Riff 卡片格式无效。');
      return card;
    });
    return { ...data, cards };
  }

  async grade(card, rating, reviewedCards, epoch = this.epoch()) {
    choice(rating, Object.keys(RIFF_RATINGS), 'rating');
    return this.call('/api/riff/reviewRiffCard', { deckID: card.deckID, cardID: card.cardID, rating: RIFF_RATINGS[rating], reviewedCards }, false, epoch);
  }
}
