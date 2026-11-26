# Codex

waffles runs on OpenAI Codex through Codex's plugin format and its command hooks. Codex loads no plugin code: for each hook event it starts `node adapters/command/cli.ts codex <event>`, hands it the event's JSON on stdin, and reads the answer from stdout. Each event runs in its own process, so the session's values (the mode, an unattended run's counters, the active goal) live in JSON files in the state folder (`WAFFLES_STATE_DIR`, else `$XDG_STATE_HOME/waffles`, else `~/.local/state/waffles`).

## What works

| Feature | On Codex |
| --- | --- |
| Skills | All skills in `skills/`, named `waffles:<skill>`. |
| Modes | The modes' rules and the current mode go to the model at the session's start, after a resume, a clear, and a compaction. A mode command changes the mode (see [Mode commands](#mode-commands)). In backlog mode each prompt carries the mode beside it. |
| Unattended runs | A prompt that starts with `/waffles:non-interactive` starts a run, and the next prompt ends it. During a run, a permission request is denied with what to do instead, and after 5 denials in a row the run is told to wrap up. The run's first question (`request_user_input`) within 5 minutes of its start goes to you; every later one is refused. |
| Plan outline | Its rules and the active goal's tree, or the open goals, go to the model at the session's start. The plan outline tool comes from the plugin's MCP server (`mcp.json`, server `waffles`), which the model calls as `mcp__waffles__plan`. |
| Checkpoint | After a `git push` or `gh pr create` that exits 0, the plan outline goes into the pull request's description, and the model reads the checkpoint's line. |
| Backlog adapter | A repo whose AGENTS.md names a backlog adapter gets the init check request at the session's start. |

## What does not work

- **No pane.** Codex has no place a plugin draws in. The plan outline shows only in the model's context and in the goal files in `<git dir>/waffles/plan/`.
- **No footer.** The mode and an active run don't show under the prompt. A mode command's text shows as a warning line, where Codex shows one.
- **No auto effort.** Codex gives a hook no way to set the reasoning effort.
- **The start question has no time limit.** A hook can't close Codex's question after 60 seconds, so the run's first question waits for you.
- **Denials don't start over after a write.** On Claude Code, a write that runs during a run resets the count of denials. Codex doesn't say whether a call is a write, so the count resets only when a run starts or ends.
- **Subagents' steps aren't marked.** A step isn't marked as a subagent's while it works.

## Mode commands

Codex has no slash commands a plugin registers. The hook recognizes a prompt that is exactly `/prod`, `/rapid`, or `/backlog-entry`, with or without the `waffles:` prefix, and runs the command. The prompt still goes to the model, with the mode change and the command's text added as context, so the model only confirms it. A `/prod` that ends rapid work starts the assessment of that work in the same turn.

The Codex CLI's composer refuses a slash command it doesn't know ("Unrecognized command"), so there these prompts reach the hook only through `codex exec "/rapid"` and other clients that send the text as typed.

## Install

Codex reads the root `plugin.json` (the Agent Plugins format). Its `extensions.com.openai` object names the hooks file, `adapters/command/codex-hooks.json`; `mcp.json` names the MCP server. The hooks need Node.js 22.18 or later as `node` on the PATH.

No marketplace lists waffles for Codex yet. To install from a checkout:

1. Make a marketplace folder with `.agents/plugins/marketplace.json` that lists the plugin, with the checkout (or a copy) under the folder:

   ```json
   {
     "name": "waffles-local",
     "plugins": [
       { "name": "waffles", "source": { "source": "local", "path": "./plugins/waffles" }, "policy": { "installation": "AVAILABLE" }, "category": "Developer Tools" }
     ]
   }
   ```

2. Add the marketplace and install the plugin:

   ```sh
   codex plugin marketplace add <marketplace folder>
   codex plugin add waffles@waffles-local
   ```

3. Review and trust the plugin's hooks with `/hooks` in Codex. Codex runs no hook from a plugin until you trust it, and asks again after an update changes it.

### Hooks on the Codex CLI

Codex's documentation supports plugin hooks only for plugins installed by hand in the Codex desktop app. In Codex CLI 0.147, the plugin's hooks didn't run, though its skills and its MCP server loaded. To use the hooks with the CLI, add them to your own hooks file:

1. Clone the repo, for example to `~/src/waffles`.
2. Copy `adapters/command/codex-hooks.json` to `~/.codex/hooks.json` (or merge its `hooks` into the one you have), and replace each `${PLUGIN_ROOT}` with the clone's path.
3. Trust the hooks with `/hooks`.

## Limits

- **Public directory.** Codex's public plugin directory doesn't accept plugins that contain lifecycle hooks. waffles can be installed from its own marketplace, or published to a workspace.
- **Context size.** The session's start adds about 7,000 characters. The hooks file raises the session start hook's `additionalContextLimit` to 8,000 tokens, so Codex passes it whole rather than saving it to a file.
- **Session end.** Codex gives `SessionEnd` 3 seconds at most and the same reason for every end, so the session's values stay until they are 7 days old; a resumed session gets them back.
- **Windows.** The hooks file has no `commandWindows` entries.
