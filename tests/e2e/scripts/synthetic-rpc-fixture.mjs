import { fileURLToPath } from 'node:url';

export const READ_ONLY_RPC_METHODS = Object.freeze([
  'initialize', 'thread/list', 'thread/read', 'thread/turns/list', 'thread/items/list',
]);
export const SYNTHETIC_THREAD_ID = '1f3865b8-1111-4111-8111-111111111111';
export const SYNTHETIC_THREAD_TITLE = 'E2E-SB-synthetic-read-only-conversation';
export const SYNTHETIC_TURN_ID = '2f3865b8-2222-4222-8222-222222222222';
export const SYNTHETIC_USER_ID = '3f3865b8-3333-4333-8333-333333333333';
export const SYNTHETIC_AGENT_ID = '4f3865b8-4444-4444-8444-444444444444';
const methods = new Set(READ_ONLY_RPC_METHODS);

function rpcError(code, message) {
  const error = new Error(`E2E-SB synthetic RPC: ${message}`);
  error.name = 'SyntheticRpcError';
  error.rpcCode = code;
  return error;
}

function page(items, { cursor = null, limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw rpcError(-32602, 'limit must be an integer from 1 to 100.');
  const match = typeof cursor === 'string' && /^E2E-SB-cursor-(\d+)$/.exec(cursor);
  const offset = cursor === null ? 0 : match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) throw rpcError(-32602, 'unknown synthetic cursor.');
  const end = Math.min(offset + limit, items.length);
  return { data: items.slice(offset, end), nextCursor: end < items.length ? `E2E-SB-cursor-${end}` : null };
}

function records(projectPath) {
  const timestamp = Date.parse('2026-10-27T00:00:00Z') / 1000;
  const thread = { id: SYNTHETIC_THREAD_ID, title: SYNTHETIC_THREAD_TITLE, cwd: projectPath, createdAt: timestamp, updatedAt: timestamp, archived: false };
  const items = [
    { id: SYNTHETIC_USER_ID, type: 'userMessage', createdAt: timestamp, content: [{ type: 'text', text: 'E2E-SB-synthetic-question: explain a small checkable learning step.' }] },
    { id: SYNTHETIC_AGENT_ID, type: 'agentMessage', createdAt: timestamp, text: 'E2E-SB-synthetic-answer: this is unverified fixture material, not a real Codex reply.' },
  ];
  return { thread, items, turn: { id: SYNTHETIC_TURN_ID, status: 'completed', itemsView: 'full', items } };
}

export function createSyntheticRpcFactory({ projectPath = fileURLToPath(new URL('../artifacts/E2E-SB-synthetic-project/', import.meta.url)) } = {}) {
  const fixture = records(projectPath);
  const hello = { userAgent: 'E2E-SB-synthetic-rpc', serverInfo: { name: 'E2E-SB-synthetic-rpc', version: '0.0.0-synthetic' }, synthetic: true };
  return function syntheticRpcFactory() {
    let state = 'new';
    const client = {
      negotiated: null,
      async start() {
        await client.request('initialize');
        return client;
      },
      async request(method, params = {}) {
        if (!methods.has(method)) throw rpcError(-32601, 'only the five read protocol methods are allowed.');
        if (state === 'closed') throw rpcError(-32000, 'client is closed.');
        if (!params || typeof params !== 'object' || Array.isArray(params)) throw rpcError(-32602, 'params must be an object.');
        if (method === 'initialize') {
          state = 'ready';
          client.negotiated = { server: structuredClone(hello), protocol: 'e2e-synthetic-in-memory', readOnly: true, synthetic: true };
          return structuredClone(hello);
        }
        if (state !== 'ready') throw rpcError(-32000, 'initialize or start the client before reading.');
        if (method === 'thread/list') {
          const excluded = params.archived === true || params.excludedThreadIds?.includes(SYNTHETIC_THREAD_ID);
          return structuredClone(page(excluded ? [] : [fixture.thread], params));
        }
        if (params.threadId !== SYNTHETIC_THREAD_ID) throw rpcError(-32602, 'unknown synthetic threadId.');
        if (method === 'thread/read') return structuredClone({ thread: { ...fixture.thread, turns: params.includeTurns === false ? [] : [fixture.turn] } });
        const items = method === 'thread/items/list' ? fixture.items : [fixture.turn];
        return structuredClone(page(items, params));
      },
      async close() { state = 'closed'; },
    };
    return client;
  };
}
