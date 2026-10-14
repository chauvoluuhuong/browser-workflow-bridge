#!/usr/bin/env node
// Installs the hosted version of the plugin in Claude Code: from GitHub, pointed at the hosted server.
// It is the README's two /plugin lines in one command, and it replaces a copy made by install:dev.
//   npm run install:production                 install or refresh
//   npm run install:production -- --dry-run    show what would run, change nothing
//   npm run install:production -- --remove     take the plugin and its marketplace out again
// This is for Claude Code only. The Claude desktop app's chat gets Browser Workflow from
// Settings → Connectors (see the README's "Install"); a plugin never appears in that list.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const remove = args.has('--remove');

const json = (f) => JSON.parse(readFileSync(path.join(root, '.claude-plugin', f), 'utf8'));
const plugin = json('plugin.json');
const marketName = json('marketplace.json').name;
const pluginId = `${plugin.name}@${marketName}`;
const source = new URL(plugin.repository).pathname.replace(/^\//, ''); // chauvoluuhuong/browser-workflow-bridge
const server = plugin.userConfig.server_url.default;
// Windows starts `claude` through a shell (it is a .cmd file there).
const shell = process.platform === 'win32';

/** Runs a command; prints its output and exits on failure. */
function run(a) {
  if (dryRun) { console.log(`  would run: claude ${a.join(' ')}`); return; }
  try {
    execFileSync('claude', a, { stdio: 'pipe', encoding: 'utf8', shell });
  } catch (e) {
    console.error(`✗ claude ${a.join(' ')}\n${[e.stdout, e.stderr].filter(Boolean).join('\n').trim()}`);
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
console.log(`Bridge plugin: ${pluginId}\n  from: GitHub ${source}`);

if (remove) {
  if (installed) run(['plugin', 'uninstall', pluginId]);
  if (market) run(['plugin', 'marketplace', 'remove', marketName]);
  console.log(installed || market ? '  ✓ removed' : '  not installed; nothing to remove');
  process.exit(0);
}

// One marketplace of this name at a time: a copy from a folder (install:dev) gives way to GitHub.
if (market && market.path) {
  console.log(`  marketplace "${marketName}" comes from ${market.path}; replacing it with GitHub`);
  run(['plugin', 'marketplace', 'remove', marketName]);
}
if (market && !market.path) {
  console.log('  refresh marketplace');
  run(['plugin', 'marketplace', 'update', marketName]);
} else {
  console.log('  add marketplace');
  run(['plugin', 'marketplace', 'add', source]);
}

// Reinstall rather than update: install is where --config applies, and it clears what install:dev left.
if (installed) {
  console.log('  uninstall the previous copy');
  run(['plugin', 'uninstall', pluginId]);
}
console.log('  install');
run(['plugin', 'install', pluginId, '--config', 'token=', '--config', `server_url=${server}`, '--config', 'allowed_sites=*']);

console.log(`    server: ${server}`);
if (dryRun) {
  console.log('\n(dry run: nothing changed)');
} else {
  console.log(`  ✓ installed

Next: start a new Claude Code session and ask "check the bridge status".
It gives you a button to link this computer. Take it out again with: npm run install:production -- --remove

This is for Claude Code. To use Browser Workflow in the Claude desktop app's chat, add the connector
under Settings → Connectors (README, "Install").`);
}
