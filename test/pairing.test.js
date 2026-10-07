// Pairing against a stand-in for the server's /pair endpoints, and the saved link.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { clearLink, Pairing, readLink, saveLink, usableToken } from '../src/pairing.js';

/** A server that answers /pair as the real one does; `script` decides what each poll answers. */
async function fakeServer(script) {
  const seen = { asks: 0, polls: 0, bodies: [], auth: [] };
  const server = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };
    if (req.method === 'POST' && req.url === '/api/bridge/v1/pair') {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        seen.asks++;
        seen.bodies.push(JSON.parse(raw));
        send(200, { pairId: `p${seen.asks}`, secret: `s${seen.asks}`, code: 'ABCD-EFGH', expiresIn: 600 });
      });
    } else if (req.method === 'GET' && req.url?.startsWith('/api/bridge/v1/pair/')) {
      seen.polls++;
      seen.auth.push(req.headers.authorization);
      const [status, body] = script(seen.polls, seen);
      send(status, body);
    } else send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('timed out');
};

test('a code is asked for, the user\'s click arrives as a token, once', async () => {
  const s = await fakeServer((n) => (n < 3 ? [200, { status: 'pending' }] : [200, { status: 'linked', token: 'bwb_abc', account: 'anna' }]));
  let got;
  const p = new Pairing({ server: s.url, version: '9.9.9', protocol: 3, pollMs: 20, onLinked: (t, a) => { got = { t, a }; } });
  p.start();
  await until(() => p.code);
  assert.equal(p.code, 'ABCD-EFGH');
  assert.equal(p.state, 'waiting');
  await until(() => got);
  assert.deepEqual(got, { t: 'bwb_abc', a: 'anna' });
  assert.equal(p.state, 'linked');
  assert.equal(p.code, undefined);
  // It asked once, identified itself, and proved it is the asker with the secret.
  assert.equal(s.seen.asks, 1);
  assert.equal(s.seen.bodies[0].protocol, 3);
  assert.equal(s.seen.bodies[0].bridgeVersion, '9.9.9');
  assert.ok(s.seen.auth.every((a) => a === 'Bearer s1'));
  const polls = s.seen.polls;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.seen.polls, polls, 'no polling after it is linked');
  await s.close();
});

test('a code the server forgot (it restarted) is replaced by a new one', async () => {
  const s = await fakeServer((n) => (n === 1 ? [404, { code: 'unknown' }] : [200, { status: 'pending' }]));
  const p = new Pairing({ server: s.url, version: '1', protocol: 3, pollMs: 20, onLinked: () => {} });
  p.start();
  await until(() => s.seen.asks >= 2);
  assert.equal(p.state, 'waiting');
  p.stop();
  await s.close();
});

test('a server that is not there: it keeps trying and says so', async () => {
  const p = new Pairing({ server: 'http://127.0.0.1:9', version: '1', protocol: 3, pollMs: 20, maxBackoffMs: 50, onLinked: () => {} });
  p.start();
  await until(() => p.state === 'unreachable');
  assert.match(p.lastError, /Could not reach/);
  assert.equal(p.code, undefined);
  p.stop();
});

test('the saved link: only for the same server, owner-only, and gone when cleared', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-link-'));
  try {
    assert.equal(readLink(dir, 'https://a.example'), '');
    saveLink(dir, 'https://a.example', 'bwb_one');
    assert.equal(readLink(dir, 'https://a.example'), 'bwb_one');
    assert.equal(readLink(dir, 'https://b.example'), '', 'a link made for another server is not used');
    if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, 'link.json')).mode & 0o777, 0o600);
    clearLink(dir);
    assert.equal(readLink(dir, 'https://a.example'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a token setting that is empty or an unfilled template is no token', () => {
  assert.equal(usableToken(undefined), '');
  assert.equal(usableToken('  '), '');
  assert.equal(usableToken('${user_config.token}'), '');
  assert.equal(usableToken(' bwb_x '), 'bwb_x');
});
