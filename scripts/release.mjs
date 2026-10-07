#!/usr/bin/env node
// Publishes the app for the Claude desktop app: builds dist/browser-workflow.mcpb and attaches it to a
// GitHub release named after the version (v0.5.0). The landing page's Download button points at
//   https://github.com/<owner>/<repo>/releases/latest/download/browser-workflow.mcpb
// which always serves the newest release, so no page changes when the version does.
//   npm run release                 build and publish (or replace the file of) this version's release
//   npm run release -- --dry-run    build, and show what would be published
// Needs the gh CLI signed in, and this commit pushed to main (the release's tag is made on it).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const tag = `v${version}`;
const file = path.join('dist', 'browser-workflow.mcpb');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const repo = (() => {
  try { return run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']); } catch { return fail('gh is not signed in, or this folder is not a GitHub repository (gh auth login).'); }
})();
if (run('git', ['status', '--porcelain'])) fail('There are uncommitted changes. Commit them first: the release is made from the commit on main.');
run('git', ['fetch', 'origin', 'main']);
if (run('git', ['rev-list', 'origin/main..HEAD', '--count']) !== '0') fail('This commit is not pushed to main yet (git push), so the release would not match what is published.');
if (run('git', ['rev-parse', 'HEAD']) !== run('git', ['rev-parse', 'origin/main'])) fail('HEAD is not the tip of origin/main. Release from main.');

console.log(execFileSync('node', [path.join('scripts', 'build-app.mjs')], { cwd: root, encoding: 'utf8' }).trim());
const exists = (() => { try { run('gh', ['release', 'view', tag]); return true; } catch { return false; } })();
const url = `https://github.com/${repo}/releases/latest/download/browser-workflow.mcpb`;
if (dryRun) {
  console.log(`\n(dry run) would ${exists ? `replace the file of release ${tag}` : `create release ${tag}`} on ${repo} with ${file}\nDownload address: ${url}`);
  process.exit(0);
}
if (exists) run('gh', ['release', 'upload', tag, file, '--clobber']);
else run('gh', ['release', 'create', tag, file, '--title', `Browser Workflow for Chrome ${version}`, '--notes', `The app for the Claude desktop app: download browser-workflow.mcpb, open it with Claude, and click Install. See https://browser-workflow.web.app`, '--target', 'main', '--latest']);
console.log(`\n✓ ${tag} on ${repo}\n  Download address: ${url}`);
