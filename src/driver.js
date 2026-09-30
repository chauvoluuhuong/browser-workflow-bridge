// Carries out browser commands in the user's Chrome with Playwright. Generated from LocalDriver in the
// Browser Workflow server (src/core/localDriver.ts) by its `npm run sync:bridge`, so a run behaves the
// same on the server and here. Modes: attach = the user's running Chrome (same discovery as
// chrome-devtools-mcp --autoConnect), cdp = any DevTools endpoint, launch = a new Chrome for the run.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
/** Header values never stored: the attach mode runs in the user's own, signed-in profile. */
const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
const MAX_API_CALLS = 500;
const MAX_BODY = 64 * 1024;
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
  async attachEndpoint() {
    const dir = this.opts.chromeUserDataDir ?? process.env.BW_CHROME_USER_DATA_DIR ?? defaultChromeUserDataDir();
    const ws = await readDevToolsActivePort(dir);
    if (!ws)
      throw new Error(ATTACH_OFF_MESSAGE);
    return ws;
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
        // Chrome keeps DevToolsActivePort after remote debugging is turned off, so a refused
        // connection means the same as a missing file.
        const browser = await this.connect('attach', await this.attachEndpoint(), ATTACH_TIMEOUT).catch((e) => {
          const m = String(e?.message);
          throw new Error(/Timeout/.test(m) ? ATTACH_TIMEOUT_MESSAGE : /ECONNREFUSED/.test(m) ? ATTACH_OFF_MESSAGE : m);
        });
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
      // target 'attach_prompt' / 'attach_off': the widget explains Chrome's Allow prompt or the
      // remote-debugging switch in the user's language.
      const target = raw === ATTACH_TIMEOUT_MESSAGE ? 'attach_prompt' : raw === ATTACH_OFF_MESSAGE ? 'attach_off' : undefined;
      return { ok: false, error: { type: 'browser_unavailable', raw, stack, ...(target ? { target } : {}) } };
    }
    const consoleErrors = [];
    const push = (m) => { if (consoleErrors.length < 20)
      consoleErrors.push(m.slice(0, 500)); };
    page.on('console', (m) => { if (m.type() === 'error')
      push(m.text()); });
    page.on('pageerror', (e) => push(e.message));
    const apiCalls = [];
    // Same filter as the crawler: only fetch/XHR, not documents, scripts or images.
    page.on('request', (r) => {
      const type = r.resourceType();
      if ((type === 'fetch' || type === 'xhr') && apiCalls.length < MAX_API_CALLS)
        apiCalls.push(apiCallOf(r));
    });
    this.sessions.set(runId, { page, owned, consoleErrors, apiCalls });
    if (o.startUrl)
      return this.navigate(runId, o.startUrl, o.timeoutMs ?? 30_000);
    return { ok: true, url: page.url() };
  }
  async navigate(runId, url, timeoutMs) {
    const { page } = this.session(runId);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      return { ok: true, output: { success: true }, url: page.url() };
    }
    catch (err) {
      return { ok: false, url: page.url(), error: { ...classify(err, 'navigation_error'), target: url, timeoutMs } };
    }
  }
  async act(runId, a) {
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
  async evaluate(runId, code, arg) {
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
    return out;
  }
  async takeApiCalls(runId) {
    const s = this.sessions.get(runId);
    return s ? s.apiCalls.splice(0) : [];
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
        const ws = await this.attachEndpoint().catch(() => undefined);
        if (!ws)
          return { runner: 'error', inspector: 'error', code: 'attach_unreachable' };
        const b = await this.connect('attach', ws, ATTACH_TIMEOUT);
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
