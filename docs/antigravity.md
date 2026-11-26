# Antigravity

waffles runs on Google Antigravity (the App, the CLI, and the IDE) through Antigravity's plugin format and its command hooks. Antigravity loads no plugin code: for each hook event it starts `node ./adapters/command/cli.ts antigravity <event>` in the plugin's folder, hands it the event's JSON on stdin, and reads the answer from stdout. Each event runs in its own process, so the session's values (the mode, an unattended run's counters, the active goal) live in JSON files in the state folder (`WAFFLES_STATE_DIR`, else `$XDG_STATE_HOME/waffles`, else `~/.local/state/waffles`). The session is the Antigravity conversation: every event carries its `conversationId`.

This wiring follows Antigravity's documentation (Plugins, Build plugins, Hooks, Customization discovery, MCP, and Permissions). It has not yet been run in Antigravity itself; [Unverified](#unverified) lists what the documentation leaves open.

## Events

| Antigravity event | What waffles does there | What the answer can do |
| --- | --- | --- |
| `SessionStart` | The modes' rules, the plan outline's rules and goal, the mode, and the backlog adapter request | Inject a system message step |
| `PreInvocation` | The prompt's work: mode commands, the start and end of a run, the mode line in backlog mode. It fires before each model call, so the work runs for the first call of a prompt alone. | Inject a system message step |
| `PreToolUse` | During a run, refuse calls that would ask you, and questions after the start question. Approve the plan outline tool and the mode tool. | `allow`, `auto_approve`, `deny`, or `deny_unless_prior_grant`, with a reason |
| `PostToolUse` | The checkpoint after a `run_command` that worked; the end of the run's start question | Nothing: the checkpoint's line waits for the next `PreInvocation` |
| `Stop` | The turn's end, for the modes | Nothing (`{}` lets the stop happen) |

## What works

| Feature | On Antigravity |
| --- | --- |
| Skills | All skills in `skills/`, named `waffles:<skill>`. |
| Modes | The modes' rules and the current mode go to the model when a conversation starts. A mode command changes the mode (see [Mode commands](#mode-commands)). In backlog mode each prompt carries the mode beside it. The MCP server's `mode` tool reads or sets the mode; the hook approves its calls (`auto_approve`), as it does the plan outline tool's. |
| Unattended runs | A prompt that starts with `/waffles:non-interactive` starts a run, and the next prompt ends it. During a run, each tool call is answered `deny_unless_prior_grant` with what to do instead: a call that your rules or an earlier grant allow runs, and one that would ask you is refused. A call to `ask_permission` is refused outright, and after 5 such refusals in a row the run is told to wrap up. The run's first question (`ask_question`) within 5 minutes of its start goes to you; every later one is refused. |
| Plan outline | Its rules and the active goal's tree, or the open goals, go to the model when a conversation starts. The plan outline tool comes from the plugin's MCP server (`mcp_config.json`, server `waffles`, which Antigravity names `waffles_waffles`). The server's entry loads the tool eagerly, so the model calls it as `mcp_waffles_waffles_plan`. Antigravity asks before an MCP tool call by default; the hook approves this tool's calls (`auto_approve`), during a run too. Your own deny and ask rules still apply. |
| Checkpoint | After a `git push` or `gh pr create` that `run_command` ran with no error, the plan outline goes into the pull request's description. `PostToolUse` answers nothing the model reads, so the checkpoint's line goes to the model at its next call. |
| Backlog adapter | A repo whose AGENTS.md names a backlog adapter gets the init check request when a conversation starts. |

## What does not work

- **No pane.** Antigravity has no place a plugin draws in. The plan outline shows only in the model's context and in the goal files in the plan outline's store (`<git dir>/waffles/plan/`).
- **No footer.** The mode and an active run don't show under the prompt.
- **No notice line.** Antigravity has no hook output that shows a line to you and not to the model. A mode command's text reaches you through the model's reply.
- **No auto effort.** Antigravity gives a hook no way to set the reasoning effort.
- **No session end.** Antigravity has no event for a conversation's end. The plan outline's lock on the active goal is not released when the conversation ends: it goes stale 120 seconds after the last hook renewed it, and until then another session sees the goal as in use. The session's values stay until they are 7 days old.
- **No resume, clear, or compaction event.** `SessionStart` fires once, when a conversation starts. Injected steps stay in the conversation, so a resumed conversation keeps the rules. After `/compact`, the summary can leave them out, and nothing sends them again.
- **Refusals of ordinary calls aren't counted.** The hook input doesn't say whether a call would ask you, and no later event says whether Antigravity refused it. So a run counts only its refused `ask_permission` calls toward the 5 that make it wrap up. On Claude Code and Codex, every refused permission request counts.
- **The start question has no time limit.** A hook can't close Antigravity's question after 60 seconds, so the run's first question waits for you.
- **Subagents aren't told apart.** No input field marks a subagent's hook. If a subagent runs the plugin's hooks under its own conversation ID, it is its own session: it starts in production mode, and during your run its calls are not refused.
- **The same prompt twice in a row counts once.** `PreInvocation` carries the person's last prompt before every model call. The hook runs a prompt's work only when that text differs from the last one it ran, so a prompt sent again with the same text, such as `continue`, runs no prompt work.
- **Every tool call starts Node.js.** The `PreToolUse` hook matches every tool so that a run can refuse any call. Each call waits for one `node` process, about 0.1 seconds in this repo's tests.

## Mode commands

Antigravity has no slash commands a plugin registers, other than its skills. The hook reads the person's last prompt at the first model call of each prompt (`lastUserInput` in `PreInvocation`) and recognizes a prompt that is exactly `/prod`, `/rapid`, or `/backlog-entry`, with or without the `waffles:` prefix, and runs the command. The prompt still goes to the model, with the mode change and the command's text added as a system message, so the model only confirms it. A `/prod` that ends rapid work starts the assessment of that work in the same turn.

## Install

Antigravity reads `.antigravity-plugin/plugin.json`, which takes precedence over the root `plugin.json` (Codex's manifest). It loads the components from the repo root: `skills/`, `agents/`, `hooks.json`, and `mcp_config.json`. The hooks and the MCP server need Node.js 22.18 or later as `node` on the PATH.

No marketplace lists waffles for Antigravity. Install it in one of these ways:

- From GitHub: `agy plugin install https://github.com/waffleparty/waffles`.
- From a checkout: `agy plugin install <path to the checkout>`, or put the folder (or a link to it) in `~/.gemini/config/plugins/` for every workspace, or in `.agents/plugins/` for one workspace.

Check what Antigravity loaded with `agy plugin list --json`, and the hooks with `/hooks` in the CLI.

To check the plugin, run `agy plugin validate .` without `--strict`. The repo also holds files for other agents, and Antigravity warns about each one it ignores: the root `plugin.json` (shadowed by `.antigravity-plugin/plugin.json`), `mcp.json`, and `hooks/hooks.json` (Claude Code's hooks).

`agy plugin import claude` copies Claude Code plugins from `~/.claude/plugins/` into Antigravity. It is not a route for waffles: Claude Code's hooks are a module that `hooks/hooks.json` names, which Antigravity doesn't run, so an import brings no hooks. Install the repo itself instead; it carries Antigravity's own manifest, hooks, and MCP configuration.

## Limits

- **Marketplace.** The Antigravity Marketplace requires a `logo` in the manifest, a bundled square image. The repo has none, so the manifest names none, and Antigravity shows a generic icon.
- **Agents.** Antigravity loads `agents/<name>.md` from a plugin, but the agents in `agents/` are written for Claude Code: their `model` values (`haiku`, `sonnet`, `opus`) and `tools` names (`Read`, `Bash`) are not Antigravity's.
- **Context size.** A conversation's start adds about 7,000 characters, as one system message.
- **A slow checkpoint holds the agent.** Antigravity's hooks run synchronously. The checkpoint after a push can take up to 75 seconds; the hook's timeout is 90.

## Unverified

The documentation leaves these open. Each needs a check in a real Antigravity.

- **`deny_unless_prior_grant`.** The Hooks page says it "denies execution unless the resource was previously approved in a prior grant". It doesn't say whether a call that Antigravity allows by default, such as reading a workspace file or a command in the terminal sandbox, counts as granted. If it doesn't, a run's ordinary calls are refused too.
- **The plan outline tool's name.** The docs give the plugin's server the name `<plugin>_<server>` and an eager tool the name `mcp_<server>_<tool>`, which makes `mcp_waffles_waffles_plan`. They don't show the two together.
- **The MCP server's folder.** The docs don't say which folder a plugin's MCP server starts in. The plan outline needs the project's checkout; a plugin can't name it in `mcp_config.json`.
- **Mode commands in the prompt box.** The docs don't say whether the App's or the CLI's prompt box sends a slash command it doesn't know to the model as typed.
- **`PreInvocation` and the prompt.** The docs don't say whether `invocationNum` counts from 0 for each prompt or for the whole conversation, so the hook goes by the prompt's text.
