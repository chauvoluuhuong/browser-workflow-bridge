// Carries out browser commands in the user's Chrome with Playwright. Generated from LocalDriver in the
// Browser Workflow server (src/core/localDriver.ts) by its `npm run sync:bridge`, so a run behaves the
// same on the server and here. Modes: attach = the user's running Chrome (same discovery as
// chrome-devtools-mcp --autoConnect), cdp = any DevTools endpoint, launch = a new Chrome for the run.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
/** Header values never stored: the attach mode runs in the user's own, signed-in profile. */
const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
const MAX_API_CALLS = 500;
const MAX_BODY = 64 * 1024;
/** Request bodies kept between two takes: they travel to the server in one message. */
const MAX_API_BYTES = 1024 * 1024;
export function apiCallOf(r) {
  const h = Object.fromEntries(Object.entries(r.headers()).map(([k, v]) => [k, SECRET_HEADERS.test(k) ? '[redacted]' : v]));
  const body = r.postData();
  return {
    url: r.url(),
    method: r.method(),
    resourceType: r.resourceType(),
    requestHeaders: Object.keys(h).length ? h : undefined,
    requestBody: body == null ? null : body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}… (truncated)` : body,
    at: new Date().toISOString(),
  };
}
/** Chrome asks the user to allow each new remote-debugging connection: give them time to click Allow. */
const ATTACH_TIMEOUT = 60_000;
const ATTACH_TIMEOUT_MESSAGE = 'Chrome did not accept the connection within 60 s. Chrome asks to allow remote debugging: click Allow in the Chrome window, then run again.';
const ATTACH_OFF_MESSAGE = 'Chrome is not accepting remote debugging connections. Open chrome://inspect/#remote-debugging and allow remote debugging, then run again.';
const ATTACH_STUCK_START = 'A tab in Chrome is not responding';
const attachStuckMessage = (titles) => `${ATTACH_STUCK_START} (${titles.map((t) => `"${t}"`).join(', ')}), so Chrome can't be used for the run. Close that tab in Chrome, then run again.`;
/** How long a tab has to answer, and how long a connection gets once a tab is known not to. */
const STUCK_TAB_MS = 2500;
const STUCK_GRACE_MS = 4000;
const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'];
export function defaultChromeUserDataDir() {
  const home = os.homedir();
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  if (process.platform === 'win32')
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  return path.join(home, '.config', 'google-chrome');
}
/** Reads the DevTools endpoint Chrome writes when remote debugging is allowed in chrome://inspect. */
export async function readDevToolsActivePort(userDataDir) {
  try {
    const [port, wsPath] = (await fs.readFile(path.join(userDataDir, 'DevToolsActivePort'), 'utf8'))
      .split('\n').map((l) => l.trim()).filter(Boolean);
    const n = Number(port);
    if (!n || n > 65535 || !wsPath)
      return undefined;
    return `ws://127.0.0.1:${n}${wsPath}`;
  }
  catch {
    return undefined;
  }
}
/** The browser endpoint a DevTools port answers with. Chrome answers only when it was started with that port, not when remote debugging was allowed in chrome://inspect. */
export async function readDevToolsUrl(url) {
  try {
    const r = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(2000) });
    const ws = (await r.json()).webSocketDebuggerUrl;
    return typeof ws === 'string' ? ws : undefined;
  }
  catch {
    return undefined;
  }
}
/** The DevTools port and profile folder a Chrome was started with, from its command line. Nothing for other programs and for Chrome's own helper processes. */
export function chromeOptions(commandLine) {
  const program = commandLine.split(/\s--/)[0];
  if (!/chrom(e|ium)/i.test(program) || /\s--type=/.test(commandLine))
    return undefined;
  const port = /\s--remote-debugging-port=(\d+)/.exec(commandLine)?.[1];
  // A folder name may hold spaces, so it ends at the next option.
  const dir = /\s--user-data-dir=(.+?)(?=\s+--|$)/.exec(commandLine)?.[1].trim().replace(/^"(.*)"$/, '$1');
  if (port === undefined && !dir)
    return undefined;
  return { ...(port === undefined ? {} : { port: Number(port) }), ...(dir ? { userDataDir: dir } : {}) };
}
/** The command lines of the programs running on this computer; none when the system does not give them. */
async function commandLines() {
  try {
    if (process.platform === 'linux') {
      const pids = (await fs.readdir('/proc')).filter((d) => /^\d+$/.test(d));
      return await Promise.all(pids.map((pid) => fs.readFile(`/proc/${pid}/cmdline`, 'utf8').then((c) => c.replace(/\0/g, ' ').trim(), () => '')));
    }
    const [cmd, args] = process.platform === 'win32'
      ? ['powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { $_.CommandLine }"]]
      : ['ps', ['-axww', '-o', 'args=']];
    const out = await new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (e, stdout) => (e ? reject(e) : resolve(stdout)));
    });
    return out.split(/\r?\n/);
  }
  catch {
    return [];
  }
}
function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
/**
* The titles of the open tabs that do not answer, asked over a DevTools connection of its own.
* Playwright waits for every open tab when it connects to a running Chrome, so one crashed tab makes
* the connection hang until it times out, and the user is told to click an Allow button that is not
* there. `undefined`: nothing is known (Chrome did not take this connection in time: it may be asking
* the user to allow it; or this Node.js has no WebSocket).
*/
export function stuckTabs(ws, ms = STUCK_TAB_MS) {
  const WS = globalThis.WebSocket;
  if (!WS)
    return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let socket;
    let done = false;
    const finish = (v) => {
      if (done)
        return;
      done = true;
      clearTimeout(giveUp);
      try {
        socket?.close();
      }
      catch { /* already closed */ }
      resolve(v);
    };
    // Twice the time a tab gets: once to connect and list the tabs, once for them to answer.
    const giveUp = setTimeout(() => finish(undefined), ms * 2 + 500);
    let seq = 0;
    const waiting = new Map();
    const ask = (method, params = {}, sessionId) => new Promise((answer) => {
      const id = ++seq;
      waiting.set(id, answer);
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (waiting.delete(id))
        answer(undefined); }, ms);
    });
    try {
      socket = new WS(ws);
    }
    catch {
      return finish(undefined);
    }
    socket.onerror = () => finish(undefined);
    socket.onclose = () => finish(undefined);
    socket.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(String(e.data));
      }
      catch {
        return;
      }
      const answer = waiting.get(m.id);
      if (!answer)
        return;
      waiting.delete(m.id);
      answer(m);
    };
    socket.onopen = async () => {
      const targets = (await ask('Target.getTargets'))?.result?.targetInfos;
      if (!Array.isArray(targets))
        return finish(undefined);
      const pages = targets.filter((t) => t.type === 'page');
      const stuck = await Promise.all(pages.map(async (t) => {
        const sessionId = (await ask('Target.attachToTarget', { targetId: t.targetId, flatten: true }))?.result?.sessionId;
        if (!sessionId)
          return undefined;
        const alive = await ask('Page.getFrameTree', {}, sessionId);
        void ask('Target.detachFromTarget', { sessionId });
        return alive ? undefined : String(t.title || t.url || 'a tab').slice(0, 60);
      }));
      finish(stuck.filter((t) => !!t));
    };
  });
}
/**
* The running Chromes that take DevTools connections, the likeliest first, found one at a time so the
* usual case asks the system nothing:
* 1. the port file of the usual profile: remote debugging allowed in chrome://inspect;
* 2. what each running Chrome was started with: a DevTools port of its own (it writes no port file
*    then), or another profile folder with a port file in it;
* 3. port 9222, where the system does not give command lines.
* A port file outlives its Chrome, so one whose port is closed is left out. `only` (or
* BW_CHROME_USER_DATA_DIR) names the one profile folder to look in, and nothing else is tried.
*/
export async function* attachEndpoints(only = process.env.BW_CHROME_USER_DATA_DIR) {
  const userDataDir = only ?? defaultChromeUserDataDir();
  const seen = new Set();
  const fresh = (ws) => !!ws && !seen.has(ws) && !!seen.add(ws);
  const fromProfile = async (dir) => {
    const ws = await readDevToolsActivePort(dir);
    return ws && (await listening(Number(new URL(ws).port))) && fresh(ws) ? { ws, usual: dir === defaultChromeUserDataDir() } : undefined;
  };
  const fromPort = async (port) => {
    const browserUrl = `http://127.0.0.1:${port}`;
    const ws = await readDevToolsUrl(browserUrl);
    return fresh(ws) ? { ws, browserUrl } : undefined;
  };
  const usual = await fromProfile(userDataDir);
  if (usual)
    yield usual;
  if (only)
    return;
  for (const line of await commandLines()) {
    const o = chromeOptions(line);
    const byPort = o?.port ? await fromPort(o.port) : undefined;
    if (byPort)
      yield byPort;
    const byProfile = o?.userDataDir && o.userDataDir !== userDataDir ? await fromProfile(o.userDataDir) : undefined;
    if (byProfile)
      yield byProfile;
  }
  const guess = await fromPort(9222);
  if (guess)
    yield guess;
}
/**
* Wraps step code so functions are called with `arg` and plain expressions (or IIFEs) are awaited.
* `setVariables({...})` is provided for workflows written for the crawler's older API; values
* passed to it come back in `set`.
*/
export function wrapCode(code, arg) {
  return `(async () => { const __set = {}; const setVariables = async (v) => { Object.assign(__set, v); };
const __f = (${code.trim().replace(/;+$/, '')}
); const result = typeof __f === 'function' ? await __f(${JSON.stringify(arg ?? null)}) : await __f; return { result, set: __set }; })()`;
}
function classify(err, fallback) {
  const e = err;
  const raw = (e?.message ?? String(err)).split('\n=========')[0].trim();
  const type = /Timeout|timeout|waiting for locator/.test(raw) && fallback === 'navigation_error' ? 'timeout' : fallback;
  return { type, raw, stack: e?.stack };
}
export class LocalDriver {
  opts;
  sessions = new Map();
  connections = new Map();
  constructor(opts = {}) {
    this.opts = opts;
  }
  // ---------- connections ----------
  async connect(key, endpoint, timeout = 15_000) {
    const cached = this.connections.get(key);
    if (cached) {
      const b = await cached.catch(() => undefined);
      if (b?.isConnected())
        return b;
      this.connections.delete(key);
    }
    const p = chromium.connectOverCDP(endpoint, { timeout });
    this.connections.set(key, p);
    p.catch(() => this.connections.delete(key));
    const b = await p;
    b.on('disconnected', () => this.connections.delete(key));
    return b;
  }
  /** Connects to the first running Chrome that takes the connection. */
  /** Rejects when a tab does not answer and the connection is still not made a little later. Never resolves. */
  stuckWhileConnecting(ws, connecting) {
    return new Promise((_, reject) => {
      let made = false;
      connecting.then(() => { made = true; }, () => { made = true; });
      void stuckTabs(ws).then((stuck) => {
        if (!stuck?.length)
          return;
        setTimeout(() => {
          if (made)
            return;
          this.connections.delete('attach');
          reject(new Error(attachStuckMessage(stuck)));
        }, STUCK_GRACE_MS).unref?.();
      });
    });
  }
  async attachBrowser() {
    let refused;
    for await (const e of attachEndpoints(this.opts.chromeUserDataDir)) {
      const connecting = this.connect('attach', e.ws, ATTACH_TIMEOUT);
      // A Chrome started with a DevTools port asks the user nothing, so its tabs can be looked at
      // while the connection is made. A connection that succeeds is never refused: only one still
      // not made a few seconds after a tab was found not to answer is given up, instead of in 60 s.
      const gaveUp = e.browserUrl ? this.stuckWhileConnecting(e.ws, connecting) : undefined;
      try {
        return await (gaveUp ? Promise.race([connecting, gaveUp]) : connecting);
      }
      catch (err) {
        const m = String(err?.message);
        if (m.startsWith(ATTACH_STUCK_START))
          throw err;
        if (/Timeout/.test(m)) {
          // Timed out: a tab that does not answer, or Chrome waiting for the user's Allow (another
          // Chrome would not be the one they mean).
          const stuck = await stuckTabs(e.ws);
          throw new Error(stuck?.length ? attachStuckMessage(stuck) : ATTACH_TIMEOUT_MESSAGE);
        }
        if (!/ECONNREFUSED/.test(m))
          refused ??= m;
      }
    }
    throw new Error(refused ?? ATTACH_OFF_MESSAGE);
  }
  async launch(headed) {
    // Port 0: no DevTools port (the cloud browser runs several Chromes and needs no inspector).
    const port = this.opts.launchDebugPort ?? 9333;
    const args = port ? [...LAUNCH_ARGS, `--remote-debugging-port=${port}`] : [...LAUNCH_ARGS];
    if (this.opts.executablePath)
      return chromium.launch({ executablePath: this.opts.executablePath, headless: !headed, args });
    try {
      return await chromium.launch({ channel: 'chrome', headless: !headed, args });
    }
    catch {
      return chromium.launch({ headless: !headed, args }); // bundled Chromium, if installed
    }
  }
  session(runId) {
    const s = this.sessions.get(runId);
    if (!s)
      throw new Error(`No open browser tab for run ${runId}`);
    return s;
  }
  // ---------- commands ----------
  async open(runId, o) {
    let page;
    let owned;
    try {
      if (o.mode === 'attach') {
        const browser = await this.attachBrowser();
        const context = browser.contexts()[0] ?? (await browser.newContext());
        page = await context.newPage();
        owned = { kind: 'page' };
      }
      else if (o.mode === 'cdp') {
        if (!o.cdpEndpoint)
          throw new Error('No CDP endpoint configured');
        const browser = await this.connect(`cdp:${o.cdpEndpoint}`, o.cdpEndpoint);
        const context = await browser.newContext();
        page = await context.newPage();
        owned = { kind: 'context', context };
      }
      else if (o.mode === 'launch') {
        const headed = o.headed ?? true;
        const browser = await this.launch(headed);
        const context = await browser.newContext(headed ? { viewport: null } : { viewport: { width: 1280, height: 800 } });
        page = await context.newPage();
        owned = { kind: 'browser', browser };
      }
      else {
        throw new Error('The cloud browser runs on the server, not in the bridge');
      }
    }
    catch (err) {
      const { raw, stack } = classify(err, 'unknown_error');
      // target 'attach_prompt' / 'attach_off' / 'attach_stuck': the widget explains Chrome's Allow
      // prompt, the remote-debugging switch or the tab to close in the user's language.
      const target = raw === ATTACH_TIMEOUT_MESSAGE ? 'attach_prompt' : raw === ATTACH_OFF_MESSAGE ? 'attach_off' : raw.startsWith(ATTACH_STUCK_START) ? 'attach_stuck' : undefined;
      return { ok: false, error: { type: 'browser_unavailable', raw, stack, ...(target ? { target } : {}) } };
    }
    const consoleErrors = [];
    const push = (m) => { if (consoleErrors.length < 20)
      consoleErrors.push(m.slice(0, 500)); };
    page.on('console', (m) => { if (m.type() === 'error')
      push(m.text()); });
    page.on('pageerror', (e) => push(e.message));
    const session = { page, owned, consoleErrors, apiCalls: [], apiBytes: 0 };
    // Same filter as the crawler: only fetch/XHR, not documents, scripts or images.
    page.on('request', (r) => {
      const type = r.resourceType();
      if ((type !== 'fetch' && type !== 'xhr') || session.apiCalls.length >= MAX_API_CALLS)
        return;
      const call = apiCallOf(r);
      session.apiBytes += call.requestBody?.length ?? 0;
      if (session.apiBytes > MAX_API_BYTES && call.requestBody)
        call.requestBody = '(left out: too much request data in this step)';
      session.apiCalls.push(call);
    });
    this.sessions.set(runId, session);
    if (o.startUrl)
      return this.goto(runId, o.startUrl, o.timeoutMs ?? 30_000);
    return { ok: true, url: page.url() };
  }
  /** Adds what `after` asks for to an action's result (the page as the action left it). */
  async withAfter(runId, r, after) {
    if (!after)
      return r;
    const { excerptOnFailure, ...o } = after;
    if (!r.ok && excerptOnFailure)
      o.excerptAround = r.error?.type === 'cant_get_web_element_xpath' ? r.error.target ?? '' : '';
    return { ...r, after: await this.capture(runId, o) };
  }
  async navigate(runId, url, timeoutMs, after) {
    return this.withAfter(runId, await this.goto(runId, url, timeoutMs), after);
  }
  async goto(runId, url, timeoutMs) {
    const { page } = this.session(runId);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      return { ok: true, output: { success: true }, url: page.url() };
    }
    catch (err) {
      return { ok: false, url: page.url(), error: { ...classify(err, 'navigation_error'), target: url, timeoutMs } };
    }
  }
  async act(runId, a, after) {
    return this.withAfter(runId, await this.actOn(runId, a), after);
  }
  async actOn(runId, a) {
    const { page } = this.session(runId);
    const loc = page.locator(`xpath=${a.xpath}`).first();
    const timeout = a.timeoutMs;
    const value = a.value ?? '';
    try {
      switch (a.command) {
        case 'click':
          await loc.click({ timeout });
          break;
        case 'fill':
          await loc.fill(value, { timeout });
          break;
        case 'type':
          await loc.pressSequentially(value, { delay: 100, timeout });
          break;
        case 'hover':
          await loc.hover({ timeout });
          break;
        case 'press':
          await loc.press(value, { timeout });
          break;
        case 'select':
        case 'selectOption':
          await loc.selectOption(value, { timeout });
          break;
        case 'check':
          await loc.check({ timeout });
          break;
        case 'uncheck':
          await loc.uncheck({ timeout });
          break;
        case 'focus':
          await loc.focus({ timeout });
          break;
        case 'scroll':
        case 'scrollIntoView':
          await loc.scrollIntoViewIfNeeded({ timeout });
          break;
        case 'wait':
        case 'waitFor':
          await loc.waitFor({ state: 'visible', timeout });
          break;
        default: throw new Error(`Unsupported command: ${a.command}`);
      }
      return { ok: true, output: { success: true }, url: page.url() };
    }
    catch (err) {
      const c = classify(err, 'cant_get_web_element_xpath');
      const notFound = /Timeout|waiting for locator|not attached|not visible/.test(c.raw);
      return {
        ok: false,
        url: page.url(),
        error: { ...c, type: notFound ? 'cant_get_web_element_xpath' : 'unknown_error', target: a.xpath, timeoutMs: timeout },
      };
    }
  }
  async evaluate(runId, code, arg, after) {
    return this.withAfter(runId, await this.run(runId, code, arg), after);
  }
  async run(runId, code, arg) {
    const { page } = this.session(runId);
    try {
      // Evaluated through DevTools, so it also works on pages whose CSP forbids eval.
      const r = (await page.evaluate(wrapCode(code, arg)));
      return { ok: true, output: r.result, variables: Object.keys(r.set).length ? r.set : undefined, url: page.url() };
    }
    catch (err) {
      return { ok: false, url: page.url(), error: classify(err, 'execute_javascript_failed') };
    }
  }
  async capture(runId, o) {
    const s = this.sessions.get(runId);
    if (!s)
      return { consoleErrors: [] };
    const out = { url: s.page.url(), consoleErrors: [...s.consoleErrors] };
    if (o.screenshotQuality) {
      try {
        out.screenshot = (await s.page.screenshot({ type: 'jpeg', quality: o.screenshotQuality, scale: 'css', timeout: 10_000 })).toString('base64');
      }
      catch { /* page may be closed or navigating */ }
    }
    if (o.html) {
      try {
        out.html = await s.page.content();
      }
      catch { /* ignore */ }
    }
    if (o.excerptAround !== undefined) {
      try {
        out.domExcerpt = await s.page.evaluate(domExcerpt, { xpath: o.excerptAround, max: o.excerptMaxBytes ?? 8192 });
      }
      catch { /* ignore */ }
    }
    if (o.apiCalls)
      out.apiCalls = await this.takeApiCalls(runId);
    return out;
  }
  async takeApiCalls(runId) {
    const s = this.sessions.get(runId);
    if (!s)
      return [];
    s.apiBytes = 0;
    return s.apiCalls.splice(0);
  }
  async close(runId) {
    const s = this.sessions.get(runId);
    if (!s)
      return;
    this.sessions.delete(runId);
    try {
      if (s.owned.kind === 'page')
        await s.page.close();
      else if (s.owned.kind === 'context')
        await s.owned.context.close();
      else
        await s.owned.browser.close();
    }
    catch { /* already gone */ }
  }
  async check(mode, cdpEndpoint) {
    try {
      if (mode === 'attach') {
        const b = await this.attachBrowser();
        return { runner: 'ok', inspector: 'ok', code: 'attach_ok', arg: b.version().split('.')[0] };
      }
      if (mode === 'cdp') {
        if (!cdpEndpoint || !/^(wss?|https?):\/\/.+/.test(cdpEndpoint))
          return { runner: 'error', inspector: 'error', code: 'cdp_invalid' };
        await this.connect(`cdp:${cdpEndpoint}`, cdpEndpoint);
        return { runner: 'ok', inspector: 'ok', code: 'cdp_ok', arg: new URL(cdpEndpoint).host };
      }
      if (mode === 'launch') {
        const b = await this.launch(false);
        const v = b.version().split('.')[0];
        await b.close();
        return { runner: 'ok', inspector: 'ok', code: 'launch_ok', arg: v };
      }
      return { runner: 'error', inspector: 'error', code: 'remote_paid' };
    }
    catch {
      return mode === 'attach'
        ? { runner: 'error', inspector: 'error', code: 'attach_unreachable' }
        : { runner: 'error', inspector: 'error', code: 'cdp_invalid' };
    }
  }
  async dispose() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
    for (const p of this.connections.values()) {
      // Disconnect from (not close) the user's browser.
      p.then((b) => b.close()).catch(() => { });
    }
    this.connections.clear();
  }
}
/**
* Runs in the page: HTML of the element at `xpath`, or of its closest ancestor that still exists
* (by trimming path segments), without scripts/styles, capped at `max` characters.
*/
function domExcerpt({ xpath, max }) {
  const clean = (el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll('script,style,svg,noscript,link,meta').forEach((n) => n.remove());
    const h = c.outerHTML.replace(/\s{2,}/g, ' ');
    return h.length > max ? `${h.slice(0, max)}…` : h;
  };
  let x = xpath;
  while (x && x.length > 1) {
    try {
      const r = document.evaluate(x, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (r && r.nodeType === 1 && r !== document.documentElement)
        return clean(r);
    }
    catch { /* invalid partial XPath: keep trimming */ }
    const i = x.lastIndexOf('/');
    if (i <= 1)
      break;
    x = x.slice(0, i).replace(/\/+$/, '');
  }
  return document.body ? clean(document.body) : '';
}
