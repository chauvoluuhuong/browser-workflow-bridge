// Page inspector: runs the bundled chrome-devtools-mcp as a child process and re-exposes a curated set
// of its tools as page_*, so Claude can explore pages in the same browser that runs workflows. The
// child restarts with matching flags when the server sends new browser settings. Generated from the
// Browser Workflow server's src/core/inspector.ts by its `npm run sync:bridge`.
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
/** chrome-devtools-mcp tools worth giving Claude for exploring pages and diagnosing failures. */
export const CURATED = [
  'list_pages', 'select_page', 'new_page', 'navigate_page', 'take_snapshot', 'take_screenshot',
  'click', 'fill', 'press_key', 'evaluate_script', 'wait_for',
  'list_console_messages', 'list_network_requests', 'get_network_request',
];
export function inspectorArgs(browser) {
  const args = ['--no-usage-statistics'];
  if (browser.mode === 'attach')
    args.push('--autoConnect');
  else if (browser.mode === 'cdp' && browser.cdpEndpoint) {
    args.push(browser.cdpEndpoint.startsWith('ws') ? '--wsEndpoint' : '--browserUrl', browser.cdpEndpoint);
  }
  // launch: chrome-devtools-mcp starts its own Chrome (runs close their tab when done).
  else if (browser.mode === 'launch' && browser.headed === false)
    args.push('--headless');
  return args;
}
export class Inspector {
  log;
  client;
  starting;
  tools;
  browser;
  constructor(browser, log = (m) => console.error(m)) {
    this.log = log;
    this.browser = browser;
  }
  bin() {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('chrome-devtools-mcp/package.json');
    return pkg.replace(/package\.json$/, 'build/src/bin/chrome-devtools-mcp.js');
  }
  connect() {
    if (this.client)
      return Promise.resolve(this.client);
    this.starting ??= (async () => {
      const client = new Client({ name: 'browser-workflow-bridge-inspector', version: '0.2.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [this.bin(), ...inspectorArgs(this.browser)],
        stderr: 'ignore',
      });
      await client.connect(transport);
      this.client = client;
      return client;
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  /** The curated tools with the child's own schemas (so our proxies validate the same way). */
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
  /** Restarts the child when the browser target changed. */
  async configure(browser) {
    const same = JSON.stringify(inspectorArgs(browser)) === JSON.stringify(inspectorArgs(this.browser));
    this.browser = browser;
    if (same)
      return;
    await this.close();
    this.log(`[inspector] restarting for browser mode "${browser.mode}"`);
  }
  async close() {
    const c = this.client;
    this.client = undefined;
    await c?.close().catch(() => { });
  }
}
