// Checks each command from the server before the driver runs it. The server decides what a workflow
// does; these rules limit what it can make this browser do, even if the server were compromised:
//   - it only acts on tabs this bridge opened for a run, never the user's other tabs or windows;
//   - it only opens http and https pages, and only the allowed sites when the user set any;
//   - a run's tab closes after its time limit (the server's, at most MAX_RUN_MS), and at most
//     MAX_OPEN runs are open at once (`maxRunMs` shortens the limit in tests);
//   - page HTML sent back is capped at MAX_HTML bytes;
//   - when the server asks to keep a run on this computer (`save`), what a command captured is saved
//     in the run's folder and only file names go back (src/storage.js).

export const MAX_RUN_MS = 60 * 60 * 1000;
export const MAX_OPEN = 3;
export const MAX_HTML = 2 * 1024 * 1024;

/** "example.com, shop.example.org" → ['example.com', 'shop.example.org']; "*" or empty → [] (any site). */
export function parseSites(value) {
  const sites = String(value ?? '').split(/[\s,]+/).map((s) => s.trim().toLowerCase().replace(/^\*\./, '')).filter(Boolean);
  return sites.includes('*') ? [] : sites;
}

/** Returns why `url` may not be opened, or undefined when it may. */
export function refuseUrl(url, sites) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return `Not a valid URL: ${url}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `The bridge only opens http and https pages, not ${u.protocol}`;
  const host = u.hostname.toLowerCase();
  if (sites.length && !sites.some((s) => host === s || host.endsWith(`.${s}`))) {
    return `${host} is not in the bridge's allowed sites (${sites.join(', ')}).`;
  }
  return undefined;
}

const refused = (type, raw, target) => ({ ok: false, error: { type, raw, ...(target ? { target } : {}) } });

/** Cuts a capture's HTML to MAX_HTML bytes (the captures of `capture` and of a command's `after`). */
function capHtml(cap) {
  if (cap && typeof cap.html === 'string' && Buffer.byteLength(cap.html) > MAX_HTML) {
    cap.html = `${Buffer.from(cap.html).subarray(0, MAX_HTML).toString().replace(/\uFFFD$/, '')}<!-- truncated by the bridge -->`;
  }
  return cap;
}

/**
 * Returns execute(name, args), which runs one command on `driver` (a LocalDriver), plus helpers to
 * close every tab this bridge opened.
 */
export function createExecutor(driver, { allowedSites = [], log = () => {}, storage, maxRunMs = MAX_RUN_MS } = {}) {
  /** The longest any run's tab stays open here, whatever the server asks for. */
  const cap = Number.isFinite(maxRunMs) && maxRunMs > 0 ? Math.min(maxRunMs, MAX_RUN_MS) : MAX_RUN_MS;
  /** runId → when its tab was opened, and how long it may stay open */
  const opened = new Map();
  const expired = (run) => Date.now() - run.at > run.maxMs;

  async function closeRun(runId) {
    opened.delete(runId);
    await driver.close(runId).catch(() => {});
  }

  /** Returns a refusal when `runId` has no tab from this bridge or ran too long. */
  async function checkRun(runId) {
    const run = opened.get(runId);
    if (!run) return refused('unknown_error', `Run ${runId} has no tab opened by this bridge.`);
    if (expired(run)) {
      const minutes = Math.round(run.maxMs / 6000) / 10;
      await closeRun(runId);
      log(`closed run ${runId}: it passed its ${minutes}-minute limit`);
      return refused('browser_unavailable', `The run passed its ${minutes}-minute limit, so the bridge closed its tab.`);
    }
    return undefined;
  }

  /**
   * Finishes an action's result: caps the HTML, and with `save` keeps what was captured in the run's
   * folder. If saving fails, the step fails and the captured content is dropped, never sent.
   */
  async function finish(runId, after, r) {
    if (!r?.after) return r;
    capHtml(r.after);
    if (!after?.save) return r;
    try {
      if (!storage) throw new Error('this bridge has no data folder');
      await storage.saveCapture(runId, after.save, r.after, after.save.items && r.ok ? r.output ?? null : undefined);
      return r;
    } catch (e) {
      log(`could not save run ${runId}: ${e?.message ?? e}`);
      return refused('unknown_error', `Couldn't save on your computer: ${e?.message ?? e}`, 'local_save');
    }
  }

  async function execute(name, args) {
    const a = Array.isArray(args) ? args : [];
    switch (name) {
      case 'open': {
        const [runId, o = {}] = a;
        if (o.mode === 'remote') return refused('browser_unavailable', 'The cloud browser runs on the server, not in the bridge.');
        if (opened.size >= MAX_OPEN && !opened.has(runId)) return refused('browser_unavailable', `The bridge already has ${MAX_OPEN} runs open.`);
        if (o.startUrl) {
          const why = refuseUrl(o.startUrl, allowedSites);
          if (why) return refused('navigation_error', why, o.startUrl);
        }
        // The server sends the run's time limit; the bridge never keeps a tab longer than its own.
        const maxMs = Number.isFinite(o.maxRunMs) && o.maxRunMs > 0 ? Math.min(o.maxRunMs, cap) : cap;
        opened.set(runId, { at: Date.now(), maxMs });
        return driver.open(runId, o);
      }
      case 'navigate': {
        const [runId, url, timeoutMs, after] = a;
        const no = await checkRun(runId);
        if (no) return no;
        const why = refuseUrl(url, allowedSites);
        if (why) return refused('navigation_error', why, url);
        return finish(runId, after, await driver.navigate(runId, url, timeoutMs, after));
      }
      case 'act':
      case 'evaluate': {
        const no = await checkRun(a[0]);
        if (no) return no;
        // `after`: the page state to return with the result (act's 3rd argument, evaluate's 4th).
        return finish(a[0], name === 'act' ? a[2] : a[3], await driver[name](...a));
      }
      case 'capture': {
        if (!opened.has(a[0])) return { consoleErrors: [] };
        const o = a[1] ?? {};
        const cap = capHtml(await driver.capture(a[0], o));
        if (o.save) {
          if (!storage) throw new Error('this bridge has no data folder');
          await storage.saveCapture(a[0], o.save, cap);
        }
        return cap;
      }
      case 'store': {
        if (!storage) throw new Error('this bridge has no data folder');
        return storage.run(a[0], a.slice(1));
      }
      case 'takeApiCalls':
        return opened.has(a[0]) ? driver.takeApiCalls(a[0]) : [];
      case 'close':
        await closeRun(a[0]);
        return null;
      case 'check':
        return driver.check(a[0], a[1]);
      default:
        throw new Error(`Unknown command: ${name}`);
    }
  }

  return {
    execute,
    openRuns: () => opened.size,
    maxRunMs: cap,
    /** Closes runs past the time limit; call every minute. */
    async sweep() {
      for (const [runId, run] of opened) if (expired(run)) await closeRun(runId);
    },
    async closeAll() {
      await Promise.all([...opened.keys()].map(closeRun));
    },
  };
}
