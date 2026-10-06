// Runs kept on this computer. When the server keeps an account's runs with the bridge, each run gets a
// folder here: its record (run.json), a screenshot and the page HTML after each step, the data it
// extracted and the requests the page made. The bridge saves these itself as it carries out each
// command, so they are not sent to the server to be stored; the server reads them back only when
// Claude or the widget asks for a run (the `store` command).
// The store itself (src/store.js) is generated from the server's file store, so the folder has the
// same layout as the server's. It holds no workflow logic: it saves and loads by run id.
import os from 'node:os';
import path from 'node:path';
import { LocalFsStore } from './store.js';

const READS = new Set(['listRuns', 'getRun', 'readAsset', 'getItems', 'getApiCalls', 'unfinishedRuns', 'usage']);
const WRITES = new Set(['saveRun', 'appendItems', 'deleteRun', 'deleteRunsOf', 'stopRun', 'endRun']);
/** Account ids and file names become path segments: letters, digits, dots, dashes and underscores only. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The data folder: the plugin's "Data folder" setting, or ~/.browser-workflow. */
export function dataDir(value) {
  const v = String(value ?? '').trim();
  if (!v) return path.join(os.homedir(), '.browser-workflow');
  return path.resolve(v.startsWith('~') ? path.join(os.homedir(), v.slice(1)) : v);
}

export function createStorage({ baseDir }) {
  let store;
  // One operation at a time, in the order they arrive: a run's saves must not overtake each other.
  let chain = Promise.resolve();
  const inOrder = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };
  const need = () => {
    if (!store) throw new Error('The bridge has no data folder yet: it is not connected to an account.');
    return store;
  };

  return {
    /** Picks the account's folder (the server says which account this is when it welcomes the bridge). */
    use(accountId) {
      if (!NAME.test(String(accountId)) || String(accountId).includes('..')) throw new Error(`Invalid account id "${accountId}"`);
      const dir = path.join(baseDir, 'accounts', String(accountId));
      if (store?.location !== dir) store = new LocalFsStore(dir);
      return dir;
    },

    location: () => store?.location,

    /** One operation asked by the server: a read (answered with data) or a write (answered when saved). */
    run(op, args = []) {
      const s = need();
      if (!READS.has(op) && !WRITES.has(op)) throw new Error(`Unknown store operation: ${op}`);
      return inOrder(async () => {
        switch (op) {
          case 'listRuns': return s.listRunsSlim(args[0] ?? undefined);
          case 'getRun': return (await s.getRun(args[0])) ?? null;
          case 'readAsset': return (await s.readAsset(args[0], String(args[1])))?.toString('base64') ?? null;
          case 'getItems': return s.getItems(args[0]);
          case 'getApiCalls': return s.getApiCalls(args[0], Array.isArray(args[1]) ? args[1] : []);
          case 'unfinishedRuns': return s.unfinishedRuns();
          case 'usage': return s.usage();
          case 'saveRun': await s.mergeRun(args[0], Array.isArray(args[1]) ? args[1] : [], args[2]); return null;
          case 'appendItems': return s.appendItems(args[0], args[1], args[2]);
          case 'deleteRun': await s.deleteRun(args[0]); return null;
          case 'deleteRunsOf': await s.deleteRunsOf(args[0]); return null;
          case 'stopRun': await s.stopRun(args[0]); return null;
          case 'endRun': await s.endRun(args[0], args[1] === 'failure' ? 'failure' : 'stopped', args[2], args[3]); return null;
          default: return null;
        }
      });
    },

    /**
     * Saves what a command captured in the run's folder, and replaces the content in `cap` with the
     * names of the files (`cap.saved`), so only the names go back to the server. `items` is a step's
     * extracted data, when it has any.
     */
    saveCapture(runId, save, cap, items) {
      const s = need();
      if (!NAME.test(String(save?.execId)) || typeof save.stepId !== 'string') throw new Error('Invalid save options');
      return inOrder(async () => {
        const saved = {};
        if (cap.screenshot) {
          saved.screenshot = `${save.execId}.jpg`;
          await s.writeAsset(runId, saved.screenshot, Buffer.from(cap.screenshot, 'base64'));
        }
        if (typeof cap.html === 'string') {
          saved.html = `${save.execId}.html`;
          await s.writeAsset(runId, saved.html, cap.html);
        }
        if (cap.apiCalls?.length) saved.apiCallIds = await s.saveApiCalls(runId, save.stepId, save.execId, cap.apiCalls);
        if (items !== undefined) saved.items = await s.appendItems(runId, save.stepId, items);
        delete cap.screenshot;
        delete cap.html;
        delete cap.apiCalls;
        cap.saved = saved;
        return cap;
      });
    },
  };
}
