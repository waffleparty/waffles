# MCP server

Cursor, Codex, and Antigravity take tools only from MCP servers: their plugins cannot register a tool in code. The waffles MCP server gives them the [plan outline](plan-outline.md) tool. Claude Code and OpenCode register the tool themselves and do not need it.

## What it offers

| Item | Value |
| --- | --- |
| Server name | `waffles` |
| Tool | `plan`: the plan outline tool, with the same description and input as on Claude Code |
| Instructions | The plan outline's rules, which these platforms have no plugin-written system prompt for |
| Transport | stdio, one JSON-RPC message per line. Logs go to stderr. |
| Protocol | MCP `2026-07-28` per request, and `2025-11-25` after an `initialize` |

A refused call (an unknown step, no active goal) is a tool result with `isError: true` and the reason, so the model reads it and corrects the call.

The server needs Node.js 22.18 or later and no npm packages.

## Add it to a client

Add an entry to the client's MCP configuration, with the path to the plugin's folder. Name the entry `waffles`: most clients show the tool to the model under the entry's name, such as `mcp__waffles__plan`.

```json
{
  "mcpServers": {
    "waffles": {
      "command": "node",
      "args": ["/path/to/waffles/adapters/mcp/server.ts"]
    }
  }
}
```

Set `env` in the entry when the client shows tools under another pattern, or starts the server outside the project folder:

```json
{
  "mcpServers": {
    "waffles": {
      "command": "node",
      "args": ["/path/to/waffles/adapters/mcp/server.ts"],
      "env": { "WAFFLES_PLAN_TOOL": "waffles_plan", "WAFFLES_CWD": "/path/to/project" }
    }
  }
}
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `WAFFLES_PLAN_TOOL` | `mcp__waffles__plan` | The tool's name as the model sees it, used in the rules |
| `WAFFLES_ASK_TOOL` | `a multiple-choice question` | The tool the model asks the person a question with, used in the rules. The default reads as plain words, so on a client with no such tool the model asks in the chat. |
| `WAFFLES_SESSION_ID` | A new ID for each server process | The session the mode and the active goal belong to. Set it to the ID the platform's hooks use, so the hooks and the server agree. |
| `WAFFLES_CWD` | The process's working directory | The folder whose checkout holds the plan outline |
| `WAFFLES_STATE_DIR` | `waffles` in `XDG_STATE_HOME`, else `~/.local/state/waffles` | Where the session's values are kept, shared with the hooks |
| `WAFFLES_DEBUG` | Not set | When set, the plan outline's failures go to stderr with their stacks |

## Sessions

MCP gives a server no session ID. With `WAFFLES_SESSION_ID` set, a new server process continues the session's active goal. Without it, each server process is its own session: it starts with no active goal, a `show` call lists the open goals, and its values are removed when it exits.

The server starts the plan outline at the client's first `initialize` or `2026-07-28` request, and keeps the session's lock on its active goal live while the process runs. When the client closes stdin, or stops the process with `SIGTERM`, the server answers the calls under way, releases the lock, and exits with code 0.
