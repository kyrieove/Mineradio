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
