import type { Names } from '../../core/host.ts'
import type { NeutralAnswer, NeutralEvent } from './neutral.ts'
import type { Platform } from './platform.ts'

// OpenAI Codex's hooks, as its hooks reference and the hook input and output schemas of Codex 0.147
// state them: each event's JSON on stdin, and the JSON each may answer with on stdout.

/** What Codex calls its own things. */
export const NAMES: Names = {
  assistant: 'Codex',
  product: 'Codex',
  // Codex names an MCP server's tool `mcp__<server>__<tool>`; the plugin's MCP config names the server `waffles`.
  planTool: 'mcp__waffles__plan',
  ask: 'request_user_input',
  planMode: "Codex's Plan mode",
  // The plugin's skills are `waffles:<skill>`, and a prompt that starts with the run's skill starts a run.
  skill: name => `waffles:${name}`,
  runCommand: '/waffles:non-interactive',
  // The hook runs a prompt that is exactly a mode command.
  command: name => `/${name}`,
}

/** The shell tool's name in hook input. */
const SHELL = 'Bash'

type Input = Record<string, unknown>

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

// Whether a shell call's result says it failed. Codex sends the result the model reads: text that
// starts `Exit code: N`, or an object with an exit code. A result that names no code counts as success.
export function isFailed(response: unknown): boolean {
  if (typeof response === 'string') {
    const code = /^(?:Exit code|Process exited with code):?\s*(-?\d+)/m.exec(response)?.[1]
    return code !== undefined && code !== '0'
  }
  if (typeof response !== 'object' || response === null) return false
  const r = response as { exit_code?: unknown; exitCode?: unknown; metadata?: { exit_code?: unknown } }
  const code = r.exit_code ?? r.exitCode ?? r.metadata?.exit_code
  return typeof code === 'number' && code !== 0
}

function eventOf(name: string, input: Input): NeutralEvent | null {
  const tool = text(input.tool_name)
  const args = typeof input.tool_input === 'object' && input.tool_input !== null ? (input.tool_input as Input) : {}
  const isQuestion = tool === NAMES.ask
  // Codex adds `agent_id` to the input of a hook that runs for a subagent.
  const isAgent = text(input.agent_id) !== undefined
  switch (name) {
    case 'SessionStart': {
      const source = text(input.source)
      return { kind: 'start', source: source === 'resume' || source === 'clear' || source === 'compact' ? source : 'startup' }
    }
    case 'UserPromptSubmit': {
      const prompt = text(input.prompt)
      return prompt === undefined ? null : { kind: 'prompt', text: prompt, isAgent }
    }
    case 'PreToolUse':
      return tool === undefined ? null : { kind: 'tool', isQuestion, isAgent }
    case 'PermissionRequest':
      return tool === undefined ? null : { kind: 'permission', isQuestion, isAgent }
    case 'PostToolUse': {
      if (tool === undefined || isFailed(input.tool_response)) return null
      const command = tool === SHELL ? text(args.command) : undefined
      return { kind: 'toolDone', isQuestion, shell: command === undefined ? null : { command, cwd: text(args.workdir) } }
    }
    case 'Stop':
      return { kind: 'turnEnd', isAgent: false }
    case 'SubagentStop':
      return { kind: 'turnEnd', isAgent: true }
    // Codex sends `reason: "other"` for every end, and a session can be resumed later: its values stay
    // until they are pruned.
    case 'SessionEnd':
      return { kind: 'end', isClear: false, isGone: false }
    default:
      return null
  }
}

function outputOf(name: string, { context, notice, deny }: NeutralAnswer): object | null {
  const added = context.join('\n\n')
  const message = notice === undefined ? {} : { systemMessage: notice }
  switch (name) {
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return added || notice !== undefined
        ? { ...message, ...(added ? { hookSpecificOutput: { hookEventName: name, additionalContext: added } } : {}) }
        : null
    case 'PreToolUse':
      return deny === undefined ? null : { hookSpecificOutput: { hookEventName: name, permissionDecision: 'deny', permissionDecisionReason: deny } }
    case 'PermissionRequest':
      return deny === undefined ? null : { hookSpecificOutput: { hookEventName: name, decision: { behavior: 'deny', message: deny } } }
    // Codex reads JSON from these when the hook exits 0: an empty object lets the turn end.
    case 'Stop':
    case 'SubagentStop':
      return {}
    default:
      return null
  }
}

/** Codex's translation table. */
export const codex: Platform = {
  names: NAMES,
  session: input => {
    const [sessionId, cwd] = [text(input.session_id), text(input.cwd)]
    return sessionId && cwd ? { sessionId, cwd } : null
  },
  event: eventOf,
  output: outputOf,
  // Inside each hook's timeout in codex-hooks.json: SessionEnd gets 3 seconds at most, and a
  // checkpoint after a push up to a minute.
  budgetMs: name => (name === 'SessionEnd' ? 2_500 : name === 'PostToolUse' ? 75_000 : 25_000),
  // Only an event Codex reads context from can carry a mode change's note.
  hasContext: name => name === 'SessionStart' || name === 'UserPromptSubmit' || name === 'PostToolUse',
}
