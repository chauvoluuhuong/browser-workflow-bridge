// The app alone in an AI app (src/alone.js): the list of the server's tools it ships, and the account it gets by itself.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { isAlone, OwnAccount, readTools } from '../src/alone.js';

test('is alone only when asked to be', () => {
  assert.equal(isAlone({}), false);
  assert.equal(isAlone({ BW_ALONE: '1' }), true);
});

test('ships the server\'s tools, readable, without the ones that link a computer', () => {
  const list = readTools('https://example.test');
  const names = list.tools.map((t) => t.name);
  for (const n of ['run_workflow', 'propose_workflow', 'get_account']) assert.ok(names.includes(n), n);
  for (const n of ['link_computer', 'ui_confirm_link']) assert.ok(!names.includes(n), n);
  // Every tool says what it does and carries the labels a directory asks for.
  for (const t of list.tools) {
    assert.ok(t.description && t.inputSchema, t.name);
    assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', t.name);
  }
  assert.ok(list.instructions.length > 100);
  assert.ok(list.resources[0].uri.startsWith('ui://'));
  assert.ok(!JSON.stringify(list).includes('{{server}}'));
});

test('gets an account of its own, and tries again while the server is away', async () => {
  let asked = 0;
  const server = createServer((req, res) => {
    asked += 1;
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (asked === 1) { res.writeHead(503).end('{}'); return; }
      assert.equal(req.url, '/api/bridge/v1/account');
      assert.equal(JSON.parse(body).protocol, 3);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: 'bwb_key', account: 'anon-1' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const linked = await new Promise((resolve) => {
      const own = new OwnAccount({ server: `http://127.0.0.1:${server.address().port}`, version: '1.1.0', protocol: 3, maxBackoffMs: 20, onLinked: (token, account) => resolve({ token, account, own }) });
      own.start();
    });
    assert.deepEqual([linked.token, linked.account, linked.own.state, asked], ['bwb_key', 'anon-1', 'linked', 2]);
  } finally {
    server.close();
  }
});
