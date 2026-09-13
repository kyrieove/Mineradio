# 语音助手 · 第二阶段 v1「对着 Mineradio 说话」Implementation Plan

> **For agentic workers:** 按任务顺序执行，每步用 `- [ ]` 勾选。每个任务先写测试、看它失败、再实现、看它通过。**不要 git commit**（运行目录不是仓库，提交由 Claude 审完 diff 后在 fork 做）。本计划里的所有代码和「查找 → 替换」锚点都已由 Claude 在源码副本上跑通过测试，照抄即可。

**Goal:** 按一下全局快捷键（默认 `Ctrl+Alt+V`）说一句话，停顿约 0.8 秒后 Mineradio 自己识别并执行（播放 / 搜歌 / 特效 / 壁纸），不经过任何 AI 客户端。

**Architecture:** 渲染层热键 `voiceCommand` → `08-voice-command.js` 压低音乐、提示音、`getUserMedia` 采 16 kHz 音频 → IPC 分块发给主进程 → `desktop/voice-asr.js` 转给 worker 线程 `desktop/voice-asr-worker.js`（官方预编译 sherpa-onnx WASM：silero VAD 断句 + SenseVoice 识别）→ 识别文本 IPC 回渲染层 → `07-voice-rules.js` 纯函数匹配成 `{ tool, args }` → 直接调第一阶段的 `window.__mineradioMcpCall`（不走 HTTP）。

**Tech Stack:** 官方预编译 sherpa-onnx WASM v1.13.2（零 npm 依赖）、Node `worker_threads` + `vm`、Electron IPC、Web Audio（`ScriptProcessorNode`）、`node tests/*.test.js` 裸跑 `node:assert`。

---

## 0. 背景事实（已由 Claude 核对源码并实测，实施时不用再查）

