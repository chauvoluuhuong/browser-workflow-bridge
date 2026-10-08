// Page inspector: runs the bundled chrome-devtools-mcp inside this process and re-exposes a curated
// set of its tools as page_*, so Claude can explore pages in the same browser that runs workflows. It
// is made again with matching flags when the server sends new browser settings. No second Node.js
// process is started: the Node.js inside the Claude desktop app refuses to start one. Generated from
// the Browser Workflow server's src/core/inspector.ts by its `npm run sync:bridge`.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { attachEndpoints } from './driver.js';
/** chrome-devtools-mcp tools worth giving Claude for exploring pages and diagnosing failures. */
export const CURATED = [
  'list_pages', 'select_page', 'new_page', 'navigate_page', 'take_snapshot', 'take_screenshot',
  'click', 'fill', 'press_key', 'evaluate_script', 'wait_for',
  'list_console_messages', 'list_network_requests', 'get_network_request',
];
/** `found`: in attach mode, the running Chrome to join. --autoConnect finds only a Chrome with remote debugging allowed in its usual profile. */
export function inspectorArgs(browser, found) {
  const args = ['--no-usage-statistics'];
  if (browser.mode === 'attach') {
    if (!found || found.usual)
      args.push('--autoConnect');
    else
      args.push(...(found.browserUrl ? ['--browserUrl', found.browserUrl] : ['--wsEndpoint', found.ws]));
  }
  else if (browser.mode === 'cdp' && browser.cdpEndpoint) {
    args.push(browser.cdpEndpoint.startsWith('ws') ? '--wsEndpoint' : '--browserUrl', browser.cdpEndpoint);
  }
  // launch: chrome-devtools-mcp starts its own Chrome (runs close their tab when done), with a profile
  // of its own that is removed afterwards: a profile shared between two of them lets only one start.
  else if (browser.mode === 'launch')
    args.push('--isolated', ...(browser.headed === false ? ['--headless'] : []));
  return args;
}
/**
* chrome-devtools-mcp's own modules. It publishes no API for making its server with a browser we can
* close again, so these are files inside the package, and its version is pinned in package.json.
*/
export async function devtools() {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('chrome-devtools-mcp/package.json'));
  const load = (file) => import(pathToFileURL(path.join(root, 'build', 'src', file)).href);
  // What its own start-up loads first: names that older Node.js versions lack.
  await load('utils/polyfill.js');
  const [{ McpServer }, { BrowserManager }, { parser }, { VERSION }] = await Promise.all([
    load('index.js'), load('BrowserManager.js'), load('config/mcp-options.js'), load('version.js'),
  ]);
  return { McpServer, BrowserManager, parser, VERSION };
}
/** chrome-devtools-mcp's settings from its command-line flags. A flag it refuses is an error here, where its own start-up would end the process. */
export function devtoolsArgs(d, flags) {
  // Its parser skips the program's own leading arguments: two under Node.js, one inside a packaged
  // Electron app, which is what the Claude desktop app's Node.js says it is.
  const lead = process.versions.electron && !process.defaultApp ? 1 : 2;
  return d.parser(d.VERSION, [...Array(lead).fill('chrome-devtools-mcp'), ...flags])
    .exitProcess(false)
    .fail((message, err) => { throw err ?? new Error(message); })
    .parseSync();
}
export class Inspector {
  log;
  client;
  server;
  starting;
  flags;
  tools;
  browser;
  constructor(browser, log = (m) => console.error(m)) {
    this.log = log;
    this.browser = browser;
  }
  connect() {
    this.starting ??= (async () => {
      // Asked at each use: Chrome may have been started, or started another way, since the last one.
      const found = this.browser.mode === 'attach' ? (await attachEndpoints().next()).value : undefined;
      const flags = inspectorArgs(this.browser, found);
      if (this.client && this.flags === flags.join(' '))
        return this.client;
      await this.close();
      const d = await devtools();
      const args = devtoolsArgs(d, flags);
      const server = await d.McpServer.from(args, { browserManager: new d.BrowserManager(args, {}) });
      const [near, far] = InMemoryTransport.createLinkedPair();
      await server.server.connect(far);
      const client = new Client({ name: 'browser-workflow-bridge-inspector', version: '0.2.0' });
      await client.connect(near);
      this.server = server;
      this.client = client;
      this.flags = flags.join(' ');
      return client;
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  /** The curated tools with chrome-devtools-mcp's own schemas (so our proxies validate the same way). */
  async listTools() {
    // Schemas don't change between restarts of the same pinned version, so list once.
    this.tools ??= (async () => {
      const c = await this.connect();
      const { tools } = await c.listTools();
      return tools.filter((t) => CURATED.includes(t.name));
    })().catch((e) => { this.tools = undefined; throw e; });
    return this.tools;
  }
  async call(name, args) {
    const c = await this.connect();
    return c.callTool({ name, arguments: args });
  }
  async ping() {
    await this.connect();
    return true;
  }
  /** Makes the inspector again, at its next use, when the browser target changed. */
  async configure(browser) {
    const same = JSON.stringify(inspectorArgs(browser)) === JSON.stringify(inspectorArgs(this.browser));
    this.browser = browser;
    if (same)
      return;
    await this.close();
    this.log(`[inspector] restarting for browser mode "${browser.mode}"`);
  }
  /** Also closes a Chrome the inspector started itself; a Chrome it connected to stays open. */
  async close() {
    const c = this.client;
    const s = this.server;
    this.client = undefined;
    this.server = undefined;
    await c?.close().catch(() => { });
    await s?.close().catch(() => { });
  }
}
