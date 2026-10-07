#!/usr/bin/env node
// Browser Workflow bridge: a local MCP server that Claude starts and keeps running. It connects to the
// Browser Workflow server and carries out primitive browser commands (open a tab, navigate, act on an
// XPath, evaluate, capture, close) in the user's Chrome. It holds no workflow logic: the server decides
// every step. To Claude it offers bridge_status and the page_* inspector tools.
// Env (set by the plugin from userConfig):
//   BW_SERVER_URL      the server's base URL (default: the hosted server, PRODUCTION in guide.js)
//   BW_BRIDGE_TOKEN    optional: links the bridge to the user's account; never logged or returned. Without it the
//                      bridge links itself by pairing (src/pairing.js) and keeps the token in link.json
//   BW_ALLOWED_SITES   optional: only open these sites (comma-separated host names)
//   BW_DATA_DIR        optional: where runs are saved on this computer (default ~/.browser-workflow);
//                      the bridge's log, bridge.log, is there too
// Development and tests: BW_NO_INSPECTOR=1 skips the page_* tools; BW_CHROME_PATH launches that
// executable; BW_LAUNCH_DEBUG_PORT sets the DevTools port of launched Chrome (default 9333);
// BW_MAX_RUN_MS is the longest a run's tab stays open (default and at most 60 minutes);
// BW_MAX_BACKOFF_MS is the longest wait between two attempts to reconnect (default 30 seconds).
// The bridge talks to the server with HTTP requests and holds no connection open to it (src/rest.js).
// `node src/index.js --standalone` runs only the connection (no MCP), for a terminal or a dev script.
// Claude Code starts src/start.js, which installs the dependencies when they are missing and then loads this.
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { createExecutor, MAX_OPEN, parseSites } from './commands.js';
import { connectorHint, INSTRUCTIONS, nextSteps, PRODUCTION, reachable } from './guide.js';
import { createLog } from './log.js';
import { clearLink, Pairing, readLink, saveLink, usableToken } from './pairing.js';
import { PROTOCOL, RestConnection } from './rest.js';
import { LocalDriver } from './driver.js';
import { Inspector } from './inspector.js';
import { bridgeId, createStorage, dataDir } from './storage.js';

const VERSION = '0.5.1';

// stdout is the MCP channel: keep every log on stderr. The same lines, and every command, also go to
// `bridge.log` in the data folder (src/log.js).
console.log = (...a) => console.error(...a);
const { log, debug, file: logFile } = createLog(dataDir(process.env.BW_DATA_DIR));

const server = (process.env.BW_SERVER_URL || PRODUCTION).replace(/\/+$/, '');
const baseDir = dataDir(process.env.BW_DATA_DIR);
// A token from the settings wins (an advanced setting; most computers are linked by pairing instead);
// else the one pairing saved in the data folder.
const settingToken = usableToken(process.env.BW_BRIDGE_TOKEN);
let token = settingToken || readLink(baseDir, server);
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
// What bridge_status says about the page_* tools: how many there are, or why there are none.
let inspectorState = inspector ? 'starting' : 'off';
// The inspector runs inside this process (src/inspector.js), so a promise it leaves unhandled would end
// the app with it. Its own start-up notes these and carries on; so does this.
process.on('unhandledRejection', (reason) => log(`unhandled: ${reason?.stack ?? reason}`));

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
  // The server doesn't know this token (a new one replaced it, or the account is gone): forget it and pair again.
  onBadToken: () => {
    if (settingToken) return;
    log('the saved link is no longer valid; pairing again');
    clearLink(baseDir);
    token = '';
    connection.setToken('');
    pairing.start();
  },
  log,
  debug,
  maxBackoffMs: Number(process.env.BW_MAX_BACKOFF_MS) || undefined,
});
// No token yet: pair. Claude passes the code to the connector, the user clicks, and the token arrives.
const pairing = new Pairing({
  server,
  version: VERSION,
  protocol: PROTOCOL,
  log,
  debug,
  maxBackoffMs: Number(process.env.BW_MAX_BACKOFF_MS) || undefined,
  pollMs: Number(process.env.BW_PAIR_POLL_MS) || undefined,
  onLinked: (t) => {
    token = t;
    try {
      saveLink(baseDir, server, t);
    } catch (e) {
      log(`could not save the link in ${baseDir}: ${e?.message ?? e}; it lasts until this app stops`);
    }
    connection.setToken(t);
  },
});
if (token) connection.start();
else pairing.start();
// Every minute, or sooner when the limit itself is shorter (tests).
setInterval(() => void executor.sweep(), Math.min(60_000, Math.max(250, executor.maxRunMs / 2))).unref();

