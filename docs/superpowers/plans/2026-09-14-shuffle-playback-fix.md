# 随机播放（Shuffle）修复 Implementation Plan

> **For agentic workers:** 按任务顺序执行，每步用 `- [ ]` 勾选。每个任务先写测试、看它失败、再实现、看它通过。**不要 git commit**。

**Goal:** 修好 Mineradio 的随机播放，使其符合业界标准 Shuffle 语义——一轮之内按洗好的固定序列顺序前进（队列面板高亮始终 1→2→3 下移、列表内容在一轮内不变），一轮播完后重新洗牌，从而做到"每轮顺序都不一样"，且不再出现"上一首/下一首来回弹回同一首"。

**Architecture:** 洗牌**只在两个时机发生**：(1) 首次进入随机模式；(2) 一轮播完（`nextTrack` 走到队尾）。一轮之内 `playQueue` 数组完全不动，`currentIdx` 顺序 +1，队列面板渲染（`renderQueuePanel` 里的 `i === currentIdx`）因此天然保持有序高亮。回退由 `shuffleRoundStartIdx` 界定本轮边界，跨轮不越界。

**Tech Stack:** 渲染层经典脚本全局函数、现有 Fisher-Yates（`shuffleArrayInPlace`）、`node tests/*.test.js` 裸跑 `node:assert` 测试。

---

## 0. 背景事实（已核对源码，实施时不用再查）

