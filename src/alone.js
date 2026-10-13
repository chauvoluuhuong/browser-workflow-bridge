// The app as the only thing the AI app has (BW_ALONE=1, set by the install command that asks for it):
// no Browser Workflow connector to add and sign in to, and no computer to link.
//   1. With no token, the app asks the server for an account of its own (POST /account) instead of a
//      pairing code. The token it gets is this account's one key, kept in `link.json` like any other.
//   2. The app offers the server's tools itself. Their names, descriptions and inputs are in
//      `tools.json`, written by the server's `scripts/sync-tools.ts` and shipped with the app, so what
//      the AI is told a tool does is readable here and never fetched at run time. The work of a tool
//      stays on the server: each call is passed on to it with the key, and its answer handed back as it is.
//      So does a card: its page is read from the server each time. Only the page's address is in the
//      list, and an AI app keeps a page it fetched under its address, so the app asks the server for
//      today's address when it starts (`cardAddress`): a changed card is then seen without a new app.
// Without BW_ALONE nothing here is used, and the app is linked by pairing as before.
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const ACCOUNT = '/api/bridge/v1/account';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

export const isAlone = (env = process.env) => env.BW_ALONE === '1';

/** Tools that link a computer: an app with an account of its own has nothing to link. */
const NOT_ALONE = new Set(['link_computer', 'ui_confirm_link', 'ui_new_bridge_token']);

/** A card page's address: "ui://browser-workflow/app-<a mark of its build>.html". */
const CARD = /ui:\/\/browser-workflow\/app-[0-9a-f]+\.html/g;

/** The address of the card's page on the server today; nothing when the server does not answer in time, or is an older one. */
export async function cardAddress(server, timeoutMs = 2500) {
  try {
    const res = await fetch(`${server}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const ui = (await res.json()).ui;
    return typeof ui === 'string' && new RegExp(`^(?:${CARD.source})$`).test(ui) ? ui : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The server's tools as shipped with the app, with this server's address where a card's settings name
 * it, and `card` (today's address of the card's page, when known) in place of the one of the day the list was written.
 */
export function readTools(server, card, file = new URL('./tools.json', import.meta.url)) {
  let text = readFileSync(file, 'utf8').split('{{server}}').join(server);
  if (card) text = text.replace(CARD, card);
  const list = JSON.parse(text);
  return { instructions: list.instructions ?? '', tools: (list.tools ?? []).filter((t) => !NOT_ALONE.has(t.name)), resources: list.resources ?? [] };
}

/**
 * Gets this app an account of its own. It has the shape of Pairing (start, stop, state, lastError),
 * so the rest of the app treats "no token yet" the same way; there is no code and nothing for the user to do.
 */
export class OwnAccount {
  /**
   * @param {{
   *   server: string, version: string, protocol: number,
   *   onLinked(token: string, account?: string): void | Promise<void>,
   *   log?(line: string): void, debug?(line: string): void, maxBackoffMs?: number,
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.state = 'idle';
    this.lastError = undefined;
    this.running = false;
    this.attempt = 0;
  }

  start() {
    if (this.running || this.state === 'linked') return;
    this.running = true;
    void this.ask();
  }

  stop() {
    this.running = false;
    if (this.state !== 'linked') this.state = 'idle';
  }

  async ask() {
    while (this.running) {
      this.state = 'asking';
      try {
        const res = await fetch(`${this.opts.server}${ACCOUNT}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ protocol: this.opts.protocol, bridgeVersion: this.opts.version, platform: process.platform }),
          signal: AbortSignal.timeout(15_000),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.token) throw new Error(json.message ?? `the server answered ${res.status}`);
        if (!this.running) return;
        this.state = 'linked';
        this.running = false;
        this.lastError = undefined;
        this.opts.log?.(`this computer has its own account now: ${json.account ?? 'an account with no name'}`);
        await this.opts.onLinked(json.token, json.account);
        return;
      } catch (e) {
        this.state = 'unreachable';
        this.lastError = e?.message ?? String(e);
        this.opts.debug?.(`no account yet: ${this.lastError}`);
        this.attempt += 1;
        await sleep(Math.min(this.opts.maxBackoffMs ?? 30_000, 1000 * 2 ** Math.min(this.attempt, 5)));
      }
    }
  }
}

/**
 * Passes the AI app's requests on to the server with this app's key.
 * @param {{ server: string, token(): string, version: string, log?(line: string): void }} o
 */
export function createUpstream(o) {
  let client;
  let usedToken = '';
  let connecting;

  async function connected() {
    const token = o.token();
    if (!token) throw new Error('This computer is still getting its account from the server. Call bridge_status, then try again in a few seconds.');
    if (client && usedToken === token) return client;
    connecting ??= (async () => {
      try {
        await client?.close().catch(() => {});
        const c = new Client({ name: 'browser-workflow-app', version: o.version });
        await c.connect(new StreamableHTTPClientTransport(new URL(`${o.server}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
        client = c;
        usedToken = token;
        return c;
      } finally {
        connecting = undefined;
      }
    })();
    return connecting;
  }

  /** One request, tried once more on a fresh connection: the server forgets a connection when it restarts. */
  async function pass(send) {
    try {
      return await send(await connected());
    } catch (e) {
      o.log?.(`passing a request to the server failed (${e?.message ?? e}); connecting again`);
      await client?.close().catch(() => {});
      client = undefined;
      return send(await connected());
    }
  }

  return {
    /** A tool's answer as the server gave it; when the server can't be reached, an error the AI can read. */
    async call(name, args) {
      try {
        return await pass((c) => c.callTool({ name, arguments: args ?? {} }, { timeout: 120_000 }));
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `Browser Workflow's server could not be reached for ${name}: ${e?.message ?? e}. Call bridge_status to see why.` }] };
      }
    },
    read: (uri) => pass((c) => c.readResource({ uri })),
    close: async () => { await client?.close().catch(() => {}); client = undefined; },
  };
}
