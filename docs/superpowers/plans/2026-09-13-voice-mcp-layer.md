# 语音助手 · 第一阶段 MCP 层 Implementation Plan

> **For agentic workers:** 按任务顺序执行，每步用 `- [ ]` 勾选。每个任务先写测试、看它失败、再实现、看它通过。**不要 git commit**（运行目录不是仓库，提交由 Claude 审完 diff 后在 fork 做）。

**Goal:** 在 Mineradio 已有本地服务上挂一个带令牌的 MCP 端点 `http://127.0.0.1:<port>/mcp`，暴露 20 个工具（播放 / 网易云音乐 / 视觉特效 / WE 壁纸 / 撤销），让 AI 客户端打字就能操控播放器。

**Architecture:** MCP 客户端 → `server.js` 的 `/mcp` 路由（协议层 `desktop/mcp-http.js`，手写最小 Streamable HTTP，只回 `application/json`）→ 主进程注入的 bridge（`desktop/main.js`，`webContents.executeJavaScript` 调用渲染层）→ 渲染层 `window.__mineradioMcpCall`（`public/js/modules/10-shell/06-mcp-tools.js`）→ 现有播放 / 视觉 / 壁纸函数。不重写任何播放或视觉逻辑。

**Tech Stack:** Node `http` + `crypto`（零新依赖）、Electron `executeJavaScript`、渲染层经典脚本全局函数、`node tests/*.test.js` 裸跑 `node:assert` 测试。

---

## 0. 背景事实（已由 Claude 核对源码，实施时不用再查）

