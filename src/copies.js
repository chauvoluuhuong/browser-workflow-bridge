// Several copies of this app can run from one data folder: a chat app may start one for each chat, or
// a few short-lived ones while it works (the ChatGPT desktop app started 20 in seven minutes). They
// share one link and one name for the server, so if each of them registered, the newest would take
// the signals from the others and, on stopping, sign the whole account off.
// So one copy is in charge: it holds a local socket in the data folder, and it alone pairs,
// registers, listens for work and runs workflows. The others connect to that socket and stay passive:
// they ask the copy in charge for the status and pass "pause" and "resume" on to it, and it tells
// them the browser settings so their page_* tools use the same browser.
//   - The socket is the lock: the system frees it when its process ends, however it ended.
//   - When the copy in charge goes away, a passive one takes its place. One that has been running a
//     while goes first, so the copy a chat keeps open wins over one that lives a few seconds.
// Messages are JSON lines. From a passive copy: {id, t: 'status'}, {id, t: 'act', action},
// {t: 'was_in_charge'}. From the copy in charge: {t: 'hello', nonce, browser}, {t: 'browser', browser},
// {id, text} or {id, error}.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** Where the copies of one data folder meet: a socket in it, or a named pipe on Windows. */
export function meetingPoint(dir) {
  const id = createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 16);
  if (process.platform === 'win32') return `\\\\.\\pipe\\browser-workflow-${id}`;
  const inFolder = path.join(dir, 'app.sock');
  // A socket's path may be about 100 bytes long at most: a deeper folder gets one in the temp folder.
  return Buffer.byteLength(inFolder) < 100 ? inFolder : path.join(os.tmpdir(), `browser-workflow-${id}.sock`);
}

/** Calls `onLine` with each JSON line a socket receives; a line that is not JSON is dropped. */
function readLines(sock, onLine) {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { onLine(JSON.parse(line)); } catch { /* not ours */ }
    }
  });
}

const send = (sock, m) => { if (!sock.destroyed) sock.write(`${JSON.stringify(m)}\n`); };

