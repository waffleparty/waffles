# MCP server

Cursor, Codex, and Antigravity take tools only from MCP servers: their plugins cannot register a tool or a slash command in code. The waffles MCP server gives them the [plan outline](plan-outline.md) tool, and the mode commands as MCP prompts, which most clients show as slash commands. Claude Code and OpenCode register these themselves and do not need it.

## What it offers

| Item | Value |
| --- | --- |
| Server name | `waffles` |
| Tools | `plan`: the plan outline tool, with the same description and input as on Claude Code. `mode`: reads the session's mode, or sets it with `{ "set": "production" \| "rapid" \| "backlog" }`, for a client that shows no prompts. |
| Prompts | `prod`, `rapid`, `backlog-entry`: getting one changes the mode, as the command does on Claude Code. Its message is the mode statement the model reads; its `description` is the text Claude Code shows the person. |
| Resources | `waffles://plan-outline` (`text/plain`): what `show` prints, the active goal's tree and the other open goals, or the open goals. A subscriber is told when a tool call or the heartbeat changed it. |
| Instructions | The modes' definitions, then the plan outline's rules, which these platforms have no plugin-written system prompt for |
| Transport | stdio, one JSON-RPC message per line. Logs go to stderr. |
| Protocol | MCP `2026-07-28` per request, and `2025-11-25` after an `initialize` |

A refused call (an unknown step, no active goal) is a tool result with `isError: true` and the reason, so the model reads it and corrects the call. A tool that fails is a tool result with `isError: true` and a short reason too; the stack goes to stderr.

The current mode is not in the instructions: a client reads them once or caches them, so a mode statement there would go stale at the first change, and a fresh one would change the client's system prompt. The instructions say to call the `mode` tool with no input to read the mode, and each prompt and each `mode` call with `set` returns the statement of the change. They also say that no mode statement comes with the first message, unless `WAFFLES_HOOKS` is `1`: the platform's hooks then send one. On these clients no statement comes beside a prompt typed in backlog mode: the platforms give the server no hook on the person's prompts.

The server needs Node.js 22.18 or later and no npm packages.

## Notifications

| Notification | `2025-11-25` | `2026-07-28` |
| --- | --- | --- |
| `notifications/resources/updated` | After `resources/subscribe` with the URI, until `resources/unsubscribe` | On a `subscriptions/listen` stream that names the URI in `resourceSubscriptions` |
| `notifications/tools/list_changed`, `prompts/…`, `resources/…` | To an initialized client | On a stream that asks for `toolsListChanged`, `promptsListChanged`, or `resourcesListChanged` |

The server announces `listChanged` only for a list a module changes while the process runs; no module does today, so a listen stream's acknowledgement leaves list changes out. A `2026-07-28` stream ends when the client sends `notifications/cancelled` with the stream's request ID, or when the server ends, which answers the `subscriptions/listen` request.

## Add it to a client

Add an entry to the client's MCP configuration, with the path to the plugin's folder. Name the entry `waffles`: most clients show the tools to the model under the entry's name, such as `mcp__waffles__plan`.

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
      "env": { "WAFFLES_TOOL_PREFIX": "waffles_", "WAFFLES_CWD": "/path/to/project" }
    }
  }
}
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `WAFFLES_TOOL_PREFIX` | `mcp__waffles__` | What comes before a tool's name as the model sees it, for every tool the instructions name. Set it to an empty string where the client shows the bare name. |
| `WAFFLES_PLAN_TOOL` | The prefix and `plan` | The plan outline tool's whole name as the model sees it, in place of the prefix |
| `WAFFLES_ASK_TOOL` | `a multiple-choice question` | The tool the model asks the person a question with, used in the rules. The default reads as plain words, so on a client with no such tool the model asks in the chat. |
| `WAFFLES_MCP_MODULES` | Every module | The modules to offer, comma-separated: `modes`, `plan`. The server announces a capability only for what they provide. |
| `WAFFLES_SESSION_ID` | A new ID for each server process | The session the mode and the active goal belong to. Set it to the ID the platform's hooks use, so the hooks and the server agree. |
| `WAFFLES_CWD` | The process's working directory | The folder whose checkout holds the plan outline |
| `WAFFLES_HOOKS` | Not set | `1` where the platform's hooks run beside the server and send the mode statement with the first message. The instructions then leave out that no statement comes. The plugin's MCP configurations for Codex, Cursor, and Antigravity set it. On the Codex CLI, which runs no plugin hooks, it still leaves the instructions true: it only removes that sentence, and the `mode` tool still returns the mode. |
| `WAFFLES_STATE_DIR` | `waffles` in `XDG_STATE_HOME`, else `~/.local/state/waffles` | Where the session's values are kept, shared with the hooks |
| `WAFFLES_DEBUG` | Not set | When set, the plan outline's failures go to stderr with their stacks |

