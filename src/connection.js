// The connection to the Browser Workflow server. The bridge dials out, so the user needs no firewall
// or router changes. It says `hello` with the user's token, then answers each `command` the server
// sends with a `result` carrying the same id. It reconnects with backoff until paused, rejected or
// stopped. Messages are JSON; their shapes are listed in the README.
import os from 'node:os';

// 2: navigate, act and evaluate take `after` and answer with the page state in the same reply;
//    `store` keeps runs on this computer.
export const PROTOCOL = 2;
/** The server drops a connection that sends more than 8 MB in one message; stay well under it. */
export const MAX_RESULT = 6 * 1024 * 1024;
const COMMANDS = new Set(['open', 'navigate', 'act', 'evaluate', 'capture', 'takeApiCalls', 'close', 'check', 'store']);
const MAX_BACKOFF = 30_000;
/** BW_DEBUG=1 logs each command and its answer (typed values only by length: they can be passwords). */
const DEBUG = !!process.env.BW_DEBUG;
const time = () => new Date().toISOString().slice(11, 23);

export function describe(name, args = []) {
  const [a0, a1] = args;
  if (name === 'open') return `${a0} mode=${a1?.mode}${a1?.startUrl ? ` ${a1.startUrl}` : ''}`;
  if (name === 'navigate') return `${a0} ${a1}`;
  if (name === 'act') return `${a0} ${a1?.command} ${a1?.xpath}${a1?.value ? ` value=(${String(a1.value).length} chars)` : ''}`;
  if (name === 'evaluate') return `${a0} ${String(a1).replace(/\s+/g, ' ').slice(0, 60)}`;
  if (name === 'check') return `mode=${a0}`;
  if (name === 'store') return `${a0} ${typeof a1 === 'string' ? a1 : a1?.runId ?? ''}`;
  return String(a0 ?? '');
}

export function outcome(v) {
  if (v == null) return 'ok';
  // A file read back for the server (base64), or a count.
  if (typeof v !== 'object') return typeof v === 'string' ? `${v.length} chars` : String(v);
  if (Array.isArray(v)) return `${v.length} items`;
  if (typeof v.ok === 'boolean') return v.ok ? 'ok' : `error ${v.error?.type}: ${String(v.error?.raw ?? '').slice(0, 100)}`;
  if ('consoleErrors' in v) return [v.screenshot && 'screenshot', v.html && 'html', v.domExcerpt && 'excerpt'].filter(Boolean).join('+') || 'nothing';
  if ('runner' in v) return v.code;
  return 'ok';
}

/** ws(s)://…/bridge from the server's base URL (http → ws, https → wss); a ws(s) URL is used as is. */
export function bridgeUrl(server) {
  const u = new URL(server);
  if (u.protocol === 'ws:' || u.protocol === 'wss:') return u.toString();
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/bridge`;
  return u.toString();
}

export class Connection {
  /**
   * @param {{
   *   url: string, token: string, version: string,
   *   execute(name: string, args: unknown[]): Promise<unknown>,
   *   onWelcome?(welcome: { account: string, accountId?: string }): void,
   *   onConfig?(browser: object): void,
   *   onDisconnect?(): void,
   *   log?(message: string): void,
   *   maxBackoffMs?: number,
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    /** The longest wait between two attempts to reconnect (shortened in tests). */
    this.maxBackoff = opts.maxBackoffMs > 0 ? opts.maxBackoffMs : MAX_BACKOFF;
    /** not_configured | connecting | connected | disconnected | paused | rejected */
    this.state = opts.token ? 'disconnected' : 'not_configured';
    this.attempt = 0;
    this.ws = undefined;
    this.timer = undefined;
    this.account = undefined;
    this.connectedAt = undefined;
    this.lastError = undefined;
    this.stopped = false;
  }

  start() {
    if (this.opts.token) this.connect();
  }

  connect() {
    clearTimeout(this.timer);
    this.state = 'connecting';
    let ws;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (e) {
      this.lastError = e?.message ?? String(e);
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'hello', token: this.opts.token, protocol: PROTOCOL, bridgeVersion: this.opts.version, platform: `${os.platform()} ${os.arch()}`,
      }));
    };
    ws.onmessage = (ev) => this.onMessage(ws, ev.data);
    ws.onerror = () => {
      if (this.state === 'connecting') this.lastError = `Could not reach ${this.opts.url}`;
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      const wasConnected = this.state === 'connected';
      if (wasConnected) this.log('disconnected from the server');
      this.opts.onDisconnect?.();
      if (this.stopped || this.state === 'paused' || this.state === 'rejected') return;
      this.state = 'disconnected';
      this.account = undefined;
      this.retry();
    };
  }

  retry() {
    if (this.stopped) return;
    const delay = Math.min(this.maxBackoff, 1000 * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 10);
    this.timer = setTimeout(() => this.connect(), delay);
    this.timer.unref?.();
  }

  send(ws, m) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }

  onMessage(ws, data) {
    let m;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (m.type) {
      case 'welcome':
        this.state = 'connected';
        this.account = m.account;
        this.connectedAt = new Date().toISOString();
        this.lastError = undefined;
        this.attempt = 0;
        this.log(`connected to ${this.opts.url} as ${m.account}`);
        this.opts.onWelcome?.(m);
        break;
      case 'rejected':
        // A wrong token or an old bridge won't fix itself; "replaced" means another bridge took over.
        this.state = 'rejected';
        this.lastError = m.message;
        this.log(`the server refused the connection: ${m.message}`);
        ws.close();
        break;
      case 'ping':
        this.send(ws, { type: 'pong' });
        break;
      case 'config':
        this.opts.onConfig?.(m.browser);
        break;
      case 'command':
        void this.run(ws, m);
        break;
      default:
    }
  }

  async run(ws, m) {
    const t0 = Date.now();
    if (DEBUG) console.error(`${time()} [bridge] ← #${m.id} ${m.name} ${describe(m.name, m.args)}`);
    try {
      if (!COMMANDS.has(m.name)) throw new Error(`Unknown command: ${m.name}`);
      const value = await this.opts.execute(m.name, m.args);
      if (DEBUG) console.error(`${time()} [bridge] → #${m.id} ${m.name} ${outcome(value)} ${Date.now() - t0}ms`);
      const reply = JSON.stringify({ type: 'result', id: m.id, ok: true, value: value ?? null });
      if (Buffer.byteLength(reply) > MAX_RESULT) throw new Error(`The step returned more than ${MAX_RESULT / 1024 / 1024} MB of data. Return less, or split it across steps.`);
      if (ws.readyState === WebSocket.OPEN) ws.send(reply);
    } catch (e) {
      if (DEBUG) console.error(`${time()} [bridge] → #${m.id} ${m.name} threw: ${e?.message ?? e}`);
      this.send(ws, { type: 'result', id: m.id, ok: false, error: e?.message ?? String(e) });
    }
  }

  pause() {
    clearTimeout(this.timer);
    this.state = 'paused';
    this.account = undefined;
    this.ws?.close(1000, 'paused');
  }

  resume() {
    if (!this.opts.token || this.state === 'connected' || this.state === 'connecting') return;
    this.attempt = 0;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close(1000, 'stopped');
  }
}