**工作目录：`D:\Mineradio\resources\app\`**。下文路径都相对这个目录。行号取自 fork `C:\dev\Mineradio`（与运行目录一致），只作定位参考，以「查找」文本为准。

### 0.1 识别引擎（实测）

| 事实 | 依据 |
|---|---|
| 官方有现成的 SenseVoice + silero VAD 的 WASM 包：`sherpa-onnx-wasm-simd-1.13.2-vad-asr-zh_en_ja_ko_cantonese-sense_voice_small.tar.bz2`，压缩 166 MB | GitHub release `v1.13.2`；生成脚本 `scripts/wasm/generate-vad-asr.py` |
| 解压后 7 个文件：`.data` 240 MB（内含 `sense-voice.onnx` int8、`silero_vad.onnx`、`tokens.txt`）、`.wasm` 12.9 MB、`sherpa-onnx-wasm-main-vad-asr.js` 117 KB、`sherpa-onnx-asr.js` 54 KB、`sherpa-onnx-vad.js` 7.8 KB、`app-vad-asr.js`、`index.html`（后两个是网页 demo，用不到） | 实测解压 |
| **该包是 pthread 多线程构建**（启动即建 4 个线程，需要 `SharedArrayBuffer`）。浏览器 / Electron 渲染层要用 SAB，只能 ① 给主页面加 COOP/COEP 跨源隔离头（会拦截没有 CORP 头的跨域封面图、音频、iframe），或 ② `--enable-features=SharedArrayBuffer` 全局放开（削弱整个应用含登录窗口的 Spectre 防护）。两条都不做 | 包内 JS：`initMainThread(){var pthreadPoolSize=4` |
| **所以识别跑在主进程的 `worker_thread` 里**：Node worker 原生支持 SAB，同一个 WASM 包直接能用，不阻塞主进程事件循环（本地服务 `server.js` 也在主进程）。仍然零 npm install | 实测 |
| 用 Mineradio 自带运行时实测可用：`$env:ELECTRON_RUN_AS_NODE=1; & D:\Mineradio\Mineradio.exe <脚本>` → Node 24.16.0 / Electron 42.4.1 | 实测 |
| 耗时（Electron 42 运行时、worker 线程、单线程识别，Windows 中文 TTS 音频）：模型加载 1.4–2.4 s；1.4–2.6 s 的句子识别 205–541 ms。`numThreads: 2` 反而更慢，用 1 | 实测 10 句 |
| 准确率：10 句 TTS 对 9 句，错的是「预设」→「预社 / 浴社」；SenseVoice 开 ITN 后输出阿拉伯数字（「音量调到30。」）且句末带「。」 | 实测 |
| **VAD 切出的片段开头偏晚会吞字**：「切到星河」被识别成「街道星河」。解法：worker 自己保存整段音频，从 `segment.start` 往前多取 0.3 s 再识别，改后开头不再丢字 | 实测对比 |
| VAD API：`createVad(Module, config)`（不传 config 时 `minSilenceDuration` 默认 0.5）；`vad.acceptWaveform(512 样本)`、`isDetected()`、`isEmpty()`、`front()` → `{ samples, start }`、`pop()`、`flush()`、`reset()`。识别：`new OfflineRecognizer(config, Module)`、`createStream()`、`acceptWaveform(16000, samples)`、`decode(stream)`、`getResult(stream).text`、`stream.free()` | 包内 `sherpa-onnx-vad.js:158`、`sherpa-onnx-asr.js:1840` |
| Emscripten 胶水代码在 Node 里需要全局 `Module` / `require` / `module` / `__dirname` / `__filename`（pthread 子线程会按 `__filename` 重新加载主 JS），用 `vm.runInThisContext` 加载 | 实测 |
| 内存：加载后进程 RSS 约 680 MB（Node 单进程实测 683 MB）。所以**懒加载**（第一次按热键才加载）+ **空闲 10 分钟卸载**（之后第一句多等约 2 s） | 实测 |
| 模型放 `%APPDATA%\Mineradio\voice-model\`（`STABLE_USER_DATA_PATH`），不放 `public/vendor`：240 MB 的 `.data` 超过 GitHub 单文件 100 MB 上限，fork 提交不了；`server.js` 的 `serveStatic` 用 `fs.readFile` 整读且 `no-store`，也不适合 | `desktop/main.js:193`、`server.js:401` |

### 0.2 Mineradio 源码

| 事实 | 位置 |
|---|---|
| 主窗口页面是 `http://127.0.0.1:<port>/`，`sandbox: true` + `contextIsolation: true`；`index.html` 没有 CSP meta | `desktop/main.js:784` `isLocalAppUrl`、`:793` `isTrustedMainDocumentUrl` |
| 摄像头权限的现成写法：IPC 先建短时 grant（`createGestureCameraPermissionGrant`），`configureLocalAppPermissions` 的 check / request 两个 handler 里 `permission === 'media'` 时调 `isTrustedGestureCameraMediaPermission`（只放行 video、拒 audio）。麦克风照抄成只放行 audio 的版本 | `desktop/main.js:820`、`:830`、`:1700-1722`、`:5063` |
| `isTrustedMainWindowIpc(event)` 校验 IPC 来自主窗口主 frame 的本地页面 | `desktop/main.js:804` |
| preload 暴露 `window.desktopWindow`；渲染层用 `getDesktopWindowApi()` 取（非桌面版返回 null） | `desktop/preload.js:3`、`public/js/modules/10-shell/04-desktop-overlay-fullscreen.js:89` |
| 热键动作表 `HOTKEY_ACTIONS`。**`Ctrl+Alt+Space` 已被「播放 / 暂停」占用**，语音默认用 `Ctrl+Alt+KeyV`（全部现有全局热键里没有 V） | `public/js/modules/00-state/00-core-stores.js:159-168` |
| 渲染层执行热键 `executeHotkeyAction(actionKey)`；设置页按 `category` 自动分组，新加一行就出现在设置页、可改键、有冲突提示 | `public/js/modules/07-fx/06-hotkeys.js:93`、`:213` |
| 主进程 `configureMineradioGlobalHotkeys` 对 action 名没有白名单，原样回传 `mineradio-global-hotkey` → **主进程热键代码不用改** | `desktop/main.js:1816`、`:1853` |
| `setVolume()` 会写 `localStorage('apex-player-volume')`，不能用来压低 | `public/js/modules/05-playback/08-audio-graph-controls.js:611` |
| 临时增益：`rampAudioOutputGain(值, 毫秒)` 只改包络 `audioFadeEnvelope`（输出 = `targetVolume × 包络`），不动 `targetVolume`；它会取消正在进行的淡入淡出 | 同文件 `:454`、`:416` |
| 暂停 / 淡入 / 切歌都会 `audioFadeSerial++`（`preparePlaybackFadeIn`、`startPlaybackFadeIn`、`restorePlaybackGain`、`fadeOutAndPauseAudio`）。所以恢复前比较 serial：没变才拉回，变了说明别的逻辑已接管增益 | 同文件 `:523-555`；`audioFadeSerial` 声明在 `00-state/00-core-stores.js:58` |
| 静音保护 `ensureAudiblePlaybackGain` 只在增益 ≤ `targetVolume × 10%` 时强行恢复；压到 15% 不会被它顶回去 | 同文件 `:488-506` |
| 全局 `audio`、`playing`、`targetVolume` | `00-state/00-core-stores.js:6`、`:22` |
| 第一阶段入口 `window.__mineradioMcpCall(name, args)`；`mcpOk` / `mcpFail` 自带 toast「🤖 …」；`player_now_playing` 和 `fx_find_params` **不弹 toast** | `public/js/modules/10-shell/06-mcp-tools.js:65-73`、`:385` |
| `fx_find_params` 返回 `{ ok, data: { params: [{ id, type: 'range' 或 'toggle', title, ... }] } }`，按匹配分数排序；「光晕」会同时命中开关 `t-bloom`（别名「粒子光晕」）和滑块 `fx-bloom`（「光晕强度」），所以执行时要按 `type` 挑 | 同文件 `:125-145`、`:311-325`；`07-fx/09-console-workspace.js` 的 `fxConsoleItem` 表 |
| 视觉预设名：Emily、滚筒、星球、虚空、唱片、星河、安魂、音域回响、月蚀圣环、雨幕霓虹、折光蝶群、深海绽放 | `07-fx/00-preset-archive-data.js:2` |
| 渲染层模块按 `index-loader.js` 列表顺序加载；测试用 `vm.runInContext` 直接跑渲染层文件 | `public/js/index-loader.js:110`、`tests/mcp-renderer-tools.test.js` |
| **第一阶段测试断言了 `06-mcp-tools.js` 后面紧跟 `11-main-loop.js`**，插入新模块后要同步改这一行断言 | `tests/mcp-renderer-tools.test.js:19` |

### 0.3 和 HANDOFF 决定的差异（Claude 决定，已告知用户）

1. **识别跑主进程 worker，不跑渲染层**：原因见 0.1 的 SharedArrayBuffer 一行。仍然是 WASM、零安装。
2. **默认快捷键 `Ctrl+Alt+V`**：HANDOFF 举例的 `Ctrl+Alt+Space` 已被播放 / 暂停占用。
3. **「说完到执行 ≤ 1 秒」和「静音 0.8 秒自动结束」有冲突**：体感延迟 ≈ 0.8 s 静音判定 + 0.2–0.55 s 识别 + 执行 ≈ 1.0–1.4 s。v1 按决定保留 0.8 s（`desktop/voice-asr.js` 的 `minSilenceSeconds`），验收时分开记录「识别 + 执行」耗时（目标 ≤ 1 s）和体感；体感超了再由用户决定是否降到 0.5 s。
4. **「暂停」「继续」不会误反转**：第一阶段只有 `player_toggle`，已暂停时说「暂停」会变成播放。规则输出 `onlyIf: 'playing' | 'paused'`，执行前检查全局 `playing`。
5. **「换一个」= 换搜歌候选，「换一首」= 下一首**。

**假设（实施中如发现不成立，停下来报告）：**
- 渲染层经 `ipcRenderer.send` 发出的 `Float32Array` 到主进程仍是 `Float32Array`（Electron IPC 用结构化克隆）。不成立的症状：每次都「🎙️ 没听到声音」。
- `new AudioContext({ sampleRate: 16000 })` 接 48 kHz 麦克风时 Chromium 自动重采样。
- 回声靠 `echoCancellation: true` + 音乐压到 15%；外放很大声时可能误识别，属于验收观察项，不在 v1 处理。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `public/js/modules/10-shell/07-voice-rules.js` | 新建 | 纯函数：识别文本 → `{ tool, args, onlyIf?, paramQuery?, paramType? }` 或 `null`；中文数字、同义词 |
| `tests/voice-rules.test.js` | 新建 | 38 句四类验收句 + 数字解析 + 不匹配返回 null |
| `desktop/voice-asr-worker.js` | 新建 | worker 线程：加载 WASM、VAD 断句、补 0.3 s 开头、识别、回传 |
| `desktop/voice-asr.js` | 新建 | 主进程：检查模型文件、懒加载 worker、空闲卸载、转发音频和事件。不依赖 Electron，可单测 |
| `tests/fixtures/fake-voice-asr-worker.js` | 新建 | 同协议的假 worker，单测不需要模型 |
| `tests/voice-asr.test.js` | 新建 | 模型缺失、音频转发、非法块丢弃、卸载后重建、初始化失败 |
| `tests/voice-asr-model.smoke.js` | 新建 | 真模型冒烟（手动带参数跑） |
| `desktop/main.js` | 改 8 处 | require、grant 变量和常量、麦克风权限函数 + `getVoiceAsr`、两个权限 handler、3 个 IPC、退出时卸载 |
| `desktop/preload.js` | 改 1 处 | `voiceBegin` / `sendVoiceAudio` / `voiceFlush` / `onVoiceEvent` |
| `public/js/modules/10-shell/08-voice-command.js` | 新建 | 热键入口、压低 / 恢复音乐、提示音、采音、超时、执行规则结果 |
| `tests/voice-command.test.js` | 新建 | 执行逻辑（按类型挑参数、onlyIf、没听懂）+ 接线断言 |
| `public/js/modules/00-state/00-core-stores.js` | 改 1 处 | `HOTKEY_ACTIONS` 加 `voiceCommand` |
| `public/js/modules/07-fx/06-hotkeys.js` | 改 1 处 | `executeHotkeyAction` 加一行 |
| `public/js/index-loader.js` | 改 1 处 | 登记两个新模块 |
| `tests/mcp-renderer-tools.test.js` | 改 1 行 | 加载顺序断言跟着改 |

---

### Task 0: 安装语音模型（用户手工做，约 3 分钟）

- [ ] **Step 1: PowerShell 下载并解压到 userData**

```powershell
$dst = "$env:APPDATA\Mineradio\voice-model"
New-Item -ItemType Directory -Force $dst | Out-Null
$tar = "$env:TEMP\sherpa-onnx-sensevoice-wasm-1.13.2.tar.bz2"
curl.exe -L -o $tar https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.2/sherpa-onnx-wasm-simd-1.13.2-vad-asr-zh_en_ja_ko_cantonese-sense_voice_small.tar.bz2
tar -xjf $tar -C $dst --strip-components=1
Get-ChildItem $dst | Select-Object Name, Length
```

Expected：列表里有 `sherpa-onnx-wasm-main-vad-asr.data`（240193589）、`sherpa-onnx-wasm-main-vad-asr.wasm`（12898602）、`sherpa-onnx-wasm-main-vad-asr.js`、`sherpa-onnx-asr.js`、`sherpa-onnx-vad.js`。确认后可删 `$tar`。

---

### Task 1: 本地规则 `07-voice-rules.js`

**Files:**
- Create: `public/js/modules/10-shell/07-voice-rules.js`
- Test: `tests/voice-rules.test.js`

- [ ] **Step 1: 写失败测试** —— 新建 `tests/voice-rules.test.js`：

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(appRoot, 'public/js/modules/10-shell/07-voice-rules.js'), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(source, ctx);
const parse = (text) => JSON.parse(JSON.stringify(ctx.parseVoiceCommand(text)));

assert.equal(ctx.voiceParseNumber('三十'), 30);
assert.equal(ctx.voiceParseNumber('二十五'), 25);
assert.equal(ctx.voiceParseNumber('一百零五'), 105);
assert.equal(ctx.voiceParseNumber('十'), 10);
assert.equal(ctx.voiceParseNumber('45'), 45);

// Texts ending in 。 are verbatim SenseVoice output from the Task 0 benchmark.
const cases = [
  // 播放
  ['暂停。', { tool: 'player_toggle', args: {}, onlyIf: 'playing' }],
  ['继续播放', { tool: 'player_toggle', args: {}, onlyIf: 'paused' }],
  ['下一首。', { tool: 'player_next', args: {} }],
  ['上一首', { tool: 'player_prev', args: {} }],
  ['音量调到30。', { tool: 'player_set_volume', args: { value: 30 } }],
  ['音量调到三十', { tool: 'player_set_volume', args: { value: 30 } }],
  ['大声点', { tool: 'player_set_volume', args: { direction: 'up' } }],
  ['声音小一点', { tool: 'player_set_volume', args: { direction: 'down' } }],
  ['快进30秒', { tool: 'player_seek', args: { delta: 30 } }],
  ['后退十秒', { tool: 'player_seek', args: { delta: -10 } }],
  ['跳到1分30秒', { tool: 'player_seek', args: { seconds: 90 } }],
  ['跳到一分钟', { tool: 'player_seek', args: { seconds: 60 } }],
  ['单曲循环', { tool: 'player_set_play_mode', args: { mode: 'single' } }],
  ['切到顺序播放', { tool: 'player_set_play_mode', args: { mode: 'loop' } }],
  ['红心这首歌', { tool: 'player_like_current', args: { liked: true } }],
  ['取消红心', { tool: 'player_like_current', args: { liked: false } }],
  ['现在放的是什么歌？', { tool: 'player_now_playing', args: {} }],
  // 搜歌
  ['播放周杰伦的晴天。', { tool: 'music_search_and_play', args: { query: '周杰伦的晴天' } }],
  ['我想听七里香', { tool: 'music_search_and_play', args: { query: '七里香' } }],
  ['放点陈奕迅的歌', { tool: 'music_search_and_play', args: { query: '陈奕迅' } }],
  ['换一个。', { tool: 'music_play_next_candidate', args: {} }],
  ['放我喜欢的音乐', { tool: 'music_play_playlist', args: { name: '我喜欢的音乐' } }],
  ['播放歌单睡前', { tool: 'music_play_playlist', args: { name: '睡前' } }],
  // 特效
  ['切到星河预设', { tool: 'fx_set_preset', args: { name: '星河' } }],
  ['切到星河浴社。', { tool: 'fx_set_preset', args: { name: '星河' } }],
  ['换成唱片', { tool: 'fx_set_preset', args: { name: '唱片' } }],
  ['应用存档夜晚', { tool: 'fx_apply_archive', args: { name: '夜晚' } }],
  ['光晕调大一点。', { tool: 'fx_adjust_param', args: { direction: 'up' }, paramQuery: '光晕', paramType: 'range' }],
  ['泛光调大一点', { tool: 'fx_adjust_param', args: { direction: 'up' }, paramQuery: '光晕', paramType: 'range' }],
  ['把运动速度调低一些', { tool: 'fx_adjust_param', args: { direction: 'down' }, paramQuery: '运动速度', paramType: 'range' }],
  ['打开桌面歌词', { tool: 'fx_set_param', args: { on: true }, paramQuery: '桌面歌词', paramType: 'toggle' }],
  ['背景星河关掉', { tool: 'fx_set_param', args: { on: false }, paramQuery: '背景星河', paramType: 'toggle' }],
  ['撤销。', { tool: 'history_undo', args: {} }],
  // 壁纸
  ['随机换个壁纸。', { tool: 'wallpaper_random', args: {} }],
  ['关掉壁纸。', { tool: 'wallpaper_restore', args: {} }],
  ['恢复原背景', { tool: 'wallpaper_restore', args: {} }],
  ['换个下雨的壁纸', { tool: 'wallpaper_set_by_name', args: { name: '下雨' } }],
  ['壁纸换成赛博朋克', { tool: 'wallpaper_set_by_name', args: { name: '赛博朋克' } }],
];
for (const [text, expected] of cases) {
  assert.deepEqual(parse(text), expected, text);
}

assert.equal(ctx.parseVoiceCommand(''), null);
assert.equal(ctx.parseVoiceCommand('。'), null);
assert.equal(ctx.parseVoiceCommand('今天天气怎么样'), null);

console.log('OK voice-rules (' + cases.length + ' sentences)');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/voice-rules.test.js`
Expected: FAIL，`ENOENT ... 07-voice-rules.js`

- [ ] **Step 3: 实现** —— 新建 `public/js/modules/10-shell/07-voice-rules.js`：

```js
// Voice command v1 local rules: recognized text -> { tool, args } for MCP_TOOL_HANDLERS. Pure functions, no DOM.

var VOICE_FX_SYNONYMS = { '泛光': '光晕', '发光': '光晕', '粒子大小': '粒子尺寸', '镜头晃动': '电影镜头' };
var VOICE_CN_DIGITS = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
var VOICE_NUM = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';

function voiceNormalizeText(text) {
  return String(text || '').toLowerCase()
    .replace(/[\s，。、！？!?,.；;“”"'‘’]/g, '')
    .replace(/^(请|麻烦|帮我|给我|帮忙)+/, '')
    .replace(/(吧|啊|呀|哦|一下|谢谢)+$/, '');
}

function voiceParseNumber(raw) {
  var s = String(raw || '');
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (!/^[零〇一二两三四五六七八九十百]+$/.test(s)) return NaN;
  var total = 0;
  var current = 0;
  for (var i = 0; i < s.length; i++) {
    if (s[i] === '百') { total += (current || 1) * 100; current = 0; }
    else if (s[i] === '十') { total += (current || 1) * 10; current = 0; }
    else current = VOICE_CN_DIGITS[s[i]];
  }
  return total + current;
}

function voiceFxQuery(subject) {
  var q = String(subject || '').replace(/^把/, '').replace(/的$/, '');
  return VOICE_FX_SYNONYMS[q] || q;
}

function voiceCall(tool, args, extra) {
  var out = { tool: tool, args: args || {} };
  Object.keys(extra || {}).forEach(function (key) { out[key] = extra[key]; });
  return out;
}

function parseVoiceCommand(text) {
  var t = voiceNormalizeText(text);
  var m;
  if (!t) return null;

  if (/(什么歌|哪首歌|啥歌|放的是什么|放的什么|这首歌叫什么)/.test(t)) return voiceCall('player_now_playing');

  // Wallpaper before music / fx: "关掉壁纸" must not become a fx toggle, "换个下雨的壁纸" must not become a song search.
  if (/^((关掉|关闭|取消|去掉|不要|退出)(动态)?壁纸|恢复(原来的|原|默认)?背景)$/.test(t)) return voiceCall('wallpaper_restore');
  if (/^(随机|随便)?(换|来|切)一?(个|张)?壁纸$/.test(t)) return voiceCall('wallpaper_random');
  if ((m = t.match(/^(换成|切到|切换到|设成|换|切|来|用)一?(个|张)?(.+?)的?壁纸$/))) return voiceCall('wallpaper_set_by_name', { name: m[3] });
  if ((m = t.match(/^壁纸(换成|切到|用)(.+)$/))) return voiceCall('wallpaper_set_by_name', { name: m[2] });

  if (/^(撤销|撤回|回退|还原|撤销上一步|返回上一步|恢复上一步)$/.test(t)) return voiceCall('history_undo');

  if (/^(暂停|暂停播放|停|停止|停止播放|别放了|先停)$/.test(t)) return voiceCall('player_toggle', {}, { onlyIf: 'playing' });
  if (/^(继续|继续播放|接着放|播放|开始播放|恢复播放)$/.test(t)) return voiceCall('player_toggle', {}, { onlyIf: 'paused' });
  if (/^(下一首|下一曲|下首|下一个|切歌|跳过|换一首|换首歌)歌?$/.test(t)) return voiceCall('player_next');
  if (/^(上一首|上一曲|上首|上一个)歌?$/.test(t)) return voiceCall('player_prev');
  if (/^(换一个|换个|换个版本)$/.test(t)) return voiceCall('music_play_next_candidate');

  if ((m = t.match(/^(切到|切换到|换成|改成|改为|设为)?(单曲循环|单曲播放|随机播放|顺序播放|列表循环|列表播放|循环播放)$/))) {
    return voiceCall('player_set_play_mode', { mode: /^单曲/.test(m[2]) ? 'single' : m[2] === '随机播放' ? 'shuffle' : 'loop' });
  }
  if (/^取消(红心|收藏|喜欢)(这首歌?|当前歌曲)?$/.test(t)) return voiceCall('player_like_current', { liked: false });
  if (/^我?(红心|收藏|喜欢|点赞)(这首歌?|当前歌曲)$|^(红心|收藏)$/.test(t)) return voiceCall('player_like_current', { liked: true });

  if (t === '静音') return voiceCall('player_set_volume', { value: 0 });
  if ((m = t.match(new RegExp('^(音量|声音)(调到|调成|设为|设成|设置为|改成|开到|到)?(百分之)?' + VOICE_NUM + '%?$')))) {
    return voiceCall('player_set_volume', { value: voiceParseNumber(m[4]) });
  }
  if (/^(大声点?|大点声|(声音|音量)(大|调大|调高|加大|高)一?(点|些)?|(调大|调高|加大)(声音|音量))$/.test(t)) return voiceCall('player_set_volume', { direction: 'up' });
  if (/^(小声点?|小点声|(声音|音量)(小|调小|调低|减小|低)一?(点|些)?|(调小|调低|减小)(声音|音量))$/.test(t)) return voiceCall('player_set_volume', { direction: 'down' });

  if ((m = t.match(new RegExp('^(快进|前进|往后|快退|后退|倒退|往前)' + VOICE_NUM + '?(秒钟?)?$')))) {
    var seconds = m[2] ? voiceParseNumber(m[2]) : 10;
    return voiceCall('player_seek', { delta: /^(快退|后退|倒退|往前)$/.test(m[1]) ? -seconds : seconds });
  }
  if ((m = t.match(/^(跳到|跳转到|拖到)(\d+)[:：](\d{2})$/))) return voiceCall('player_seek', { seconds: Number(m[2]) * 60 + Number(m[3]) });
  if ((m = t.match(new RegExp('^(跳到|跳转到|拖到)(?:' + VOICE_NUM + '分钟?)?(?:' + VOICE_NUM + '秒钟?)?$'))) && (m[2] || m[3])) {
    return voiceCall('player_seek', { seconds: (m[2] ? voiceParseNumber(m[2]) * 60 : 0) + (m[3] ? voiceParseNumber(m[3]) : 0) });
  }

  if ((m = t.match(/^(应用|使用|用|切到|换成)(用户)?存档(.+)$/))) return voiceCall('fx_apply_archive', { name: m[3] });
  if ((m = t.match(/^(应用|使用|用)(.+?)存档$/))) return voiceCall('fx_apply_archive', { name: m[2] });

  // SenseVoice often hears 预设 as 预社 / 浴社, so the suffix list carries the common mishearings.
  if ((m = t.match(/^(切到|切换到|换成|换到|切成|用|使用|打开)(.+?)(预设|预社|浴社|玉社|效果|特效|视觉)$/))) return voiceCall('fx_set_preset', { name: m[2] });
  if ((m = t.match(/^(视觉)?预设(切到|换成|用)?(.+)$/))) return voiceCall('fx_set_preset', { name: m[3] });
  if ((m = t.match(/^(切到|切换到|换成|换到|切成)(.+)$/))) return voiceCall('fx_set_preset', { name: m[2] });

  if (/^(播放|放|打开|来点)?(我喜欢的(音乐|歌曲|歌)?|红心歌单|我的红心|喜欢的音乐)$/.test(t)) return voiceCall('music_play_playlist', { name: '我喜欢的音乐' });
  if ((m = t.match(/^(播放|放|打开)歌单(.+)$/))) return voiceCall('music_play_playlist', { name: m[2] });
  if ((m = t.match(/^(播放|放|打开)(.+?)这?个?歌单$/))) return voiceCall('music_play_playlist', { name: m[2] });
  if ((m = t.match(/^(我想听|我要听|想听|来一首|来首|来点|放一首|放首|放点|播放一首|播放|放)(.+)$/))) {
    var query = m[2].replace(/(的歌曲?|这首歌)$/, '');
    if (query) return voiceCall('music_search_and_play', { query: query });
  }

  if ((m = t.match(/^(.+?)(调大|调高|加大|增大|加强|提高|大|高|强|亮)一?(点儿?|些)?$/))) return voiceCall('fx_adjust_param', { direction: 'up' }, { paramQuery: voiceFxQuery(m[1]), paramType: 'range' });
  if ((m = t.match(/^(调大|调高|加大|增大|加强|提高|增加)(.+)$/))) return voiceCall('fx_adjust_param', { direction: 'up' }, { paramQuery: voiceFxQuery(m[2]), paramType: 'range' });
  if ((m = t.match(/^(.+?)(调小|调低|减小|减弱|降低|小|低|弱|暗)一?(点儿?|些)?$/))) return voiceCall('fx_adjust_param', { direction: 'down' }, { paramQuery: voiceFxQuery(m[1]), paramType: 'range' });
  if ((m = t.match(/^(调小|调低|减小|减弱|降低|减少)(.+)$/))) return voiceCall('fx_adjust_param', { direction: 'down' }, { paramQuery: voiceFxQuery(m[2]), paramType: 'range' });

  if ((m = t.match(/^(打开|开启|启用|开)(.+)$/)) || (m = t.match(/^(.+?)(打开|开启)$/))) {
    return voiceCall('fx_set_param', { on: true }, { paramQuery: voiceFxQuery(/^(打开|开启|启用|开)$/.test(m[1]) ? m[2] : m[1]), paramType: 'toggle' });
  }
  if ((m = t.match(/^(关闭|关掉|禁用|停用|关)(.+)$/)) || (m = t.match(/^(.+?)(关闭|关掉|关了|关上)$/))) {
    return voiceCall('fx_set_param', { on: false }, { paramQuery: voiceFxQuery(/^(关闭|关掉|禁用|停用|关)$/.test(m[1]) ? m[2] : m[1]), paramType: 'toggle' });
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tests/voice-rules.test.js`
Expected: `OK voice-rules (38 sentences)`

---

### Task 2: 主进程识别 `desktop/voice-asr.js` + worker

**Files:**
- Create: `desktop/voice-asr.js`、`desktop/voice-asr-worker.js`、`tests/fixtures/fake-voice-asr-worker.js`、`tests/voice-asr-model.smoke.js`
- Test: `tests/voice-asr.test.js`

- [ ] **Step 1: 写假 worker** —— 新建 `tests/fixtures/fake-voice-asr-worker.js`：

```js
'use strict';

// Stand-in for desktop/voice-asr-worker.js: same message protocol, no model.
const { parentPort, workerData } = require('worker_threads');

if (workerData.modelDir.endsWith('fail-init')) {
  parentPort.postMessage({ type: 'error', error: 'boom' });
} else {
  parentPort.on('message', (msg) => {
    if (msg.type === 'audio') parentPort.postMessage({ type: 'result', text: 'len:' + msg.samples.length });
    if (msg.type === 'flush') parentPort.postMessage({ type: 'result', text: 'flushed' });
  });
  parentPort.postMessage({ type: 'ready' });
}
```

- [ ] **Step 2: 写失败测试** —— 新建 `tests/voice-asr.test.js`：

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VOICE_MODEL_FILES, createVoiceAsr } = require('../desktop/voice-asr');

const workerPath = path.join(__dirname, 'fixtures', 'fake-voice-asr-worker.js');

function fakeModelDir(name) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-voice-')), name);
  fs.mkdirSync(dir);
  VOICE_MODEL_FILES.forEach((file) => fs.writeFileSync(path.join(dir, file), ''));
  return dir;
}

function nextEvent(events) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no event')), 3000);
    events.waiter = (event) => { clearTimeout(timer); resolve(event); };
  });
}

(async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-voice-empty-'));
  const missing = await createVoiceAsr({ modelDir: empty, workerPath }).begin();
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'VOICE_MODEL_MISSING');
  assert.equal(missing.missing.length, VOICE_MODEL_FILES.length);

  const events = { waiter: null };
  const asr = createVoiceAsr({ modelDir: fakeModelDir('ok'), workerPath, onEvent: (event) => events.waiter && events.waiter(event) });
  assert.deepEqual(await asr.begin(), { ok: true });

  let got = nextEvent(events);
  asr.pushAudio(new Float32Array(1600));
  assert.deepEqual(await got, { type: 'result', text: 'len:1600' });

  got = nextEvent(events);
  asr.pushAudio([0, 0, 0]);
  asr.pushAudio(new Float32Array(16001));
  asr.flush();
  assert.deepEqual(await got, { type: 'result', text: 'flushed' }, 'non-Float32Array and oversized chunks are dropped');

  asr.dispose();
  assert.deepEqual(await asr.begin(), { ok: true }, 'begin after dispose starts a new worker');
  asr.dispose();

  const failed = await createVoiceAsr({ modelDir: fakeModelDir('fail-init'), workerPath }).begin();
  assert.deepEqual(failed, { ok: false, error: 'boom' });

  console.log('OK voice-asr');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node tests/voice-asr.test.js`
Expected: FAIL，`Cannot find module '../desktop/voice-asr'`

- [ ] **Step 4: 实现主进程封装** —— 新建 `desktop/voice-asr.js`：

```js
'use strict';

// Main-process owner of the speech worker: lazy load on first use, unload after idle, forward audio and events.
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const VOICE_MODEL_FILES = [
  'sherpa-onnx-wasm-main-vad-asr.js',
  'sherpa-onnx-wasm-main-vad-asr.wasm',
  'sherpa-onnx-wasm-main-vad-asr.data',
  'sherpa-onnx-asr.js',
  'sherpa-onnx-vad.js',
];
const VOICE_READY_TIMEOUT_MS = 30000;
const VOICE_MAX_CHUNK_SAMPLES = 16000;

function missingVoiceModelFiles(modelDir) {
  return VOICE_MODEL_FILES.filter((name) => !fs.existsSync(path.join(modelDir, name)));
}

function createVoiceAsr(options) {
  const opts = Object.assign({
    workerPath: path.join(__dirname, 'voice-asr-worker.js'),
    minSilenceSeconds: 0.8,
    idleUnloadMs: 10 * 60 * 1000,
    onEvent: () => {},
  }, options);
  let worker = null;
  let ready = null;
  let idleTimer = null;

  function emit(event) {
    try { opts.onEvent(event); } catch (_) {}
  }

  function unload() {
    clearTimeout(idleTimer);
    idleTimer = null;
    const current = worker;
    worker = null;
    ready = null;
    if (current) current.terminate().catch(() => {});
  }

  function ensureWorker() {
    if (ready) return ready;
    const missing = missingVoiceModelFiles(opts.modelDir);
    if (missing.length) return Promise.resolve({ ok: false, error: 'VOICE_MODEL_MISSING', missing });
    const current = new Worker(opts.workerPath, {
      workerData: { modelDir: opts.modelDir, minSilenceSeconds: opts.minSilenceSeconds },
    });
    worker = current;
    ready = new Promise((resolve) => {
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
        if (!result.ok && worker === current) unload();
      };
      const timer = setTimeout(() => settle({ ok: false, error: 'VOICE_MODEL_TIMEOUT' }), VOICE_READY_TIMEOUT_MS);
      current.on('message', (msg) => {
        if (!settled && msg && msg.type === 'ready') return settle({ ok: true });
        if (!settled && msg && msg.type === 'error') return settle({ ok: false, error: msg.error });
        emit(msg);
      });
      current.on('error', (error) => {
        const message = String(error && error.message || error);
        if (!settled) return settle({ ok: false, error: message });
        emit({ type: 'error', error: message });
        if (worker === current) unload();
      });
      current.on('exit', () => {
        settle({ ok: false, error: 'VOICE_WORKER_EXITED' });
        if (worker === current) {
          worker = null;
          ready = null;
        }
      });
    });
    return ready;
  }

  async function begin() {
    const result = await ensureWorker();
    if (!result.ok || !worker) return result.ok ? { ok: false, error: 'VOICE_WORKER_EXITED' } : result;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(unload, opts.idleUnloadMs);
    worker.postMessage({ type: 'start' });
    return { ok: true };
  }

  function pushAudio(samples) {
    if (!worker || !(samples instanceof Float32Array)) return;
    if (!samples.length || samples.length > VOICE_MAX_CHUNK_SAMPLES) return;
    worker.postMessage({ type: 'audio', samples });
  }

  function flush() {
    if (worker) worker.postMessage({ type: 'flush' });
  }

  return { begin, pushAudio, flush, dispose: unload };
}

module.exports = { VOICE_MODEL_FILES, createVoiceAsr, missingVoiceModelFiles };
```

- [ ] **Step 5: 实现 worker** —— 新建 `desktop/voice-asr-worker.js`：

```js
'use strict';

// Worker thread: loads the prebuilt sherpa-onnx WASM (SenseVoice + silero VAD) and turns 16 kHz audio chunks into text.
// The official build uses pthreads (SharedArrayBuffer), which Node worker threads support without cross-origin isolation.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parentPort, workerData } = require('worker_threads');

const SAMPLE_RATE = 16000;
const LEAD_IN_SAMPLES = 4800; // VAD segments start late and clip the first syllable; decode 0.3 s before the onset.
const MAIN_JS = 'sherpa-onnx-wasm-main-vad-asr.js';
const dir = path.resolve(workerData.modelDir);

let recognizer = null;
let vad = null;
let recorded = new Float32Array(0);
let pending = null;
let heardSpeech = false;

function runScript(name) {
  const file = path.join(dir, name);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}

function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function decode(samples) {
  const started = Date.now();
  const stream = recognizer.createStream();
  stream.acceptWaveform(SAMPLE_RATE, samples);
  recognizer.decode(stream);
  const text = String(recognizer.getResult(stream).text || '').trim();
  stream.free();
  parentPort.postMessage({ type: 'result', text, audioMs: Math.round(samples.length / 16), decodeMs: Date.now() - started });
}

function drainSegments() {
  while (!vad.isEmpty()) {
    const segment = vad.front();
    vad.pop();
    const from = Math.max(0, segment.start - LEAD_IN_SAMPLES);
    decode(recorded.slice(from, segment.start + segment.samples.length));
  }
}

function acceptAudio(samples) {
  recorded = concat(recorded, samples);
  const input = pending ? concat(pending, samples) : samples;
  const size = vad.config.sileroVad.windowSize;
  let offset = 0;
  for (; offset + size <= input.length; offset += size) {
    vad.acceptWaveform(input.subarray(offset, offset + size));
    if (!heardSpeech && vad.isDetected()) {
      heardSpeech = true;
      parentPort.postMessage({ type: 'speech-start' });
    }
  }
  pending = offset < input.length ? input.slice(offset) : null;
  drainSegments();
}

parentPort.on('message', (msg) => {
  try {
    if (msg.type === 'start') {
      vad.reset();
      recorded = new Float32Array(0);
      pending = null;
      heardSpeech = false;
    } else if (msg.type === 'audio') {
      acceptAudio(msg.samples);
    } else if (msg.type === 'flush') {
      vad.flush();
      drainSegments();
    }
  } catch (error) {
    parentPort.postMessage({ type: 'error', error: String(error && error.message || error) });
  }
});

// The Emscripten glue reads these globals the same way it does when loaded by a plain <script>.
globalThis.require = require;
globalThis.module = { exports: {} };
globalThis.__dirname = dir;
globalThis.__filename = path.join(dir, MAIN_JS);
globalThis.Module = {
  locateFile: (file) => path.join(dir, file),
  print: () => {},
  printErr: () => {},
  onRuntimeInitialized() {
    try {
      runScript('sherpa-onnx-asr.js');
      runScript('sherpa-onnx-vad.js');
      recognizer = new OfflineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          senseVoice: { model: './sense-voice.onnx', language: '', useInverseTextNormalization: 1 },
          tokens: './tokens.txt',
          numThreads: 1,
          debug: 0,
        },
      }, globalThis.Module);
      vad = createVad(globalThis.Module, {
        sileroVad: {
          model: './silero_vad.onnx',
          threshold: 0.5,
          minSilenceDuration: workerData.minSilenceSeconds,
          minSpeechDuration: 0.25,
          maxSpeechDuration: 8,
          windowSize: 512,
        },
        tenVad: { model: '', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 256 },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
        bufferSizeInSeconds: 10,
      });
      parentPort.postMessage({ type: 'ready' });
    } catch (error) {
      parentPort.postMessage({ type: 'error', error: String(error && error.message || error) });
    }
  },
};
runScript(MAIN_JS);
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node tests/voice-asr.test.js`
Expected: `OK voice-asr`

- [ ] **Step 7: 写真模型冒烟脚本** —— 新建 `tests/voice-asr-model.smoke.js`：

```js
'use strict';

// Real-model smoke: node tests/voice-asr-model.smoke.js <modelDir> <a.wav> [b.wav ...]
// WAVs must be 16 kHz mono 16-bit PCM. Audio is streamed in 100 ms chunks followed by 1.5 s of silence, like the microphone.
const assert = require('node:assert/strict');
const fs = require('fs');
const { createVoiceAsr, missingVoiceModelFiles } = require('../desktop/voice-asr');

const [modelDir, ...wavs] = process.argv.slice(2);
if (!modelDir || !wavs.length) {
  console.log('usage: node tests/voice-asr-model.smoke.js <modelDir> <a.wav> [b.wav ...]');
  process.exit(2);
}
if (missingVoiceModelFiles(modelDir).length) {
  console.log('SKIP voice-asr-model (model files missing in ' + modelDir + ')');
  process.exit(0);
}

function readWav(file) {
  const buf = fs.readFileSync(file);
  const dataAt = buf.indexOf('data') + 8;
  const samples = new Float32Array((buf.length - dataAt) >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(dataAt + i * 2) / 32768;
  return samples;
}

(async () => {
  let resolveEvent = null;
  const asr = createVoiceAsr({ modelDir, onEvent: (event) => { if (event.type === 'result' && resolveEvent) resolveEvent(event); } });
  const loadStarted = Date.now();
  const first = await asr.begin();
  assert.equal(first.ok, true, JSON.stringify(first));
  console.log('model load ms', Date.now() - loadStarted);

  for (const file of wavs) {
    const speech = readWav(file);
    const clip = new Float32Array(speech.length + 24000);
    clip.set(speech, 0);
    assert.deepEqual(await asr.begin(), { ok: true });
    const result = new Promise((resolve) => { resolveEvent = resolve; });
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= clip.length) return clearInterval(timer);
      asr.pushAudio(clip.slice(offset, offset + 1600));
      offset += 1600;
    }, 100);
    const event = await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve(null), 8000))]);
    clearInterval(timer);
    assert.ok(event, 'no result for ' + file);
    console.log(file, JSON.stringify(event.text), 'decode ' + event.decodeMs + 'ms');
    assert.ok(event.decodeMs < 1000, 'decode too slow: ' + event.decodeMs + 'ms');
  }
  asr.dispose();
  console.log('OK voice-asr-model');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 8: 用 Windows 中文 TTS 生成测试音频**（放 `%TEMP%`，不进项目目录）

先新建 `%TEMP%\mineradio-voice-smoke\sentences.txt`（UTF-8），每行一句：

```text
暂停
播放周杰伦的晴天
切到星河预设
光晕调大一点
随机换个壁纸
```

再新建 `%TEMP%\mineradio-voice-smoke\tts.ps1`（纯 ASCII，Windows PowerShell 5 也能跑）：

```powershell
param([string]$OutDir = "$env:TEMP\mineradio-voice-smoke")
Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$i = 0
foreach ($line in Get-Content -Encoding UTF8 (Join-Path $OutDir 'sentences.txt')) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voice = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
  if (-not $voice) { throw 'No zh-CN voice installed' }
  $s.SelectVoice($voice.VoiceInfo.Name)
  $s.SetOutputToWaveFile((Join-Path $OutDir "cmd$i.wav"), $fmt)
  $s.Speak($line)
  $s.Dispose()
  $i++
}
Get-ChildItem $OutDir -Filter *.wav | ForEach-Object { $_.FullName }
```

Run（PowerShell）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\mineradio-voice-smoke\tts.ps1"
```

Expected：输出 `cmd0.wav` … `cmd4.wav` 五个路径。

- [ ] **Step 9: 用 Mineradio 自带的 Electron 运行时跑冒烟**（需要 Task 0 已完成）

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$w = "$env:TEMP\mineradio-voice-smoke"
& D:\Mineradio\Mineradio.exe tests\voice-asr-model.smoke.js "$env:APPDATA\Mineradio\voice-model" "$w\cmd0.wav" "$w\cmd1.wav" "$w\cmd2.wav" "$w\cmd3.wav" "$w\cmd4.wav"
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

Expected：先打印 `model load ms <约 1500–2500>`，每句一行「文本 + decode <1000ms」，最后 `OK voice-asr-model`。第 3 句识别成「切到星河预社。」属正常（规则已兼容）。`OK` 之后可能多一行 `PostQueuedCompletionStatus: (6) ...`，是 Electron 以 Node 模式退出时 worker 已终止的无害警告。模型没装时打印 `SKIP ...`。

---

### Task 3: 主进程接线 `desktop/main.js` + `desktop/preload.js`

**Files:**
- Modify: `desktop/main.js`（8 处）、`desktop/preload.js`（1 处）

每处都是「查找」→「替换为」。查找文本在文件里必须**恰好出现一次**；找不到或不止一处就停下报告。

- [ ] **Step 1: `desktop/main.js` — require 识别模块**

查找：

```js
const { readOrCreateMcpToken, writeMcpClientInfo } = require('./mcp-http');
```

替换为：

```js
const { readOrCreateMcpToken, writeMcpClientInfo } = require('./mcp-http');
const { createVoiceAsr } = require('./voice-asr');
```

- [ ] **Step 2: `desktop/main.js` — grant 与 voiceAsr 变量**

查找：

```js
let gestureCameraPermissionGrant = null;
```

替换为：

```js
let gestureCameraPermissionGrant = null;
let voiceMicrophonePermissionGrant = null;
let voiceAsr = null;
```

- [ ] **Step 3: `desktop/main.js` — grant 时长常量**

查找：

```js
const GESTURE_CAMERA_PERMISSION_GRANT_MS = 45000;
```

替换为：

```js
const GESTURE_CAMERA_PERMISSION_GRANT_MS = 45000;
const VOICE_MICROPHONE_PERMISSION_GRANT_MS = 15000;
```

- [ ] **Step 4: `desktop/main.js` — 麦克风权限函数 + getVoiceAsr（插在 isTrustedWallpaperEngineIpc 前）**

查找：

```js
function isTrustedWallpaperEngineIpc(event) {
```

替换为：

```js
function createVoiceMicrophonePermissionGrant(event) {
  if (!isTrustedMainWindowIpc(event)) return null;
  const sourceUrl = event.senderFrame && event.senderFrame.url || event.sender.getURL();
  voiceMicrophonePermissionGrant = {
    webContentsId: event.sender.id,
    origin: sourceUrl,
    expiresAt: Date.now() + VOICE_MICROPHONE_PERMISSION_GRANT_MS,
  };
  return voiceMicrophonePermissionGrant;
}

// Mirror of isTrustedGestureCameraMediaPermission, but audio-only.
function isTrustedVoiceMicrophoneMediaPermission(webContents, origin, details) {
  const grant = voiceMicrophonePermissionGrant;
  if (!grant || Date.now() > grant.expiresAt) {
    voiceMicrophonePermissionGrant = null;
    return false;
  }
  try {
    if (!webContents || webContents.isDestroyed() || webContents.id !== grant.webContentsId) return false;
    if (!mainWindow || mainWindow.isDestroyed() || webContents !== mainWindow.webContents) return false;
    if (!isTrustedMainDocumentUrl(origin) || !isTrustedMainDocumentUrl(grant.origin)) return false;
    if (details && details.isMainFrame === false) return false;
    const mediaType = String(details && details.mediaType || '').toLowerCase();
    const mediaTypes = details && Array.isArray(details.mediaTypes)
      ? details.mediaTypes.map((value) => String(value || '').toLowerCase()).filter(Boolean)
      : [];
    if (mediaType.includes('video') || mediaTypes.some((value) => value.includes('video'))) return false;
    if (mediaType && !mediaType.includes('audio')) return false;
    if (mediaTypes.length && !mediaTypes.every((value) => value.includes('audio'))) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function getVoiceAsr() {
  if (!voiceAsr) {
    voiceAsr = createVoiceAsr({
      modelDir: path.join(STABLE_USER_DATA_PATH, 'voice-model'),
      onEvent: (event) => {
        if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
        mainWindow.webContents.send('mineradio-voice-event', event);
      },
    });
  }
  return voiceAsr;
}

function isTrustedWallpaperEngineIpc(event) {
```

- [ ] **Step 5: `desktop/main.js` — 权限 check handler 放行麦克风**

查找：

```js
    if (permission === 'media') return isTrustedWallpaperEnginePreparationMediaPermission(webContents, origin, details)
      || isTrustedGestureCameraMediaPermission(webContents, origin, details);
```

替换为：

```js
    if (permission === 'media') return isTrustedWallpaperEnginePreparationMediaPermission(webContents, origin, details)
      || isTrustedGestureCameraMediaPermission(webContents, origin, details)
      || isTrustedVoiceMicrophoneMediaPermission(webContents, origin, details);
```

- [ ] **Step 6: `desktop/main.js` — 权限 request handler 放行麦克风**

查找：

```js
      callback(isTrustedWallpaperEnginePreparationMediaPermission(webContents, origin, details)
        || isTrustedGestureCameraMediaPermission(webContents, origin, details));
```

替换为：

```js
      callback(isTrustedWallpaperEnginePreparationMediaPermission(webContents, origin, details)
        || isTrustedGestureCameraMediaPermission(webContents, origin, details)
        || isTrustedVoiceMicrophoneMediaPermission(webContents, origin, details));
```

- [ ] **Step 7: `desktop/main.js` — 3 个语音 IPC（插在 mineradio-wallpaper-update 前）**

查找：

```js
ipcMain.handle('mineradio-wallpaper-update', async (event) => {
```

替换为：

```js
ipcMain.handle('mineradio-voice-begin', async (event) => {
  if (!isTrustedMainWindowIpc(event)) return { ok: false, error: 'VOICE_UNTRUSTED_SENDER' };
  const result = await getVoiceAsr().begin();
  // Grant the microphone only after the model is ready, so a slow first load cannot outlive the grant.
  if (result.ok) createVoiceMicrophonePermissionGrant(event);
  return result;
});

ipcMain.on('mineradio-voice-audio', (event, samples) => {
  if (voiceAsr && isTrustedMainWindowIpc(event)) voiceAsr.pushAudio(samples);
});

ipcMain.on('mineradio-voice-flush', (event) => {
  if (voiceAsr && isTrustedMainWindowIpc(event)) voiceAsr.flush();
});

ipcMain.handle('mineradio-wallpaper-update', async (event) => {
```

- [ ] **Step 8: `desktop/main.js` — 退出时卸载 worker**

查找：

```js
    unregisterMineradioGlobalHotkeys();
    closeDesktopLyricsWindow();
```

替换为：

```js
    unregisterMineradioGlobalHotkeys();
    if (voiceAsr) voiceAsr.dispose();
    closeDesktopLyricsWindow();
```

- [ ] **Step 9: `desktop/preload.js` — 暴露语音 IPC**

查找：

```js
  requestGestureCameraPermission: () => ipcRenderer.invoke('mineradio-gesture-camera-request-permission'),
```

替换为：

```js
  requestGestureCameraPermission: () => ipcRenderer.invoke('mineradio-gesture-camera-request-permission'),
  voiceBegin: () => ipcRenderer.invoke('mineradio-voice-begin'),
  sendVoiceAudio: (samples) => ipcRenderer.send('mineradio-voice-audio', samples),
  voiceFlush: () => ipcRenderer.send('mineradio-voice-flush'),
  onVoiceEvent: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-voice-event', listener);
    return () => ipcRenderer.removeListener('mineradio-voice-event', listener);
  },
```

- [ ] **Step 10: 语法检查 + 摄像头权限旧测试**

Run: `node --check desktop/main.js && node --check desktop/preload.js && node tests/gesture-camera-permission.test.js`
Expected: `OK gesture-camera-permission`

---

### Task 4: 渲染层 `08-voice-command.js` + 热键 + 加载列表

**Files:**
- Create: `public/js/modules/10-shell/08-voice-command.js`
- Modify: `public/js/modules/00-state/00-core-stores.js`、`public/js/modules/07-fx/06-hotkeys.js`、`public/js/index-loader.js`、`tests/mcp-renderer-tools.test.js`
- Test: `tests/voice-command.test.js`

- [ ] **Step 1: 写失败测试** —— 新建 `tests/voice-command.test.js`：

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
const rules = read('public/js/modules/10-shell/07-voice-rules.js');
const command = read('public/js/modules/10-shell/08-voice-command.js');

const calls = [];
const toasts = [];
const params = [
  { id: 't-bloom', type: 'toggle', title: '粒子溢光' },
  { id: 'fx-bloom', type: 'range', title: '光晕强度' },
];
const ctx = {
  playing: true,
  showToast: (msg) => toasts.push(msg),
  window: {
    __mineradioMcpCall: async (name, args) => {
      calls.push([name, args]);
      if (name === 'fx_find_params') return { ok: true, data: { params: args.query === '光晕' ? params : [] } };
      if (name === 'player_now_playing') return { ok: true, message: '晴天 - 周杰伦' };
      return { ok: true, message: name };
    },
  },
};
vm.createContext(ctx);
vm.runInContext(rules, ctx);
vm.runInContext(command, ctx);

function reset(playing) {
  calls.length = 0;
  toasts.length = 0;
  ctx.playing = playing;
}

(async () => {
  reset(true);
  await ctx.runVoiceCommand('泛光调大一点');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['fx_find_params', { query: '光晕' }],
    ['fx_adjust_param', { direction: 'up', id: 'fx-bloom' }],
  ], 'range command skips the toggle that matched first');

  reset(true);
  await ctx.runVoiceCommand('关掉光晕');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), ['fx_set_param', { on: false, id: 't-bloom' }]);

  reset(true);
  const missing = await ctx.runVoiceCommand('打开程序');
  assert.equal(missing.error, 'PARAM_NOT_FOUND');
  assert.deepEqual(toasts, ['🤖 没找到开关：程序']);

  reset(false);
  await ctx.runVoiceCommand('暂停。');
  assert.equal(calls.length, 0, 'saying 暂停 while paused must not toggle playback back on');
  assert.deepEqual(toasts, ['🤖 已经暂停了']);

  reset(true);
  await ctx.runVoiceCommand('暂停');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['player_toggle', {}]]);

  reset(true);
  await ctx.runVoiceCommand('现在放的是什么歌');
  assert.deepEqual(toasts, ['🤖 晴天 - 周杰伦']);

  reset(true);
  const unknown = await ctx.runVoiceCommand('今天天气怎么样');
  assert.equal(unknown.error, 'NO_MATCH');
  assert.deepEqual(toasts, ['🤖 没听懂：今天天气怎么样']);
  assert.equal(calls.length, 0);

  const loader = read('public/js/index-loader.js');
  assert.match(loader, /'js\/modules\/10-shell\/06-mcp-tools\.js',\s*'js\/modules\/10-shell\/07-voice-rules\.js',\s*'js\/modules\/10-shell\/08-voice-command\.js',\s*'js\/modules\/11-main-loop\.js'/);
  assert.match(read('public/js/modules/00-state/00-core-stores.js'), /\{ key: 'voiceCommand', label: '语音指令', category: '语音', local: '', global: 'Ctrl\+Alt\+KeyV' \}/);
  assert.match(read('public/js/modules/07-fx/06-hotkeys.js'), /if \(actionKey === 'voiceCommand'\) return startVoiceCommand\(\);/);
  assert.doesNotMatch(command, /setVolume\(/, 'ducking must not persist volume');

  const preload = read('desktop/preload.js');
  assert.match(preload, /voiceBegin: \(\) => ipcRenderer\.invoke\('mineradio-voice-begin'\)/);
  assert.match(preload, /sendVoiceAudio: \(samples\) => ipcRenderer\.send\('mineradio-voice-audio', samples\)/);
  assert.match(preload, /ipcRenderer\.on\('mineradio-voice-event', listener\)/);

  const main = read('desktop/main.js');
  assert.match(main, /const \{ createVoiceAsr \} = require\('\.\/voice-asr'\);/);
  assert.match(main, /function isTrustedVoiceMicrophoneMediaPermission\(webContents, origin, details\)/);
  assert.match(main, /permission === 'media'\) return isTrustedWallpaperEnginePreparationMediaPermission\(webContents, origin, details\)\s*\|\| isTrustedGestureCameraMediaPermission\(webContents, origin, details\)\s*\|\| isTrustedVoiceMicrophoneMediaPermission\(webContents, origin, details\);/);
  assert.match(main, /callback\(isTrustedWallpaperEnginePreparationMediaPermission\(webContents, origin, details\)\s*\|\| isTrustedGestureCameraMediaPermission\(webContents, origin, details\)\s*\|\| isTrustedVoiceMicrophoneMediaPermission\(webContents, origin, details\)\);/);
  assert.match(main, /ipcMain\.handle\('mineradio-voice-begin'/);
  assert.match(main, /if \(voiceAsr\) voiceAsr\.dispose\(\);/);

  console.log('OK voice-command');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tests/voice-command.test.js`
Expected: FAIL，`ENOENT ... 08-voice-command.js`

- [ ] **Step 3: 实现** —— 新建 `public/js/modules/10-shell/08-voice-command.js`：

```js
// Voice command v1: global hotkey -> microphone -> main-process sherpa-onnx (desktop/voice-asr.js)
// -> parseVoiceCommand (07-voice-rules.js) -> MCP_TOOL_HANDLERS via window.__mineradioMcpCall.

var VOICE_DUCK_ENVELOPE = 0.15;
var VOICE_NO_SPEECH_MS = 5000;
var VOICE_MAX_LISTEN_MS = 12000;
var voiceSession = null;
var voiceModelLoaded = false;
var voiceEventsBound = false;
var voiceLastRun = null;

function voiceBeep(frequency) {
  try {
    var ctx = voiceBeep.ctx || (voiceBeep.ctx = new AudioContext());
    if (ctx.state === 'suspended') ctx.resume();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    var now = ctx.currentTime;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.13);
  } catch (e) { }
}

