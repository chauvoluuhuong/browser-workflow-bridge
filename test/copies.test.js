// Several copies of the app on one data folder: one is in charge of the server, the others are passive.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Copies, meetingPoint } from '../src/copies.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  assert.fail('timed out');
};
const folder = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-copies-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A copy that notes what it is told. */
function copy(dir, name, extra = {}) {
  const seen = { name, inCharge: 0, passive: 0, acts: [], browser: undefined, returned: 0 };
  const c = new Copies({
    dir,
    settleMs: 0,
    onInCharge: () => { seen.inCharge++; },
    onPassive: () => { seen.passive++; },
    status: async () => `status of ${name}`,
    act: async (a) => { seen.acts.push(a); },
    onBrowser: (b) => { seen.browser = b; },
    onReturned: () => { seen.returned++; },
    ...extra,
  });
  return { c, seen };
}

test('the first copy is in charge; the next ones ask it', async (t) => {
  const dir = folder(t);
  const a = copy(dir, 'a');
  const b = copy(dir, 'b');
  t.after(() => { a.c.stop(); b.c.stop(); });
  await a.c.start();
  a.c.setBrowser({ mode: 'launch' });
  await b.c.start();
  assert.equal(a.c.leading, true);
  assert.equal(b.c.leading, false);
  assert.deepEqual([a.seen.inCharge, b.seen.inCharge, b.seen.passive], [1, 0, 1]);
  assert.equal(await b.c.status(), 'status of a');
  assert.equal(await b.c.act('pause'), 'status of a');
  assert.deepEqual(a.seen.acts, ['pause']);
  // The passive copy uses the browser the copy in charge was given, then and when it changes.
  await until(() => b.seen.browser?.mode === 'launch');
  a.c.setBrowser({ mode: 'attach' });
  await until(() => b.seen.browser?.mode === 'attach');
});

test('when the copy in charge leaves, a passive one takes over, and it says how many stay', async (t) => {
  const dir = folder(t);
  const a = copy(dir, 'a');
  const b = copy(dir, 'b');
  const c = copy(dir, 'c');
  t.after(() => { a.c.stop(); b.c.stop(); c.c.stop(); });
  await a.c.start();
  await b.c.start();
  await c.c.start();
  await until(() => a.c.passives.size === 2);
  assert.equal(a.c.stop(), 2);
  await until(() => [b, c].filter((x) => x.c.leading).length === 1 && [b, c].some((x) => x.c.state === 'passive' && x.c.inCharge));
  const [lead, other] = b.c.leading ? [b, c] : [c, b];
  assert.equal(await other.c.status(), `status of ${lead.seen.name}`);
  assert.equal(other.c.stop(), 0);
  await until(() => lead.c.passives.size === 0);
  assert.equal(lead.c.stop(), 0);
});

test('a copy that has run for a while takes over before a new one', async (t) => {
  const dir = folder(t);
  const a = copy(dir, 'a');
  const old = copy(dir, 'old', { settleMs: 400 });
  t.after(() => { a.c.stop(); old.c.stop(); });
  await a.c.start();
  await old.c.start();
  await sleep(450);
  const young = copy(dir, 'young', { settleMs: 400 });
  t.after(() => young.c.stop());
  await young.c.start();
  a.c.stop();
  await until(() => old.c.leading || young.c.leading);
  assert.equal(old.c.leading, true);
  await until(() => young.c.state === 'passive' && young.c.inCharge);
});

test('a socket left by a copy that was killed is replaced', { skip: process.platform === 'win32' }, async (t) => {
  const dir = folder(t);
  const point = meetingPoint(dir);
  const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(point)}, () => console.log('up')); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((r) => child.stdout.once('data', r));
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  assert.equal(existsSync(point), true);
  const a = copy(dir, 'a');
  t.after(() => a.c.stop());
  await a.c.start();
  await until(() => a.c.leading);
});

// ---------- the real app, several times, against a stand-in for the server ----------

async function fakeServer() {
  const seen = { registers: 0, signOffs: 0 };
  const streams = new Set();
  const server = http.createServer((req, res) => {
    const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.url === '/signals') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: put\ndata: {"path":"/","data":{"n":1}}\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.url === '/api/bridge/v1/session' && req.method === 'POST') {
        seen.registers++;
        return json(200, { session: JSON.parse(raw).instance, account: 'anna', accountId: 'acct_1', signalUrl: `${url}/signals` });
      }
      if (req.url?.startsWith('/api/bridge/v1/session') && req.method === 'DELETE') {
        seen.signOffs++;
        return json(200, { ok: true });
      }
      json(200, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, seen, close: () => { for (const s of streams) s.destroy(); return new Promise((r) => server.close(r)); } };
}

/** Starts the app as an AI app does, and gives a way to call bridge_status and to end it. */
function app(serverUrl, dir) {
  const p = spawn(process.execPath, [path.join(root, 'src', 'index.js')], {
    env: { ...process.env, BW_NO_INSPECTOR: '1', BW_BRIDGE_TOKEN: 'bwb_test', BW_SERVER_URL: serverUrl, BW_DATA_DIR: dir, BW_SETTLE_MS: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buffer = '';
  let id = 0;
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buffer += d;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const m = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(m.id)?.(m);
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    waiting.set(++id, resolve);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const ready = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    .then(() => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`));
  return {
    status: async () => { await ready; return (await rpc('tools/call', { name: 'bridge_status', arguments: {} })).result.content[0].text; },
    end: () => new Promise((r) => { p.once('exit', r); p.stdin.end(); }),
    kill: () => p.kill('SIGKILL'),
  };
}

test('three copies of the app register once, and only the last one signs off', { timeout: 60_000 }, async (t) => {
  const s = await fakeServer();
  const dir = folder(t);
  const apps = [];
  t.after(async () => { for (const a of apps) a.kill(); await s.close(); });
  const start = () => { const a = app(s.url, dir); apps.push(a); return a; };

  const a = start();
  assert.match(await a.status(), /Browser Workflow app/);
  await until(() => s.seen.registers === 1);
  const b = start();
  const c = start();
  // A passive copy answers with what the copy in charge knows.
  await until(async () => /Connection: connected as anna/.test(await b.status()));
  assert.match(await c.status(), /Connection: connected as anna/);
  assert.equal(s.seen.registers, 1);

  // A passive copy leaving says nothing to the server.
  await b.end();
  await sleep(300);
  assert.deepEqual(s.seen, { registers: 1, signOffs: 0 });

  // The copy in charge leaving hands over: the one left registers, and nobody signed off.
  await a.end();
  await until(() => s.seen.registers === 2);
  assert.equal(s.seen.signOffs, 0);
  await until(async () => /Connection: connected as anna/.test(await c.status()));

  // The last copy signs off.
  await c.end();
  await until(() => s.seen.signOffs === 1);
  assert.equal(s.seen.registers, 2);
});
