# Cursor

waffles runs on Cursor through Cursor's plugin format and its command hooks. Cursor loads no plugin code: for each hook event it starts `node adapters/command/cli.ts cursor <event>`, hands it the event's JSON on stdin, and reads the answer from stdout. Each event runs in its own process, so the session's values (the mode, an unattended run's counters, the active goal) live in JSON files in the state folder (`WAFFLES_STATE_DIR`, else `$XDG_STATE_HOME/waffles`, else `~/.local/state/waffles`). A conversation's ID is its session.

## What works

| Feature | On Cursor |
| --- | --- |
| Skills | All skills in `skills/`. Cursor runs a skill as `/<skill>`. The modes' rules name a skill by its name and a run as `/non-interactive`. |
| Modes | The modes' rules and the current mode go to the model when a conversation starts. A mode command changes the mode (see [Mode commands](#mode-commands)). The model reads a change, and backlog mode's statement beside each prompt, with the result of its next tool call (see [Context per prompt](#context-per-prompt)). |
| Plan outline | Its rules and the active goal's tree, or the open goals, go to the model when a conversation starts. The plan outline tool comes from the plugin's MCP server (`adapters/command/cursor-mcp.json`, server `waffles`). |
| Checkpoint | After a `git push` or `gh pr create` that exits 0, the plan outline goes into the pull request's description, and the model reads the checkpoint's line after the command's result. |
| Backlog adapter | A repo whose AGENTS.md names a backlog adapter gets the init check request when a conversation starts. |

| Cursor event | What the hook does |
| --- | --- |
| `sessionStart` | Adds the rules, the mode, and the plan outline as `additional_context`. |
| `beforeSubmitPrompt` | Runs a mode command and stops its prompt; keeps the context of any other prompt for the next tool call. |
| `postToolUse` | Hands over the context kept from a prompt, and adds the checkpoint's line after a shell command. |
| `stop` | Marks the end of a turn, which takes over pending rapid work once the model has read it. |
| `sessionEnd` | Releases the conversation's lock on its active goal. |

## What does not work

- **No pane.** Cursor has no place a plugin draws in. The plan outline shows only in the model's context and in the goal files in the plan outline's store (`<git dir>/waffles/plan/`).
- **No footer.** The mode and an active run don't show under the prompt. A mode command's text shows only as the message Cursor shows for a stopped prompt.
- **No auto effort.** Cursor gives a hook no way to set the reasoning effort.
- **No unattended runs.** Cursor has no event before a permission prompt, and its documentation names no tool the agent asks a question with, so no hook can refuse either. A `/non-interactive` run still loads its skill and tells the model the mode, but a permission prompt or a question waits for you.
- **No context per prompt.** See [Context per prompt](#context-per-prompt).
- **No statement after a compaction or a resume.** Cursor runs `sessionStart` only for a new conversation. Its `preCompact` event can't add context.
- **Subagents' steps aren't marked.** A step isn't marked as a subagent's while it works.
- **Cloud agents.** Cursor's cloud agents load hooks from a repo's `.cursor/hooks.json` and from team and enterprise settings; its documentation doesn't list plugin hooks among them. They don't run `sessionStart` or `sessionEnd`.

## Context per prompt

`beforeSubmitPrompt` can only let a prompt go on or stop it, with a message for you. It adds nothing the model reads. So the hook keeps what it would add to a prompt, and the next `postToolUse` of the conversation adds it as `additional_context`, after that tool's result:

| What | When the model reads it |
| --- | --- |
| The rules and the mode | At the conversation's start. |
| A mode change, and a command's text | With the result of the next tool call, in this turn or a later one. |
| Backlog mode's statement beside a prompt | With the result of the turn's first tool call. A reply with no tool call goes without it. |
| The checkpoint's line | With the result of the push. |

The session's start tells the model this. Until the model's first tool call in a turn, it acts on the last statement it read.

## Mode commands

The hook recognizes a prompt that is exactly `/prod`, `/rapid`, or `/backlog-entry`, with or without the `waffles:` prefix, and runs the command. Since the model can't read the command's text with the prompt, the hook stops the prompt: Cursor shows the command's text in its place, and no turn runs. The model reads the change with the result of its next tool call.

`/prod` after rapid work: the model reads, with its next tool call, that rapid work is pending and an assessment comes first. The next conversation's start states the pending rapid work again, since the hook can't tell when the model read it.

Cursor's documentation doesn't say whether a prompt that starts with `/` and names no command reaches `beforeSubmitPrompt` as typed.

## Install

Cursor reads `.cursor-plugin/plugin.json`. It names the skills, the hooks file (`adapters/command/cursor-hooks.json`), and the MCP servers file (`adapters/command/cursor-mcp.json`). The hooks and the MCP server need Node.js 22.18 or later as `node` on the PATH.

No marketplace lists waffles for Cursor yet. To install from a checkout:

1. Put the checkout at `~/.cursor/plugins/local/waffles`, for example by linking it: `ln -s ~/src/waffles ~/.cursor/plugins/local/waffles`. Cursor's documentation says to copy the plugin's files there; a link is not documented.
2. Restart Cursor, or run **Developer: Reload Window**.
3. Open **Customize** and check that the skills, the hooks, and the `waffles` MCP server are there. Cursor shows the server as `plugin-waffles-waffles` and asks before the model's first call to it.

On Enterprise, local plugins load only with **Allow Local Plugin Imports** on.

## Limits

- **The MCP server's session.** Cursor gives an MCP server no conversation ID, so the server is its own session: it starts with no active goal, and a `show` call lists the open goals. The hooks' plan outline context and the tool can name different active goals.
- **The MCP server's folder.** Cursor's documentation doesn't say which folder a plugin's MCP server starts in. The server works on the checkout of its working folder (`WAFFLES_CWD` is not set), so the plan outline tool works only when that is the project.
- **The plan outline tool's name.** Cursor's documentation doesn't say what name the model sees an MCP tool under, so the rules name it "the waffles MCP server's plan tool".
- **Session end.** Cursor runs `sessionEnd` without waiting for it, and a closed conversation can be opened again, so the session's values stay until they are 7 days old.
- **Windows.** The hooks' commands use `${CURSOR_PLUGIN_ROOT}` as a POSIX shell expands it. Cursor runs hooks through PowerShell on Windows, which doesn't.