// Ducks through the fade envelope instead of setVolume, so the user's saved volume is never touched.
function voiceDuckMusic(session) {
  if (!playing || !audio || audio.paused || targetVolume <= 0.001) return;
  rampAudioOutputGain(targetVolume * VOICE_DUCK_ENVELOPE, 160);
  session.duckSerial = audioFadeSerial;
}

function voiceRestoreMusic(session) {
  if (session.duckSerial === null) return;
  var untouched = session.duckSerial === audioFadeSerial;
  session.duckSerial = null;
  // Pause, fade-in and track switches bump audioFadeSerial; after that they own the gain.
  if (untouched && playing && audio && !audio.paused) rampAudioOutputGain(targetVolume, 260);
}

async function runVoiceCommand(text) {
  var command = parseVoiceCommand(text);
  if (!command) {
    showToast('🤖 没听懂：' + text);
    return { ok: false, error: 'NO_MATCH' };
  }
  if (command.onlyIf === 'playing' && !playing) {
    showToast('🤖 已经暂停了');
    return { ok: true, skipped: true };
  }
  if (command.onlyIf === 'paused' && playing) {
    showToast('🤖 正在播放');
    return { ok: true, skipped: true };
  }
  var args = Object.assign({}, command.args);
  if (command.paramQuery) {
    var found = await window.__mineradioMcpCall('fx_find_params', { query: command.paramQuery });
    var params = found && found.ok && found.data ? found.data.params : [];
    var param = params.filter(function (p) { return p.type === command.paramType; })[0];
    if (!param) {
      showToast('🤖 没找到' + (command.paramType === 'toggle' ? '开关' : '参数') + '：' + command.paramQuery);
      return { ok: false, error: 'PARAM_NOT_FOUND' };
    }
    args.id = param.id;
  }
  var result = await window.__mineradioMcpCall(command.tool, args);
  // player_now_playing is a silent query for AI clients; spoken questions need a visible answer.
  if (command.tool === 'player_now_playing' && result && result.ok) showToast('🤖 ' + result.message);
  return result;
}