const STATES = {
  not_configured: 'not linked to an account yet',
  connecting: 'connecting…',
  connected: 'connected',
  disconnected: 'disconnected, retrying',
  paused: 'paused (ask to resume the bridge to reconnect)',
  rejected: 'refused by the server',
};

async function statusText() {
  const c = connection;
  // Not connected: say whether the server is there at all, since the steps depend on it.
  const serverUp = ['not_configured', 'connecting', 'disconnected'].includes(c.state) ? await reachable(server) : true;
  const steps = nextSteps({ state: c.state, server, token: !!token, lastError: c.lastError, serverUp, pairing });
  return [
    `Browser Workflow app ${VERSION}`,
    `Server: ${server}${serverUp ? '' : ' (not answering)'}`,
    `Token: ${token ? 'set' : 'not set (this computer links itself by pairing)'}`,
    `Connection: ${STATES[c.state] ?? c.state}${c.state === 'connected' ? ` as ${c.account} since ${c.connectedAt}` : ''}`,
    c.lastError && c.state !== 'connected' ? `Last error: ${c.lastError}` : undefined,
    `Browser mode: ${browser.mode}${browser.cdpEndpoint ? ` (${browser.cdpEndpoint})` : ''}`,
    `Page inspector: ${inspectorState}`,
    `Open runs: ${executor.openRuns()} (at most ${MAX_OPEN}; each closes after ${Math.round(executor.maxRunMs / 6000) / 10} minutes)`,
    `Allowed sites: ${allowedSites.length ? allowedSites.join(', ') : 'any'}`,
    `Runs saved in: ${storage.location() ?? `${baseDir} (once connected)`}`,
    `Log: ${logFile}`,
    '',
    ...(steps.length ? ['What to do next:', ...steps] : [connectorHint(server)]),
  ].filter((l) => l !== false && l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');
}

async function shutdown() {
  pairing.stop();
  await connection.stop();
  await executor.closeAll();
  await driver.dispose().catch(() => {});
  await inspector?.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (standalone) {
  log(`standalone · server ${server}${token ? '' : ' · no token yet: pairing'}`);
  setInterval(() => {}, 1 << 30); // stay up while reconnecting
} else {
  await startMcp();
}

async function startMcp() {
  const mcp = new McpServer({ name: 'browser-workflow-bridge', version: VERSION }, { instructions: INSTRUCTIONS });

  mcp.registerTool(
    'bridge_status',
    {
      title: 'Bridge status',
      description: 'Shows whether the Browser Workflow bridge is set up and connected to the server that runs workflows in this Chrome, and when it is not, the steps for the user to finish setting it up. Pass action "pause" to disconnect it (nothing can run in this browser until resumed) or "resume" to reconnect.',
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
      return { content: [{ type: 'text', text: await statusText() }] };
    },
  );

  if (inspector) {
    try {
      let count = 0;
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
        count += 1;
      }
      inspectorState = `ready (${count} page_* tools)`;
    } catch (e) {
      inspectorState = `unavailable (${e?.message ?? e}). Workflows still run; the page_* tools are missing, so pages cannot be explored before a workflow is written.`;
      log(`page inspector unavailable: ${e?.message ?? e}`);
    }
  }

  await mcp.connect(new StdioServerTransport());
  log(`ready on stdio · server ${server}`);
  process.stdin.on('close', shutdown);
}
