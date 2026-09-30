// The bridge's own rules, with a fake driver. The full path (server → bridge → Chrome) is tested in
// the Browser Workflow server repo (test/bridge.test.ts), which starts this bridge.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExecutor, MAX_HTML, MAX_OPEN, MAX_RUN_MS, parseSites, refuseUrl } from '../src/commands.js';
import { bridgeUrl } from '../src/connection.js';

function fakeDriver() {
  const calls = [];
  const d = {
    calls,
    open: async (...a) => { calls.push(['open', ...a]); return { ok: true, url: 'about:blank' }; },
    navigate: async (...a) => { calls.push(['navigate', ...a]); return { ok: true }; },
    act: async (...a) => { calls.push(['act', ...a]); return { ok: true }; },
    evaluate: async (...a) => { calls.push(['evaluate', ...a]); return { ok: true, output: 1 }; },
    capture: async () => ({ consoleErrors: [], html: 'x'.repeat(MAX_HTML + 10) }),
    takeApiCalls: async () => [{ url: 'https://example.com/api' }],
    close: async (...a) => { calls.push(['close', ...a]); },
    check: async (mode) => ({ runner: 'ok', inspector: 'ok', code: `${mode}_ok` }),
  };
  return d;
}

test('server URLs become the bridge endpoint', () => {
  assert.equal(bridgeUrl('https://app.example.com'), 'wss://app.example.com/bridge');
  assert.equal(bridgeUrl('http://127.0.0.1:3310/'), 'ws://127.0.0.1:3310/bridge');
  assert.equal(bridgeUrl('ws://127.0.0.1:3310/bridge'), 'ws://127.0.0.1:3310/bridge');
});

test('only http(s) pages, and only allowed sites when set', () => {
  const sites = parseSites(' Example.com, *.shop.org ');
  assert.deepEqual(sites, ['example.com', 'shop.org']);
  assert.deepEqual(parseSites('*'), []);
  assert.equal(refuseUrl('https://www.example.com/x', sites), undefined);
  assert.equal(refuseUrl('https://a.shop.org', sites), undefined);
  assert.match(refuseUrl('https://evil.com', sites), /not in the bridge's allowed sites/);
  assert.match(refuseUrl('file:///etc/passwd', []), /only opens http and https/);
  assert.match(refuseUrl('chrome://settings', []), /only opens http and https/);
  assert.equal(refuseUrl('https://anything.test', []), undefined);
});

test('acts only on tabs it opened', async () => {
  const d = fakeDriver();
  const x = createExecutor(d);
  const r = await x.execute('act', ['run_x', { command: 'click', xpath: '//a', timeoutMs: 100 }]);
  assert.equal(r.ok, false);
  assert.match(r.error.raw, /no tab opened by this bridge/);
  assert.deepEqual(await x.execute('capture', ['run_x', {}]), { consoleErrors: [] });
  assert.deepEqual(await x.execute('takeApiCalls', ['run_x']), []);
  assert.equal(d.calls.length, 0);

  await x.execute('open', ['run_1', { mode: 'launch' }]);
  assert.equal((await x.execute('act', ['run_1', { command: 'click', xpath: '//a', timeoutMs: 100 }])).ok, true);
  const cap = await x.execute('capture', ['run_1', { html: true }]);
  assert.ok(cap.html.length <= MAX_HTML + 40);
  assert.match(cap.html, /truncated by the bridge/);
  await x.execute('close', ['run_1']);
  assert.equal(x.openRuns(), 0);
});

test('refuses the cloud browser, too many runs, and blocked start pages', async () => {
  const x = createExecutor(fakeDriver(), { allowedSites: ['example.com'] });
  assert.match((await x.execute('open', ['r0', { mode: 'remote' }])).error.raw, /cloud browser runs on the server/);
  assert.equal((await x.execute('open', ['r0', { mode: 'attach', startUrl: 'https://other.com' }])).error.type, 'navigation_error');
  for (let i = 1; i <= MAX_OPEN; i++) assert.equal((await x.execute('open', [`r${i}`, { mode: 'attach' }])).ok, true);
  assert.match((await x.execute('open', ['r9', { mode: 'attach' }])).error.raw, /already has/);
  await x.closeAll();
  assert.equal(x.openRuns(), 0);
});

test('closes a run that passed the time limit', async (t) => {
  const d = fakeDriver();
  const x = createExecutor(d);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await x.execute('open', ['r1', { mode: 'launch' }]);
  Date.now.mock.mockImplementation(() => now + MAX_RUN_MS + 1);
  const r = await x.execute('navigate', ['r1', 'https://example.com', 1000]);
  assert.match(r.error.raw, /minute limit/);
  assert.deepEqual(d.calls.at(-1), ['close', 'r1']);
});

test('rejects unknown commands', async () => {
  await assert.rejects(createExecutor(fakeDriver()).execute('dispose', []), /Unknown command/);
});