function stopVoiceCapture(session) {
  session.timers.forEach(clearTimeout);
  session.timers = [];
  if (session.processor) {
    session.processor.onaudioprocess = null;
    try { session.processor.disconnect(); } catch (e) { }
  }
  if (session.stream) session.stream.getTracks().forEach(function (track) { track.stop(); });
  if (session.ctx) session.ctx.close().catch(function () { });
  session.processor = null;
  session.stream = null;
  session.ctx = null;
}

function endVoiceSession(session, toast) {
  if (voiceSession !== session) return;
  voiceSession = null;
  stopVoiceCapture(session);
  voiceRestoreMusic(session);
  if (toast) showToast(toast);
}

async function handleVoiceEvent(event) {
  var session = voiceSession;
  if (!session || !event) return;
  if (event.type === 'speech-start') {
    session.heardSpeech = true;
    return;
  }
  if (event.type === 'error') {
    endVoiceSession(session, '🎙️ 识别出错：' + event.error);
    return;
  }
  if (event.type !== 'result') return;
  var resultAt = performance.now();
  var text = String(event.text || '').trim();
  endVoiceSession(session);
  if (!text.replace(/[\s，。、！？!?,.]/g, '')) {
    showToast('🎙️ 没听清');
    return;
  }
  voiceBeep(660);
  var result = await runVoiceCommand(text);
  voiceLastRun = { text: text, audioMs: event.audioMs, decodeMs: event.decodeMs, execMs: Math.round(performance.now() - resultAt), result: result };
}

