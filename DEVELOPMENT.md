# Developing Browser Workflow for Chrome

For people who work on this repo. Users want the [README](README.md).

The app is the local half of Browser Workflow: a small program with no workflow logic that Claude starts on the user's computer. It carries out the browser commands the server sends, saves each run's files on the computer, and answers the server. It ships as a Claude Code plugin (`browser-workflow-bridge`) and as a file for the Claude desktop app (`browser-workflow.mcpb`); the code is the same.

## What the plugin adds

| Part | What it is |
|---|---|
| `bridge` | A local MCP server that Claude starts. It connects to the Browser Workflow server and runs the commands below. To Claude it offers `bridge_status` (connection state; pause or resume) and the `page_*` inspector tools |
| `browser-workflow` | The Browser Workflow connector at `<Server>/mcp`: your workflows, runs and data. Connecting takes one click (**Continue**); you can create an account later, or sign in if you have one |

The bridge runs where Claude can start local MCP servers from plugins: Claude Code (terminal, IDE, and the desktop app's Code tab) and Cowork on your computer.

## What it does in your browser

The bridge connects to Chrome through the Chrome DevTools Protocol (Playwright) and accepts only these commands from the server:

| Command | What it does |
|---|---|
| `open` | Opens a new tab for one workflow run: in your running Chrome, a Chrome at a DevTools address you set, or a new Chrome window |
| `navigate` | Loads a URL in that tab |
| `act` | Clicks, types, selects or waits on one element, found by XPath |
| `evaluate` | Runs the workflow's JavaScript in that tab |
| `capture` | Takes a screenshot, the page HTML or an excerpt, console errors and the page's requests |
| `takeApiCalls` | Returns the fetch/XHR requests the tab made, with credentials in headers removed |
| `close` | Closes what `open` created |
| `check` | Tells whether Chrome can be reached, before a run starts |
| `store` | Saves or reads one of your runs in the bridge's data folder (see "What it keeps on your computer") |

`navigate`, `act` and `evaluate` can carry an `after` option: the bridge then captures the page right after the action, as `capture` would, and answers once for both.

Rules the bridge enforces itself, even if the server asked for something else:

- It acts only on tabs it opened for a run. It never reads or controls your other tabs or windows.
- It opens only `http` and `https` pages (never `file:`, `chrome:` or similar), and only the **Allowed sites** when you set them.
- At most 3 runs are open at once. A run's tab closes at the time limit the server gave for it, and never later than 60 minutes.
- Page HTML is capped at 2 MB, and one answer to the server at 6 MB.
- `store` reads and writes only runs, only inside your account's folder. It can't be given a path, and it has no way to read other files.
- When a run is kept on your computer and saving fails (a full disk, for example), the step fails and what was captured is dropped. It is not sent to the server instead.
- When the connection to the server drops, it closes every tab it opened.
- `bridge_status` with `pause` disconnects it; nothing runs in your browser until you resume it.

## Protocol

HTTP, protocol version 3 (`src/rest.js`). Every request carries the bridge token as a Bearer token.

| Call | Purpose |
|---|---|
| `POST /pair` `{ protocol, bridgeVersion, platform, name }` (no token) | Ask for a pairing code. Answers `{ pairId, secret, code, expiresIn }`. The user confirms the code in Claude (`link_computer`, then a button) |
| `GET /pair/<pairId>` with `Bearer <secret>` (no token) | Poll: `{ status: 'pending' }`, or once `{ status: 'linked', token, account }`. Unknown or expired: 404, and the app asks for a new code |
| `POST /session` `{ protocol, bridgeVersion, platform }` | Register. Answers `{ session, account, accountId, browser, signalUrl }`. One bridge per account: a new one replaces the old |
| `GET /work?session=` | After a signal: `{ start, stop, resume }` (run ids), `settle` (runs the server ended while this bridge was away: how, to note on the record here), `asks` (`{ id, name, args }`: a record or a file to read back, a browser check), `browser` |
| `POST /runs/<id>/next` `{ session, seq, result, state }` | The result of command `seq` (0 the first time), and the `state` from the last answer. Answers `{ seq, command: { name, args } }`, `{ seq, wait: { untilMs } }` (a manual step) or `{ seq, done }`, with `save` (the record's header and the steps that changed, written to the run's folder) and the next `state`. Repeating a call is safe |
| `POST /runs/<id>/settled` `{ session }` | The bridge noted how a run in `settle` ended |
| `POST /answers/<id>` `{ session, ok, value \| error }` | The answer to one of `asks` |
| `DELETE /session?session=` | The bridge is going away |

The bridge listens on `signalUrl` with a plain streaming GET (`Accept: text/event-stream`). Each event means "ask `/work`"; a lost or repeated one changes nothing. `command.name` is one of the commands above, or `sleep` (a delay step: wait that many milliseconds).

For `store` questions, `args` is an operation and its arguments: `listRuns`, `getRun`, `readAsset`, `getItems`, `getApiCalls`, `usage` (reads), and `saveRun`, `deleteRun`, `deleteRunsOf`, `endRun` (writes). They are carried out one at a time, in the order they arrive.

`src/driver.js`, `src/inspector.js` and `src/store.js` are generated from the server's code, so a run behaves and is saved the same on both sides; the rest is written here.

## Working on it

There is one hosted server, and the plugin points at it by default. To work on the bridge, install it from this folder pointed at a server on your own computer (`http://127.0.0.1:3310`, where the server repo's dev commands listen):

```bash
npm run install:dev
```

It installs with no token, so the bridge starts unlinked, as it does for a new user: ask Claude to "check the bridge status" to read what it tells them, with your server running or not. `BW_BRIDGE_TOKEN=… npm run install:dev` installs it already linked, and `BW_BRIDGE_URL` names another address. `npm run install:dev -- --dry-run` shows the commands, and this takes it out again:

```bash
npm run install:dev -- --remove
```

Only one copy of the plugin is installed at a time. After `--remove`, the commands under [Install](#install) bring back the hosted version.

For one session without installing anything:

```bash
claude --plugin-dir .
```

**How it starts.** Claude Code starts `src/start.js`. A copy installed from GitHub has no `node_modules`, so the first start runs `npm ci` into the plugin's data folder (`~/.claude/plugins/data/…`, kept across updates) and links it; a clone where you ran `npm install` is used as it is. Then it loads `src/index.js`, the bridge. If the install can't be done, it still answers Claude, and `bridge_status` says why.

**Pairing** is `src/pairing.js`: with no token, the app asks the server for a code, shows it in `bridge_status`, and polls until the user's click on the server side hands it a token, which it saves in `link.json`. A saved token the server no longer knows is deleted and pairing starts again.

**What the app tells a user who isn't set up** is in `src/guide.js`: the steps `bridge_status` ends with when it is not linked yet (with the code), when the server doesn't answer, or when the server refused this computer.

**The file for the Claude desktop app** is built with `npm run build:app` (`dist/browser-workflow.mcpb`: the same code with its dependencies inside, from `mcpb/manifest.json`; `BW_BUILD_SERVER=http://127.0.0.1:3310` points it at a server on this computer). `npm run release` publishes it as a GitHub release, which the landing page's Download button points at (`releases/latest/download/browser-workflow.mcpb`). Both are run from the server repo with `npm run deploy:app`. GitHub does it by itself too (`.github/workflows/ci.yml`): every push to `main` is tested and built, and when `package.json` has a version with no release yet, that version is published. So to release, change the version in `package.json` and `.claude-plugin/plugin.json` and merge; a merge that leaves the version alone publishes nothing.

Run the bridge's tests, and check both manifests before pushing:

```bash
npm test
```

```bash
npm run validate
```

Two settings shorten the bridge's timers for tests (the server's end-to-end suite uses them): `BW_MAX_RUN_MS`, the longest a run's tab stays open (default and at most 60 minutes), and `BW_MAX_BACKOFF_MS`, the longest wait between two attempts to reconnect (default 30 seconds).