**工作目录：`D:\Mineradio\resources\app\`**（实际运行的明文源码，改这里才生效）。下文所有路径都相对这个目录。

| 事实 | 位置 |
|---|---|
| `server.js` 在 Electron 主进程里 `require` 执行，不是子进程；主进程先设 `HOST=127.0.0.1`、`PORT=findOpenPort(3000)` | `desktop/main.js` `ensureLocalServerStarted()`（约 5283 行）、`configureLocalServerEnvironment()`（约 5064 行） |
| `server.js` 单独运行时 HOST 默认 `0.0.0.0`，所以 `/mcp` 必须自己校验回环地址 + 令牌 | `server.js:122` |
| `server.js` 路由写法 `if (pn === '/api/...')`，请求处理器在 `http.createServer(async (req, res) => {` | `server.js:4635` |
| `server.js` 结尾 `server.clearAllLoginCredentials = ...; module.exports = server;` | `server.js:6715-6717` |
| 主进程 → 渲染层取返回值的现成写法：`mainWindow.webContents.executeJavaScript(script, true)`，脚本里调 `window.__xxx` | `desktop/main.js` 约 1070-1100 行 |
| userData 目录常量 `STABLE_USER_DATA_PATH`（通常 `%APPDATA%\Mineradio`） | `desktop/main.js:192` |
| 渲染层模块是经典 `<script>`，顶层 `function` / `var` 都是全局；新模块要登记到加载列表 | `public/js/index-loader.js:103-111` |
| `showToast(msg)` | `public/js/modules/09-idle-toast-libraries.js:484` |
| 播放：`togglePlay()` async、`nextTrack(true)`、`prevTrack(true)`、`cyclePlayMode()`、`playModeLabel(mode)`、全局 `playMode`（`loop`/`shuffle`/`single`） | `05-playback/14-player-controls.js:540/640/664/748/701` |
| 音量：`setVolume(0..1, silent)`、全局 `targetVolume` | `05-playback/08-audio-graph-controls.js:611` |
| 进度：`getPlaybackDurationSeconds()`、`getPlaybackCurrentSeconds()`、`commitProgressSeek(秒, 是否继续播放)` | `06-lyrics/04-progress-seek.js:141/145/392` |
| 当前歌：`currentCoverSong()`；红心：`isSongLiked(song)`、`toggleLikeCurrent()`、`isSongAccountLoggedIn(provider)`（未登录时 `toggleLikeSong` 会弹登录框，所以要先查） | `05-playback/06-track-detail-lyrics-actions.js:1/1262/1437/1246` |
| 全局 `playing`、`playQueue`、`currentIdx`、`playlist`（搜索结果） | `00-state/00-core-stores.js:22` |
| 搜索：`fetchMusicSearchResults(q, 'netease')` → `{ songs, providerPages, hasMore }`，失败原因在全局 `searchProviderNotice`；`songProviderKey(song)` 返回 `netease/qq/kugou/qishui/spotify` | `05-playback/07-search.js:1062/439` |
| 点搜索结果播放：`playSearchResult(i)`（入队到队首 → `playQueueAt(currentIdx)`），依赖 `playlist[i]`，所以 MCP 里按同样规则写一个接收 song 对象的版本 | `05-playback/10-queue-actions.js:87` |
| 播放历史：全局 `listenStatsState.songs`（对象，值含 `plays`、`name`、`artist`），`songFromListenRecord(record)` 转成可播 song | `05-playback/02-listen-stats.js`、`05-playback/05-home-actions.js:1` |
| 歌单：全局 `userPlaylists`；`playlistAccountProvider(pl)`；红心歌单 `Number(pl.specialType) === 5`；`fetchPlaylistTracksPage('netease', id, { limit, offset })` → `{ tracks }`；`loadPlaylistIntoQueueById(id, true, title)` 失败返回 `false` | `06-lyrics/02-playlist-detail.js:277`、`06-lyrics/03-podcast-playlist-loaders.js:210` |
| 视觉预设：`presetMeta`（`{ name, desc }` 数组，**有两个都叫「音域回响」**）、`setPreset(index, { silent })` | `07-fx/00-preset-archive-data.js:2`、`07-fx/04-preset-grid-uniforms.js:71` |
| 用户存档：全局 `userFxArchives`（`{ name, snapshot }`）、`applyFxArchiveSnapshot(snapshot)` 返回布尔（`applyUserFxArchive` 定义了两次，内部都调它） | `07-fx/00-preset-archive-data.js:716/757` |
| 控制台参数目录：全局 `fxConsoleRegistry`，每项 `{ title, aliases(空格分隔中文别名), tab, groupLabel, history, element }`；`fxConsoleEntryForElement(el)` | `07-fx/09-console-workspace.js:300/529` |
| 滑块 → `fx` 字段：`bindFxPanel()` 里 `ids` 表逐个 `el.addEventListener('input', ...)`；所以**给 `input.value` 赋值再派发 `input` 事件**就走现有逻辑。取值范围直接读 `input.min/max/step` | `07-fx/07-bindings-shelf-immersive.js:13-60` |
| 开关：`.fx-toggle` 元素，`onclick="toggleFx('key')"`，开启态 class 是 `on` | `public/index.html`、`07-fx/05-fx-panel-performance.js:336` |
| 撤销历史：`captureFxConsoleState()`、`pushFxConsoleHistory(label, key, before, after, mergeable)`（内部已 `renderFxConsoleHistory()`）、`undoFxConsoleHistory()`（自带 toast「已回退：xx」）、全局 `fxConsoleHistory`、`fxConsoleHistoryTxn`。控制台在 `#fx-panel` 上监听 click，点 `.fx-toggle` 会**自动**写历史 | `07-fx/09-console-workspace.js:661/741/854/1022` |
| 控制台里不可逆 / 系统类区域：`#audio-output-panel,#cache-storage-panel,.memory-action-row,.bg-media-row,.wallpaper-engine-row`；`tab === 'system'` 是系统页 | `07-fx/09-console-workspace.js:915-919` |
| WE 壁纸：全局 `wallpaperEngineProjects`（`{ id, title, playable, enginePlayable, hasPreview }`）、`loadWallpaperEngineLibrary(force, showNotice)`、`hiddenWallpaperEngineIds`（Set）、`activateWallpaperEngineItem(id)`、`deactivateWallpaperEngineBackground(quiet)`、全局 `wallpaperEngineSelection.active/.id` | `07-fx/03-wallpaper-engine-library.js:4/2228/2373/1768/1798` |

**和设计共识的两处差异（Claude 决定，已告知用户）：**
1. 工具名用下划线（`player_toggle`）而不是点（`player.toggle`）：Anthropic API 的工具名只允许 `[a-zA-Z0-9_-]`，用点号会让 Claude Code 这个备选客户端接不上。
2. 设计写「16 个工具」，但列出来的是 20 个，按列出的 20 个做。

**假设（实施中如发现不成立，停下来报告）：**
- 只读查询（`player_now_playing`、`fx_find_params`）不弹 toast，其余每次执行都弹「🤖 …」。
- `history_undo` 只撤销控制台视觉历史（预设 / 存档 / 参数），播放类操作不可撤销。
- 客户端请求不带 `Origin` 头（Node 进程发的请求默认不带）；带了就 403，防浏览器网页跨站调用。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `desktop/mcp-http.js` | 新建 | 工具清单、JSON-RPC/MCP 协议、令牌读写、回环 + 令牌 + Origin 校验。不依赖 Electron，可单测 |
| `tests/mcp-http.test.js` | 新建 | 起真 HTTP 服务测协议和安全校验 |
| `server.js` | 改 3 处 | require 协议层、挂 `/mcp` 路由、导出 `setMcpBridge` |
| `desktop/main.js` | 改 3 处 | require、生成令牌 + 写 `mcp.json`、把工具调用转发到渲染层 |
| `public/js/modules/05-playback/14-player-controls.js` | 改 1 处 | 从 `cyclePlayMode` 拆出 `setPlayMode(mode)`，避免「loop→single」途经 shuffle 打乱队列 |
| `public/js/modules/10-shell/06-mcp-tools.js` | 新建 | 20 个工具的渲染层实现 + `window.__mineradioMcpCall` |
| `public/js/index-loader.js` | 改 1 行 | 登记新模块 |
| `tests/mcp-renderer-tools.test.js` | 新建 | 工具名两端一致、加载列表、匹配函数行为 |

---

### Task 1: 协议层 `desktop/mcp-http.js`

**Files:**
- Create: `desktop/mcp-http.js`
- Test: `tests/mcp-http.test.js`

- [ ] **Step 1: 写失败测试** —— 新建 `tests/mcp-http.test.js`：

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { MCP_TOOLS, createMcpHttpHandler, readOrCreateMcpToken, writeMcpClientInfo } = require('../desktop/mcp-http');

function post(port, body, headers) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(data),
      }, headers),
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-mcp-'));
  const token = readOrCreateMcpToken(dir);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(readOrCreateMcpToken(dir), token);
  writeMcpClientInfo(dir, 3123, token);
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'));
  assert.equal(info.url, 'http://127.0.0.1:3123/mcp');
  assert.equal(info.headers.Authorization, 'Bearer ' + token);

  assert.equal(MCP_TOOLS.length, 20);
  for (const tool of MCP_TOOLS) {
    assert.match(tool.name, /^[a-z]+_[a-z_]+$/);
    assert.equal(tool.inputSchema.type, 'object');
  }
  assert.equal(MCP_TOOLS.some((tool) => /delete|remove|login|logout|cache|memory|quit|exit|close/.test(tool.name)), false);

  const calls = [];
  const mcp = createMcpHttpHandler({ serverVersion: 'test', callTimeoutMs: 200 });
  const server = http.createServer((req, res) => mcp.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const auth = { Authorization: 'Bearer ' + token };
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

  assert.equal((await post(port, init, auth)).status, 503);

  mcp.setBridge({
    token,
    dispatch: async (name, args) => {
      calls.push([name, args]);
      if (name === 'wallpaper_random') return new Promise(() => {});
      return { ok: true, message: 'done' };
    },
  });

  assert.equal((await post(port, init, {})).status, 401);
  assert.equal((await post(port, init, { Authorization: 'Bearer ' + '0'.repeat(64) })).status, 401);
  assert.equal((await post(port, init, Object.assign({ Origin: 'http://evil.example' }, auth))).status, 403);

  const initRes = await post(port, init, auth);
  assert.equal(initRes.status, 200);
  assert.equal(initRes.json.result.protocolVersion, '2025-06-18');
  assert.deepEqual(initRes.json.result.capabilities, { tools: { listChanged: false } });
  assert.equal(initRes.json.result.serverInfo.name, 'mineradio');

  const oldClient = await post(port, Object.assign({}, init, { params: { protocolVersion: '1999-01-01' } }), auth);
  assert.equal(oldClient.json.result.protocolVersion, '2025-06-18');

  assert.equal((await post(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth)).status, 202);

  const list = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
  assert.equal(list.json.result.tools.length, 20);

  const call = await post(port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'player_next', arguments: {} } }, auth);
  assert.equal(call.json.id, 3);
  assert.equal(call.json.result.isError, false);
  assert.deepEqual(JSON.parse(call.json.result.content[0].text), { ok: true, message: 'done' });
  assert.deepEqual(calls[0], ['player_next', {}]);

  const unknown = await post(port, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'app_quit', arguments: {} } }, auth);
  assert.equal(unknown.json.error.code, -32602);
  assert.equal(calls.length, 1);

  const slow = await post(port, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'wallpaper_random' } }, auth);
  assert.equal(slow.json.result.isError, true);

  assert.equal((await post(port, '{bad', auth)).json.error.code, -32700);
  assert.equal((await post(port, { jsonrpc: '2.0', id: 6, method: 'nope' }, auth)).json.error.code, -32601);
  assert.equal((await post(port, { jsonrpc: '2.0', id: 7, method: 'ping' }, auth)).json.result && true, true);

  server.close();
  console.log('OK mcp-http');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/mcp-http.test.js`
Expected: FAIL，`Cannot find module '../desktop/mcp-http'`

- [ ] **Step 3: 实现** —— 新建 `desktop/mcp-http.js`：

```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/mcp-http.test.js`
Expected: 输出 `OK mcp-http`，退出码 0

---

### Task 2: `server.js` 挂 `/mcp`

**Files:**
- Modify: `server.js:119`（require 区末尾）、`server.js:145`（`APP_VERSION` 之后）、`server.js:4638`（`const pn = url.pathname;` 之后）、`server.js:6715`（导出前）

- [ ] **Step 1: 在 `const { planCuefieldTransitionFromCache } = require('./cuefield/mineradio-bridge');` 下一行加：**

```js
const { createMcpHttpHandler } = require('./desktop/mcp-http');
```

- [ ] **Step 2: 在 `const APP_VERSION = ...;` 下一行加：**

```js
const mcpHttp = createMcpHttpHandler({ serverVersion: APP_VERSION });
```

- [ ] **Step 3: 在请求处理器里 `const pn = url.pathname;` 下一行加：**

```js
  if (pn === '/mcp') {
    await mcpHttp.handle(req, res);
    return;
  }
