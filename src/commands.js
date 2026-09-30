// Checks each command from the server before the driver runs it. The server decides what a workflow
// does; these rules limit what it can make this browser do, even if the server were compromised:
//   - it only acts on tabs this bridge opened for a run, never the user's other tabs or windows;
//   - it only opens http and https pages, and only the allowed sites when the user set any;
//   - a run's tab closes after MAX_RUN_MS, and at most MAX_OPEN runs are open at once;
//   - page HTML sent back is capped at MAX_HTML.

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

/**
 * Returns execute(name, args), which runs one command on `driver` (a LocalDriver), plus helpers to
 * close every tab this bridge opened.
 */
export function createExecutor(driver, { allowedSites = [], log = () => {} } = {}) {
  /** runId → when its tab was opened */
  const opened = new Map();

  async function closeRun(runId) {
    opened.delete(runId);
    await driver.close(runId).catch(() => {});
  }

  /** Returns a refusal when `runId` has no tab from this bridge or ran too long. */
  async function checkRun(runId) {
    const at = opened.get(runId);
    if (at === undefined) return refused('unknown_error', `Run ${runId} has no tab opened by this bridge.`);
    if (Date.now() - at > MAX_RUN_MS) {
      await closeRun(runId);
      log(`closed run ${runId}: it passed the ${MAX_RUN_MS / 60000}-minute limit`);
      return refused('browser_unavailable', `The run passed the bridge's ${MAX_RUN_MS / 60000}-minute limit, so its tab was closed.`);
    }
    return undefined;
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
        opened.set(runId, Date.now());
        return driver.open(runId, o);
      }
      case 'navigate': {
        const [runId, url, timeoutMs] = a;
        const no = await checkRun(runId);
        if (no) return no;
        const why = refuseUrl(url, allowedSites);
        if (why) return refused('navigation_error', why, url);
        return driver.navigate(runId, url, timeoutMs);
      }
      case 'act':
      case 'evaluate': {
        const no = await checkRun(a[0]);
        if (no) return no;
        return driver[name](...a);
      }
      case 'capture': {
        if (!opened.has(a[0])) return { consoleErrors: [] };
        const cap = await driver.capture(a[0], a[1] ?? {});
        if (typeof cap.html === 'string' && cap.html.length > MAX_HTML) cap.html = `${cap.html.slice(0, MAX_HTML)}<!-- truncated by the bridge -->`;
        return cap;
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
    /** Closes runs past the time limit; call every minute. */
    async sweep() {
      for (const [runId, at] of opened) if (Date.now() - at > MAX_RUN_MS) await closeRun(runId);
    },
    async closeAll() {
      await Promise.all([...opened.keys()].map(closeRun));
    },
  };
}
