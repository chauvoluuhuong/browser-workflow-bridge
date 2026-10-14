// Linking on the login page (src/login.js) against a stand-in for the server: the pairing, the signal,
// the proof read from the app's own tab, and the key that comes back.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { WebLogin } from '../src/login.js';

/** A server with /pair and a signal channel; `login()` is the user logging in on the page. */
async function fakeServer({ withLogin = true } = {}) {
  const seen = { pairBodies: [], pairAuth: [], claims: [] };
  const listeners = new Set();
  let web = false;
  const server = http.createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.method === 'POST' && req.url === '/api/bridge/v1/pair') {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        seen.pairBodies.push(JSON.parse(raw));
        seen.pairAuth.push(req.headers.authorization);
        send(200, { pairId: 'p1', secret: 's1', code: 'ABCD-EFGH', expiresIn: 600, ...(withLogin ? { signalUrl: `${base}/signals/c1.json`, loginUrl: `${base}/account/login?pair=p1` } : {}) });
      });
    } else if (req.url === '/signals/c1.json') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // As Firebase does, the first event is the value now: a signal sent before the app listened is not lost.
      res.write(`event: put\ndata: {"path":"/","data":${web ? '{"n":1}' : 'null'}}\n\n`);
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
    } else if (req.url?.startsWith('/api/bridge/v1/pair/p1')) {
      seen.claims.push({ auth: req.headers.authorization, proof: req.headers['x-link-proof'] });
      if (!web) return send(200, { status: 'pending' });
      if (req.headers['x-link-proof'] !== 'the-proof') return send(200, { status: 'proof' });
      send(200, { status: 'linked', token: 'bwb_new', account: 'anna' });
    } else send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    login() {
      web = true;
      for (const l of listeners) l.write(`event: put\ndata: {"path":"/","data":{"n":${Date.now()}}}\n\n`);
    },
    close: () => { for (const l of listeners) l.end(); server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('timed out');
};

test('the login page opens in the tab, the signal brings the app to fetch its key with the page\'s proof', async () => {
  const s = await fakeServer();
  let opened;
  let page = '';
  let got;
  const w = new WebLogin({
    server: s.url, version: '9.9.9', protocol: 3, token: () => 'bwb_own', pollMs: 60_000,
    openTab: async (url) => { opened = url; return { proof: async () => page }; },
    onLinked: (t, a) => { got = { t, a }; },
  });
  assert.equal(await w.begin(), `${s.url}/account/login?pair=p1`);
  assert.equal(opened, `${s.url}/account/login?pair=p1`);
  assert.equal(w.state, 'waiting');
  // It said which account it has now, so what was made with it can follow.
  assert.equal(s.seen.pairAuth[0], 'Bearer bwb_own');
  assert.equal(s.seen.pairBodies[0].protocol, 3);

  // The user logs in; the welcome page shows a moment later.
  s.login();
  setTimeout(() => { page = 'the-proof'; }, 300);
  await until(() => got);
  assert.deepEqual(got, { t: 'bwb_new', a: 'anna' });
  assert.equal(w.state, 'linked');
  // Every request proved it is the app that asked, and the key came only with the page's proof.
  assert.ok(s.seen.claims.every((c) => c.auth === 'Bearer s1'));
  assert.equal(s.seen.claims.at(-1).proof, 'the-proof');
  w.stop();
  await s.close();
});

test('a server without the login page, or a Chrome that can\'t be reached, is said plainly', async () => {
  const old = await fakeServer({ withLogin: false });
  const w = new WebLogin({ server: old.url, version: '1', protocol: 3, token: () => '', openTab: async () => ({ proof: async () => '' }), onLinked: () => {} });
  await assert.rejects(w.begin(), /no login page/);
  await old.close();

  const s = await fakeServer();
  const v = new WebLogin({ server: s.url, version: '1', protocol: 3, token: () => '', openTab: async () => { throw new Error('Chrome could not be reached'); }, onLinked: () => {} });
  await assert.rejects(v.begin(), /Chrome could not be reached/);
  assert.equal(v.state, 'idle');
  // No key of its own: it asked without one.
  assert.equal(s.seen.pairAuth[0], undefined);
  await s.close();
});