```

- [ ] **Step 4: 在 `server.clearAllLoginCredentials = clearAllRuntimeLoginCredentials;` 下一行加：**

```js
server.setMcpBridge = mcpHttp.setBridge;
```

- [ ] **Step 5: 语法检查**

Run: `node --check server.js`
Expected: 无输出，退出码 0

---

### Task 3: `desktop/main.js` 令牌 + 转发到渲染层

**Files:**
- Modify: `desktop/main.js:19`（require 区）、`sendGlobalHotkeyAction` 函数之后（约 1818 行）、`ensureLocalServerStarted()` 内（约 5300 行）

- [ ] **Step 1: 在 `const { FullDesktopModeRuntime } = require('./full-desktop-mode-runtime');` 下一行加：**

```js
const { readOrCreateMcpToken, writeMcpClientInfo } = require('./mcp-http');
```

- [ ] **Step 2: 在 `function sendGlobalHotkeyAction(action) { ... }` 整个函数之后加：**

```js
async function dispatchMcpToolToRenderer(name, args) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '主窗口未就绪' };
  const script = `(() => {
    const call = window.__mineradioMcpCall;
    if (typeof call !== 'function') return { ok: false, error: 'MCP 渲染层未加载' };
    return Promise.resolve(call(${JSON.stringify(String(name))}, ${JSON.stringify(args || {})}))
      .catch((error) => ({ ok: false, error: String(error && (error.message || error) || 'MCP_CALL_FAILED').slice(0, 500) }));
  })()`;
  try {
    return await mainWindow.webContents.executeJavaScript(script, true);
  } catch (error) {
    return { ok: false, error: String(error && (error.message || error.name) || error || 'MCP_RENDERER_FAILED').slice(0, 500) };
  }
}

function attachMcpBridge(server, port) {
  if (!server || typeof server.setMcpBridge !== 'function') return;
  try {
    const token = readOrCreateMcpToken(STABLE_USER_DATA_PATH);
    writeMcpClientInfo(STABLE_USER_DATA_PATH, port, token);
    server.setMcpBridge({ token, dispatch: dispatchMcpToolToRenderer });
  } catch (error) {
    console.warn('[MCP] bridge disabled:', error && error.message || error);
  }
}
```

- [ ] **Step 3: 在 `ensureLocalServerStarted()` 里 `await waitForLocalHttpReady(port, STARTUP_HTTP_TIMEOUT_MS);` 下一行加：**

```js
    attachMcpBridge(localServer, port);
