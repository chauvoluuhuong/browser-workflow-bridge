---
name: browser-workflow
description: How to build, run and fix browser-automation workflows with the browser-workflow MCP tools (read_workflows, propose_workflow, run_workflow, get_failure, propose_change, page_* inspector). Use it whenever the user wants to automate a website, scrape or extract data from pages, repeat a browsing task, or fix a workflow run that failed, even if they don't say "workflow".
---

# Building and fixing browser workflows

A workflow is a JSON graph of steps that runs in a real Chrome: the user's own Chrome by default,
signed in to their sites. Workflows are deterministic, so once a workflow works it runs the same way
every time, without you driving the browser step by step.

## The loop

1. **Understand the task.** Ask which site, which inputs change between runs (they become
   `environmentVariableSchema` inputs), and what data they want back.
2. **Explore the site with the inspector.** `page_new_page` → `page_take_snapshot` (the structure
   and text of the page) → try things with `page_click` / `page_fill` / `page_evaluate_script`.
   Write down the XPaths that work.
3. **Draft.** Call `get_step_schema` once for the exact format, then `propose_workflow`. The user
   reviews it and chooses **Save & test run**.
4. **When a run fails:** call `get_failure(runId)` for the error, the screenshot, the HTML near the
   failing element and the variables. If you need more context, open the page with the inspector.
   Then call `propose_change({ workflowId, runId, reason, changes })`. The user presses
   **Apply & test**, which re-runs from the first step and stops right after the fixed step.
5. **When the user asks to edit a step** (the widget sends a message naming the step), read it
   with `get_workflow` and answer with `propose_change`, without a `runId`.

You never save or edit a workflow directly. Every change is a proposal the user confirms.
Write `reason` in the user's language, as one sentence.

## Step types

| stepType | action | output |
|---|---|---|
| `navigate` | `{ value: url }` | `{ success }` |
| `executeXpathCommand` | `{ xpathSelector, command, value?, timeoutMs? }`; commands: click, fill, type, press, hover, selectOption, check, uncheck, focus, scrollIntoView, waitFor | `{ success }` |
| `javascript` | `{ jsCode }`: runs in the page | whatever it returns |
| `extractData` | `{ jsCode }`: returns the items (array or object), **unwrapped** | the items, saved as run data |
| `delay` | `{ value: "1500" }` (ms) | `{ success }` |
| `if` | `{ jsCondition, trueNextStepId, falseNextStepId }` | `{ result }` |
| `switch` | `{ cases: [{ jsCondition, nextStepId }], defaultNextStepId }` | `{ matchedJsCondition }` |
| `manual` | `{ description, timeoutMs? }`: pauses until the user presses Resume | `{ status }` |

Every step has `id`, `stepName`, `description` and `nextStepId` (`null` ends the chain). The run
starts at the steps nothing points to. `pageUrl`, if set, is opened before the first step.

## Variables

- **Inputs:** `environmentVariableSchema.properties` (give each a `title`, and a `default` when
  sensible; list the required ones in `required`). **State:** `runTimeVariableSchema` (defaults only).
- **In strings** (URLs, XPaths, values, code): `{{environment.q}}`, `{{runtime.page}}`, or bare `{{q}}`.
  Values are inserted as text, and objects as JSON.
- **In `if` / `switch` conditions:** plain JavaScript with `environment` and `runtime` in scope,
  e.g. `runtime.page <= environment.maxPages`. Don't use `{{ }}` here.
- **Setting runtime variables:** a `javascript` step returns `{ variables: { page: 2 } }`
  (deep-merged). `await setVariables({...})` also works, for older workflows.
- `runtime.lastOutput` / `runtime.lastOutputParsed` hold the previous step's output. `javascript`
  and `extractData` functions receive it as their argument: `(input) => …`.

## Writing robust steps

- Prefer XPaths built on stable attributes (`@id`, `@name`, `@aria-*`, `@data-*`, visible text:
  `//button[normalize-space()='Search']`) over positions and generated class names.
- Wait for content with `executeXpathCommand` + `waitFor`, not with fixed delays.
- In `jsCode`, check what you query and `throw new Error('…')` with a clear message when something
  is missing. A failed step shows that message, which is much easier to fix than empty data later.
- Loops: a `javascript` step advances a counter (`{ variables: { page: {{runtime.page}} + 1 } }`),
  an `if` step decides, and the last step points back to the start of the loop. Runs stop after 2000
  step executions.
- Captchas and logins: use a `manual` step with a clear `description`. The user completes it in
  the browser and presses Resume.
- Keep `extractData` output flat (one object per item, same keys), so the data table and CSV
  export read well.

## Reading run results

These tools answer you with text and show the user nothing. Use them for your own work:

- `get_run(runId)`: status, and the state of every step.
- `read_runs(workflowId)`: past runs.
- `get_step(runId, stepId)`: one step's URL, output or error, and screenshot.
- `get_run_data(runId, offset, limit)`: the extracted items, a part at a time.
- `read_workflows()`, `get_workflow(id)`, `get_history(id)`: the library, one definition, its versions.

The tools that show a widget (`list_workflows`, `show_workflow`, `show_run`, `list_runs`, `show_step`,
`show_run_data`, `show_failure`, `show_account`) put the same things in a widget for the user and answer you
with the same text. While you are still working, use the silent tools and never one that shows a widget. For
your final answer, when what the user asked for is what a widget shows, call the tool that shows it
instead of writing it out, and do not repeat in text what the widget shows. A single fact ("how
many", "when did it last run") is answered in a sentence, with no widget.
Show one widget per reply: after a widget where the user has something to do, end your reply and
wait for them.

- The widget reports finished runs to you automatically.
