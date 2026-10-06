// Runs kept on this computer: what the bridge saves, what goes back to the server, and what it refuses.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createExecutor } from '../src/commands.js';
import { createStorage, dataDir } from '../src/storage.js';

const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'bw-bridge-storage-')); dirs.push(d); return d; };
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64');
const page = () => ({ consoleErrors: ['boom'], url: 'https://example.com/', screenshot: JPEG, html: '<html><p>secret page</p></html>', apiCalls: [{ url: 'https://example.com/api', method: 'POST', resourceType: 'fetch', requestBody: '{"q":1}', at: 'now' }] });

function fakeDriver() {
  return {
    open: async () => ({ ok: true, url: 'about:blank' }),
    navigate: async (_r, _u, _t, after) => ({ ok: true, url: 'https://example.com/', ...(after ? { after: page() } : {}) }),
    act: async (_r, _a, after) => ({ ok: false, error: { type: 'cant_get_web_element_xpath', raw: 'not found' }, ...(after ? { after: { ...page(), domExcerpt: '<form>' } } : {}) }),
    evaluate: async (_r, _c, _a, after) => ({ ok: true, output: [{ code: 'A' }, { code: 'B' }], ...(after ? { after: page() } : {}) }),
    capture: async () => page(),
    takeApiCalls: async () => [],
    close: async () => {},
    check: async () => ({ runner: 'ok' }),
  };
}

const header = (runId, status = 'running') => ({ runId, workflowId: 'wf', workflowName: 'Wf', version: 1, status, browser: 'attach', variables: { q: '1' }, runtime: {}, startedAt: '2026-01-01T00:00:00Z', items: 0 });
const save = (execId) => ({ stepId: 's1', execId });

test('the data folder: the setting, or ~/.browser-workflow', () => {
  assert.equal(dataDir(''), path.join(os.homedir(), '.browser-workflow'));
  assert.equal(dataDir(undefined), path.join(os.homedir(), '.browser-workflow'));
  assert.equal(dataDir('~/bw-data'), path.join(os.homedir(), 'bw-data'));
  assert.equal(dataDir('/tmp/bw'), path.resolve('/tmp/bw'));
});

test('saves what a step captured and sends back only file names', async () => {
  const base = tmp();
  const storage = createStorage({ baseDir: base });
  const dir = storage.use('acct_1');
  assert.equal(dir, path.join(base, 'accounts', 'acct_1'));
  const x = createExecutor(fakeDriver(), { storage });
  await x.execute('open', ['run_1', { mode: 'launch' }]);

  const nav = await x.execute('navigate', ['run_1', 'https://example.com', 1000, { screenshotQuality: 55, html: true, apiCalls: true, save: save('ex0001') }]);
  assert.equal(nav.ok, true);
  assert.deepEqual(Object.keys(nav.after).sort(), ['consoleErrors', 'saved', 'url']);
  assert.equal(nav.after.saved.screenshot, 'ex0001.jpg');
  assert.equal(nav.after.saved.html, 'ex0001.html');
  assert.equal(nav.after.saved.apiCallIds.length, 1);
  assert.ok(!JSON.stringify(nav).includes('secret page'));

  // A failed step keeps its small excerpt in the reply (Claude needs it) and saves the rest.
  const act = await x.execute('act', ['run_1', { command: 'click', xpath: '//a', timeoutMs: 100 }, { html: true, save: save('ex0002') }]);
  assert.equal(act.ok, false);
  assert.equal(act.after.domExcerpt, '<form>');
  assert.equal(act.after.html, undefined);

  // Extracted items are saved here too; the output still goes back (the engine needs it for variables).
  const ev = await x.execute('evaluate', ['run_1', '() => 1', null, { save: { ...save('ex0003'), items: true } }]);
  assert.equal(ev.after.saved.items, 2);
  assert.deepEqual(ev.output, [{ code: 'A' }, { code: 'B' }]);

  const cap = await x.execute('capture', ['run_1', { apiCalls: true, save: save('ex0004') }]);
  assert.equal(cap.screenshot, undefined);
  assert.equal(cap.saved.screenshot, 'ex0004.jpg');

  const files = readdirSync(path.join(dir, 'runs', 'run_1')).sort();
  assert.deepEqual(files, ['apicalls.json', 'ex0001.html.gz', 'ex0001.jpg', 'ex0002.html.gz', 'ex0002.jpg', 'ex0003.html.gz', 'ex0003.jpg', 'ex0004.html.gz', 'ex0004.jpg', 'items.json']);

  // Without `save` the content goes back as before (runs kept on the server).
  const plain = await x.execute('navigate', ['run_1', 'https://example.com', 1000, { html: true }]);
  assert.ok(plain.after.html.includes('secret page'));
  assert.equal(plain.after.saved, undefined);
});