```

- [ ] **Step 4: 语法检查 + 相关回归**

Run: `node --check desktop/main.js && node tests/main-window-runtime-recovery.test.js`
Expected: 第二条输出以 `OK` 开头，退出码 0

---

### Task 4: 拆出 `setPlayMode(mode)`

**Files:**
- Modify: `public/js/modules/05-playback/14-player-controls.js:748-764`

- [ ] **Step 1: 把整个 `function cyclePlayMode() { ... }` 替换为下面两段（逻辑逐行保留，只是目标模式改成参数）：**

```js
function setPlayMode(nextMode) {
  var prevMode = playMode;
  playMode = nextMode;
  if (playMode === 'shuffle' && prevMode !== 'shuffle') {
    reorderQueueForShufflePlaybackOrder(currentIdx, { reason: 'play-mode-shuffle' });
  }
  if (typeof syncActiveAudioRepeatMode === 'function') syncActiveAudioRepeatMode(audio);
  if (playMode === 'single' && prevMode !== 'single') {
    if (typeof clearAlbumGaplessPreload === 'function') clearAlbumGaplessPreload('play-mode-single');
    if (typeof resetCuefieldAutoMix === 'function') resetCuefieldAutoMix('play-mode-single');
  }
  updatePlayModeButton(true);
  showToast('播放模式: ' + playModeLabel(playMode));
}
function cyclePlayMode() {
  var modes = ['loop', 'shuffle', 'single'];
  setPlayMode(modes[(modes.indexOf(playMode) + 1) % modes.length]);
}
```

- [ ] **Step 2: 语法检查**

Run: `node --check public/js/modules/05-playback/14-player-controls.js`
Expected: 无输出，退出码 0

---

### Task 5: 渲染层工具 `10-shell/06-mcp-tools.js`

**Files:**
- Create: `public/js/modules/10-shell/06-mcp-tools.js`
- Modify: `public/js/index-loader.js:109`
- Test: `tests/mcp-renderer-tools.test.js`

- [ ] **Step 1: 写失败测试** —— 新建 `tests/mcp-renderer-tools.test.js`：

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { MCP_TOOLS } = require('../desktop/mcp-http');

const appRoot = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
const source = read('public/js/modules/10-shell/06-mcp-tools.js');
const loader = read('public/js/index-loader.js');
const server = read('server.js');
const main = read('desktop/main.js');

const handlerNames = Array.from(source.matchAll(/^  ([a-z]+_[a-z_]+): (?:async )?function/gm), (m) => m[1]).sort();
assert.deepEqual(handlerNames, MCP_TOOLS.map((tool) => tool.name).sort());

assert.match(loader, /'js\/modules\/10-shell\/05-startup-bindings\.js',\s*'js\/modules\/10-shell\/06-mcp-tools\.js',\s*'js\/modules\/11-main-loop\.js'/);
assert.match(server, /if \(pn === '\/mcp'\)/);
assert.match(server, /server\.setMcpBridge = mcpHttp\.setBridge/);
assert.match(main, /attachMcpBridge\(localServer, port\)/);
assert.match(source, /captureFxConsoleState\(\)/);
assert.match(source, /pushFxConsoleHistory\(/);
assert.match(source, /tab === 'system'/);
assert.doesNotMatch(source, /cyclePlayMode\(/);

const ctx = { window: {}, console };
vm.createContext(ctx);
vm.runInContext(source, ctx);
assert.equal(typeof ctx.window.__mineradioMcpCall, 'function');

assert.equal(ctx.mcpNorm(' 晴天 (Live)·周杰伦 '), '晴天live周杰伦');
assert.equal(ctx.mcpSongMatches('晴天', { name: '晴天', artist: '周杰伦' }), true);
assert.equal(ctx.mcpSongMatches('周杰伦的晴天', { name: '晴天', artist: '周杰伦' }), true);
assert.equal(ctx.mcpSongMatches('晴天', { name: '晴天娃娃', artist: '某人' }), false);
assert.equal(ctx.mcpSongMatches('七里香', { name: '晴天', artist: '周杰伦' }), false);

const presets = [{ name: '星河' }, { name: '音域回响' }, { name: '音域回响' }, { name: '月蚀圣环' }];
const star = ctx.mcpBestMatch('星河', presets, (it) => it.name);
assert.equal(star.item.name, '星河');
assert.equal(ctx.mcpBestMatch('月蚀', presets, (it) => it.name).item.name, '月蚀圣环');
assert.equal(ctx.mcpBestMatch('音域回响', presets, (it) => it.name).matches.length, 2);
assert.equal(ctx.mcpBestMatch('不存在', presets, (it) => it.name).item, null);

assert.equal(ctx.mcpFormatTime(75), '1:15');

console.log('OK mcp-renderer-tools');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/mcp-renderer-tools.test.js`
Expected: FAIL，`ENOENT ... 06-mcp-tools.js`

- [ ] **Step 3: 登记模块** —— `public/js/index-loader.js` 里把：

```js
    'js/modules/10-shell/05-startup-bindings.js',
    'js/modules/11-main-loop.js',
```

改成：

```js
    'js/modules/10-shell/05-startup-bindings.js',
    'js/modules/10-shell/06-mcp-tools.js',
    'js/modules/11-main-loop.js',
```

- [ ] **Step 4: 实现** —— 新建 `public/js/modules/10-shell/06-mcp-tools.js`：

