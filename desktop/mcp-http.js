'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MCP_FALLBACK_PROTOCOL_VERSION = '2025-06-18';
const MCP_MAX_BODY_BYTES = 64 * 1024;
const MCP_CALL_TIMEOUT_MS = 20000;
const MCP_TOKEN_FILE = 'mcp-token.txt';
const MCP_CLIENT_INFO_FILE = 'mcp.json';

// Schemas avoid additionalProperties and union types: Gemini-based clients reject them.
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const tool = (name, description, properties, required) => ({
  name,
  description,
  inputSchema: Object.assign(
    { type: 'object', properties: properties || {} },
    required && required.length ? { required } : {}
  ),
});

const MCP_TOOLS = [
  tool('player_toggle', '播放 / 暂停切换'),
  tool('player_next', '下一首'),
  tool('player_prev', '上一首'),
  tool('player_set_volume', '设置音量：value 为 0-100；或 direction=up/down 按 step（默认 10）增减', {
    value: num('目标音量 0-100'),
    direction: { type: 'string', enum: ['up', 'down'], description: '增大或减小' },
    step: num('增减幅度，默认 10'),
  }),
  tool('player_seek', '跳转进度：seconds 为绝对秒数；或 delta 为相对秒数（负数后退）', {
    seconds: num('绝对位置（秒）'),
    delta: num('相对偏移（秒），负数后退'),
  }),
  tool('player_now_playing', '查询当前歌曲、播放状态、进度、音量、播放模式、是否红心'),
  tool('player_set_play_mode', '设置播放模式', {
    mode: { type: 'string', enum: ['loop', 'shuffle', 'single'], description: 'loop 顺序循环 / shuffle 随机 / single 单曲循环' },
  }, ['mode']),
  tool('player_like_current', '红心或取消红心当前歌曲（需已登录对应平台）', {
    liked: { type: 'boolean', description: '默认 true；false 为取消红心' },
  }),
  tool('music_search_and_play', '按歌名 / 歌手放歌：先匹配红心歌单和播放历史，找不到再搜网易云，直接播第一个', {
    query: str('歌名、歌手，或两者'),
  }, ['query']),
  tool('music_play_next_candidate', '「换一个」：播放上一次 music_search_and_play 的下一个候选'),
  tool('music_play_playlist', '按名称播放网易云账号里的歌单，「我喜欢」即红心歌单', {
    name: str('歌单名，可模糊'),
  }, ['name']),
  tool('fx_set_preset', '切换视觉预设（如 星河、唱片、月蚀圣环），可模糊匹配', {
    name: str('预设名'),
  }, ['name']),
  tool('fx_apply_archive', '应用一个用户视觉存档', {
    name: str('存档名，可模糊'),
  }, ['name']),
  tool('fx_find_params', '按控制台里的中文参数名或别名查找可调视觉参数，返回 id、类型、当前值、范围。调参前先调用它；0 个结果就换同义词再查（如 泛光→光晕，粒子速度→运动速度）', {
    query: str('关键词，如 光晕、歌词大小、运动速度、律动强度'),
  }, ['query']),
  tool('fx_set_param', '设置视觉参数：滑块传 value（会夹到范围内），开关传 on', {
    id: str('fx_find_params 返回的 id'),
    value: num('滑块目标值'),
    on: { type: 'boolean', description: '开关目标状态' },
  }, ['id']),
  tool('fx_adjust_param', '相对调整滑块参数：delta 为原始单位；或 direction=up/down 按范围的 10% 调整', {
    id: str('fx_find_params 返回的 id'),
    delta: num('增量（原始单位）'),
    direction: { type: 'string', enum: ['up', 'down'], description: '增大或减小' },
  }, ['id']),
  tool('wallpaper_set_by_name', '按标题模糊匹配切换 Wallpaper Engine 壁纸', {
    name: str('壁纸标题关键词'),
  }, ['name']),
  tool('wallpaper_random', '随机切换一个 Wallpaper Engine 壁纸'),
  tool('wallpaper_restore', '关闭 Wallpaper Engine 壁纸，恢复原背景'),
  tool('history_undo', '撤销最近一次视觉修改（控制台撤销历史：预设 / 存档 / 参数；播放操作不可撤销）'),
];

