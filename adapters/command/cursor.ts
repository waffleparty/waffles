import type { Names } from '../../core/host.ts'
import type { NeutralAnswer, NeutralEvent } from './neutral.ts'
import type { Platform } from './platform.ts'

// Cursor's hooks, as its hooks reference (cursor.com/docs/hooks) states them: each event's JSON on
// stdin, and the JSON each may answer with on stdout. A plugin's hooks run command hooks only.

/** What Cursor calls its own things. */
export const NAMES: Names = {
  assistant: 'Cursor',
  product: 'Cursor',
  // Cursor's documentation doesn't say what name the model sees an MCP tool under, so the rules name
  // the server and the tool. cursor-mcp.json gives the MCP server the same name.
  planTool: "waffles MCP server's plan",
  // Nor does it name the tool the agent asks the person a question with: plain words, which the model
  // can follow with that tool or in the chat.
  ask: 'a multiple-choice question',
  planMode: "Cursor's Plan mode",
}

/** The shell tool's name in hook input. */
const SHELL = 'Shell'

// Cursor's hooks can't add context to a prompt: the session's start says where the mode's statements
// come instead. A fact, as the modes' definitions are.
export const LATE = `On ${NAMES.product}, the waffles hooks can't add text to a prompt. A statement of the mode after a change, and the one beside each prompt typed in backlog mode, come with the result of the next tool call instead.`

type Input = Record<string, unknown>

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

// Whether a shell call's result says it failed. Cursor sends the result as a JSON string, such as
// `{"exitCode":0,"stdout":"..."}`. A result that names no code counts as success.
export function isFailed(output: unknown): boolean {
  let value: unknown = output
  if (typeof output === 'string') {
    try {
      value = JSON.parse(output)
    } catch {
      return false
    }
  }
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { exitCode?: unknown; exit_code?: unknown }).exitCode ?? (value as { exit_code?: unknown }).exit_code
  return typeof code === 'number' && code !== 0
}

function eventOf(name: string, input: Input): NeutralEvent | null {
  const tool = text(input.tool_name)
  const args = typeof input.tool_input === 'object' && input.tool_input !== null ? (input.tool_input as Input) : {}
  switch (name) {
    // Cursor runs it for a new conversation only: none for a resume, a clear, or a compaction.
    case 'sessionStart':
      return { kind: 'start', source: 'startup' }
    case 'beforeSubmitPrompt': {
      const prompt = text(input.prompt)
      return prompt === undefined ? null : { kind: 'prompt', text: prompt, isAgent: false }
    }
    // Every tool, so context deferred from a prompt reaches the model at its first tool call. A shell
    // call that failed gets no checkpoint, but still carries that context.
    case 'postToolUse': {
      if (tool === undefined) return null
      const command = tool === SHELL && !isFailed(input.tool_output) ? text(args.command) : undefined
      return { kind: 'toolDone', isQuestion: false, shell: command === undefined ? null : { command, cwd: text(args.working_directory) ?? text(input.cwd) } }
    }
    case 'stop':
      return { kind: 'turnEnd', isAgent: false }
    case 'subagentStop':
      return { kind: 'turnEnd', isAgent: true }
    // A conversation that ended can be opened again from the history: its values stay until they are pruned.
    case 'sessionEnd':
      return { kind: 'end', isClear: false, isGone: false }
    default:
      return null
  }
}

function outputOf(name: string, { context, notice, isCommand }: NeutralAnswer): object | null {
  switch (name) {
    case 'sessionStart':
      return { additional_context: [...context, LATE].join('\n\n') }
    // The prompt's context can't go with it, so a waffles command stops here: the person reads its
    // text, and the model reads the change with the next tool call's result.
    case 'beforeSubmitPrompt':
      return isCommand ? { continue: false, ...(notice === undefined ? {} : { user_message: notice }) } : null
    case 'postToolUse': {
      const added = context.join('\n\n')
      return added ? { additional_context: added } : null
    }
    default:
      return null
  }
}

/** Cursor's translation table. */
export const cursor: Platform = {
  names: NAMES,
  // `conversation_id` comes with every agent event; `session_id`, the same ID, with the session's start and end.
  session: input => {
    const sessionId = text(input.conversation_id) ?? text(input.session_id)
    const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : []
    const cwd = text(roots[0]) ?? text(input.cwd)
    return sessionId && cwd ? { sessionId, cwd } : null
  },
  event: eventOf,
  output: outputOf,
  // Inside each hook's timeout in cursor-hooks.json: a checkpoint after a push takes up to a minute.
  budgetMs: name => (name === 'sessionEnd' ? 4_000 : name === 'postToolUse' ? 75_000 : 25_000),
  hasContext: name => name === 'sessionStart' || name === 'postToolUse',
  defersContext: name => name === 'beforeSubmitPrompt',
}
