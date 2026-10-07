#!/usr/bin/env node
// For working on the bridge: installs the plugin in Claude Code from this folder, pointed at a server
// on this computer instead of the hosted one. Users don't need this; the README's "Install" is theirs.
//   npm run install:dev                 install or refresh, Server = http://127.0.0.1:3310, no token
//   npm run install:dev -- --dry-run    show what would run, change nothing
//   npm run install:dev -- --remove     take the plugin and this folder's marketplace out again
// With no token the bridge starts unlinked, which is how a new user's first session looks: ask
// Claude to "check the bridge status" to see what it tells them to do. Whether the server is running
// or not is yours to choose; the bridge says so either way.
// Env: BW_BRIDGE_URL (another address), BW_BRIDGE_TOKEN (install already linked to an account),
// BW_BRIDGE_ALLOWED_SITES (default *). Claude Code keeps the token in the system's credential store;
// this script never prints it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const remove = args.has('--remove');
const server = process.env.BW_BRIDGE_URL || 'http://127.0.0.1:3310';
const token = process.env.BW_BRIDGE_TOKEN || '';
const allowedSites = process.env.BW_BRIDGE_ALLOWED_SITES || '*';

const json = (f) => JSON.parse(readFileSync(path.join(root, '.claude-plugin', f), 'utf8'));
const pluginId = `${json('plugin.json').name}@${json('marketplace.json').name}`;
const marketName = json('marketplace.json').name;
// Windows starts `claude` and `npm` through a shell (they are .cmd files there).
const shell = process.platform === 'win32';

/** Runs a command; prints its output and exits on failure. `shown` replaces the arguments in messages (hides the token). */
function run(cmd, a, shown = a) {
  const line = `${cmd} ${shown.join(' ')}`;
  if (dryRun) { console.log(`  would run: ${line}`); return ''; }
  try {
    return execFileSync(cmd, a, { cwd: root, stdio: 'pipe', encoding: 'utf8', shell });
  } catch (e) {
    console.error(`✗ ${line}\n${[e.stdout, e.stderr].filter(Boolean).join('\n').trim()}`);
    process.exit(1);
  }
}
const claudeJson = (...a) => JSON.parse(execFileSync('claude', a, { stdio: 'pipe', encoding: 'utf8', shell }));

try {
  execFileSync('claude', ['--version'], { stdio: 'pipe', shell });
} catch {
  console.error('✗ the "claude" command was not found. Install Claude Code first.');
  process.exit(1);
}

const market = claudeJson('plugin', 'marketplace', 'list', '--json').find((m) => m.name === marketName);
const installed = claudeJson('plugin', 'list', '--json').some((p) => p.id === pluginId);
console.log(`Bridge plugin: ${pluginId}\n  from: ${root}`);

if (remove) {
  if (installed) run('claude', ['plugin', 'uninstall', pluginId]);
  if (market) run('claude', ['plugin', 'marketplace', 'remove', marketName]);
  console.log(installed || market ? '  ✓ removed' : '  not installed; nothing to remove');
  if (!dryRun && (installed || market)) console.log('\nStart a new Claude Code session to finish. For the hosted version, follow "Install" in the README.');
  process.exit(0);
}

console.log('  npm install');
run('npm', ['install', '--no-audit', '--no-fund']);
console.log('  validate');
for (const f of ['plugin.json', 'marketplace.json']) run('claude', ['plugin', 'validate', path.join(root, '.claude-plugin', f)]);

// One marketplace of this name at a time: the hosted one (GitHub) gives way to this folder.
if (market && market.path !== root) {
  console.log(`  marketplace "${marketName}" comes from ${market.path ?? market.repo ?? market.url ?? 'elsewhere'}; replacing it with this folder`);
  run('claude', ['plugin', 'marketplace', 'remove', marketName]);
}
if (market && market.path === root) {
  console.log('  refresh marketplace');
  run('claude', ['plugin', 'marketplace', 'update', marketName]);
} else {
  console.log('  add marketplace');
  run('claude', ['plugin', 'marketplace', 'add', root]);
}

// Reinstall rather than update: install is where --config applies.
if (installed) {
  console.log('  uninstall the previous copy');
  run('claude', ['plugin', 'uninstall', pluginId]);
}
console.log('  install');
// An empty token is given on purpose: it replaces one a previous install left in the credential store.
const settings = ['--config', `server_url=${server}`, '--config', `allowed_sites=${allowedSites}`];
run('claude', ['plugin', 'install', pluginId, '--config', `token=${token}`, ...settings], ['plugin', 'install', pluginId, '--config', `token=${token ? '***' : ''}`, ...settings]);

console.log(`    server: ${server}`);
console.log(`    token:  ${token ? 'from BW_BRIDGE_TOKEN' : 'none: the bridge starts unlinked, as for a new user'}`);
if (dryRun) {
  console.log('\n(dry run: nothing changed)');
} else {
  console.log(`  ✓ installed

Next: start a new Claude Code session and ask "check the bridge status".
It says what is missing (the server at ${server}, the connector, the token) and what to do.
Take it out again with: npm run install:dev -- --remove`);
}
