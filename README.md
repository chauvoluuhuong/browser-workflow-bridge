# Browser Workflow Bridge

A Claude plugin that runs your Browser Workflow automations in your own Chrome, with your own logins, keeps what they produce on your computer, and connects Claude to the Browser Workflow server.

The server decides every step of a workflow. This bridge is a small local program with no workflow logic: it connects to the server, carries out simple browser commands in tabs it opens, saves each run's screenshots, page HTML and data in a folder on your computer, and answers the server. It also gives Claude page-inspection tools for the same browser, so Claude can explore a site before writing or fixing a workflow.

## Install

You need [Claude Code](https://claude.com/claude-code) and [Node.js](https://nodejs.org) 22 or newer (the LTS installer is enough). The same two commands work on macOS, Windows and Linux.

**Inside Claude Code** (the terminal, or the Code tab of the desktop app), type these one after the other:

```text
/plugin marketplace add chauvoluuhuong/browser-workflow-bridge
```

```text
/plugin install browser-workflow-bridge@browser-workflow
```

**Or from a terminal.** macOS and Linux (Terminal), and Windows (Command Prompt or PowerShell):

```bash
claude plugin marketplace add chauvoluuhuong/browser-workflow-bridge
```

```bash
claude plugin install browser-workflow-bridge@browser-workflow
```

Then start a new Claude Code session and ask Claude to **"check the bridge status"**. It tells you what is left to do. For a new user that is:

1. Connect to Browser Workflow: run `/mcp`, choose **browser-workflow**, then **Authenticate**. On the page that opens, **Continue** is enough; you can create an account later.
2. Ask Claude to "show my browser-workflow account", and click **New bridge token** in the view that appears. Copy the token.
3. Run `/plugin configure browser-workflow-bridge` and paste it as **Bridge token**.
4. Start a new session. "Check the bridge status" should now say **connected**.

The first start downloads the bridge's parts (about 50 MB, usually a few seconds). If the bridge shows as failed in `/mcp` right after installing, wait a minute and reconnect it there.

To update later: `/plugin marketplace update browser-workflow`. To remove: `/plugin uninstall browser-workflow-bridge@browser-workflow`.

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

## What it keeps on your computer

Runs made in your own Chrome are saved by the bridge, not by the server. Each run gets a folder in the bridge's data folder (`~/.browser-workflow/accounts/<your account id>/runs/<run id>/` unless you set **Data folder**):

| File | What |
|---|---|
| `run.json` | The run's record: its inputs, and each step's state, result or error |
| `<step>.jpg`, `<step>.html.gz` | A screenshot and the page's HTML after each browser step |
| `items.json` | The data your workflow extracted |
| `apicalls.json` | The fetch/XHR requests the pages made, with `Authorization`, `Cookie` and similar headers replaced by `[redacted]` |

The data folder also has `bridge.log`: what the bridge did, for finding out what went wrong (it registered, each command it carried out and how it ended, with page addresses and XPaths; values typed into pages only by their length, and no page content). It is kept under 2 MB, stays on your computer, and is yours to read or delete. `bridge-id` holds a random name the server uses to recognise this bridge after a restart.

The last 20 runs of each workflow are kept; older ones are deleted when a new run starts. Nothing else is deleted for you. They are plain files: you can open or delete them yourself. `bridge_status` shows where the folder is.

## What it sends, and where

- **The Browser Workflow server** (the **Server** setting, `https://…`): the bridge sends HTTPS requests to `<Server>/api/bridge/v1` and holds no connection open to it. Claude's connector entry talks to `<Server>/mcp`. For a run it sends:
  - each step's result (page URL, the value your step's code returned, or the error), because the server decides the next step from it;
  - console errors, and for a failed step the HTML near the element it was looking for (at most 8 KB), so the failure can be explained;
  - the names of the files it saved, not their content;
  - what you or Claude ask to see of a past run: a step's screenshot, its extracted data or its requests. This is read from the folder above and sent when asked for, for example when Claude looks at a failed step to fix the workflow. The server passes it on and does not keep it.
  - The bridge also sends back, unchanged, a signed note the server gave it with the previous step (the run's inputs, its variables and its latest two steps): the server keeps nothing of a run between two steps, so it needs this to decide the next one. The run's record itself is saved here, by the bridge, as each step is answered.
- **A signal channel:** the address the server gives the bridge to listen on, so the bridge knows when to ask for work without a connection to the server. For a hosted server this is **Firebase Realtime Database** (Google). The bridge only reads there, and what it reads is a number that changes: no page content, no workflow, no account data. (The widget in Claude listens the same way for a run you are watching, and is told the run's status and each step's state by its id.) A server you run yourself can carry the signals itself, and then there is no second destination.
- Runs in the server's cloud browser don't involve the bridge at all.
- **Nothing else.** The page inspector (`chrome-devtools-mcp`) runs on your computer, talks only to your Chrome, and runs with usage statistics turned off.

Pages a workflow opens load in Chrome as they would if you visited them yourself.

## Settings

| Setting | What it's for |
|---|---|
| **Bridge token** | Links the bridge to your account. Create it in the Account view (ask Claude to "show my browser-workflow account", then **New bridge token**). Stored in your system's secure credential store |
| **Server** | The Browser Workflow server's address. The default is the hosted server, `https://browser-workflow-294054962898.us-central1.run.app`. Change it only if you run your own server |
| **Allowed sites** | Only let workflows open these sites, separated by commas. `*` (the default) allows any site |
| **Data folder** | Where your runs are saved on this computer. Empty (the default) means `~/.browser-workflow` |

Change them at any time with `/plugin configure browser-workflow-bridge`, then start a new session.

## Protocol

HTTP, protocol version 3 (`src/rest.js`). Every request carries the bridge token as a Bearer token.

| Call | Purpose |
|---|---|
| `POST /session` `{ protocol, bridgeVersion, platform }` | Register. Answers `{ session, account, accountId, browser, signalUrl }`. One bridge per account: a new one replaces the old |
| `GET /work?session=` | After a signal: `{ start, stop, resume }` (run ids), `settle` (runs the server ended while this bridge was away: how, to note on the record here), `asks` (`{ id, name, args }`: a record or a file to read back, a browser check), `browser` |
| `POST /runs/<id>/next` `{ session, seq, result, state }` | The result of command `seq` (0 the first time), and the `state` from the last answer. Answers `{ seq, command: { name, args } }`, `{ seq, wait: { untilMs } }` (a manual step) or `{ seq, done }`, with `save` (the record's header and the steps that changed, written to the run's folder) and the next `state`. Repeating a call is safe |
| `POST /runs/<id>/settled` `{ session }` | The bridge noted how a run in `settle` ended |
| `POST /answers/<id>` `{ session, ok, value \| error }` | The answer to one of `asks` |
| `DELETE /session?session=` | The bridge is going away |

The bridge listens on `signalUrl` with a plain streaming GET (`Accept: text/event-stream`). Each event means "ask `/work`"; a lost or repeated one changes nothing. `command.name` is one of the commands above, or `sleep` (a delay step: wait that many milliseconds).

For `store` questions, `args` is an operation and its arguments: `listRuns`, `getRun`, `readAsset`, `getItems`, `getApiCalls`, `usage` (reads), and `saveRun`, `deleteRun`, `deleteRunsOf`, `endRun` (writes). They are carried out one at a time, in the order they arrive.

`src/driver.js`, `src/inspector.js` and `src/store.js` are generated from the server's code, so a run behaves and is saved the same on both sides; the rest is written here.

## Development

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

**What the bridge tells a user who isn't set up** is in `src/guide.js`: the steps `bridge_status` ends with when there is no token, when the server doesn't answer, or when the server refused the token.

Run the bridge's tests, and check both manifests before pushing:

```bash
npm test
```

```bash
npm run validate
```

Two settings shorten the bridge's timers for tests (the server's end-to-end suite uses them): `BW_MAX_RUN_MS`, the longest a run's tab stays open (default and at most 60 minutes), and `BW_MAX_BACKOFF_MS`, the longest wait between two attempts to reconnect (default 30 seconds).

## License

MIT. See [LICENSE](LICENSE).