```js
'use strict';

// MCP tools called from the main process (desktop/main.js dispatchMcpToolToRenderer).
// Every handler reuses existing player / fx / wallpaper functions; tool names must match desktop/mcp-http.js.

var mcpMusicState = { query: '', candidates: [], searched: false, played: [] };
var mcpLikedSongsCache = null;
var MCP_UNSAFE_CONTROL_AREAS = '#audio-output-panel,#cache-storage-panel,.memory-action-row,.bg-media-row,.wallpaper-engine-row';

function mcpNorm(text) {
  return String(text || '').toLowerCase().replace(/[\s·・,，。.!！?？'"“”‘’|\-_/()（）\[\]【】]+/g, '');
}

function mcpMatchScore(query, text) {
  var q = mcpNorm(query);
  var t = mcpNorm(text);
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.indexOf(q) === 0) return 80;
  if (t.indexOf(q) >= 0) return 60;
  if (t.length >= 2 && q.indexOf(t) >= 0) return 40;
  return 0;
}

// Returns the best item plus every item tied at that score, so callers can report ambiguity.
function mcpBestMatch(query, items, textOf) {
  var best = 0;
  var matches = [];
  (items || []).forEach(function (item) {
    var score = mcpMatchScore(query, textOf(item));
    if (score > best) {
      best = score;
      matches = [item];
    } else if (score && score === best) {
      matches.push(item);
    }
  });
  return { item: matches[0] || null, matches: matches };
}

// Strict on purpose: a loose local hit plays the wrong song, while a miss just falls back to NetEase search.
function mcpSongMatches(query, song) {
  var q = mcpNorm(query);
  var name = mcpNorm(song && song.name);
  var artist = mcpNorm(song && song.artist);
  if (!q || !name) return false;
  if (q === name || q === name + artist || q === artist + name) return true;
  return name.length >= 2 && artist.length >= 1 && q.indexOf(name) >= 0 && q.indexOf(artist) >= 0;
}

function mcpFormatTime(seconds) {
  var total = Math.max(0, Math.round(Number(seconds) || 0));
  var rest = total % 60;
  return Math.floor(total / 60) + ':' + (rest < 10 ? '0' : '') + rest;
}

function mcpSongLabel(song) {
  return (song && song.name || '未知歌曲') + (song && song.artist ? ' - ' + song.artist : '');
}

function mcpSongInfo(song) {
  return { name: song && song.name || '', artist: song && song.artist || '', provider: songProviderKey(song) };
}

function mcpOk(message, data) {
  if (message) showToast('🤖 ' + message);
  return { ok: true, message: message || '', data: data };
}

function mcpFail(error) {
  showToast('🤖 失败：' + error);
  return { ok: false, error: error };
}

// Same queue rule as playSearchResult (05-playback/10-queue-actions.js), but takes a song object.
async function mcpPlaySong(song) {
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  var key = queueItemKey(song);
  var matchIdx = -1;
  for (var j = 0; j < playQueue.length; j++) if (queueItemKey(playQueue[j]) === key) { matchIdx = j; break; }
  if (matchIdx >= 0) currentIdx = moveQueueIndexToTop(matchIdx);
  else { playQueue.unshift(cloneSong(song)); currentIdx = 0; }
  return playQueueAt(currentIdx);
}

async function mcpLikedNeteaseSongs() {
  if (mcpLikedSongsCache) return mcpLikedSongsCache;
  var liked = (userPlaylists || []).find(function (pl) {
    return playlistAccountProvider(pl) === 'netease' && Number(pl.specialType || 0) === 5;
  });
  if (!liked) return [];
  var page = await fetchPlaylistTracksPage('netease', liked.id, { limit: 1000, offset: 0 });
  mcpLikedSongsCache = page && Array.isArray(page.tracks) ? page.tracks : [];
  return mcpLikedSongsCache;
}

function mcpLocalSongMatches(query, liked) {
  var history = Object.keys(listenStatsState.songs || {})
    .map(function (key) { return listenStatsState.songs[key]; })
    .sort(function (a, b) { return (b.plays || 0) - (a.plays || 0); })
    .map(songFromListenRecord);
  var seen = {};
  return liked.concat(history).filter(function (song) {
    if (!song || !(song.id || song.mid) || songProviderKey(song) !== 'netease' || !mcpSongMatches(query, song)) return false;
    var key = queueItemKey(song);
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

async function mcpNeteaseSearch(query) {
  var result = await fetchMusicSearchResults(query, 'netease');
  return result && Array.isArray(result.songs) ? result.songs : [];
}

async function mcpPlayCandidate(song, prefix) {
  mcpMusicState.played.push(queueItemKey(song));
  if (await mcpPlaySong(song) === false) return mcpFail('播放失败：' + mcpSongLabel(song));
  return mcpOk(prefix + mcpSongLabel(song), { song: mcpSongInfo(song), remaining: mcpMusicState.candidates.length });
}

function mcpParamControls(entry) {
  if (!entry || !entry.history || entry.tab === 'system' || !entry.element) return [];
  var root = entry.element;
  var nodes = [];
  if (root.matches('input[type="range"][id],.fx-toggle[id]')) nodes.push(root);
  Array.prototype.forEach.call(root.querySelectorAll('input[type="range"][id],.fx-toggle[id]'), function (node) { nodes.push(node); });
  return nodes.filter(function (node) {
    return !node.closest(MCP_UNSAFE_CONTROL_AREAS);
  }).map(function (node) {
    var wrap = node.closest('.fx-slider,.fx-toggle');
    var labelNode = wrap && wrap.querySelector('label,span');
    var title = labelNode && labelNode.textContent.trim() || entry.title;
    if (node.matches('input[type="range"]')) {
      return {
        id: node.id, type: 'range', title: title, group: entry.groupLabel,
        value: Number(node.value), min: Number(node.min), max: Number(node.max), step: Number(node.step) || 0
      };
    }
    return { id: node.id, type: 'toggle', title: title, group: entry.groupLabel, value: node.classList.contains('on') };
  });
}

function mcpFindParamControl(id) {
  var node = document.getElementById(String(id || ''));
  if (!node) return null;
  var entry = fxConsoleEntryForElement(node);
  var controls = mcpParamControls(entry);
  for (var i = 0; i < controls.length; i++) {
    if (controls[i].id === node.id) return { node: node, entry: entry, info: controls[i] };
  }
  return null;
}

function mcpRecordFxChange(label, key, change) {
  var before = captureFxConsoleState();
  change();
  pushFxConsoleHistory('🤖 ' + label, 'mcp:' + key, before, captureFxConsoleState(), false);
}

function mcpSetRange(found, value) {
  var info = found.info;
  var next = Math.max(info.min, Math.min(info.max, Number(value)));
  if (info.step > 0) next = Math.max(info.min, Math.min(info.max, info.min + Math.round((next - info.min) / info.step) * info.step));
  next = Number(next.toFixed(6));
  if (fxConsoleHistoryTxn && fxConsoleHistoryTxn.control === found.node) fxConsoleHistoryTxn = null;
  mcpRecordFxChange(info.title, found.node.id, function () {
    found.node.value = String(next);
    found.node.dispatchEvent(new Event('input', { bubbles: true }));
    found.node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  var applied = Number(found.node.value);
  return mcpOk(info.title + ' → ' + applied, { id: found.node.id, value: applied, min: info.min, max: info.max });
}

async function mcpWallpaperProjects() {
  if (!wallpaperEngineProjects.length) await loadWallpaperEngineLibrary(false, false);
  return wallpaperEngineProjects.filter(function (item) {
    return !hiddenWallpaperEngineIds.has(item.id) && (item.playable || item.enginePlayable || item.hasPreview);
  });
}

var MCP_TOOL_HANDLERS = {
  player_toggle: async function () {
    await togglePlay();
    return mcpOk(playing ? '播放' : '暂停');
  },
  player_next: function () {
    nextTrack(true);
    return mcpOk('下一首');
  },
  player_prev: function () {
    prevTrack(true);
    return mcpOk('上一首');
  },
  player_set_volume: function (args) {
    var current = Math.round((Number(targetVolume) || 0) * 100);
    var step = Number(args.step) > 0 ? Number(args.step) : 10;
    var next = typeof args.value === 'number' ? args.value
      : args.direction === 'up' ? current + step
        : args.direction === 'down' ? current - step : NaN;
    if (!isFinite(next)) return mcpFail('需要 value 或 direction');
    next = Math.max(0, Math.min(100, Math.round(next)));
    setVolume(next / 100, true);
    return mcpOk('音量 ' + next + '%', { volume: next });
  },
  player_seek: function (args) {
    var duration = getPlaybackDurationSeconds();
    if (!duration) return mcpFail('当前没有可跳转的歌曲');
    var target = typeof args.seconds === 'number' ? args.seconds
      : typeof args.delta === 'number' ? getPlaybackCurrentSeconds() + args.delta : NaN;
    if (!isFinite(target)) return mcpFail('需要 seconds 或 delta');
    target = Math.max(0, Math.min(Math.max(0, duration - 1), target));
    commitProgressSeek(target, !!playing);
    return mcpOk('跳到 ' + mcpFormatTime(target), { position: Math.round(target), duration: Math.round(duration) });
  },
  player_now_playing: function () {
    var song = currentCoverSong();
    if (!song) return { ok: true, message: '当前没有歌曲', data: null };
    return {
      ok: true,
      message: mcpSongLabel(song),
      data: {
        song: mcpSongInfo(song),
        playing: !!playing,
        position: Math.round(getPlaybackCurrentSeconds()),
        duration: Math.round(getPlaybackDurationSeconds() || 0),
        volume: Math.round((Number(targetVolume) || 0) * 100),
        playMode: playMode,
        liked: isSongLiked(song)
      }
    };
  },
  player_set_play_mode: function (args) {
    if (['loop', 'shuffle', 'single'].indexOf(args.mode) < 0) return mcpFail('mode 只能是 loop / shuffle / single');
    if (playMode !== args.mode) setPlayMode(args.mode);
    return mcpOk('播放模式：' + playModeLabel(playMode), { mode: playMode });
  },
  player_like_current: function (args) {
    var song = currentCoverSong();
    if (!song) return mcpFail('当前没有歌曲');
    var provider = songProviderKey(song);
    if (!isSongAccountLoggedIn(provider)) return mcpFail('未登录 ' + provider + '，无法红心');
    var want = args.liked !== false;
    if (isSongLiked(song) !== want) toggleLikeCurrent();
    return mcpOk((want ? '已红心：' : '已取消红心：') + mcpSongLabel(song));
  },
  music_search_and_play: async function (args) {
    var query = String(args.query || '').trim();
    if (!query) return mcpFail('缺少歌名');
    var liked = await mcpLikedNeteaseSongs().catch(function () { return []; });
    var candidates = mcpLocalSongMatches(query, liked);
    var searched = false;
    if (!candidates.length) {
      candidates = await mcpNeteaseSearch(query);
      searched = true;
      if (!candidates.length) return mcpFail(searchProviderNotice || ('网易云没有找到「' + query + '」'));
    }
    mcpMusicState = { query: query, candidates: candidates.slice(1, 10), searched: searched, played: [] };
    return mcpPlayCandidate(candidates[0], searched ? '播放：' : '播放（红心/历史）：');
  },
  music_play_next_candidate: async function () {
    var st = mcpMusicState;
    if (!st.query) return mcpFail('还没有搜过歌');
    if (!st.candidates.length && !st.searched) {
      st.searched = true;
      st.candidates = (await mcpNeteaseSearch(st.query)).filter(function (song) {
        return st.played.indexOf(queueItemKey(song)) < 0;
      }).slice(0, 10);
    }
    var song = st.candidates.shift();
    if (!song) return mcpFail('「' + st.query + '」没有更多候选了');
    return mcpPlayCandidate(song, '换成：');
  },
  music_play_playlist: async function (args) {
    var name = String(args.name || '').trim();
    var lists = (userPlaylists || []).filter(function (pl) { return playlistAccountProvider(pl) === 'netease'; });
    if (!lists.length) return mcpFail('没有网易云歌单（未登录或歌单未加载）');
    var hit = /我喜欢|红心|喜欢的音乐/.test(name)
      ? lists.find(function (pl) { return Number(pl.specialType || 0) === 5; })
      : mcpBestMatch(name, lists, function (pl) { return pl.name; }).item;
    if (!hit) return mcpFail('没找到歌单「' + name + '」');
    if (await loadPlaylistIntoQueueById(hit.id, true, hit.name || '') === false) return mcpFail('歌单加载失败：' + hit.name);
    return mcpOk('播放歌单：' + hit.name);
  },
  fx_set_preset: function (args) {
    var indexed = presetMeta.map(function (meta, index) { return { meta: meta, index: index }; });
    var found = mcpBestMatch(args.name, indexed, function (it) { return it.meta.name; });
    if (!found.item) return mcpFail('没有叫「' + args.name + '」的视觉预设');
    var p = found.item.index;
    mcpRecordFxChange('视觉预设：' + presetMeta[p].name, 'preset', function () { setPreset(p, { silent: true }); });
    return mcpOk('已切换：' + presetMeta[p].name, {
      preset: presetMeta[p].name,
      desc: presetMeta[p].desc,
      alternatives: found.matches.slice(1).map(function (it) { return it.meta.name + '（' + it.meta.desc + '）'; })
    });
  },
  fx_apply_archive: function (args) {
    var slots = userFxArchives.map(function (slot, index) { return { slot: slot, index: index }; })
      .filter(function (it) { return it.slot && it.slot.snapshot; });
    var found = mcpBestMatch(args.name, slots, function (it) { return it.slot.name; });
    if (!found.item) return mcpFail('没有叫「' + args.name + '」的用户存档');
    var slot = found.item.slot;
    var applied = false;
    mcpRecordFxChange('用户存档：' + slot.name, 'archive', function () { applied = applyFxArchiveSnapshot(slot.snapshot); });
    return applied ? mcpOk('已应用存档：' + slot.name) : mcpFail('存档应用失败：' + slot.name);
  },
  fx_find_params: function (args) {
    if (!mcpNorm(args.query)) return { ok: false, error: '缺少关键词' };
    var results = [];
    fxConsoleRegistry.forEach(function (entry) {
      var controls = mcpParamControls(entry);
      if (!controls.length) return;
      var texts = [entry.title, entry.groupLabel].concat(String(entry.aliases || '').split(/\s+/));
      controls.forEach(function (control) {
        var score = mcpMatchScore(args.query, control.title);
        texts.forEach(function (text) { score = Math.max(score, mcpMatchScore(args.query, text)); });
        if (score) results.push({ score: score, control: control });
      });
    });
    results.sort(function (a, b) { return b.score - a.score; });
    return { ok: true, message: '找到 ' + results.length + ' 个参数', data: { params: results.slice(0, 12).map(function (r) { return r.control; }) } };
  },
  fx_set_param: function (args) {
    var found = mcpFindParamControl(args.id);
    if (!found) return mcpFail('参数不存在或不允许修改：' + args.id);
    if (found.info.type === 'range') {
      if (typeof args.value !== 'number') return mcpFail(found.info.title + ' 需要数值 value');
      return mcpSetRange(found, args.value);
    }
    if (typeof args.on !== 'boolean') return mcpFail(found.info.title + ' 是开关，需要 on=true/false');
    // The console's #fx-panel click listener records toggle clicks into undo history by itself.
    if (found.info.value !== args.on) found.node.click();
    return mcpOk(found.info.title + (args.on ? ' 已开启' : ' 已关闭'), { id: found.node.id, on: found.node.classList.contains('on') });
  },
  fx_adjust_param: function (args) {
    var found = mcpFindParamControl(args.id);
    if (!found || found.info.type !== 'range') return mcpFail('不是可调滑块：' + args.id);
    var span = found.info.max - found.info.min;
    var delta = typeof args.delta === 'number' ? args.delta
      : args.direction === 'up' ? span * 0.1
        : args.direction === 'down' ? -span * 0.1 : NaN;
    if (!isFinite(delta)) return mcpFail('需要 delta 或 direction');
    return mcpSetRange(found, found.info.value + delta);
  },
  wallpaper_set_by_name: async function (args) {
    var items = await mcpWallpaperProjects();
    if (!items.length) return mcpFail('壁纸库为空或 Wallpaper Engine 不可用');
    var found = mcpBestMatch(args.name, items, function (item) { return item.title; });
    if (!found.item) return mcpFail('没有标题包含「' + args.name + '」的壁纸');
    activateWallpaperEngineItem(found.item.id);
    return mcpOk('壁纸：' + found.item.title, {
      title: found.item.title,
      others: found.matches.slice(1, 5).map(function (item) { return item.title; })
    });
  },
  wallpaper_random: async function () {
    var items = (await mcpWallpaperProjects()).filter(function (item) {
      return !(wallpaperEngineSelection.active && item.id === wallpaperEngineSelection.id);
    });
    if (!items.length) return mcpFail('没有可切换的壁纸');
    var item = items[Math.floor(Math.random() * items.length)];
    activateWallpaperEngineItem(item.id);
    return mcpOk('壁纸：' + item.title, { title: item.title });
  },
  wallpaper_restore: function () {
    if (!wallpaperEngineSelection.active) return mcpOk('当前没有 WE 壁纸，已是原背景');
    deactivateWallpaperEngineBackground(true);
    return mcpOk('已恢复原背景');
  },
  history_undo: function () {
    if (!fxConsoleHistory.length) return mcpFail('没有可撤销的视觉修改');
    var count = fxConsoleHistory.length;
    var label = fxConsoleHistory[count - 1].label;
    undoFxConsoleHistory();
    // undoFxConsoleHistory shows its own "已回退 / 回退失败" toast.
    if (fxConsoleHistory.length === count) return { ok: false, error: '回退失败：' + label };
    return { ok: true, message: '已回退：' + label };
  }
};

window.__mineradioMcpCall = async function (name, args) {
  var handler = Object.prototype.hasOwnProperty.call(MCP_TOOL_HANDLERS, name) ? MCP_TOOL_HANDLERS[name] : null;
  if (!handler) return { ok: false, error: '未知工具：' + name };
  try {
    return await handler(args && typeof args === 'object' ? args : {});
  } catch (error) {
    console.error('[MCP]', name, error);
    return mcpFail(String(error && error.message || error).slice(0, 200));
  }
};
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node tests/mcp-renderer-tools.test.js`
Expected: 输出 `OK mcp-renderer-tools`，退出码 0

