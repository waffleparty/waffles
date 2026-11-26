import type { Names } from '../../core/host.ts'
import type { NeutralAnswer, NeutralEvent } from './neutral.ts'
import type { Platform } from './platform.ts'

// Google Antigravity's hooks, as its Hooks and Build plugins pages state them: each event's JSON on
// stdin, in camelCase, and the JSON each may answer with on stdout. Antigravity names no event for a
// prompt, a permission request, or the session's end: the prompt's work runs at the turn's first model
// call (PreInvocation), and a run refuses a call before it starts (PreToolUse).

/** The plugin's MCP server as Antigravity names it: the plugin's name, then the server's key in mcp_config.json. */
const SERVER = 'waffles_waffles'

/** What Antigravity calls its own things. */
export const NAMES: Names = {
  assistant: 'Antigravity',
  product: 'Antigravity',
  // mcp_config.json loads the tool eagerly, so the model calls it by this name and not through call_mcp_tool.
  planTool: `mcp_${SERVER}_plan`,
  ask: 'ask_question',
  planMode: "Antigravity's plan mode",
}

/** The shell tool's name in hook input. */
const SHELL = 'run_command'
/** The tool the model asks the person for more permissions with. */
const ASK_PERMISSION = 'ask_permission'

type Input = Record<string, unknown>

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

// The tool call in a PreToolUse or PostToolUse input: its name, and its arguments.
function callOf(input: Input): { name: string | undefined; args: Input } {
  const call = typeof input.toolCall === 'object' && input.toolCall !== null ? (input.toolCall as Input) : {}
  const args = typeof call.args === 'object' && call.args !== null ? (call.args as Input) : {}
  return { name: text(call.name), args }
}

/** Whether a call is to the plan outline tool: by its own name, or through call_mcp_tool where the tool loads lazily. */
export function isPlanCall(name: string | undefined, args: Input): boolean {
  return name === NAMES.planTool || (name === 'call_mcp_tool' && args.ServerName === SERVER && args.ToolName === 'plan')
}

function eventOf(name: string, input: Input): NeutralEvent | null {
  const call = callOf(input)
  const isQuestion = call.name === NAMES.ask
  // No input field marks a subagent's hook: each event counts as the main conversation's.
  const isAgent = false
  switch (name) {
    // It fires once, when a conversation starts: Antigravity sends no event for a resume, a clear, or a compaction.
    case 'SessionStart':
      return { kind: 'start', source: 'startup' }
    // It fires before each model call, with the person's last prompt each time.
    case 'PreInvocation': {
      const prompt = text(input.lastUserInput)
      return prompt === undefined ? null : { kind: 'prompt', text: prompt, isAgent, repeats: true }
    }
    case 'PreToolUse':
      if (call.name === undefined) return null
      // The model asks for more permissions: that asks the person, as a permission request does.
      if (call.name === ASK_PERMISSION) return { kind: 'permission', isQuestion: false, isAgent }
      // Its own tool is never refused; `outputOf` approves it.
      if (isPlanCall(call.name, call.args)) return { kind: 'tool', isQuestion: false, isAgent }
      return { kind: 'tool', isQuestion, isAgent, mayAsk: !isQuestion }
    // `error` holds the failure, a shell command's exit status among them; it is empty when the call worked.
    case 'PostToolUse': {
      if (call.name === undefined || text(input.error)) return null
      const command = call.name === SHELL ? text(call.args.CommandLine) : undefined
      return { kind: 'toolDone', isQuestion, shell: command === undefined ? null : { command, cwd: text(call.args.Cwd) } }
    }
    // A stop with background work still going isn't the turn's end: the loop may go on when it finishes.
    case 'Stop':
      return input.fullyIdle === false ? null : { kind: 'turnEnd', isAgent }
    default:
      return null
  }
}

const inject = (added: string) => ({ injectSteps: [{ systemMessage: { systemMessage: added } }] })

function outputOf(name: string, { context, deny, denyAsk }: NeutralAnswer, input: Input): object | null {
  const added = context.join('\n\n')
  switch (name) {
    // An injected step stays in the conversation, so these inject only what the core added.
    case 'SessionStart':
    case 'PreInvocation':
      return added ? inject(added) : {}
    case 'PreToolUse': {
      if (deny !== undefined) return { decision: 'deny', reason: deny }
      // During a run: a call the person has granted before runs, and one that would ask is refused.
      if (denyAsk !== undefined) return { decision: 'deny_unless_prior_grant', reason: denyAsk }
      const call = callOf(input)
      // MCP tools ask for approval by default; the plugin's own tool doesn't need it.
      return { decision: isPlanCall(call.name, call.args) ? 'auto_approve' : 'allow' }
    }
    // Antigravity reads nothing from these but the empty object, which lets the stop happen.
    case 'PostToolUse':
    case 'Stop':
      return {}
    default:
      return null
  }
}

/** Antigravity's translation table. */
export const antigravity: Platform = {
  names: NAMES,
  // The conversation's ID is the session's: every event of the conversation carries it. The first
  // workspace is the folder the session works in.
  session: input => {
    const sessionId = text(input.conversationId)
    const cwd = Array.isArray(input.workspacePaths) ? text(input.workspacePaths[0]) : undefined
    return sessionId && cwd ? { sessionId, cwd } : null
  },
  event: eventOf,
  output: outputOf,
  // Inside each hook's timeout in hooks.json: a checkpoint after a push takes up to a minute.
  budgetMs: name => (name === 'PostToolUse' ? 75_000 : 25_000),
  // Only an event Antigravity injects steps from can carry context; the rest wait for the next one.
  hasContext: name => name === 'SessionStart' || name === 'PreInvocation',
  defersContext: name => name === 'PreToolUse' || name === 'PostToolUse' || name === 'Stop',
}
