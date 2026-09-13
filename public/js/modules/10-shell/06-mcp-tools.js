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
