// Links this computer to the account the user logs in to (or creates) on the server's login page, with
// nothing to copy and no button to click in the chat. The `open_login_page` tool starts it:
//   1. The app asks for a pairing (POST /pair), with its current key when it has one: an account of its
//      own (src/alone.js) has its workflows moved to the account the user logs in to.
//   2. It opens the answer's `loginUrl` in a tab of the Chrome it drives, and listens on `signalUrl`.
//   3. The user logs in or signs up. The server writes on the channel, and the browser goes to a
//      welcome page that holds a one-time proof.
//   4. The app reads the proof from its own tab and fetches its key with it (GET /pair/<id>, with the
//      pairing's secret). A login link sent to someone else links nothing: no app sees their tab.
// The key never travels through the signal: a signal only says "ask now".
import os from 'node:os';
import { computerName } from './pairing.js';

const PAIR = '/api/bridge/v1/pair';
/** What the app reads from its tab: the welcome page's proof (server: accountPage.ts), or nothing yet. */
export const READ_PROOF = 'document.querySelector(\'meta[name="bw-link-proof"]\')?.content ?? ""';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

/** Calls `onPut` for each value the channel takes (Firebase's stream format), until `signal` aborts. */
async function listen(url, onPut, signal) {
  while (!signal.aborted) {
    try {
      const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal });
      if (!res.ok) throw new Error(`the signal stream answered ${res.status}`);
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!/^event: *(put|patch)$/m.test(block)) continue;
          try { onPut(JSON.parse(/^data: *(.*)$/m.exec(block)?.[1] ?? 'null')?.data); } catch { /* not ours */ }
        }
      }
    } catch { /* closed or unreachable: the slow asking covers it */ }
    await sleep(3000);
  }
}

export class WebLogin {
  /**
   * @param {{
   *   server: string, version: string, protocol: number,
   *   token(): string,                                     the app's key now, if any
   *   openTab(url: string): Promise<{ proof(): Promise<string> }>, opens the page where the user can see it
   *   onLinked(token: string, account?: string): void | Promise<void>,
   *   log?(m: string): void, debug?(m: string): void,
   *   pollMs?: number,                                    the slow asking, when no signal comes (default 15 s)
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.base = `${String(opts.server).replace(/\/+$/, '')}${PAIR}`;
    /** idle | waiting | linked | expired */
    this.state = 'idle';
    this.account = undefined;
    this.watching = undefined;
  }

  /** Opens the login page in Chrome and waits for the user in the background. Returns the page's address; throws with a reason the AI can pass on. */
  async begin() {
    this.watching?.abort();
    const key = this.opts.token();
    let res;
    try {
      res = await fetch(this.base, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ protocol: this.opts.protocol, bridgeVersion: this.opts.version, platform: `${os.platform()} ${os.arch()}`, name: computerName() }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error(`Could not reach ${this.opts.server}.`);
    }
    const p = await res.json().catch(() => ({}));
    if (res.status !== 200 || !p.pairId) throw new Error(p.message ?? `The server answered ${res.status}.`);
    if (!p.loginUrl || !p.signalUrl) throw new Error('This server has no login page for linking a computer yet.');
    const tab = await this.opts.openTab(p.loginUrl);
    const watching = new AbortController();
    this.watching = watching;
    this.state = 'waiting';
    this.opts.log?.('the login page is open in Chrome; waiting for the user to log in');
    void this.watch(p, tab, watching, Date.now() + (Number(p.expiresIn) > 0 ? Number(p.expiresIn) * 1000 : 600_000));
    return p.loginUrl;
  }

  stop() {
    this.watching?.abort();
    if (this.state === 'waiting') this.state = 'idle';
  }

  async watch(p, tab, ctl, until) {
    const { signal } = ctl;
    let busy = false;
    const claim = async () => {
      if (busy || signal.aborted) return;
      busy = true;
      try {
        // The welcome page may still be loading when the signal arrives: a few tries.
        for (let i = 0; i < 20 && !signal.aborted; i++) {
          const proof = await tab.proof().catch(() => '');
          const r = await fetch(`${this.base}/${encodeURIComponent(p.pairId)}`, {
            headers: { authorization: `Bearer ${p.secret}`, ...(proof ? { 'x-link-proof': proof } : {}) },
            signal: AbortSignal.timeout(10_000),
          }).catch(() => undefined);
          const json = await r?.json().catch(() => ({})) ?? {};
          if (r?.status === 404) { this.state = 'expired'; ctl.abort(); return; }
          if (json.status === 'linked' && json.token) {
            ctl.abort();
            this.state = 'linked';
            this.account = json.account;
            this.opts.log?.(`linked on the login page${json.account ? ` to ${json.account}` : ''}`);
            await this.opts.onLinked(json.token, json.account);
            return;
          }
          if (json.status !== 'proof') return; // still waiting for the user
          await sleep(700);
        }
      } finally {
        busy = false;
      }
    };
    void listen(p.signalUrl, (v) => { if (v) void claim(); }, signal);
    while (!signal.aborted && Date.now() < until) {
      await sleep(this.opts.pollMs ?? 15_000);
      await claim();
    }
    if (this.state === 'waiting' && this.watching === ctl) this.state = 'expired';
    ctl.abort();
  }
}
