# Browser Workflow for Chrome

**Tell Claude what you do on a website, and it does it for you, again and again.**

Browser Workflow turns a task you repeat (checking prices, collecting a list, filling in a form) into an automation that Claude builds from your description, runs in Chrome on your computer, and fixes when the website changes. This is the small app that runs on your computer, so the automation can open Chrome and save its results where only you can see them.

## Why use it

- **You describe it, you don't build it.** Say "collect the prices on this page every morning". Claude looks at the site, writes the steps, and shows them to you before anything is saved.
- **It runs on your computer.** Chrome opens on your machine and does the steps there. The screenshots and the data it collects are saved in a folder on your computer, not on our server.
- **It repairs itself with you.** When a step breaks, Claude sees what the page showed, proposes a fix, and tests it with you.
- **Free to try.** You don't need to sign up: Claude connects with one click, and you can create an account later.

## Install

You need [Google Chrome](https://www.google.com/chrome/) and the Claude desktop app or the ChatGPT desktop app (or Claude Code, below). It takes about two minutes, once, and there is no account to create and nothing to sign in to.

### In the Claude or the ChatGPT desktop app (Windows, macOS, Linux)

1. **Paste one command.** It adds this app to the AI apps on your computer.

   On Windows, press the **Windows** key, type **PowerShell**, press **Enter**, and paste:

   ```text
   irm https://browser-workflow.web.app/install.ps1 | iex
   ```

   On a Mac or Linux, open the **Terminal** app and paste:

   ```text
   curl -fsSL https://browser-workflow.web.app/install.sh | sh
   ```

2. **Quit your AI app and open it again.**

3. **Ask for something to automate**, for example: *"Create a workflow that opens example.com and collects the page title."*

That's all. The app has Browser Workflow's tools itself and gets an account with no name for this computer, so there is no address to add and no computer to link. The [install guide](https://browser-workflow.web.app/install) has every step, how to remove it, and what to do if you already have an account with a username.

### In Claude Code (macOS, Windows, Linux)

You also need [Node.js](https://nodejs.org) 22 or newer. In Claude Code, type these two lines, one after the other:

```text
/plugin marketplace add chauvoluuhuong/browser-workflow-bridge
```

```text
/plugin install browser-workflow@browser-workflow
```

Then start a new session and ask Claude to **"check the bridge status"**. It tells you what is left, and you click **Link this computer** in the chat. If it asks you to sign in, type `/mcp`, choose **browser-workflow**, then **Authenticate** (**Continue** is enough).

## Is it safe?

The app can only do what a workflow asks, and only in tabs it opens itself:

- It never reads or controls your other tabs or windows.
- It only opens normal web pages (`http` and `https`), never files on your computer. You can limit it to sites you list (see **Settings**).
- It closes everything it opened when the connection drops, and a run never lasts more than 60 minutes.
- It can only read and write its own run folder, and nothing else on your computer.
- You can pause it, or remove it, at any time.

### What stays on your computer

Every run is saved in a folder on your computer (`~/.browser-workflow` unless you choose another): the screenshots, the page content, and the data your workflow collected. The last 20 runs of each workflow are kept, and you can open or delete the files yourself. We don't store them.

### What it sends, and where

- **To the Browser Workflow server:** what it needs to decide the next step of a run: the result of each step (the page address, the value your step returned, or the error), console errors, and for a failed step the part of the page around the element it was looking for (8 KB at most) so the failure can be explained. It sends the *names* of the files it saved, not their content. When you or Claude ask to see a past run, such as the screenshot of a failed step, that file is sent once to answer, and the server doesn't keep it.
- **To Google's Firebase:** the app listens there for a number that changes when there is work for it. No page content, workflows or account details go through it.
- **Nothing else.** The page inspector runs on your computer, talks only to your Chrome, and has usage statistics turned off.

The pages a workflow opens load in Chrome as if you had visited them yourself. The full policy is at [browser-workflow.web.app/privacy](https://browser-workflow.web.app/privacy).

## Settings

You rarely need these. In Claude Code, change them with `/plugin configure browser-workflow`.

| Setting | What it's for |
|---|---|
| **Allowed sites** | Only let workflows open these sites, separated by commas, for example `example.com, shop.example.org`. `*` (the default) allows any site |
| **Data folder** | Where your runs are saved. Empty means `~/.browser-workflow` |
| **Server** | The Browser Workflow server. Leave it unless you run your own |
| **Bridge token** | Normally empty: linking happens with one click. Only paste one if you were given it |

## If something doesn't work

Ask Claude to **"check the bridge status"**. It says what is missing and what to do. The usual causes:

| What you see | What to do |
|---|---|
| Claude says the app isn't connected | Install it as in step 3 above, then click **I installed it** in the chat, or ask Claude to continue |
| There is no **Link this computer** button | Add the connector first (step 1). Claude needs both parts to link them |
| A pairing code appears but nothing happens | Codes last 10 minutes. Ask Claude to check the status again: it gets a new one |
| A run can't start | Make sure Google Chrome is installed on this computer |
| The plugin shows as failed in Claude Code right after installing | Wait a minute (it downloads its parts the first time) and reconnect it in `/mcp`. It needs Node.js 22 or newer |
| It worked, then stopped on another computer | One computer is linked to an account at a time. Linking a second one replaces the first; link the first again to switch back |

Still stuck? [Open an issue](https://github.com/chauvoluuhuong/browser-workflow-bridge/issues). Please don't put passwords or private data in it.

## Update or remove

- **Claude desktop app:** download the newest file from the link in step 3 and open it. To remove it, use **Settings → Extensions** in Claude.
- **Claude Code:** `/plugin marketplace update browser-workflow` to update, and `/plugin uninstall browser-workflow@browser-workflow` to remove.

Your saved runs stay in their folder when you remove the app. Delete the folder to remove them.

## For developers

How it works, the commands it accepts, the protocol and how to build it: [DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT. See [LICENSE](LICENSE).
