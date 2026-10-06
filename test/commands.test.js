// The bridge's own rules, with a fake driver. The full path (server → bridge → Chrome) is tested in
// the Browser Workflow server repo (test/bridge.test.ts), which starts this bridge.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExecutor, MAX_HTML, MAX_OPEN, MAX_RUN_MS, parseSites, refuseUrl } from '../src/commands.js';

function fakeDriver() {
  const calls = [];
  const d = {
    calls,
    open: async (...a) => { calls.push(['open', ...a]); return { ok: true, url: 'about:blank' }; },
    // Like the real driver: with an `after` option, the page state comes back in the same result.
    navigate: async (...a) => { calls.push(['navigate', ...a]); return { ok: true, ...(a[3] ? { after: await d.capture() } : {}) }; },
    act: async (...a) => { calls.push(['act', ...a]); return { ok: true, ...(a[2] ? { after: await d.capture() } : {}) }; },
    evaluate: async (...a) => { calls.push(['evaluate', ...a]); return { ok: true, output: 1 }; },
    capture: async () => ({ consoleErrors: [], html: 'x'.repeat(MAX_HTML + 10) }),
    takeApiCalls: async () => [{ url: 'https://example.com/api' }],
    close: async (...a) => { calls.push(['close', ...a]); },
    check: async (mode) => ({ runner: 'ok', inspector: 'ok', code: `${mode}_ok` }),
  };
  return d;
}

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

test('returns the page state with the action, with its HTML capped', async () => {
  const d = fakeDriver();
  const x = createExecutor(d);
  await x.execute('open', ['r1', { mode: 'launch' }]);
  const after = { screenshotQuality: 55, html: true, apiCalls: true };
  const nav = await x.execute('navigate', ['r1', 'https://example.com', 1000, after]);
  assert.deepEqual(d.calls.at(-1), ['navigate', 'r1', 'https://example.com', 1000, after]);
  assert.match(nav.after.html, /truncated by the bridge/);
  assert.ok(Buffer.byteLength(nav.after.html) <= MAX_HTML + 40);
  const act = await x.execute('act', ['r1', { command: 'click', xpath: '//a', timeoutMs: 100 }, after]);
  assert.match(act.after.html, /truncated by the bridge/);
  // Without `after` nothing extra is taken.
  assert.equal((await x.execute('act', ['r1', { command: 'click', xpath: '//a', timeoutMs: 100 }])).after, undefined);
});

test('uses the server\'s time limit for a run, never more than its own', async (t) => {
  const d = fakeDriver();
  const x = createExecutor(d);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await x.execute('open', ['short', { mode: 'launch', maxRunMs: 60_000 }]);
  await x.execute('open', ['long', { mode: 'launch', maxRunMs: MAX_RUN_MS * 10 }]);
  Date.now.mock.mockImplementation(() => now + 61_000);
  assert.match((await x.execute('act', ['short', { command: 'click', xpath: '//a', timeoutMs: 100 }])).error.raw, /1-minute limit/);
  assert.equal((await x.execute('act', ['long', { command: 'click', xpath: '//a', timeoutMs: 100 }])).ok, true);
  Date.now.mock.mockImplementation(() => now + MAX_RUN_MS + 1);
  await x.sweep();
  assert.equal(x.openRuns(), 0);
});

test('a shorter limit of its own caps every run (BW_MAX_RUN_MS, for tests)', async (t) => {
  const x = createExecutor(fakeDriver(), { maxRunMs: 2000 });
  assert.equal(x.maxRunMs, 2000);
  assert.equal(createExecutor(fakeDriver(), { maxRunMs: MAX_RUN_MS * 2 }).maxRunMs, MAX_RUN_MS);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await x.execute('open', ['r1', { mode: 'launch', maxRunMs: 60_000 }]);
  Date.now.mock.mockImplementation(() => now + 2001);
  await x.sweep();
  assert.equal(x.openRuns(), 0);
});

test('rejects unknown commands', async () => {
  await assert.rejects(createExecutor(fakeDriver()).execute('dispose', []), /Unknown command/);
});