**工作目录：`D:\Mineradio\resources\app\`**（实际运行的明文源码，改这里才生效）。下文所有路径相对这个目录。

| 事实 | 位置 |
|---|---|
| 全局 `playQueue` / `currentIdx` / `playing` 声明 | `public/js/modules/00-state/00-core-stores.js:22` |
| 全局 `playMode = 'loop'` 声明 | `public/js/modules/00-state/01-perf-render-state.js:24` |
| `shuffleArrayInPlace(items)` Fisher-Yates 洗牌 | `public/js/modules/05-playback/14-player-controls.js:607` |
| `reorderQueueForShufflePlaybackOrder(startIdx, opts)` 洗牌 + 重排队列 + `currentIdx = 0` | `public/js/modules/05-playback/14-player-controls.js:616` |
| `nextTrack(userInitiated)` | `public/js/modules/05-playback/14-player-controls.js:640` |
| `prevTrack(userInitiated)` | `public/js/modules/05-playback/14-player-controls.js:664` |
| `shuffleQueue()`（"队列已随机"按钮） | `public/js/modules/05-playback/14-player-controls.js:673` |
| `setPlayMode(nextMode)` | `public/js/modules/05-playback/14-player-controls.js:748` |
| `cyclePlayMode()` 调用 `setPlayMode` | `public/js/modules/05-playback/14-player-controls.js:762` |
| `playQueueAt(idx, opts)`，其中 `idx` 会被重排返回值覆盖 | `public/js/modules/05-playback/13-playback-start-audio.js:986`、`1006`、`1018` |
| `playAlbumGaplessNextOnEnded` 用 `skipShuffleOrder: true` | `public/js/modules/05-playback/13-playback-start-audio.js:857` |
| `saveLastPlaybackSnapshot(force, reason)` 持久化 `playQueue.slice(0,120)` | `public/js/modules/05-playback/09-queue-snapshot-autoplay.js:39`、`47` |
| `restoreLastPlaybackSnapshot()` 恢复队列与 `currentIdx` | `public/js/modules/05-playback/09-queue-snapshot-autoplay.js:74` |
| `renderQueuePanel` 用 `i === currentIdx` 标 `.now` 高亮 | `public/js/modules/06-lyrics/01-playlist-panel-shell.js:451`、`463` |
| `queueItemKey(song)` 生成稳定 key | `public/js/modules/05-playback/09-queue-snapshot-autoplay.js:2` |

**渲染层约束**：模块是经典 `<script>`，顶层 `function` / `var` 都是全局；`00-state/*` 先于 `05-playback/*` 加载（见 `public/js/index-loader.js`）。

**已确认的三个决策**（本计划按此实现）：
1. 走到队尾自动重新洗牌（不只靠手动点"随机播放"按钮）。
2. 重洗时排除刚播完的那首，避免新一轮第一首又是它。
3. 洗牌不加"避免同歌手连播"约束，纯 Fisher-Yates。

---

## 1. 行为规格（改完必须成立）

| # | 场景 | 期望行为 |
|---|---|---|
| S1 | 切到随机模式 | 洗一次牌；当前歌钉在队首；`currentIdx = 0`；面板高亮第 1 行 |
| S2 | 点"下一首" | `currentIdx + 1`；面板高亮下移一格；**队列数组不动** |
| S3 | 点"上一首" | `currentIdx - 1`，且不得退到本轮起点之前 |
| S4 | A→下一首→上一首 | 回到 A（业界标准行为，`prevTrack` 是 `nextTrack` 的逆操作） |
| S5 | 一路"下一首"播到队尾再一下 | **重新洗牌**，新一轮开始；刚播完那首排在新一轮末尾 |
| S6 | `shuffle → single → shuffle` | **不重洗**，恢复原序列；`shuffleRoundStartIdx` 不变 |
| S7 | `loop → shuffle` | 洗一次牌（首次进入） |
| S8 | 播到队尾未播完就重启应用 | 恢复原始队列顺序 + 本轮进度，不恢复"被洗过的顺序" |
| S9 | 手动点队列里某一首 | 不动数组，`currentIdx = i` 直接播（原语义保留） |
| S10 | 手动点"队列已随机"按钮 | 清空本轮记录，立即重洗 |

---

## 2. 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `tests/shuffle-playback-order.test.js` | 新建 | 静态断言 + 纯函数模拟洗牌轮次语义 |
| `public/js/modules/00-state/01-perf-render-state.js` | 改 1 处 | 新增 3 个全局状态 |
| `public/js/modules/05-playback/14-player-controls.js` | 改 4 处 | `reorderQueueForShufflePlaybackOrder` 参数化、`nextTrack` 尾部重洗、`prevTrack` 轮次边界、`setPlayMode` 往返判断 |
| `public/js/modules/05-playback/13-playback-start-audio.js` | 改 1 处 | 删掉 `playQueueAt` 里的洗牌调用（死代码） |
| `public/js/modules/05-playback/09-queue-snapshot-autoplay.js` | 改 2 处 | 快照存原始顺序 + 轮次状态；恢复时重建 |

---

### Task 1: 写失败测试

**Files:**
- 新建: `tests/shuffle-playback-order.test.js`

- [ ] **Step 1: 新建测试文件**

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(appRoot, rel), 'utf8');

const perfState = read('public/js/modules/00-state/01-perf-render-state.js');
const controls = read('public/js/modules/05-playback/14-player-controls.js');
const startAudio = read('public/js/modules/05-playback/13-playback-start-audio.js');
const snapshot = read('public/js/modules/05-playback/09-queue-snapshot-autoplay.js');

// --- 全局状态必须存在 ---
for (const name of ['shuffleRoundStartIdx', 'shuffleRoundExcludedKey', 'shuffleModePredecessor']) {
  assert.match(perfState, new RegExp('var\\s+' + name + '\\b'), name + ' must be declared in 01-perf-render-state.js');
}

// --- playQueueAt 里那行洗牌调用必须删掉（它是"每次切歌都重排队列"的根因）---
assert.doesNotMatch(startAudio, /idx = reorderQueueForShufflePlaybackOrder\(idx, \{ reason: 'shuffle-play-queue-at'/);

// --- nextTrack 尾部必须重新洗牌，而不是取模绕回开头 ---
assert.match(controls, /function restartShuffleRound\s*\(/, 'restartShuffleRound must exist');
assert.doesNotMatch(
  controls,
  /if \(playMode === 'shuffle'\) currentIdx = currentIdx < 0 \? 0 : \(currentIdx \+ 1\) % playQueue\.length;/,
  'nextTrack must not wrap around by modulo'
);

// --- prevTrack 必须尊重本轮起点 ---
assert.match(controls, /shuffleRoundStartIdx/, 'prevTrack must consult shuffleRoundStartIdx');

// --- setPlayMode 必须能识别"从 single 回到 shuffle" ---
assert.match(controls, /shuffleModePredecessor/, 'setPlayMode must track the predecessor mode');

// --- 快照必须存原始顺序与轮次状态 ---
assert.match(snapshot, /shuffleOriginQueue/, 'snapshot must persist the pre-shuffle order');

// --- 纯逻辑：洗牌轮次语义 ---
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`
  function shuffleArrayInPlaceT(items) {
    for (var i = items.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = items[i]; items[i] = items[j]; items[j] = tmp;
    }
    return items;
  }
`, sandbox);

// 一轮之内不重复：把 "当前歌 + 其余打乱" 展开成序列，key 应互不重复
const queue = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
vm.runInContext('var q = ' + JSON.stringify(queue) + '; shuffleArrayInPlaceT(q);', sandbox);
const shuffled = sandbox.q.slice();
assert.equal(shuffled.length, queue.length);
assert.deepEqual(shuffled.slice().sort(), queue.slice().sort(), 'shuffle must be a permutation');
assert.notDeepEqual(shuffled, queue, 'a shuffled 8-item array should not keep its original order (1/40320 chance)');

console.log('OK shuffle-playback-order');
```

- [ ] **Step 2: 跑测试确认失败**

```bash
node tests/shuffle-playback-order.test.js
```

Expected: 失败，首个断言报 `shuffleRoundStartIdx must be declared in 01-perf-render-state.js`。

---

### Task 2: 新增全局状态

**Files:**
- 改: `public/js/modules/00-state/01-perf-render-state.js`

- [ ] **Step 1: 在 `var queueViewTab = ..., playMode = 'loop', miniQueueOpen = false;` 下一行加**

```js
var shuffleRoundStartIdx = 0;
var shuffleRoundExcludedKey = '';
var shuffleModePredecessor = '';
```

**语义**：
- `shuffleRoundStartIdx`：本轮洗牌后当前歌所在的下标。正常进 shuffle 时为 0；恢复/重洗后为 0。`prevTrack` 不得退到它之前。
- `shuffleRoundExcludedKey`：下一轮洗牌时要排到末尾的那首（即刚播完的队尾那首）的 `queueItemKey`。
- `shuffleModePredecessor`：上一次的播放模式，用于识别 `shuffle → single → shuffle` 往返，避免重复洗牌。

- [ ] **Step 2: 语法检查**

```bash
node --check public/js/modules/00-state/01-perf-render-state.js
```

Expected: 无输出，退出码 0。

---

### Task 3: `reorderQueueForShufflePlaybackOrder` 参数化

**Files:**
- 改: `public/js/modules/05-playback/14-player-controls.js:616`

- [ ] **Step 1: 把 `reorderQueueForShufflePlaybackOrder` 整个函数替换为**

```js
function reorderQueueForShufflePlaybackOrder(startIdx, opts) {
  opts = opts || {};
  if (!playQueue.length) return -1;
  startIdx = Math.round(Number(startIdx));
  if (!isFinite(startIdx) || startIdx < 0 || startIdx >= playQueue.length) {
    startIdx = currentIdx >= 0 && currentIdx < playQueue.length ? currentIdx : 0;
  }
  if (playQueue.length > 1) {
    var currentSong = playQueue[startIdx];
    var excludedKey = String(opts.excludeKey || shuffleRoundExcludedKey || '');
    var upcoming = [];
    var excluded = null;
    for (var i = 0; i < playQueue.length; i++) {
      if (i === startIdx) continue;
      if (excludedKey && queueItemKey(playQueue[i]) === excludedKey) excluded = playQueue[i];
      else upcoming.push(playQueue[i]);
    }
    shuffleArrayInPlace(upcoming);
    playQueue.length = 0;
    playQueue.push(currentSong);
    for (var j = 0; j < upcoming.length; j++) playQueue.push(upcoming[j]);
    if (excluded) playQueue.push(excluded);
  }
  currentIdx = 0;
  shuffleRoundStartIdx = 0;
  shuffleRoundExcludedKey = '';
  if (opts.renderPanel !== false) safeRenderQueuePanel(opts.reason || 'shuffle-playback-order', { animate: false, scrollCurrent: false, deferWhenHidden: false });
  if (opts.rebuildShelf !== false) safeShelfRebuild(opts.reason || 'shuffle-playback-order', true);
  if (opts.persistSnapshot !== false && typeof saveLastPlaybackSnapshot === 'function') saveLastPlaybackSnapshot(true, opts.reason || 'shuffle-playback-order');
  return currentIdx;
}
```

**关键改动**：末尾的 `excludeKey` 把那首排到新一轮的最后一位，保证它不会成为新一轮第一首。

- [ ] **Step 2: 语法检查**

```bash
node --check public/js/modules/05-playback/14-player-controls.js
```

Expected: 无输出，退出码 0。

---

### Task 4: `nextTrack` 尾部重新洗牌

**Files:**
- 改: `public/js/modules/05-playback/14-player-controls.js:640`

- [ ] **Step 1: 在 `nextTrack` 之前插入 `restartShuffleRound` 函数**

```js
function restartShuffleRound() {
  shuffleRoundExcludedKey = queueItemKey(playQueue[playQueue.length - 1]);
  reorderQueueForShufflePlaybackOrder(0, { reason: 'shuffle-round-restart', excludeKey: shuffleRoundExcludedKey });
  return currentIdx;
}
```

- [ ] **Step 2: 把 `nextTrack` 里这两行**

```js
  if (playMode === 'shuffle') currentIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % playQueue.length;
  else currentIdx = (currentIdx + 1) % playQueue.length;
```

**替换为**

```js
  if (playMode === 'shuffle' && currentIdx + 1 >= playQueue.length) {
    restartShuffleRound();
  } else if (playMode === 'shuffle') {
    currentIdx = currentIdx < 0 ? 0 : currentIdx + 1;
  } else {
    currentIdx = (currentIdx + 1) % playQueue.length;
  }
```

**语义**：随机模式下走到队尾时重洗，而不是取模绕回开头。

- [ ] **Step 3: 语法检查**

```bash
node --check public/js/modules/05-playback/14-player-controls.js
```

Expected: 无输出，退出码 0。

---

### Task 5: `prevTrack` 尊重本轮起点

**Files:**
- 改: `public/js/modules/05-playback/14-player-controls.js:664`

- [ ] **Step 1: 把 `prevTrack` 里这一行**

```js
  currentIdx = (currentIdx - 1 + playQueue.length) % playQueue.length;
```

**替换为**

```js
  if (playMode === 'shuffle' && currentIdx > shuffleRoundStartIdx) currentIdx = currentIdx - 1;
  else currentIdx = (currentIdx - 1 + playQueue.length) % playQueue.length;
```

**语义**：随机模式下本轮之内顺序回退（与 `nextTrack` 互逆，满足 S4）；走到本轮起点时按普通取模回退，不会越界到上一轮的残留位置。

- [ ] **Step 2: 语法检查**

```bash
node --check public/js/modules/05-playback/14-player-controls.js
```

Expected: 无输出，退出码 0。

---

### Task 6: `setPlayMode` 识别往返

**Files:**
- 改: `public/js/modules/05-playback/14-player-controls.js:748`

- [ ] **Step 1: 把 `setPlayMode` 里的**

```js
  if (playMode === 'shuffle' && prevMode !== 'shuffle') {
    reorderQueueForShufflePlaybackOrder(currentIdx, { reason: 'play-mode-shuffle' });
  }
```

**替换为**

```js
  if (playMode === 'shuffle' && prevMode !== 'shuffle') {
    if (prevMode !== 'single' || shuffleModePredecessor !== 'shuffle') {
      reorderQueueForShufflePlaybackOrder(currentIdx, { reason: 'play-mode-shuffle' });
    }
  }
  shuffleModePredecessor = prevMode;
```

**语义**：`loop → shuffle` 洗牌；`shuffle → single → shuffle` 往返时**不重洗**，恢复原序列（满足 S6）。

- [ ] **Step 2: 语法检查**

```bash
node --check public/js/modules/05-playback/14-player-controls.js
```

Expected: 无输出，退出码 0。

---

### Task 7: 删掉 `playQueueAt` 里的洗牌死代码

**Files:**
- 改: `public/js/modules/05-playback/13-playback-start-audio.js:998-1007`

- [ ] **Step 1: 删掉这个整块**

```js
  if (
    playMode === 'shuffle'
    && !opts.skipShuffleOrder
    && !opts.autoRepeat
    && !opts.qualitySwitch
    && !opts.resumeRecovery
    && !opts.fallbackDepth
    && typeof reorderQueueForShufflePlaybackOrder === 'function'
  ) {
    idx = reorderQueueForShufflePlaybackOrder(idx, { reason: 'shuffle-play-queue-at', renderPanel: false, rebuildShelf: false, persistSnapshot: false });
  }
```

**理由**：`reorderQueueForShufflePlaybackOrder` 内部无条件 `currentIdx = 0`，导致这里的 `idx` 赋值永远失效；且它每次切歌都重排队列，是"面板高亮乱跳"的根因。洗牌改由 Task 3/4/6 在明确时机触发。

**注意**：删掉后 `opts.skipShuffleOrder` 在没有别处消费的情况下成为无效参数，但 `14-player-controls.js` / `11-provider-fallback.js` / `18-cuefield-automix-integration.js` 里仍会传它——**保留传参，不要一并清理**，避免扩大改动范围。

- [ ] **Step 2: 语法检查**

```bash
node --check public/js/modules/05-playback/13-playback-start-audio.js
```

Expected: 无输出，退出码 0。

---

### Task 8: 快照存原始顺序

**Files:**
- 改: `public/js/modules/05-playback/09-queue-snapshot-autoplay.js:39` 与 `:74`

- [ ] **Step 1: 在 `saveLastPlaybackSnapshot` 里，`var queue = ...` 那一行之前插入**

```js
  var shuffleOrigin = (playMode === 'shuffle' && Array.isArray(shuffleOriginQueue) && shuffleOriginQueue.length)
    ? shuffleOriginQueue.slice(0, 120).map(playbackRestoreSongSnapshot).filter(function (item) { return item && (item.id || item.mid || item.localKey || item.name); })
    : null;
```

- [ ] **Step 2: 在 `payload` 对象里，`queue: queue` 之后加一行**

```js
    shuffleOriginQueue: shuffleOrigin,
    shuffleRoundStartIdx: playMode === 'shuffle' ? shuffleRoundStartIdx : 0,
```

- [ ] **Step 3: 在 `restoreLastPlaybackSnapshot` 里，`playQueue = queue;` 与 `currentIdx = idx;` 之间插入**

```js
    if (playMode === 'shuffle' && Array.isArray(snapshot.shuffleOriginQueue) && snapshot.shuffleOriginQueue.length) {
      shuffleOriginQueue = queue.slice();
      var originQueue = snapshot.shuffleOriginQueue.map(function (song) { return hydrateCustomCover(Object.assign({}, song)); }).filter(function (song) { return song && (song.id || song.mid || song.name); });
      if (originQueue.length) {
        playQueue = originQueue;
        var originIdx = -1;
        for (var oi = 0; oi < playQueue.length; oi++) {
          if (queueItemKey(playQueue[oi]) === queueItemKey(current)) { originIdx = oi; break; }
        }
        idx = originIdx >= 0 ? originIdx : 0;
        shuffleRoundStartIdx = 0;
      }
    }
```

**语义**：随机模式下快照里额外存一份"洗牌前的原始顺序"；恢复时按原始顺序重建队列（满足 S8），不再把上一次的洗牌结果当成新起点。

- [ ] **Step 4: 在 `00-state/01-perf-render-state.js` 里补一个全局**

在 Task 2 加的三行之后再加：

```js
var shuffleOriginQueue = [];
```

- [ ] **Step 5: 在 `reorderQueueForShufflePlaybackOrder` 里维护 `shuffleOriginQueue`**

在 Task 3 那个函数的 `currentIdx = 0;` 之前插入：

```js
  if (!shuffleOriginQueue.length) shuffleOriginQueue = playQueue.slice();
```

**语义**：首次洗牌前把原始顺序留一份底；后续重洗不再覆盖。

- [ ] **Step 6: 语法检查**

```bash
node --check public/js/modules/05-playback/09-queue-snapshot-autoplay.js && node --check public/js/modules/00-state/01-perf-render-state.js
```

Expected: 无输出，退出码 0。

---

### Task 9: 跑测试确认通过

- [ ] **Step 1: 跑新测试**

```bash
node tests/shuffle-playback-order.test.js
```

Expected: `OK shuffle-playback-order`

- [ ] **Step 2: 跑相关回归（确保没打破既有行为）**

```bash
node tests/playback-single-repeat-loop.test.js && node tests/main-window-runtime-recovery.test.js && node tests/built-in-playlist-library.test.js && node tests/cuefield-mineradio-integration.test.js && node tests/mcp-renderer-tools.test.js
```

Expected: 每个都输出 `OK ...` 或 TAP `# fail 0`，退出码 0。

- [ ] **Step 3: 重启 Mineradio 后手工验证**

按 S1-S10 逐条验证。重点是：
- S2：连点"下一首"三次，队列面板高亮应依次下移，且**列表内容不变**。
- S4：A→下一首→上一首，应回到 A。
- S5：一路播到队尾再点一下，应换出一套**不同的顺序**，且刚播完那首不在最前。
- S6：`随机→单曲→随机`，队列顺序应**不变**。

---

## 完成后交回的东西

1. 改动文件列表（应为 4 改 + 1 新建测试 = 5 个）。
2. `node tests/shuffle-playback-order.test.js` 与 Task 9 Step 2 的完整输出。
3. S1-S10 的手工验证结果（通过 / 失败 + 现象）。