const MCP_TOOL_NAMES = new Set(MCP_TOOLS.map((item) => item.name));

function readOrCreateMcpToken(userDataPath) {
  const file = path.join(userDataPath, MCP_TOKEN_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  } catch (_) {}
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token + '\n', { encoding: 'utf8', mode: 0o600 });
  return token;
}

function writeMcpClientInfo(userDataPath, port, token) {
  const info = {
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
  };
  fs.writeFileSync(path.join(userDataPath, MCP_CLIENT_INFO_FILE), JSON.stringify(info, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function bearerTokenMatches(header, token) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  if (!match || !token) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendEmpty(res, status, headers) {
  res.writeHead(status, headers || {});
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MCP_MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `渲染层 ${Math.round(ms / 1000)} 秒内未响应（操作可能仍在执行）` }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createMcpHttpHandler(options) {
  const serverName = (options && options.serverName) || 'mineradio';
  const serverVersion = (options && options.serverVersion) || '0.0.0';
  const callTimeoutMs = (options && options.callTimeoutMs) || MCP_CALL_TIMEOUT_MS;
  let bridge = null;

  async function callTool(id, params) {
    const name = params && params.name;
    if (!MCP_TOOL_NAMES.has(name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
    let outcome;
    try {
      outcome = await withTimeout(Promise.resolve(bridge.dispatch(name, args)), callTimeoutMs);
    } catch (error) {
      outcome = { ok: false, error: String((error && error.message) || error).slice(0, 500) };
    }
    if (!outcome || typeof outcome !== 'object') outcome = { ok: false, error: '渲染层返回无效结果' };
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(outcome) }],
      isError: outcome.ok !== true,
    });
  }

  async function handleMessage(message) {
    if (message.id === undefined) return null;
    const { id, method, params } = message;
    if (method === 'initialize') {
      const requested = params && params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: serverName, version: serverVersion },
      });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: MCP_TOOLS });
    if (method === 'tools/call') return callTool(id, params);
    return rpcError(id, -32601, `Method not found: ${method}`);
  }

  async function handle(req, res) {
    try {
      if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) return sendJson(res, 403, rpcError(null, -32000, 'Loopback only'));
      if (req.headers.origin) return sendJson(res, 403, rpcError(null, -32000, 'Browser origins are not allowed'));
      if (!bridge) return sendJson(res, 503, rpcError(null, -32000, 'Mineradio MCP bridge is not ready'));
      if (!bearerTokenMatches(req.headers.authorization, bridge.token)) return sendJson(res, 401, rpcError(null, -32001, 'Unauthorized'));
      if (req.method !== 'POST') return sendEmpty(res, 405, { Allow: 'POST' });
      const raw = await readBody(req);
      if (raw === null) return sendJson(res, 413, rpcError(null, -32600, 'Request body too large'));
      let message;
      try {
        message = JSON.parse(raw);
      } catch (_) {
        return sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
      }
      if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
        return sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
      }
      if (message.method === undefined) return sendEmpty(res, 202);
      const reply = await handleMessage(message);
      if (!reply) return sendEmpty(res, 202);
      return sendJson(res, 200, reply);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, rpcError(null, -32603, String((error && error.message) || error).slice(0, 200)));
      else res.end();
    }
  }

  function setBridge(next) {
    bridge = next && next.token && typeof next.dispatch === 'function' ? next : null;
  }

  return { handle, setBridge };
}

module.exports = {
  MCP_TOOLS,
  createMcpHttpHandler,
  readOrCreateMcpToken,
  writeMcpClientInfo,
};
