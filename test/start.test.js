// The launcher Claude Code starts (src/start.js): a copy of the plugin without node_modules, as an
// install from GitHub gives, installs its dependencies into the data folder and then answers as the
// bridge; when that can't be done it still answers, and says why.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { depsDir, installed } from '../src/start.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A copy of the plugin as git has it: no node_modules. */
function copy() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-plugin-'));
  for (const f of ['src', 'package.json', 'package-lock.json']) cpSync(path.join(root, f), path.join(dir, f), { recursive: true });
  return dir;
}

/** Starts the launcher as Claude Code does and returns bridge_status. */
async function status(dir, env) {
  const p = spawn(process.execPath, [path.join(dir, 'src', 'start.js')], {
    env: { ...process.env, BW_NO_INSPECTOR: '1', BW_BRIDGE_TOKEN: '', BW_SERVER_URL: 'http://127.0.0.1:9', BW_DATA_DIR: path.join(dir, 'runs'), ...env },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buffer = '';
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buffer += d;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const m = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(m.id)?.(m);
    }
  });
  const rpc = (id, method, params) => new Promise((resolve) => {
    waiting.set(id, resolve);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const r = await rpc(2, 'tools/call', { name: 'bridge_status', arguments: {} });
    return r.result.content[0].text;
  } finally {
    p.stdin.end();
    p.kill();
  }
}

test('this clone has its dependencies', () => {
  assert.equal(installed(), true);
  assert.match(path.relative(path.join('data', 'deps'), depsDir('data')), /^[0-9a-f]{12}$/);
});

test('a copy without node_modules installs them into the data folder, then answers as the bridge', { timeout: 180_000 }, async (t) => {
  const dir = copy();
  const data = mkdtempSync(path.join(os.tmpdir(), 'bw-data-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); });
  const text = await status(dir, { CLAUDE_PLUGIN_DATA: data });
  assert.match(text, /Connection: not linked to an account yet/);
  assert.match(text, /What to do next:/);
  assert.ok(lstatSync(path.join(dir, 'node_modules')).isSymbolicLink());
  assert.ok(existsSync(path.join(depsDir(data), 'node_modules', 'playwright-core', 'package.json')));
  // A second start finds them and installs nothing.
  assert.match(await status(dir, { CLAUDE_PLUGIN_DATA: data }), /Connection: not linked to an account yet/);
});

test('when the install can\'t be done, bridge_status says why and what the user needs', { timeout: 60_000 }, async (t) => {
  const dir = copy();
  const data = mkdtempSync(path.join(os.tmpdir(), 'bw-data-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); });
  // A lock file npm can't use.
  writeFileSync(path.join(dir, 'package-lock.json'), '{ not json');
  const text = await status(dir, { CLAUDE_PLUGIN_DATA: data });
  assert.match(text, /not started/);
  assert.match(text, /Node\.js 22 or newer/);
  assert.equal(existsSync(path.join(dir, 'node_modules')), false);
});