---

### Task 6: 回归 + 端到端冒烟

- [ ] **Step 1: 跑全部相关测试**

Run: `node tests/mcp-http.test.js && node tests/mcp-renderer-tools.test.js && node tests/gesture-player-actions.test.js && node tests/main-window-runtime-recovery.test.js && node tests/playback-single-repeat-loop.test.js && node tests/built-in-playlist-library.test.js && node tests/cuefield-mineradio-integration.test.js`
Expected: 每个都输出 `OK ...`，退出码 0。若某个旧测试在**改动前**就失败，记录下来，不要去修。

- [ ] **Step 2: 重启 Mineradio**（托盘右键退出，再启动；主进程改动 Ctrl+R 不生效）

- [ ] **Step 3: PowerShell 冒烟（真实应用）**

```powershell
$cfg = Get-Content "$env:APPDATA\Mineradio\mcp.json" -Raw | ConvertFrom-Json
$h = @{ Authorization = $cfg.headers.Authorization }
$call = { param($name, $arguments) Invoke-RestMethod -Method Post -Uri $cfg.url -Headers $h -ContentType 'application/json' -Body (@{ jsonrpc='2.0'; id=1; method='tools/call'; params=@{ name=$name; arguments=$arguments } } | ConvertTo-Json -Depth 6 -Compress) }
(& $call 'player_now_playing' @{}).result.content[0].text
(& $call 'fx_find_params' @{ query='光晕' }).result.content[0].text
(& $call 'fx_set_preset' @{ name='星河' }).result.content[0].text
(& $call 'history_undo' @{}).result.content[0].text
```

