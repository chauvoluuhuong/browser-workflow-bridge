// The connection to the Browser Workflow server over HTTP (protocol 3). The bridge keeps no connection
// open to the server. Instead:
//   1. It registers once (POST /session) and gets an address to listen on for signals. With a hosted
//      server that address is Firebase Realtime Database; a signal is only a number that changed.
//   2. When a signal arrives, it asks the server what to do (GET /work): runs to start, to stop or to
//      resume, questions to answer (a file to read back, a browser check).
//   3. For a run, it is the loop: POST /runs/<id>/next with the last command's result, get the next
//      command in the answer, carry it out, repeat. The server decides every step; the bridge holds
//      no workflow logic. One request per browser step.
//   4. The run's record stays here. Each answer brings the record as it is now (`save`: its header and
//      the steps that changed), which the bridge writes to the run's folder, and a signed `state`,
//      which the bridge sends back unchanged with its next request. The server keeps neither.
// Every request carries the bridge token. The shapes are listed in the README.
import { randomBytes } from 'node:crypto';
import os from 'node:os';

export const PROTOCOL = 3;
/** The server accepts a request of at most 8 MB; a step's result stays well under it. */
export const MAX_RESULT = 6 * 1024 * 1024;
const API = '/api/bridge/v1';
const MAX_BACKOFF = 30_000;
/** Firebase sends a keep-alive every 30 s; a stream this quiet is dead. */
const STREAM_SILENT = 75_000;
/** How long a run keeps trying to reach the server before the bridge gives it up and closes its tab (BW_NEXT_GIVE_UP_MS in tests). */
const NEXT_GIVE_UP = Number(process.env.BW_NEXT_GIVE_UP_MS) > 0 ? Number(process.env.BW_NEXT_GIVE_UP_MS) : 2 * 60_000;
const DEBUG = !!process.env.BW_DEBUG;
const time = () => new Date().toISOString().slice(11, 23);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

// BW_DEBUG=1 logs each command and its answer (typed values only by length: they can be passwords).
function describe(name, args = []) {
  const [a0, a1] = args;
  if (name === 'open') return `${a0} mode=${a1?.mode}${a1?.startUrl ? ` ${a1.startUrl}` : ''}`;
  if (name === 'navigate') return `${a0} ${a1}`;
  if (name === 'act') return `${a0} ${a1?.command} ${a1?.xpath}${a1?.value ? ` value=(${String(a1.value).length} chars)` : ''}`;
  if (name === 'evaluate') return `${a0} ${String(a1).replace(/\s+/g, ' ').slice(0, 60)}`;
  if (name === 'check') return `mode=${a0}`;
  if (name === 'store') return `${a0} ${typeof a1 === 'string' ? a1 : a1?.runId ?? ''}`;
  return String(a0 ?? '');
}

function outcome(v) {
  if (v == null) return 'ok';
  // A file read back for the server (base64), or a count.
  if (typeof v !== 'object') return typeof v === 'string' ? `${v.length} chars` : String(v);
  if (Array.isArray(v)) return `${v.length} items`;
  if (typeof v.ok === 'boolean') return v.ok ? 'ok' : `error ${v.error?.type}: ${String(v.error?.raw ?? '').slice(0, 100)}`;
  if ('consoleErrors' in v) return [v.screenshot && 'screenshot', v.html && 'html', v.domExcerpt && 'excerpt'].filter(Boolean).join('+') || 'nothing';
  if ('runner' in v) return v.code;
  return 'ok';
}