## Sessions

MCP gives a server no session ID. With `WAFFLES_SESSION_ID` set, a new server process continues the session's mode and active goal. Without it, each server process is its own session: it starts in production mode with no active goal, a `show` call lists the open goals, and its values are removed when it exits.

The server keeps one Host and one in-memory record per session. It starts a session's modules at the session's first request (the `initialize`, or a `2026-07-28` client's first request), gives them a heartbeat every 5 seconds, which keeps the session's lock on its active goal live, and ends them when the process ends. When the client closes stdin, or stops the process with `SIGTERM`, the server answers the calls under way, ends the listen streams, releases the lock, and exits with code 0.

The function that names a request's session (`idOf` in `adapters/mcp/sessions.ts`) reads only `WAFFLES_SESSION_ID` today; a session ID from a request's `_meta`, or from a hook's tool argument, is a change to it alone.

## Adding a tool, a prompt, or a resource

Content comes in modules, one file each in `adapters/mcp/`: `modes.ts` and `plan.ts` today. `server.ts` holds the transport and the protocol only and reads the content from the registry (`registry.ts`), so a new tool, prompt, or resource changes no protocol code. A module can contribute:

| Field | What it is |
| --- | --- |
| `tools` | Each with `name`, `description`, `inputSchema`, and optional `title`, `outputSchema`, `annotations` (`readOnlyHint` and the other hints), and `nameVariable` (a variable that replaces the tool's whole name as the model sees it). `call(session, input)` returns `{ text }`, `{ value }` (sent as `structuredContent` with its JSON as the text), or `{ refusal }` (`isError: true`). A call that throws is a tool error, never a crash. |
| `prompts` | Each with `name`, `description`, and optional `arguments`. `get(session, args)` may act, and returns the `messages` to add to the conversation and an optional `description`. |
| `resources` | Each with `uri`, `name`, `mimeType`, and `read(session)`. With `isWatched`, the module calls `session.changed(uri)` on each change, and subscribers are told. |
| `instructions` | `({ names, seenAs }) => string`: the module's block of the instructions. `seenAs('mode')` is a tool's name as the model sees it. |
| `start`, `tick`, `end` | Handlers for a session's first request, its heartbeat, and the end of the process |
| `listChanges` | The lists the module changes while the process runs; it tells of each change with `session.listChanged(kind)` |

A handler gets the request's `Session`: its `id`, its Host (`$`), and `noting(work)`, which returns the notes the core added to the conversation while `work` ran. The `mode` tool, from `modes.ts`:

```ts
const MODE_TOOL: Tool = {
  name: 'mode',
  description: 'Reads or sets the waffles mode of this session. …',
  inputSchema: {
    type: 'object',
    properties: { set: { type: 'string', enum: ['production', 'rapid', 'backlog'] } },
    additionalProperties: false,
  },
  // Not read-only: a call with set changes the mode.
  annotations: { idempotentHint: true, openWorldHint: false },
  call: async (session, input) => {
    if (input.set === undefined) return { text: (await session.noting(() => modeContext(session.$))).value }
    // …
    return { text: (await change(session, input.set)).model }
  },
}

export const modesModule: Module = { name: 'modes', tools: [MODE_TOOL], prompts: [/* … */], instructions: /* … */ }
```

A new module goes into the list in `adapters/mcp/modules.ts`, whose order is the order of the instructions and the lists. Its name is what `WAFFLES_MCP_MODULES` selects it by.