async function startVoiceCommand() {
  if (voiceSession) {
    endVoiceSession(voiceSession, '🎙️ 已取消');
    return;
  }
  var api = getDesktopWindowApi();
  if (!api || typeof api.voiceBegin !== 'function') {
    showToast('🎙️ 语音指令只在桌面版可用');
    return;
  }
  if (!voiceEventsBound) {
    voiceEventsBound = true;
    api.onVoiceEvent(handleVoiceEvent);
  }
  var session = { ctx: null, stream: null, processor: null, timers: [], duckSerial: null, heardSpeech: false };
  voiceSession = session;
  if (!voiceModelLoaded) showToast('🎙️ 正在加载语音模型…');
  var begun = await api.voiceBegin();
  if (voiceSession !== session) return;
  if (!begun || !begun.ok) {
    var reason = begun && begun.error === 'VOICE_MODEL_MISSING' ? '未安装语音模型' : (begun && begun.error || '未知错误');
    endVoiceSession(session, '🎙️ 语音启动失败：' + reason);
    return;
  }
  voiceModelLoaded = true;
  voiceDuckMusic(session);
  voiceBeep(880);
  try {
    session.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
  } catch (error) {
    endVoiceSession(session, '🎙️ 麦克风不可用：' + (error && error.name || error));
    return;
  }
  if (voiceSession !== session) {
    stopVoiceCapture(session);
    return;
  }
  // A 16 kHz context lets Chromium resample the microphone to what SenseVoice expects.
  session.ctx = new AudioContext({ sampleRate: 16000 });
  var sourceNode = session.ctx.createMediaStreamSource(session.stream);
  session.processor = session.ctx.createScriptProcessor(1024, 1, 1);
  session.processor.onaudioprocess = function (e) {
    if (voiceSession === session) api.sendVoiceAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  sourceNode.connect(session.processor);
  session.processor.connect(session.ctx.destination);
  showToast('🎙️ 正在听…');
  session.timers.push(setTimeout(function () {
    if (voiceSession === session && !session.heardSpeech) endVoiceSession(session, '🎙️ 没听到声音');
  }, VOICE_NO_SPEECH_MS));
  session.timers.push(setTimeout(function () {
    if (voiceSession === session) api.voiceFlush();
  }, VOICE_MAX_LISTEN_MS));
  session.timers.push(setTimeout(function () {
    endVoiceSession(session, '🎙️ 没听清');
  }, VOICE_MAX_LISTEN_MS + 3000));
}
```

- [ ] **Step 4: `public/js/modules/00-state/00-core-stores.js` — HOTKEY_ACTIONS 加 voiceCommand**

查找：

```js
  { key: 'toggleDesktopLyrics', label: '桌面歌词', category: '歌词', local: 'Alt+KeyL', global: 'Ctrl+Alt+KeyL' }
];
```

替换为：

```js
  { key: 'toggleDesktopLyrics', label: '桌面歌词', category: '歌词', local: 'Alt+KeyL', global: 'Ctrl+Alt+KeyL' },
  { key: 'voiceCommand', label: '语音指令', category: '语音', local: '', global: 'Ctrl+Alt+KeyV' }
];
```

- [ ] **Step 5: `public/js/modules/07-fx/06-hotkeys.js` — executeHotkeyAction 加一行**

查找：

```js
  if (actionKey === 'toggleDesktopLyrics') return toggleFx('desktopLyrics');