export class RestConnection {
  /**
   * @param {{
   *   server: string, token: string, version: string, instance?: string,
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
    this.base = `${String(opts.server).replace(/\/+$/, '')}${API}`;
    this.log = opts.log ?? (() => {});
    this.maxBackoff = opts.maxBackoffMs > 0 ? opts.maxBackoffMs : MAX_BACKOFF;
    /** not_configured | connecting | connected | disconnected | paused | rejected */
    this.state = opts.token ? 'disconnected' : 'not_configured';
    this.attempt = 0;
    /**
     * Names this bridge to the server: registering again keeps the same session and its runs. The
     * caller passes one that stays the same for this computer's data folder; else it lasts the process.
     */
    this.instance = /^[0-9a-f]{32}$/.test(opts.instance ?? '') ? opts.instance : randomBytes(16).toString('hex');
    /** Records that could not be written to disk, kept while this process lives so the run can still be read. */
    this.unsaved = new Map();
    this.session = undefined;
    this.account = undefined;
    this.connectedAt = undefined;
    this.lastError = undefined;
    this.stopped = false;
    this.timer = undefined;
    this.stream = undefined;
    /** runId → { wake?: () => void } for the runs this bridge is driving */
    this.runs = new Map();
    /** Answers from the server being applied (a record being saved): reads asked meanwhile wait for them. */
    this.applying = new Set();
    this.checking = false;
    this.checkAgain = false;
  }

  start() {
    if (this.opts.token) void this.register();
  }

  async api(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.opts.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json;
    try { json = await res.json(); } catch { json = {}; }
    return { status: res.status, json };
  }

  retry() {
    if (this.stopped || this.state === 'paused') return;
    const delay = Math.min(this.maxBackoff, 1000 * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 10);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.register(), delay);
    this.timer.unref?.();
  }

  async register() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.state = 'connecting';
    let r;
    try {
      r = await this.api('POST', '/session', { protocol: PROTOCOL, bridgeVersion: this.opts.version, platform: `${os.platform()} ${os.arch()}`, instance: this.instance });
    } catch {
      this.lastError = `Could not reach ${this.opts.server}`;
      this.state = 'disconnected';
      return this.retry();
    }
    if (this.stopped || this.state === 'paused') return;
    if (r.status === 401 || r.status === 426) return this.refused(r.json.message ?? 'The server refused this bridge.');
    if (r.status !== 200 || !r.json.session) {
      this.lastError = r.json.message ?? `The server answered ${r.status}`;
      this.state = 'disconnected';
      return this.retry();
    }
    this.session = r.json.session;
    this.state = 'connected';
    this.account = r.json.account;
    this.connectedAt = new Date().toISOString();
    this.lastError = undefined;
    this.attempt = 0;
    this.log(`registered with ${this.opts.server} as ${r.json.account}`);
    this.opts.onWelcome?.(r.json);
    if (r.json.browser) this.opts.onConfig?.(r.json.browser);
    this.listen(r.json.signalUrl);
  }

  /** A wrong token, an old bridge or another bridge that took over won't fix itself. */
  refused(message) {
    this.state = 'rejected';
    this.lastError = message;
    this.session = undefined;
    this.stream?.abort();
    this.log(`the server refused this bridge: ${message}`);
    this.opts.onDisconnect?.();
    this.wakeAll();
  }

  /** Runs waiting in a delay or for the user stop waiting: they have nobody to report to. */
  wakeAll() {
    for (const run of this.runs.values()) run.wake?.();
  }

  /** Listens for signals: each one means "ask the server for work". Reconnects by itself until told to stop. */
  listen(url) {
    this.stream?.abort();
    const mine = { over: false, ac: undefined, abort() { this.over = true; this.ac?.abort(); } };
    this.stream = mine;
    void (async () => {
      let attempt = 0;
      while (!mine.over && !this.stopped) {
        const ac = new AbortController();
        mine.ac = ac;
        let lastEvent = Date.now();
        // A stream that says nothing for this long is dead, whatever the socket claims.
        const watchdog = setInterval(() => { if (Date.now() - lastEvent > STREAM_SILENT) ac.abort(); }, 15_000);
        watchdog.unref?.();
        try {
          const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: ac.signal });
          if (!res.ok) throw new Error(`the signal stream answered ${res.status}`);
          attempt = 0;
          const dec = new TextDecoder();
          let buf = '';
          for await (const chunk of res.body) {
            lastEvent = Date.now();
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const event = /^event: *(.*)$/m.exec(buf.slice(0, i))?.[1];
              buf = buf.slice(i + 2);
              // The first `put` is the value as it is now, so it also covers signals sent while away.
              if (event === 'put' || event === 'patch') void this.checkWork();
              else if (event === 'cancel' || event === 'auth_revoked') throw new Error('the signal stream was closed by its server');
            }
          }
          throw new Error('the signal stream ended');
        } catch (e) {
          if (!mine.over && DEBUG) console.error(`${time()} [bridge] ${e?.message ?? e}; listening again`);
        } finally {
          clearInterval(watchdog);
        }
        if (mine.over || this.stopped) break;
        await sleep(Math.min(this.maxBackoff, 500 * 2 ** attempt));
        attempt = Math.min(attempt + 1, 8);
      }
    })();
  }

  /** Asks the server what to do. Calls made while one is in progress are folded into one more. */
  async checkWork() {
    if (this.checking) { this.checkAgain = true; return; }
    this.checking = true;
    try {
      do {
        this.checkAgain = false;
        if (this.state !== 'connected' || !this.session) break;
        let r;
        try {
          r = await this.api('GET', `/work?session=${encodeURIComponent(this.session)}`);
          this.workAttempt = 0;
        } catch {
          // Unreachable right now. A signal only says "ask", so the question must not be lost: ask again soon.
          const delay = Math.min(this.maxBackoff, 500 * 2 ** Math.min(this.workAttempt ?? 0, 6));
          this.workAttempt = (this.workAttempt ?? 0) + 1;
          setTimeout(() => void this.checkWork(), delay).unref?.();
          break;
        }
        if (r.status === 401) { this.refused(r.json.message ?? 'The bridge token is no longer valid.'); break; }
        if (r.status === 409) {
          // Signed out by the server (it thought this bridge was gone): register again, as the same
          // bridge, and go on with the runs in progress.
          // Replaced by another bridge: stay out of its way.
          this.stream?.abort();
          if (r.json.code === 'signed_out') { this.state = 'disconnected'; void this.register(); } else { this.session = undefined; this.refused(r.json.message ?? 'Another bridge took over.'); }
          break;
        }
        if (r.status !== 200) break;
        const w = r.json;
        if (w.browser) this.opts.onConfig?.(w.browser);
        for (const id of w.stop ?? []) {
          // Closing the tab makes a command in progress return now; a delay or a manual wait is woken.
          void this.opts.execute('close', [id]).catch(() => {});
          this.runs.get(id)?.wake?.();
        }
        for (const id of w.resume ?? []) this.runs.get(id)?.wake?.();
        for (const id of w.start ?? []) if (!this.runs.has(id)) void this.drive(id);
        for (const s of w.settle ?? []) void this.settle(s);
        for (const a of w.asks ?? []) void this.answer(a);
      } while (this.checkAgain);
    } finally {
      this.checking = false;
    }
  }

  /** A run the server ended without this bridge (it was away, or didn't obey a stop): note it on the record here. */
  async settle(s) {
    if (this.runs.has(s.runId)) return; // still closing here: the next /work brings it again
    try {
      if (s.record) {
        const { executions = [], ...header } = s.record;
        await this.opts.execute('store', ['saveRun', header, executions]);
      } else {
        await this.opts.execute('store', ['endRun', s.runId, s.status, s.endedAt, s.error]);
      }
      await this.api('POST', `/runs/${encodeURIComponent(s.runId)}/settled`, { session: this.session });
    } catch (e) {
      this.log(`could not note how run ${s.runId} ended: ${e?.message ?? e}`);
    }
  }

  async answer(a) {
    // A record the server just sent may still be on its way to disk: read after it.
    if (a.name === 'store' && this.applying.size) await Promise.allSettled([...this.applying]);
    // A run this computer could not save is answered from memory.
    if (a.name === 'store' && a.args?.[0] === 'getRun' && this.unsaved.has(a.args[1])) {
      await this.api('POST', `/answers/${encodeURIComponent(a.id)}`, { session: this.session, ok: true, value: this.unsaved.get(a.args[1]) }).catch(() => {});
      return;
    }
    const t0 = Date.now();
    if (DEBUG) console.error(`${time()} [bridge] ? ${a.name} ${describe(a.name, a.args)}`);
    let body;
    try {
      const value = await this.opts.execute(a.name, a.args);
      body = { session: this.session, ok: true, value: value ?? null };
      if (DEBUG) console.error(`${time()} [bridge] → ${a.name} ${outcome(value)} ${Date.now() - t0}ms`);
    } catch (e) {
      body = { session: this.session, ok: false, error: e?.message ?? String(e) };
    }
    await this.api('POST', `/answers/${encodeURIComponent(a.id)}`, body).catch(() => {});
  }

  /** One run, from the first command to the last: ask for the next command, carry it out, repeat. */
  async drive(runId) {
    const run = {};
    this.runs.set(runId, run);
    let seq = 0;
    let result;
    let state;
    try {
      for (;;) {
        const asked = this.next(runId, seq, result, state).then(async (out) => {
          // The record as it is now: saved here, on this computer, before anything else happens.
          if (out?.save) {
            await this.opts.execute('store', ['saveRun', out.save.header, out.save.executions ?? [], out.save.keepRuns]).catch((e) => {
              this.log(`could not save run ${runId}: ${e?.message ?? e}`);
              // Kept in memory instead, so the run can still be shown while this bridge is running.
              const old = this.unsaved.get(runId)?.executions ?? [];
              for (const x of out.save.executions ?? []) {
                const i = old.findIndex((y) => y.id === x.id);
                if (i >= 0) old[i] = x; else old.push(x);
              }
              this.unsaved.set(runId, { ...out.save.header, executions: old });
              for (const id of [...this.unsaved.keys()].slice(0, Math.max(0, this.unsaved.size - 20))) this.unsaved.delete(id);
            });
          }
          return out;
        });
        this.applying.add(asked);
        const out = await asked.finally(() => this.applying.delete(asked));
        if (!out || out.done) break;
        seq = out.seq;
        state = out.state;
        if (out.wait) {
          // A manual step: the user acts in the browser. Wakes on Resume, Stop, or when the time is up.
          await this.pause_(run, Math.max(0, out.wait.untilMs - Date.now()));
          result = undefined;
        } else {
          result = await this.carryOut(run, out.command);
        }
      }
    } finally {
      this.runs.delete(runId);
      await this.opts.execute('close', [runId]).catch(() => {});
      // The server may have ended the run without this bridge, and left a note about it.
      void this.checkWork();
    }
  }

  /** Sends a result and gets the next command. Retries while the server can't be reached; a repeated call is safe. */
  async next(runId, seq, result, state) {
    const started = Date.now();
    let body = JSON.stringify({ session: this.session, seq, result: result ?? null, state });
    if (Buffer.byteLength(body) > MAX_RESULT) {
      body = JSON.stringify({ session: this.session, seq, state, result: { ok: false, error: { type: 'unknown_error', raw: `The step returned more than ${MAX_RESULT / 1024 / 1024} MB of data. Return less, or split it across steps.` } } });
    }
    for (let attempt = 0; ; attempt += 1) {
      if (this.stopped || !this.session) return undefined;
      try {
        const res = await fetch(`${this.base}/runs/${encodeURIComponent(runId)}/next`, {
          method: 'POST', headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' }, body,
        });
        if (res.status === 200) return await res.json();
        if (res.status === 401 || res.status === 409) {
          const j = await res.json().catch(() => ({}));
          if (j.code === 'signed_out') {
            // The server gave this bridge up for a moment: register again (the same session), then go on.
            await this.register();
            continue;
          }
          this.log(`run ${runId} was taken from this bridge: ${j.message ?? res.status}`);
          return undefined;
        }
      } catch { /* unreachable: try again */ }
      if (Date.now() - started > NEXT_GIVE_UP) {
        this.log(`run ${runId}: the server could not be reached for ${Math.round(NEXT_GIVE_UP / 1000)} s; closing its tab`);
        return undefined;
      }
      await sleep(Math.min(this.maxBackoff, 500 * 2 ** Math.min(attempt, 6)));
    }
  }

  async carryOut(run, c) {
    const t0 = Date.now();
    if (DEBUG) console.error(`${time()} [bridge] ← ${c.name} ${describe(c.name, c.args)}`);
    if (c.name === 'sleep') {
      await this.pause_(run, Number(c.args?.[0]) || 0);
      return null;
    }
    try {
      const value = await this.opts.execute(c.name, c.args);
      if (DEBUG) console.error(`${time()} [bridge] → ${c.name} ${outcome(value)} ${Date.now() - t0}ms`);
      return value ?? null;
    } catch (e) {
      if (DEBUG) console.error(`${time()} [bridge] → ${c.name} threw: ${e?.message ?? e}`);
      // capture and takeApiCalls answer with data, not a result: nothing is the honest answer.
      if (c.name === 'capture' || c.name === 'takeApiCalls' || c.name === 'close') return null;
      return { ok: false, error: { type: 'unknown_error', raw: e?.message ?? String(e) } };
    }
  }

  /** Waits `ms`, or until the run is woken (stopped or resumed). */
  pause_(run, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); run.wake = undefined; resolve(); }
      run.wake = done;
    });
  }

  /** Tells the server this bridge is going away, so it knows at once. Waits 2 s for it at most. */
  async signOff() {
    const s = this.session;
    this.session = undefined;
    this.stream?.abort();
    if (!s) return;
    await fetch(`${this.base}/session?session=${encodeURIComponent(s)}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${this.opts.token}` }, signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  }

  pause() {
    clearTimeout(this.timer);
    this.state = 'paused';
    this.account = undefined;
    void this.signOff();
    this.opts.onDisconnect?.();
    this.wakeAll();
  }

  resume() {
    if (!this.opts.token || this.state === 'connected' || this.state === 'connecting') return;
    this.attempt = 0;
    void this.register();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.signOff();
  }
}
