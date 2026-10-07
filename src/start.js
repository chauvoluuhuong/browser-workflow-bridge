#!/usr/bin/env node
// What the plugin starts (.mcp.json). A plugin installed from GitHub arrives without node_modules, so
// before the bridge itself (index.js) this makes sure its dependencies are there:
//   - node_modules beside this folder (a clone someone ran `npm install` in): nothing to do.
//   - Otherwise they are installed once with `npm ci`, into the plugin's data folder
//     (CLAUDE_PLUGIN_DATA, which Claude Code keeps across plugin updates), and linked here.
// This file imports nothing but Node itself. If the install can't be done (no npm, no internet), it
// still answers Claude as a small MCP server whose bridge_status says what went wrong and what to do.
// stdout is the MCP channel: nothing here may print to it.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const say = (m) => process.stderr.write(`[bridge] ${m}\n`);
const read = (f) => JSON.parse(readFileSync(path.join(root, f), 'utf8'));

/** Every dependency of package.json has its folder here. */
export function installed(dir = root) {
  return Object.keys(read('package.json').dependencies ?? {}).every((d) => existsSync(path.join(dir, 'node_modules', d, 'package.json')));
}

/** Where this version's dependencies go: a folder named after the lock file, so a new version gets its own. */
export function depsDir(data = process.env.CLAUDE_PLUGIN_DATA) {
  const hash = createHash('sha256').update(readFileSync(path.join(root, 'package-lock.json'))).digest('hex').slice(0, 12);
  return path.join(data || path.join(root, '.deps'), 'deps', hash);
}

/**
 * Installs into a folder of its own, then renames it into place: the final folder exists only when
 * the install finished, whatever interrupted an earlier attempt. Runs as its own process (--install).
 */
function install(target) {
  if (existsSync(path.join(target, 'node_modules'))) return;
  const tmp = `${target}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) copyFileSync(path.join(root, f), path.join(tmp, f));
  // npm is a .cmd file on Windows, which only a shell can start.
  const r = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: tmp, shell: process.platform === 'win32', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    const why = r.error?.code === 'ENOENT' ? 'npm was not found (it comes with Node.js)' : (r.stderr || r.error?.message || `npm ended with ${r.status}`).trim().split('\n').slice(-3).join(' ');
    process.stderr.write(why);
    process.exitCode = 1;
    return;
  }
  try {
    renameSync(tmp, target);
  } catch {
    // Another session finished the same install first.
    rmSync(tmp, { recursive: true, force: true });
  }
  // Dependencies of versions before this one.
  for (const old of readdirSync(path.dirname(target))) {
    if (old !== path.basename(target) && !old.includes('.tmp-')) rmSync(path.join(path.dirname(target), old), { recursive: true, force: true });
  }
}

/** Makes node_modules here point at the installed ones (a junction on Windows: no admin rights needed). */
function link(target) {
  const here = path.join(root, 'node_modules');
  let old;
  try { old = lstatSync(here); } catch { /* not there */ }
  // A real folder is someone's own install with a part missing: theirs to repair, not to replace.
  if (old && !old.isSymbolicLink()) throw new Error(`${here} is incomplete; run "npm install" in ${root}`);
  if (old) unlinkSync(here);
  symlinkSync(path.join(target, 'node_modules'), here, 'junction');
}

/** Runs the install in a process of its own, so it finishes even if Claude Code gives up on this start. */
function installDetached(target) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--install', target], { detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve(e.message));
    child.on('exit', (code) => resolve(code === 0 ? undefined : err.trim() || `the install ended with ${code}`));
  });
}

/**
 * The bridge could not be started: answer Claude anyway, with one tool that says why. Newline-delimited
 * JSON-RPC on stdio, which is all an MCP client needs for `initialize`, `tools/list` and `tools/call`.
 */
function explain(problem) {
  const text = [
    `Browser Workflow bridge ${read('package.json').version}: not started.`,
    `It could not install its parts on this computer: ${problem}`,
    'Tell the user: the bridge needs Node.js 22 or newer (https://nodejs.org, the LTS installer) and an internet connection the first time it starts.',
    'After fixing that, start a new Claude Code session; the bridge tries again by itself.',
  ].join('\n');
  const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  const tool = { name: 'bridge_status', title: 'Bridge status', description: 'Shows why the Browser Workflow bridge could not start on this computer, and what the user can do.', inputSchema: { type: 'object', properties: {} } };
  let buffer = '';
  process.stdin.on('data', (d) => {
    buffer += d;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id === undefined) continue; // a notification
      if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'browser-workflow-bridge', version: read('package.json').version }, instructions: text } });
      else if (m.method === 'ping') send({ id: m.id, result: {} });
      else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [tool] } });
      else if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text }], isError: true } });
      else send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
    }
  });
  process.stdin.on('close', () => process.exit(0));
}

async function main() {
  if (process.argv[2] === '--install') return install(process.argv[3]);
  if (!installed()) {
    const target = depsDir();
    if (!existsSync(path.join(target, 'node_modules'))) {
      say('first start: installing the bridge\'s parts (about a minute)…');
      const problem = await installDetached(target);
      if (problem) {
        say(`could not install: ${problem}`);
        return explain(problem);
      }
    }
    try {
      link(target);
    } catch (e) {
      say(`could not link ${target}: ${e?.message ?? e}`);
      return explain(e?.message ?? String(e));
    }
  }
  await import('./index.js');
}

// Imported by the tests for its functions; started by Claude Code as a program.
const real = (f) => { try { return realpathSync(f); } catch { return path.resolve(f); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) await main();
