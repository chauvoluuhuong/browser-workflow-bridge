// The file store for runs kept on this computer: one folder per run with its record, screenshots,
// page HTML (gzipped), extracted data and request log. Generated from the Browser Workflow server's
// file store (src/core/fsStore.ts) by its `npm run sync:bridge`, so the folder has the same layout
// as the server's. The bridge uses its run methods only (src/storage.js).
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCb, gzip as gzipCb } from 'node:zlib';
const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);
let apiSeq = 0;
/** Same id format as the crawler's apicalls. */
export const newApiCallId = () => `api_${Date.now()}_${(apiSeq++ % 46656).toString(36).padStart(3, '0')}${Math.random().toString(36).slice(2, 8)}`;
export const DEFAULT_CONFIG = {
  browser: { mode: 'attach', headed: true },
  lang: 'auto',
  setupDone: false,
  keepRuns: 20,
};
export function defaultHome() {
  return process.env.BW_HOME ?? path.join(os.homedir(), '.browser-workflow');
}
const safe = (id) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) || id.includes('..'))
    throw new Error(`Invalid id "${id}"`);
  return id;
};
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }
  catch (e) {
    if (e?.code === 'ENOENT')
      return undefined;
    throw e;
  }
}
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file); // atomic replace
}
/** A run without what makes it heavy (inputs, outputs, variables): enough for lists and summaries. */
const slim = (r) => ({
  ...r,
  runtime: {},
  executions: r.executions.map((e) => ({ id: e.id, stepId: e.stepId, state: e.state, startedAt: e.startedAt, durationMs: e.durationMs })),
});
const unfinished = (r) => r.status === 'running' || r.status === 'waiting_manual';
/**
* ~/.browser-workflow/
*   config.json
*   workflows/<id>/meta.json, v1.json, v2.json …
*   runs/<runId>/run.json, items.json, apicalls.json, <execId>.jpg, <execId>.html.gz
*/
export class LocalFsStore {
  location;
  constructor(location) {
    this.location = location ?? defaultHome();
  }
  info() {
    return { kind: 'folder', path: this.location };
  }
  wfDir(id) { return path.join(this.location, 'workflows', safe(id)); }
  runDir(runId) { return path.join(this.location, 'runs', safe(runId)); }
  async listWorkflows() {
    const dir = path.join(this.location, 'workflows');
    const names = await fs.readdir(dir).catch(() => []);
    const metas = await Promise.all(names.map((n) => readJson(path.join(dir, n, 'meta.json'))));
    return metas.filter((m) => !!m);
  }
  getMeta(id) {
    return readJson(path.join(this.wfDir(id), 'meta.json'));
  }
  async getWorkflow(id, version) {
    const meta = await this.getMeta(id);
    if (!meta)
      return undefined;
    return readJson(path.join(this.wfDir(id), `v${version ?? meta.currentVersion}.json`));
  }
  async saveWorkflow(wf, author, event) {
    const meta = (await this.getMeta(wf.id)) ?? { id: wf.id, currentVersion: 0, versions: [] };
    const version = Math.max(0, ...meta.versions.map((v) => v.version)) + 1;
    await writeJson(path.join(this.wfDir(wf.id), `v${version}.json`), wf);
    meta.versions.push({ version, at: new Date().toISOString(), author, event });
    meta.currentVersion = version;
    await writeJson(path.join(this.wfDir(wf.id), 'meta.json'), meta);
    return version;
  }
  async deleteWorkflow(id) {
    for (const r of await this.listRuns(id))
      await fs.rm(this.runDir(r.runId), { recursive: true, force: true });
    await fs.rm(this.wfDir(id), { recursive: true, force: true });
  }
  async listRuns(workflowId) {
    const dir = path.join(this.location, 'runs');
    const names = await fs.readdir(dir).catch(() => []);
    const runs = await Promise.all(names.map((n) => readJson(path.join(dir, n, 'run.json')).catch(() => undefined)));
    return runs
      .filter((r) => !!r && (!workflowId || r.workflowId === workflowId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  getRun(runId) {
    return readJson(path.join(this.runDir(runId), 'run.json'));
  }
  async saveRun(run) {
    const isNew = !(await this.getRun(run.runId));
    await writeJson(path.join(this.runDir(run.runId), 'run.json'), run);
    if (isNew)
      await this.prune(run.workflowId);
  }
  /**
  * Saves a run from what changed: its header (everything but the executions) and the executions that
  * are new or different. The server sends runs to the bridge this way, so a long run doesn't travel
  * whole after every step.
  */
  async mergeRun(header, executions, keepRuns) {
    const old = await this.getRun(header.runId);
    const all = old?.executions ?? [];
    for (const e of executions) {
      const i = all.findIndex((x) => x.id === e.id);
      if (i >= 0)
        all[i] = e;
      else
        all.push(e);
    }
    await writeJson(path.join(this.runDir(header.runId), 'run.json'), { ...header, executions: all });
    if (!old)
      await this.prune(header.workflowId, keepRuns);
  }
  /** Runs without their inputs, outputs and variables: for lists. */
  async listRunsSlim(workflowId) {
    return (await this.listRuns(workflowId)).map(slim);
  }
  /** Ids of runs still marked running: after a crash or a lost connection nobody finished them. */
  async unfinishedRuns() {
    return (await this.listRuns()).filter(unfinished).map((r) => r.runId);
  }
  /** Marks a run nobody will finish as stopped. */
  async stopRun(runId) {
    const r = await this.getRun(runId);
    if (!r || !unfinished(r))
      return;
    r.status = 'stopped';
    r.endedAt ??= new Date().toISOString();
    r.manual = undefined;
    for (const e of r.executions)
      if (e.state === 'running' || e.state === 'waiting')
        e.state = 'stopped';
    await writeJson(path.join(this.runDir(runId), 'run.json'), r);
  }
  /**
  * Ends a run the way the server ended it without this side (the bridge was away, or didn't obey a
  * stop): its status, and for a failure the reason, on the step it was on.
  */
  async endRun(runId, status, endedAt, error) {
    const r = await this.getRun(runId);
    if (!r || !unfinished(r))
      return;
    r.status = status;
    r.endedAt ??= endedAt ?? new Date().toISOString();
    r.manual = undefined;
    const open = r.executions.filter((e) => e.state === 'running' || e.state === 'waiting');
    for (const e of open)
      e.state = status === 'stopped' ? 'stopped' : 'failed';
    const last = open[open.length - 1];
    if (status === 'failure' && last) {
      last.error = error ?? { type: 'unknown_error', raw: 'The run was ended.' };
      r.failure = { executionId: last.id, consoleErrors: [] };
    }
    await writeJson(path.join(this.runDir(runId), 'run.json'), r);
  }
  async deleteRunsOf(workflowId) {
    for (const r of await this.listRuns(workflowId))
      await fs.rm(this.runDir(r.runId), { recursive: true, force: true });
  }
  /** How much the runs folder holds, for the "your disk is filling up" warning. */
  async usage() {
    const dir = path.join(this.location, 'runs');
    const names = await fs.readdir(dir).catch(() => []);
    let bytes = 0;
    for (const n of names) {
      for (const f of await fs.readdir(path.join(dir, n)).catch(() => [])) {
        bytes += (await fs.stat(path.join(dir, n, f)).catch(() => undefined))?.size ?? 0;
      }
    }
    return { bytes, runs: names.length };
  }
  /** Deletes the oldest finished runs beyond config.keepRuns for this workflow. */
  async prune(workflowId, keep) {
    const keepRuns = keep && keep > 0 ? keep : (await this.getConfig()).keepRuns;
    const runs = await this.listRuns(workflowId);
    for (const r of runs.slice(keepRuns)) {
      if (r.status !== 'running' && r.status !== 'waiting_manual')
        await fs.rm(this.runDir(r.runId), { recursive: true, force: true });
    }
  }
  /** Page HTML is stored gzipped (`<name>.gz`): it is most of a run's size and compresses well. */
  async writeAsset(runId, name, data) {
    const dir = this.runDir(runId);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, path.basename(name));
    if (file.endsWith('.html'))
      await fs.writeFile(`${file}.gz`, await gzip(data));
    else
      await fs.writeFile(file, data);
  }
  async readAsset(runId, name) {
    const file = path.join(this.runDir(runId), path.basename(name));
    const plain = await fs.readFile(file).catch(() => undefined);
    if (plain)
      return plain;
    const packed = await fs.readFile(`${file}.gz`).catch(() => undefined);
    return packed && gunzip(packed);
  }
  /** Removes a run's folder (screenshots, HTML, items). */
  async deleteRunFiles(runId) {
    await fs.rm(this.runDir(runId), { recursive: true, force: true });
  }
  deleteRun(runId) {
    return this.deleteRunFiles(runId);
  }
  async appendItems(runId, stepId, items) {
    const file = path.join(this.runDir(runId), 'items.json');
    const all = (await readJson(file)) ?? [];
    all.push({ stepId, data: items });
    await writeJson(file, all);
    return Array.isArray(items) ? items.length : items == null ? 0 : 1;
  }
  async getItems(runId) {
    const all = (await readJson(path.join(this.runDir(runId), 'items.json'))) ?? [];
    return all.flatMap((e) => (Array.isArray(e.data) ? e.data : e.data == null ? [] : [e.data]));
  }
  async saveApiCalls(runId, stepId, executionId, calls) {
    if (!calls.length)
      return [];
    const file = path.join(this.runDir(runId), 'apicalls.json');
    const all = (await readJson(file)) ?? [];
    const saved = calls.map((c) => ({ id: newApiCallId(), stepId, executionId, ...c }));
    all.push(...saved);
    await writeJson(file, all);
    return saved.map((c) => c.id);
  }
  async getApiCalls(runId, ids) {
    if (!ids.length)
      return [];
    const all = (await readJson(path.join(this.runDir(runId), 'apicalls.json'))) ?? [];
    const byId = new Map(all.map(({ stepId: _s, executionId: _e, ...c }) => [c.id, c]));
    return ids.map((id) => byId.get(id)).filter((c) => !!c);
  }
  async getConfig() {
    const c = await readJson(path.join(this.location, 'config.json'));
    return { ...DEFAULT_CONFIG, ...c, browser: { ...DEFAULT_CONFIG.browser, ...c?.browser } };
  }
  async saveConfig(patch) {
    const next = { ...(await this.getConfig()), ...patch };
    await writeJson(path.join(this.location, 'config.json'), next);
    return next;
  }
}