```

替换为：

```js
  if (actionKey === 'toggleDesktopLyrics') return toggleFx('desktopLyrics');
  if (actionKey === 'voiceCommand') return startVoiceCommand();
```

- [ ] **Step 6: `public/js/index-loader.js` — 登记两个新模块**

查找：

```js
    'js/modules/10-shell/06-mcp-tools.js',
```

替换为：

```js
    'js/modules/10-shell/06-mcp-tools.js',
    'js/modules/10-shell/07-voice-rules.js',
    'js/modules/10-shell/08-voice-command.js',
```

- [ ] **Step 7: 同步第一阶段的加载顺序断言** —— `tests/mcp-renderer-tools.test.js` 第 19 行：

查找：

```js
assert.match(loader, /'js\/modules\/10-shell\/05-startup-bindings\.js',\s*'js\/modules\/10-shell\/06-mcp-tools\.js',\s*'js\/modules\/11-main-loop\.js'/);
```

替换为：

```js
assert.match(loader, /'js\/modules\/10-shell\/05-startup-bindings\.js',\s*'js\/modules\/10-shell\/06-mcp-tools\.js',\s*'js\/modules\/10-shell\/07-voice-rules\.js'/);
```

- [ ] **Step 8: 跑测试确认通过**

Run: `node tests/voice-command.test.js && node tests/mcp-renderer-tools.test.js`
Expected: `OK voice-command`、`OK mcp-renderer-tools`

---

### Task 5: 回归 + 真实应用冒烟

- [ ] **Step 1: 跑全部相关测试**

Run: `node tests/voice-rules.test.js && node tests/voice-asr.test.js && node tests/voice-command.test.js && node tests/mcp-renderer-tools.test.js && node tests/mcp-http.test.js && node tests/gesture-camera-permission.test.js && node tests/provider-removal-diy-cinema-preload.test.js && node tests/built-in-playlist-library.test.js && node tests/cuefield-mineradio-integration.test.js && node tests/main-window-runtime-recovery.test.js`
Expected: 每个都输出 `OK ...`，退出码 0。若某个旧测试在**改动前**就失败，记录下来，不要去修。

- [ ] **Step 2: 重启 Mineradio**（托盘右键退出，再启动；主进程改动 Ctrl+R 不生效）

- [ ] **Step 3: DevTools 冒烟**（`Ctrl+Shift+I` 打开 Console；Console 里 `console.log` 被过滤，用表达式返回值看结果）

```js
typeof startVoiceCommand + ' / ' + typeof parseVoiceCommand + ' / ' + typeof window.desktopWindow.voiceBegin
```
Expected：`function / function / function`

```js
JSON.stringify(await runVoiceCommand('切到星河预设'))
```
Expected：界面切到星河，toast「🤖 已切换：星河」。

```js
JSON.stringify(await runVoiceCommand('撤销'))
```
Expected：回到原预设。

- [ ] **Step 4: 热键设置页** —— 打开热键设置 → 全局页，出现「语音」分组「语音指令 `Ctrl+Alt+V`」，状态不是冲突。

- [ ] **Step 5: 第一次真说话** —— 放着歌，按 `Ctrl+Alt+V`：第一次 toast「🎙️ 正在加载语音模型…」约 2 秒；然后「嘀」一声、音乐明显变小、toast「🎙️ 正在听…」。说「暂停」，停顿：音乐恢复原音量后暂停。DevTools 里：

```js
JSON.stringify(voiceLastRun)
```
Expected：`text` 是「暂停。」，`decodeMs` + `execMs` < 1000，`result.ok` 为 true。

---

### Task 6: 手工验收（用户做）

- [ ] **Step 1: 10 句正式验收**（每句：按 `Ctrl+Alt+V` → 说 → 停顿；每句后在 DevTools 跑 `JSON.stringify(voiceLastRun)` 记下 `text / decodeMs / execMs`）

| # | 类别 | 说 | 期望 |
|---|---|---|---|
| 1 | 播放 | 暂停 | 暂停；已暂停时 toast「🤖 已经暂停了」，不会变成播放 |
| 2 | 播放 | 下一首 | 切歌 |
| 3 | 播放 | 音量调到三十 | 音量 30%，重启后音量仍是 30%（证明压低没写入存储） |
| 4 | 播放 | 快进三十秒 | 进度 +30 s |
| 5 | 搜歌 | 播放周杰伦的晴天 | 红心 / 历史有就直接放，否则网易云第一首 |
| 6 | 搜歌 | 换一个 | 放下一个候选 |
| 7 | 特效 | 切到唱片预设 | 预设切换，控制台历史有 🤖 条目 |
| 8 | 特效 | 泛光调大一点 | 「光晕强度」滑块变大（不是去开关「粒子溢光」） |
| 9 | 壁纸 | 随机换个壁纸 | WE 壁纸切换 |
| 10 | 壁纸 | 关掉壁纸 | 恢复原背景 |

通过标准：错 ≤ 1 句；`decodeMs + execMs` 全部 ≤ 1000。另外记一个体感：说完最后一个字到执行，大概几秒。

- [ ] **Step 2: 边界**

| # | 操作 | 期望 |
|---|---|---|
| 11 | 按热键后不说话 | 5 秒后「🎙️ 没听到声音」，音乐恢复 |
| 12 | 按热键后再按一次 | 「🎙️ 已取消」，音乐恢复 |
| 13 | 说「今天天气怎么样」 | 「🤖 没听懂：今天天气怎么样。」，什么都不执行 |
| 14 | 说「关闭程序」 | 「🤖 没找到开关：程序」，程序不退出 |
| 15 | 正在听的时候鼠标点暂停 | 音乐停；识别结束后不会被拉回原音量再响 |
| 16 | 不动 10 分钟后再按热键 | 又出现「正在加载语音模型…」（已卸载省内存），之后正常 |
| 17 | 全屏 / 壁纸模式下按热键 | 同样能听、能执行 |

- [ ] **Step 3: 把没通过的条目写成清单交回（编号 + 实际现象 + `voiceLastRun` + DevTools Console 报错）。不要自行扩大改动范围。**

---

## 完成后交回给 Claude 的东西

1. 改动文件列表（应正好是「文件结构」表里 15 个）。
2. Task 2 Step 9、Task 3 Step 10、Task 5 Step 1 的完整终端输出。
3. Task 5 Step 3–5 的实际返回。
