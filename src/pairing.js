// Links this computer to a Browser Workflow account without a token for the user to copy and paste.
//   1. The app asks the server for a pairing code (POST /pair) and shows it in `bridge_status`.
//   2. Claude, which has both this app and the Browser Workflow connector, passes the code to the
//      connector's `link_computer` tool. The connector shows the user a "Link this computer" button.
//   3. The user clicks it. The server then gives this app a token, once, at its next poll.
//   4. The token is kept in `link.json` in the data folder (readable by its owner only) and used from
//      then on, so pairing happens once per computer.
// The code is useless without a signed-in user's click, and the token goes only to the app that asked
// for the code (it holds a secret the server checks), so a code seen by someone else links nothing.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PAIR = '/api/bridge/v1/pair';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

/** A token from a setting: empty, or a template the host did not fill in ("${user_config.token}"), is none. */
export function usableToken(value) {
  const v = String(value ?? '').trim();
  return v && !v.startsWith('${') ? v : '';
}

const linkFile = (dir) => path.join(dir, 'link.json');

/** The token saved by an earlier pairing, when it was made for this server. */
export function readLink(dir, server) {
  try {
    const j = JSON.parse(readFileSync(linkFile(dir), 'utf8'));
    return j.server === server ? usableToken(j.token) : '';
  } catch {
    return '';
  }
}

export function saveLink(dir, server, token) {
  mkdirSync(dir, { recursive: true });
  const file = linkFile(dir);
  writeFileSync(file, `${JSON.stringify({ server, token })}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* not supported on this file system */ }
}

export function clearLink(dir) {
  rmSync(linkFile(dir), { force: true });
}

/** What the user sees of this computer on the confirmation button: its name and system. */
export function computerName() {
  try { return `${os.hostname()}`.slice(0, 60); } catch { return ''; }
}

export class Pairing {
  /**
   * @param {{
   *   server: string, version: string, protocol: number,
   *   onLinked(token: string, account?: string): void | Promise<void>,
   *   log?(m: string): void, debug?(m: string): void,
   *   pollMs?: number, maxBackoffMs?: number,
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.base = `${String(opts.server).replace(/\/+$/, '')}${PAIR}`;
    this.log = opts.log ?? (() => {});
    this.debug = opts.debug ?? (() => {});
    this.pollMs = opts.pollMs > 0 ? opts.pollMs : 2000;
    this.maxBackoff = opts.maxBackoffMs > 0 ? opts.maxBackoffMs : 30_000;
    /** idle | asking | waiting | unreachable | linked */
    this.state = 'idle';
    this.code = undefined;
    this.expiresAt = 0;
    this.lastError = undefined;
    this.timer = undefined;
    this.running = false;
    this.attempt = 0;
  }

  /** Starts asking for a code and waiting for the click. Does nothing while already doing so. */
  start() {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    void this.ask();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.state !== 'linked') this.state = 'idle';
  }

  later(ms, fn) {
    clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(() => void fn.call(this), ms);
    this.timer.unref?.();
  }

  backoff() {
    const delay = Math.min(this.maxBackoff, 1000 * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 10);
    return delay;
  }

  async ask() {
    if (!this.running) return;
    this.state = 'asking';
    let res;
    try {
      res = await fetch(this.base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol: this.opts.protocol, bridgeVersion: this.opts.version, platform: `${os.platform()} ${os.arch()}`, name: computerName() }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      this.lastError = `Could not reach ${this.opts.server}`;
      this.state = 'unreachable';
      return this.later(this.backoff(), this.ask);
    }
    let json = {};
    try { json = await res.json(); } catch { /* not JSON */ }
    if (res.status !== 200 || !json.pairId) {
      this.lastError = json.message ?? `The server answered ${res.status} to the pairing request`;
      this.state = 'unreachable';
      return this.later(this.backoff(), this.ask);
    }
    this.attempt = 0;
    this.lastError = undefined;
    this.id = json.pairId;
    this.secret = json.secret;
    this.code = json.code;
    this.expiresAt = Date.now() + (Number(json.expiresIn) > 0 ? Number(json.expiresIn) * 1000 : 600_000);
    this.state = 'waiting';
    this.log(`pairing code ${this.code} (waiting for the user to confirm it in Claude)`);
    this.later(this.pollMs, this.poll);
  }

  async poll() {
    if (!this.running) return;
    if (Date.now() >= this.expiresAt) return this.ask();
    let res;
    try {
      res = await fetch(`${this.base}/${encodeURIComponent(this.id)}`, { headers: { authorization: `Bearer ${this.secret}` }, signal: AbortSignal.timeout(10_000) });
    } catch {
      this.lastError = `Could not reach ${this.opts.server}`;
      this.state = 'unreachable';
      return this.later(this.backoff(), this.poll);
    }
    let json = {};
    try { json = await res.json(); } catch { /* not JSON */ }
    // Unknown to the server now (it restarted, or the code expired): ask for a new code.
    if (res.status === 404 || res.status === 410) return this.ask();
    if (res.status !== 200) {
      this.lastError = json.message ?? `The server answered ${res.status}`;
      return this.later(this.backoff(), this.poll);
    }
    this.attempt = 0;
    this.state = 'waiting';
    if (json.status === 'linked' && json.token) {
      this.state = 'linked';
      this.running = false;
      this.code = undefined;
      this.log(`linked${json.account ? ` to ${json.account}` : ''}`);
      await this.opts.onLinked(json.token, json.account);
      return;
    }
    this.later(this.pollMs, this.poll);
  }
}
