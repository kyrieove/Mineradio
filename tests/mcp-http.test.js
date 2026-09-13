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
