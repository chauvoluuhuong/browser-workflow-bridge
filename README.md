# Browser Workflow Bridge

A Claude plugin that runs your Browser Workflow automations in your own Chrome, with your own logins, and connects Claude to the Browser Workflow server.

The server decides every step of a workflow. This bridge is a small local program with no workflow logic: it connects to the server, carries out simple browser commands in tabs it opens, and sends the results back. It also gives Claude page-inspection tools for the same browser, so Claude can explore a site before writing or fixing a workflow.

## What the plugin adds

| Part | What it is |
|---|---|
| `bridge` | A local MCP server that Claude starts. It connects to the Browser Workflow server and runs the commands below. To Claude it offers `bridge_status` (connection state; pause or resume) and the `page_*` inspector tools |
| `browser-workflow` | The Browser Workflow connector at `<Server>/mcp`: your workflows, runs and data. You sign in to it with your Browser Workflow account |

The bridge runs where Claude can start local MCP servers from plugins: Claude Code (terminal, IDE, and the desktop app's Code tab) and Cowork on your computer.

## What it does in your browser

The bridge connects to Chrome through the Chrome DevTools Protocol (Playwright) and accepts only these commands from the server:

| Command | What it does |
|---|---|
| `open` | Opens a new tab for one workflow run: in your running Chrome, a Chrome at a DevTools address you set, or a new Chrome window |
| `navigate` | Loads a URL in that tab |
| `act` | Clicks, types, selects or waits on one element, found by XPath |
| `evaluate` | Runs the workflow's JavaScript in that tab |
| `capture` | Takes a screenshot, the page HTML or an excerpt, and console errors |
| `takeApiCalls` | Returns the fetch/XHR requests the tab made, with credentials in headers removed |
| `close` | Closes what `open` created |
| `check` | Tells whether Chrome can be reached, before a run starts |

Rules the bridge enforces itself, even if the server asked for something else:

- It acts only on tabs it opened for a run. It never reads or controls your other tabs or windows.
- It opens only `http` and `https` pages (never `file:`, `chrome:` or similar), and only the **Allowed sites** when you set them.
- At most 3 runs are open at once, and a run's tab closes after 60 minutes.
- Page HTML sent back is capped at 2 MB.
- When the connection to the server drops, it closes every tab it opened.
- `bridge_status` with `pause` disconnects it; nothing runs in your browser until you resume it.

## What it sends, and where

- **The Browser Workflow server** (the **Server** setting, `https://…`): the bridge connects to `<Server>/bridge` over a secure WebSocket and sends command results. These can include page URLs, data a workflow extracts, screenshots, page HTML or excerpts, console errors, and the fetch/XHR requests a page made (with `Authorization`, `Cookie` and similar headers replaced by `[redacted]`). Claude's connector entry talks to `<Server>/mcp`.
- **Nothing else.** The page inspector (`chrome-devtools-mcp`) runs on your computer, talks only to your Chrome, and runs with usage statistics turned off. The bridge stores nothing outside your computer except what it sends to the server.

Pages a workflow opens load in Chrome as they would if you visited them yourself.

## Settings

| Setting | What it's for |
|---|---|
| **Bridge token** | Links the bridge to your account. Create it in the Account view (ask Claude to "show my browser-workflow account"). Stored in your system's secure credential store |
| **Server** | The Browser Workflow server's address. Leave the default unless you run your own server |
| **Allowed sites** | Only let workflows open these sites, separated by commas. `*` (the default) allows any site |

## Protocol

JSON messages over the WebSocket the bridge opens (protocol version 1):

- bridge → server: `hello { token, protocol, bridgeVersion, platform }`, `result { id, ok, value | error }`, `pong`
- server → bridge: `welcome { account }`, `rejected { code, message }`, `command { id, name, args }`, `config { browser }`, `ping`

`name` is one of the commands above, and `args` are its arguments in order.

## Development

Load the plugin from this folder for one Claude Code session:

```bash
claude --plugin-dir .
```

Or install it the way a user would. This folder is also a one-plugin marketplace:

```bash
claude plugin marketplace add .
```

```bash
claude plugin install browser-workflow-bridge@browser-workflow
```

Run the bridge's tests, and check both manifests before pushing:

```bash
npm test
```

```bash
npm run validate
```

## License

MIT. See [LICENSE](LICENSE).
