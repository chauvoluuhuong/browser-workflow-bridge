#!/usr/bin/env node
// Builds the app for the Claude desktop app: dist/browser-workflow.mcpb, a file a user opens with
// Claude to install it (double-click, then Install). The same code as the Claude Code plugin, with its
// dependencies inside, since Claude ships its own Node.js and the user has nothing else to install.
//   npm run build:app                       for the hosted server (PRODUCTION in src/guide.js)
//   BW_BUILD_SERVER=http://127.0.0.1:3310 npm run build:app    for a server on this computer (development)
// The version is package.json's. No settings are asked of the user: the address is fixed in the file,
// and the account is linked by pairing (src/pairing.js).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PRODUCTION } = await import(pathToFileURL(path.join(root, 'src', 'guide.js')).href);
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const server = (process.env.BW_BUILD_SERVER || PRODUCTION).replace(/\/+$/, '');
const stage = path.join(root, 'dist', 'app');
const out = path.join(root, 'dist', 'browser-workflow.mcpb');
const shell = process.platform === 'win32';
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8', shell });

console.log(`Building Browser Workflow ${version} for ${server}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ['src', 'package.json', 'package-lock.json', 'LICENSE', 'README.md']) cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
cpSync(path.join(root, 'mcpb', 'icon.png'), path.join(stage, 'icon.png'));
writeFileSync(
  path.join(stage, 'manifest.json'),
  readFileSync(path.join(root, 'mcpb', 'manifest.json'), 'utf8').replaceAll('__VERSION__', version).replaceAll('__SERVER__', server),
);

console.log('  dependencies');
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], stage);
console.log('  validate');
run('npx', ['mcpb', 'validate', path.join(stage, 'manifest.json')]);
console.log('  pack');
rmSync(out, { force: true });
run('npx', ['mcpb', 'pack', stage, out]);

const bytes = readFileSync(out);
console.log(`\n✓ ${path.relative(root, out)}  ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB  sha256 ${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}…  (server ${server})`);
if (!existsSync(out)) process.exit(1);