test('answers the server\'s store operations, in order', async () => {
  const storage = createStorage({ baseDir: tmp() });
  storage.use('acct_1');
  const x = createExecutor(fakeDriver(), { storage });
  const exec = (id, state) => ({ id, stepId: 's1', state, startedAt: '2026-01-01T00:00:00Z', variablesBefore: {} });
  // Sent without waiting for each answer, like the server does.
  const writes = [
    x.execute('store', ['saveRun', header('run_2'), [exec('ex0001', 'running')], 20]),
    x.execute('store', ['saveRun', header('run_2'), [exec('ex0001', 'ok'), exec('ex0002', 'running')]]),
    x.execute('store', ['appendItems', 'run_2', 's1', [1, 2, 3]]),
  ];
  assert.deepEqual(await x.execute('store', ['unfinishedRuns']), ['run_2']);
  await Promise.all(writes);
  const run = await x.execute('store', ['getRun', 'run_2']);
  assert.deepEqual(run.executions.map((e) => e.state), ['ok', 'running']);
  assert.deepEqual(await x.execute('store', ['getItems', 'run_2']), [1, 2, 3]);
  assert.equal((await x.execute('store', ['listRuns'])).length, 1);
  assert.equal(await x.execute('store', ['getRun', 'run_none']), null);
  assert.equal(await x.execute('store', ['readAsset', 'run_2', 'nope.jpg']), null);

  await x.execute('store', ['stopRun', 'run_2']);
  assert.equal((await x.execute('store', ['getRun', 'run_2'])).status, 'stopped');
  assert.deepEqual(await x.execute('store', ['unfinishedRuns']), []);
  const used = await x.execute('store', ['usage']);
  assert.equal(used.runs, 1);
  assert.ok(used.bytes > 0);
  await x.execute('store', ['deleteRunsOf', 'wf']);
  assert.deepEqual(await x.execute('store', ['listRuns']), []);
});

test('stays inside its folder, and refuses what it does not know', async () => {
  const base = tmp();
  const storage = createStorage({ baseDir: base });
  assert.throws(() => storage.use('../elsewhere'), /Invalid account id/);
  assert.throws(() => storage.use('a/b'), /Invalid account id/);
  assert.throws(() => storage.run('getRun', ['run_1']), /no data folder yet/);
  storage.use('acct_1');
  const x = createExecutor(fakeDriver(), { storage });
  await assert.rejects(x.execute('store', ['getRun', '../../etc']), /Invalid id/);
  await assert.rejects(x.execute('store', ['saveRun', header('../x'), []]), /Invalid id/);
  assert.throws(() => storage.run('getConfig', []), /Unknown store operation/);
  assert.throws(() => storage.run('saveWorkflow', [{}]), /Unknown store operation/);
  // A file name can't climb out of the run's folder.
  writeFileSync(path.join(base, 'outside.txt'), 'private');
  assert.equal(await x.execute('store', ['readAsset', 'run_1', '../../../outside.txt']), null);
  await x.execute('open', ['run_1', { mode: 'launch' }]);
  const bad = await x.execute('navigate', ['run_1', 'https://example.com', 1000, { html: true, save: { stepId: 's1', execId: '../../evil' } }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.target, 'local_save');
  assert.equal(existsSync(path.join(base, 'evil.jpg')), false);
});

test('when saving fails, the step fails and the captured content is not sent', async () => {
  const base = tmp();
  mkdirSync(path.join(base, 'accounts', 'acct_1'), { recursive: true });
  writeFileSync(path.join(base, 'accounts', 'acct_1', 'runs'), 'a file where the folder should be');
  const storage = createStorage({ baseDir: base });
  storage.use('acct_1');
  const x = createExecutor(fakeDriver(), { storage });
  await x.execute('open', ['run_1', { mode: 'launch' }]);
  const r = await x.execute('navigate', ['run_1', 'https://example.com', 1000, { html: true, save: save('ex0001') }]);
  assert.equal(r.ok, false);
  assert.match(r.error.raw, /Couldn't save on your computer/);
  assert.equal(r.error.target, 'local_save');
  assert.ok(!JSON.stringify(r).includes('secret page'));
  assert.ok(!JSON.stringify(r).includes(JPEG));

  // A bridge without a data folder refuses instead of sending the content.
  const none = createExecutor(fakeDriver());
  await none.execute('open', ['run_1', { mode: 'launch' }]);
  const n = await none.execute('navigate', ['run_1', 'https://example.com', 1000, { html: true, save: save('ex0001') }]);
  assert.equal(n.error.target, 'local_save');
  assert.ok(!JSON.stringify(n).includes('secret page'));
});
