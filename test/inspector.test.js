// The page_* tools come from chrome-devtools-mcp running inside the app's own process: the Claude
// desktop app's Node.js refuses to start a second Node.js process, which is how they were lost before.
// No browser is started here: listing the tools needs none.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CURATED } from '../src/inspector.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the app offers the page_* tools and says so in bridge_status', { timeout: 60_000 }, async (t) => {
  const data = mkdtempSync(path.join(os.tmpdir(), 'bw-data-'));
  const p = spawn(process.execPath, [path.join(root, 'src', 'index.js')], {
    env: { ...process.env, BW_NO_INSPECTOR: '', BW_BRIDGE_TOKEN: '', BW_SERVER_URL: 'http://127.0.0.1:9', BW_DATA_DIR: data },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  t.after(() => { p.stdin.end(); p.kill(); rmSync(data, { recursive: true, force: true }); });
  let buffer = '';
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buffer += d;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      // Every line on stdout is a message of the protocol: the inspector writes nothing of its own there.
      const m = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(m.id)?.(m);
    }
  });
  const rpc = (id, method, params) => new Promise((resolve) => {
    waiting.set(id, resolve);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const names = (await rpc(2, 'tools/list', {})).result.tools.map((x) => x.name);
  assert.deepEqual(names.filter((n) => n.startsWith('page_')).sort(), CURATED.map((n) => `page_${n}`).sort());
  const status = (await rpc(3, 'tools/call', { name: 'bridge_status', arguments: {} })).result.content[0].text;
  assert.match(status, new RegExp(`Page inspector: ready \\(${CURATED.length} page_\\* tools\\)`));
});
