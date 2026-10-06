#!/usr/bin/env node
// Browser Workflow bridge: a local MCP server that Claude starts and keeps running. It connects to the
// Browser Workflow server and carries out primitive browser commands (open a tab, navigate, act on an
// XPath, evaluate, capture, close) in the user's Chrome. It holds no workflow logic: the server decides
// every step. To Claude it offers bridge_status and the page_* inspector tools.
// Env (set by the plugin from userConfig):
//   BW_SERVER_URL      the server's base URL (https://…)
//   BW_BRIDGE_TOKEN    links the bridge to the user's account; never logged or returned
//   BW_ALLOWED_SITES   optional: only open these sites (comma-separated host names)
//   BW_DATA_DIR        optional: where runs are saved on this computer (default ~/.browser-workflow)
// Development and tests: BW_NO_INSPECTOR=1 skips the page_* tools; BW_CHROME_PATH launches that
// executable; BW_LAUNCH_DEBUG_PORT sets the DevTools port of launched Chrome (default 9333);
// BW_MAX_RUN_MS is the longest a run's tab stays open (default and at most 60 minutes);
// BW_MAX_BACKOFF_MS is the longest wait between two attempts to reconnect (default 30 seconds).
// The bridge talks to the server with HTTP requests and holds no connection open to it (src/rest.js).
// `node src/index.js --standalone` runs only the connection (no MCP), for a terminal or a dev script.
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { createExecutor, MAX_OPEN, parseSites } from './commands.js';
import { RestConnection } from './rest.js';
import { LocalDriver } from './driver.js';
import { Inspector } from './inspector.js';
import { bridgeId, createStorage, dataDir } from './storage.js';

const VERSION = '0.4.0';

// stdout is the MCP channel: keep every log on stderr.
console.log = (...a) => console.error(...a);
const log = (m) => console.error(`[bridge] ${m}`);

const server = process.env.BW_SERVER_URL || 'http://127.0.0.1:3310';
const token = process.env.BW_BRIDGE_TOKEN || '';
const allowedSites = parseSites(process.env.BW_ALLOWED_SITES);
let browser = { mode: 'attach', headed: true };

const driver = new LocalDriver({
  executablePath: process.env.BW_CHROME_PATH || undefined,
  launchDebugPort: Number(process.env.BW_LAUNCH_DEBUG_PORT) || undefined,
});
const storage = createStorage({ baseDir: dataDir(process.env.BW_DATA_DIR) });
const executor = createExecutor(driver, { allowedSites, log, storage, maxRunMs: Number(process.env.BW_MAX_RUN_MS) || undefined });
const standalone = process.argv.includes('--standalone');
const inspector = process.env.BW_NO_INSPECTOR || standalone ? undefined : new Inspector(browser, log);

const connection = new RestConnection({
  server,
  token,
  instance: bridgeId(dataDir(process.env.BW_DATA_DIR)),
  version: VERSION,
  execute: executor.execute,
  // The server says which account this is; its runs are saved in that account's folder.
  onWelcome: (m) => {
    try {
      log(`runs are saved in ${storage.use(m.accountId ?? 'default')}`);
    } catch (e) {
      log(`no data folder: ${e?.message ?? e}`);
    }
  },
  onConfig: (b) => {
    browser = b;
    void inspector?.configure(b);
  },
  // Close every tab this bridge opened when the server goes away: nothing runs without it.
  onDisconnect: () => { void executor.closeAll(); },
  log,
  maxBackoffMs: Number(process.env.BW_MAX_BACKOFF_MS) || undefined,
});
connection.start();
// Every minute, or sooner when the limit itself is shorter (tests).
setInterval(() => void executor.sweep(), Math.min(60_000, Math.max(250, executor.maxRunMs / 2))).unref();

const STATES = {
  not_configured: 'not set up: add the bridge token in the plugin settings',
  connecting: 'connecting…',
  connected: 'connected',
  disconnected: 'disconnected, retrying',
  paused: 'paused (ask to resume the bridge to reconnect)',
  rejected: 'refused by the server',
};

function statusText() {
  const c = connection;
  return [
    `Browser Workflow bridge ${VERSION}`,
    `Server: ${server}`,
    `Token: ${token ? 'set' : 'not set (add it in the plugin settings)'}`,
    `Connection: ${STATES[c.state] ?? c.state}${c.state === 'connected' ? ` as ${c.account} since ${c.connectedAt}` : ''}`,
    c.lastError && c.state !== 'connected' ? `Last error: ${c.lastError}` : '',
    `Browser mode: ${browser.mode}${browser.cdpEndpoint ? ` (${browser.cdpEndpoint})` : ''}`,
    `Open runs: ${executor.openRuns()} (at most ${MAX_OPEN}; each closes after ${Math.round(executor.maxRunMs / 6000) / 10} minutes)`,
    `Allowed sites: ${allowedSites.length ? allowedSites.join(', ') : 'any'}`,
    `Runs saved in: ${storage.location() ?? `${dataDir(process.env.BW_DATA_DIR)} (once connected)`}`,
  ].filter(Boolean).join('\n');
}

async function shutdown() {
  await connection.stop();
  await executor.closeAll();
  await driver.dispose().catch(() => {});
  await inspector?.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (standalone) {
  log(`standalone · server ${server}${token ? '' : ' · no token (set BW_BRIDGE_TOKEN)'}`);
  setInterval(() => {}, 1 << 30); // stay up while reconnecting
} else {
  await startMcp();
}

async function startMcp() {
  const mcp = new McpServer({ name: 'browser-workflow-bridge', version: VERSION });

  mcp.registerTool(
    'bridge_status',
    {
      title: 'Bridge status',
      description: 'Shows whether the Browser Workflow bridge is set up and connected to the server that runs workflows in this Chrome. Pass action "pause" to disconnect it (nothing can run in this browser until resumed) or "resume" to reconnect.',
      inputSchema: z.object({ action: z.enum(['pause', 'resume']).optional() }),
      annotations: { title: 'Bridge status', readOnlyHint: false, destructiveHint: false },
    },
    async ({ action }) => {
      if (action === 'pause') {
        connection.pause();
        await executor.closeAll();
      } else if (action === 'resume') {
        connection.resume();
        await new Promise((r) => setTimeout(r, 1500));
      }
      return { content: [{ type: 'text', text: statusText() }] };
    },
  );

  if (inspector) {
    try {
      for (const t of await inspector.listTools()) {
        mcp.registerTool(
          `page_${t.name}`,
          {
            title: `Inspector: ${t.name.replace(/_/g, ' ')}`,
            description: `[Inspector — same browser as workflow runs] ${t.description ?? ''}`,
            inputSchema: fromJsonSchema(t.inputSchema),
            annotations: { title: `Inspector: ${t.name.replace(/_/g, ' ')}`, readOnlyHint: false, destructiveHint: false, ...(t.annotations ?? {}) },
          },
          async (args) => inspector.call(t.name, args ?? {}),
        );
      }
    } catch (e) {
      log(`page inspector unavailable: ${e?.message ?? e}`);
    }
  }

  await mcp.connect(new StdioServerTransport());
  log(`ready on stdio · server ${server}`);
  process.stdin.on('close', shutdown);
}