Expected：
1. 第一条返回 JSON 含 `"ok":true`（没放歌时 `data` 为 null）。
2. 第二条返回的 `params` 里有 `fx-bloom`，带 `min/max/value`。
3. 第三条界面切到星河，toast「🤖 已切换：星河」；打开控制台历史能看到「🤖 视觉预设：星河」。
4. 第四条回到原预设，toast「已回退：🤖 视觉预设：星河」。
5. 不带 Authorization 头再调一次，返回 401。

---

### Task 7: 接客户端 + 20 个工具手工验收

- [ ] **Step 1: 接 Antigravity** —— 打开 Antigravity 的 MCP 配置（Agent 面板 `…` → MCP Servers → Manage → View raw config，文件是 `mcp_config.json`），加入下面这段，`<url>` 和 `<token>` 从 `%APPDATA%\Mineradio\mcp.json` 抄：

```json
{
  "mcpServers": {
    "mineradio": {
      "serverUrl": "<url>",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

接不上时的备选（二选一）：
- agy / Gemini CLI 风格 `settings.json`：`"mineradio": { "httpUrl": "<url>", "headers": { "Authorization": "Bearer <token>" } }`
- Claude Code：`claude mcp add --transport http mineradio <url> --header "Authorization: Bearer <token>"`

注意：端口不是固定 3000（`findOpenPort(3000)` 会顺延）。端口变了要按 `mcp.json` 更新客户端配置。

- [ ] **Step 2: 在客户端逐条打字验收，每条看 toast 和实际效果**

| # | 输入 | 期望 |
|---|---|---|
| 1 | 暂停 / 继续 | `player_toggle`，toast「🤖 暂停 / 播放」 |
| 2 | 下一首、上一首 | 切歌 |
| 3 | 音量 30；大声点 | 30%；再 +10% |
| 4 | 快进 30 秒；跳到 1 分钟 | 进度正确，暂停时不自动开始播放 |
| 5 | 现在放的什么 | 返回歌名歌手，不弹 toast |
| 6 | 单曲循环；顺序播放 | 模式按钮变化；从顺序直接切单曲时**队列顺序不变** |
| 7 | 红心这首 | 已登录：红心亮；未登录：toast 失败原因，**不弹登录框** |
| 8 | 放晴天 | 历史/红心有就直接放，否则网易云第一首 |
| 9 | 换一个 | 放下一个候选 |
| 10 | 放我喜欢的歌单；放 <某歌单名> | 队列替换并播放 |
| 11 | 切到唱片预设 | 预设切换 + 历史出现 🤖 条目 |
| 12 | 应用存档 <存档名> | 存档应用 + 历史条目 |
| 13 | 泛光调大一点（先说「泛光」，验证 0 结果后会自动换「光晕」重查） | 先 `fx_find_params` 再 `fx_adjust_param`，滑块位置同步变化 |
| 14 | 把 <某开关> 关掉 | 开关变化，历史出现条目 |
| 15 | 撤销 | 回到上一步视觉状态 |
| 16 | 换个 <WE 标题关键词> 的壁纸 | WE 壁纸切换 |
| 17 | 随机换个壁纸 | 换成不同的一张 |
| 18 | 关掉壁纸 | 恢复原背景 |
| 19 | 让它清缓存 / 退出程序 | 客户端找不到对应工具，什么都不发生 |
| 20 | 拖过一次进度条后切歌，再说「快进 10 秒」 | 进度正确（确认 `commitProgressSeek` 不拿旧 media） |

- [ ] **Step 3: 把没通过的条目写成清单交回（编号 + 实际现象 + DevTools Console 报错）。不要自行扩大改动范围。**

---

## 完成后交回给 Claude 的东西

1. 改动文件列表（应正好是「文件结构」表里 8 个）。
2. Task 6 Step 1 的完整输出。
3. Task 7 验收表的结果（通过 / 失败 + 现象）。
