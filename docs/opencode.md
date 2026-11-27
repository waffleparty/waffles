# OpenCode

Waffles runs in OpenCode 2 as a plugin with 2 parts: a server part (`adapters/opencode/server.ts`) and a terminal UI part (`adapters/opencode/tui.tsx`). Both reach the same `core/` that the Claude Code hooks use. This page says what works on OpenCode, what does not yet, and how to install it.

## Install

Install the npm package `@waffleparty/waffles`:

```sh
opencode plugin add @waffleparty/waffles
```

Or name it in your global OpenCode config:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": ["@waffleparty/waffles"]
}
```

OpenCode loads both parts from the package's `package.json` (`.` is the server part, `./tui` the terminal UI part), so the terminal needs no `cli.json` entry. OpenCode supplies `@opencode/plugin`, and the plugin uses Node.js built-ins only. To use waffles in one project only, put the same entry in that project's `opencode.jsonc`. Restart OpenCode after an update (`opencode service restart`).

The package holds JavaScript, not the repo's TypeScript: an install puts it under a `node_modules` folder, and Node.js refuses to run TypeScript files there (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). The release workflow compiles it with `scripts/build-npm.ts` at each release tag, and its skills name the compiled scripts (`scripts/builders.js`, `watch.js`). The compiled files are not in git.

### From a clone

To run waffles from its source, as when you change it, clone the repo and name the clone's absolute path in place of the package:

```sh
git clone https://github.com/waffleparty/waffles.git ~/src/waffles
```

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": ["/Users/you/src/waffles"]
}
```

A relative path resolves from the config file that holds it. The clone needs no `npm install`. Do not install the repo with a Git spec (`opencode plugin add github:waffleparty/waffles`): that puts the TypeScript under `node_modules`, and the scripts that skills run from the shell fail there (builders' test runs, the merge queue's wait, the CI watcher). To update a clone, pull it and restart OpenCode.

## What works

| Feature | On OpenCode |
| --- | --- |
| Skills | Every skill in `skills/` except `plan`, which opens Claude Code's pane. Name a skill in a prompt with `@<name>`, such as `@ask`. Skills marked "explicit" are not offered to the model. |
| Modes | `/prod`, `/rapid`, and `/backlog-entry`. The model reads the current mode in a context block that OpenCode updates at the next step. |
| Plan outline | The `waffles_plan` tool, the footer item, the session panel, and the pull request checklist after a push. |
| Tools | `waffles_merge_queue` (how a pull request merges, and where it stands in its base branch's merge queue), `waffles_checkpoint` (the plan outline into the pull request's description), `waffles_review_branch` (the local branch that merges the pull requests waiting for review), `waffles_backlog_queue` (the tracker writes held for replay), and `waffles_builders` (builders' clones and the open pull request limit). Subagents can call them. |
| Unattended runs | `@non-interactive [task]` starts a run. See [Unattended runs](#unattended-runs). |
| Auto effort | A level for each prompt you type, and `/auto-effort [on\|off]`. See [Auto effort](#auto-effort). |
| Subagent steps | A subagent whose description starts with a step ID and a colon marks that step. See [Subagent steps](#subagent-steps). |

### The footer and the panel

The footer under the prompt shows the mode, or `▶ non-interactive` during a run, then the plan outline's current step, cut to fit. The plan outline itself is a session panel. It opens by itself the first time a goal becomes active in a session, and **`/plan-outline`** opens or closes it. The panel's width is OpenCode's: drag its edge to change it, and rows are cut to fit. A terminal too narrow for a side panel shows the panel over the chat; one that opened by itself closes again there. The rows scroll with the mouse wheel, and with the keys while the panel has the focus. When the current step changes, the panel scrolls it into view.

The panel draws the same rows as Claude Code's pane, collapsed steps included (see [Collapsed steps](plan-outline.md#collapsed-steps)). The automatic rules run when the main session's turn ends. A click on a parent step's row collapses or expands it: the terminal UI part calls the server part's `waffles.plan` RPC, and the server part writes the change to the session's metadata, which the panel draws from. Where OpenCode registers no RPC for the plugin, a click does nothing and the automatic rules alone decide.

### Unattended runs

A run starts when a prompt names the `non-interactive` skill (`@non-interactive`, picked from the `@` list). It ends at the next prompt you type between turns. A prompt typed while a turn runs is delivered into that turn and leaves the run on.

During a run:

- A permission request is denied with the text the run's skill expects, so the model takes another way or leaves the step to you in the plan outline.
- The run's first question goes to you. It waits 60 seconds, then OpenCode takes it off the screen and the model reads that nobody answered. A question you dismiss is answered the same way, and the run goes on.
- Every later question is refused at once. A subagent's question and permission requests are refused too, under its main session's run.
- Each turn runs at Extra high effort, where the model offers it.

The run's refusals and the modes' rules name the run as `@non-interactive` and each skill by its name, such as "the backlog skill". The skills' text is the same on every platform: it names the question tool, the plan outline tool, and the `waffles:*` agents by what they do, with Claude Code's names as examples, so a run on OpenCode asks with `question` and routes work to OpenCode's own `general` and `explore` agents.

### Auto effort

Before the first model request of a turn that starts with a prompt you typed, waffles asks a model to pick Low, Medium, High, or Extra high, with the rubric in `core/effort.ts`. The question goes to the session's own model, at its lowest variant, and waits at most 8 seconds. The pick reaches the provider as the model's own variant of that level: OpenCode's variants already hold the right request option for each provider (`effort` for Anthropic models, `reasoningEffort` for OpenAI models). A model that has no variant of that level takes the nearest one above it, else the nearest below. A model with no variants runs as it is.

- A turn that no typed prompt starts (a subagent's result, for example) runs at the variant you picked.
- A prompt that names a skill, and a slash command, are not picked for.
- A variant you change during a turn wins for the rest of it.
- Subagents run at their own variant.

**`/auto-effort [on|off]`** shows or changes the state, which is kept across sessions; its answer shows as a toast. Off runs every turn at the variant you picked for the model. The footer does not show the effort: the row has no room for it.

### Subagent steps

OpenCode's `subagent` tool always runs in the background. When the main session starts a subagent whose description starts with a step ID and a colon (`6.2: Build the parser`), waffles marks that step while the subagent works. When the subagent's turn ends, the step waits for review. A follow-up to a running or finished subagent is not a new one, and marks nothing. When a goal is continued, the marks of subagents that no longer run end.

## What does not work yet

| Feature | Status |
| --- | --- |
| The `waffles:*` agents | Claude Code only. OpenCode's `general` and `explore` agents take their place. |
| The dev servers footer item | Claude Code only. |
| Effort in the footer | Not shown. `/auto-effort` says the state. |
| A reply to `/prod`, `/rapid`, and `/backlog-entry` | Not shown. The footer shows the new mode. |
| A plugin installed from a Git spec (`opencode plugin add github:waffleparty/waffles`) | The tools work; the scripts that skills run from the shell fail (builders' test runs, the merge queue's wait, the CI watcher). Install the npm package or a clone, as above. |