export class Copies {
  /**
   * @param {{
   *   dir: string,
   *   onInCharge(): void,                       this copy is in charge now: pair or register
   *   onPassive(): void,                        another copy is: say nothing to the server
   *   status(): Promise<string>,                the status text, asked of the copy in charge
   *   act(action: string): Promise<void>,       "pause" or "resume", carried out by the copy in charge
   *   onBrowser?(browser: object): void,        a passive copy learns the browser settings
   *   onReturned?(): void,                      a copy that was briefly in charge too has stepped back
   *   log?(m: string): void,
   *   settleMs?: number,                        a copy younger than this lets older ones take over first
   *   checkMs?: number,                         how often the copy in charge checks it still holds the socket
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.point = meetingPoint(opts.dir);
    this.log = opts.log ?? (() => {});
    this.settleMs = opts.settleMs ?? 10_000;
    this.checkMs = opts.checkMs ?? 10_000;
    this.startedAt = Date.now();
    this.nonce = randomBytes(8).toString('hex');
    /** starting | in_charge | passive | stopped */
    this.state = 'starting';
    this.server = undefined;
    this.passives = new Set();
    this.inCharge = undefined;
    this.browser = undefined;
    this.waiting = new Map();
    this.seq = 0;
    this.timer = undefined;
    this.checker = undefined;
  }

  get leading() { return this.state === 'in_charge'; }

  start() { return this.settle(); }

  /** Takes charge when nobody is, else joins the copy that is. */
  async settle() {
    clearTimeout(this.timer);
    if (this.state === 'stopped') return;
    const how = await this.takeCharge();
    if (this.state === 'stopped') return;
    if (how) {
      this.state = 'in_charge';
      this.log(how === 'alone' ? 'in charge (no socket in the data folder: other copies can\'t be told)' : 'in charge of this data folder');
      this.opts.onInCharge();
      return;
    }
    if (await this.join()) return;
    if (this.state === 'stopped') return;
    // A socket nobody answers at: its copy was killed. Remove it and try again.
    if (process.platform !== 'win32') rmSync(this.point, { force: true });
    this.later(50 + Math.random() * 200);
  }

  later(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.settle(), ms);
    this.timer.unref?.();
  }

  /** 'socket' when this copy now holds the socket, 'alone' when the folder can hold none, else false. */
  takeCharge() {
    try { mkdirSync(path.dirname(this.point), { recursive: true }); } catch { /* the listen below says */ }
    return new Promise((resolve) => {
      const server = net.createServer((sock) => this.welcome(sock));
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE') return resolve(false);
        // A folder that can't hold a socket: carry on as the only copy, as before there were several.
        this.log(`no socket for other copies (${e.code ?? e.message})`);
        resolve('alone');
      });
      server.listen(this.point, () => {
        this.server = server;
        server.on('error', () => {});
        server.unref();
        clearInterval(this.checker);
        this.checker = setInterval(() => void this.checkStillHeld(), this.checkMs);
        this.checker.unref?.();
        setTimeout(() => void this.checkStillHeld(), 300).unref?.();
        resolve('socket');
      });
    });
  }

  /** A passive copy connected. */
  welcome(sock) {
    this.passives.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => this.passives.delete(sock));
    send(sock, { t: 'hello', nonce: this.nonce, browser: this.browser });
    readLines(sock, async (m) => {
      if (m.t === 'was_in_charge') return this.opts.onReturned?.();
      if (m.id === undefined) return;
      try {
        if (m.t === 'act') await this.opts.act(String(m.action));
        send(sock, { id: m.id, text: await this.opts.status() });
      } catch (e) {
        send(sock, { id: m.id, error: e?.message ?? String(e) });
      }
    });
  }

  /** Connects to the copy in charge. False when nobody answers. */
  join() {
    return new Promise((resolve) => {
      const sock = net.connect(this.point);
      let joined = false;
      sock.once('connect', () => {
        joined = true;
        sock.unref();
        this.inCharge = sock;
        const was = this.state;
        this.state = 'passive';
        if (was !== 'passive') this.log('another copy of this app is in charge; this one stays passive');
        this.opts.onPassive();
        resolve(true);
      });
      sock.on('error', () => { if (!joined) resolve(false); });
      sock.on('close', () => {
        if (!joined) return;
        if (this.inCharge === sock) this.inCharge = undefined;
        for (const w of this.waiting.values()) w.reject(new Error('The copy in charge went away.'));
        this.waiting.clear();
        if (this.state !== 'passive') return;
        // Its place is free. A copy that has run for a while takes it at once; a new one waits a little.
        const age = Date.now() - this.startedAt;
        this.later(Math.min(3000, Math.max(0, this.settleMs - age)) + Math.random() * 100);
      });
      readLines(sock, (m) => {
        if (m.t === 'hello' || m.t === 'browser') {
          if (m.browser) this.opts.onBrowser?.(m.browser);
          return;
        }
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id);
        if (m.error) w.reject(new Error(m.error));
        else w.resolve(m.text);
      });
    });
  }

  /**
   * Two copies that found the same dead socket can both replace it; the second one's file is the one
   * that stays. The first then holds a socket nobody can reach: it steps back and joins the other.
   */
  async checkStillHeld() {
    if (this.state !== 'in_charge' || !this.server) return;
    const nonce = await new Promise((resolve) => {
      const sock = net.connect(this.point);
      const done = (v) => { sock.destroy(); resolve(v); };
      sock.on('error', () => done('nobody'));
      readLines(sock, (m) => { if (m.t === 'hello') done(m.nonce); });
      // No answer in time says nothing: a busy moment is not a reason to step back.
      setTimeout(() => done(this.nonce), 2000).unref?.();
    });
    if (this.state !== 'in_charge' || nonce === this.nonce) return;
    this.log('another copy holds the socket now; stepping back');
    this.closeServer();
    this.state = 'starting';
    this.opts.onPassive();
    await this.settle();
    if (this.inCharge) send(this.inCharge, { t: 'was_in_charge' });
  }

  closeServer() {
    clearInterval(this.checker);
    for (const s of this.passives) s.destroy();
    this.passives.clear();
    this.server?.close();
    this.server = undefined;
  }

  /** The copy in charge tells the passive ones which browser to use. */
  setBrowser(browser) {
    this.browser = browser;
    for (const s of this.passives) send(s, { t: 'browser', browser });
  }

  ask(m, ms = 8000) {
    const sock = this.inCharge;
    if (!sock) return Promise.reject(new Error('No copy is in charge right now.'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting.delete(id); reject(new Error('The copy in charge did not answer.')); }, ms);
      t.unref?.();
      this.waiting.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      send(sock, { id, ...m });
    });
  }

  /** The status text of the copy in charge, for a passive copy. */
  status() { return this.ask({ t: 'status' }); }

  /** Has the copy in charge pause or resume, and returns its status text. */
  act(action) { return this.ask({ t: 'act', action }); }

  /** Leaves. Returns how many passive copies stay behind: one of them takes over. */
  stop() {
    const left = this.passives.size;
    this.state = 'stopped';
    clearTimeout(this.timer);
    this.closeServer();
    this.inCharge?.destroy();
    this.inCharge = undefined;
    return left;
  }
}
