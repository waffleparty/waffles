import { adapterContext } from '../../core/backlog-adapter.ts'
import { afterShell } from '../../core/checkpoint.ts'
import type { Host, Prompt } from '../../core/host.ts'
import {
  ASSESS_PROMPT,
  BACKLOG_COMMAND,
  clearMode,
  completeMode,
  modeContext,
  MODES_TEXT,
  PROD_COMMAND,
  RAPID_COMMAND,
  runBacklog,
  runProd,
  runRapid,
  startMode,
  submitMode,
  wafflesMode,
} from '../../core/modes.ts'
import { endPlan, startPlan, submitPlan, tickPlan } from '../../core/plan.ts'
import { planContext, planRules } from '../../core/plan-prompt.ts'
import { permissionAsked, questionAsked, questionDone, saveUnattended, startUnattended, submitUnattended } from '../../core/unattended.ts'
import { forgetSession, pruneSessions } from '../node/host.ts'

/**
 * The events of a platform whose hook starts one process per event, in no platform's terms: each
 * platform's table (codex.ts) turns its event into one of these, and the answer into its own output.
 */
export type NeutralEvent =
  /** The session started, came back, was cleared, or was compacted; each gets the session's context again. */
  | { kind: 'start'; source: 'startup' | 'resume' | 'clear' | 'compact' }
  | { kind: 'prompt'; text: string; isAgent: boolean }
  /** Before a tool call; `isQuestion` when the tool asks the person a question. */
  | { kind: 'tool'; isQuestion: boolean; isAgent: boolean }
  /** The platform is about to ask the person to approve a call. */
  | { kind: 'permission'; isQuestion: boolean; isAgent: boolean }
  /** After a tool call that succeeded; `shell` for a shell command, with the folder it ran in where the platform says. */
  | { kind: 'toolDone'; isQuestion: boolean; shell: { command: string; cwd?: string } | null }
  | { kind: 'turnEnd'; isAgent: boolean }
  /** The session ended: `isClear` when the conversation was cleared, `isGone` when it can't come back. */
  | { kind: 'end'; isClear: boolean; isGone: boolean }

/** What the platform does with an event, in neutral terms; each platform shows what it can of it. */
export type NeutralAnswer = {
  /** Text the model reads with this event, one block per entry. */
  context: string[]
  /** A line the person reads, where the platform shows one. */
  notice?: string
  /** Why the call is refused; the platform refuses it. */
  deny?: string
}

/** What a handler needs besides the host: where the session's values are kept, for pruning and forgetting them. */
export type Session = { $: Host; sessionId: string; stateFolder: string }

/** The plugin's name, as a platform prefixes its commands with it. */
export const PREFIX = 'waffles'

// A leading slash command, `/name` or `/plugin:name`, alone or before the rest of the prompt.
const COMMAND = /^\/((?:[\w-]+:)?[\w-]+)(?:\s|$)/
const MODE_COMMANDS: readonly string[] = [PROD_COMMAND, RAPID_COMMAND, BACKLOG_COMMAND]

/**
 * A prompt's text as the core reads it. These platforms run every hook for a prompt the person sent, so
 * each is typed: none is a notification or a trigger.
 */
export function promptOf(text: string): Prompt {
  return { isPerson: true, isTyped: true, command: COMMAND.exec(text.trim())?.[1], isMeta: false, text }
}

/** The mode command a prompt is, exactly: `/prod`, `/rapid` or `/backlog-entry`, with or without the plugin's prefix; else null. */
export function modeCommandOf(text: string): string | null {
  const name = /^\/(?:([\w-]+):)?([\w-]+)$/.exec(text.trim())
  if (!name || (name[1] !== undefined && name[1] !== PREFIX)) return null
  return MODE_COMMANDS.includes(name[2]!) ? name[2]! : null
}

// The person's prompt was a waffles command, which the plugin ran: the model reads what it printed. A
// fact, not an order, as the modes' definitions are.
const ran = (name: string, text: string) => `waffles command: the person's prompt /${name} is a waffles command, and the waffles plugin has run it. It printed: ${text}`

async function start({ $, sessionId, stateFolder }: Session, source: Extract<NeutralEvent, { kind: 'start' }>['source']): Promise<NeutralAnswer> {
  await pruneSessions(stateFolder, sessionId).catch(error => $.log(`old sessions were not pruned: ${String(error)}`))
  if (source === 'clear') await clearMode($)
  await startPlan($).catch(error => $.log(`the plan outline did not start: ${String(error)}`))
  // These platforms have no system prompt section a plugin writes, so the rules come first in the
  // session's context, then the blocks of the first message.
  const blocks = [MODES_TEXT, planRules($.names), await modeContext($), await planContext($).catch(() => ''), await adapterContext($)]
  return { context: blocks.filter(Boolean) }
}

async function prompt($: Host, text: string): Promise<NeutralAnswer> {
  const typed = promptOf(text)
  // Read before the prompt starts or ends a run, so the model is told of the change.
  const before = await wafflesMode($)
  await submitUnattended($, typed)
  submitPlan($)
  const line = await submitMode($, typed, before)
  // The poll waits behind the reset `submitPlan` queued, so both are done before the process ends.
  await tickPlan($)
  const context = line === null ? [] : [line]
  const name = modeCommandOf(text)
  if (name === null) return { context }
  if (name === PROD_COMMAND) {
    const { text: printed, isHandover } = await runProd($)
    // The assessment starts in this turn: the prompt that would start it goes with the command.
    return { context: [...context, ran(name, printed), ...(isHandover ? [ASSESS_PROMPT] : [])], notice: printed }
  }
  const printed = name === RAPID_COMMAND ? await runRapid($) : await runBacklog($)
  return { context: [...context, ran(name, printed)], notice: printed }
}

async function tool($: Host, isQuestion: boolean, isAgent: boolean): Promise<NeutralAnswer> {
  if (!isQuestion) return { context: [] }
  const asked = await questionAsked($, isAgent)
  // The run's start question goes to the person. A hook can't close the dialog after a time, so it
  // waits for them; `toolDone` marks it off the screen.
  return 'deny' in asked ? { context: [], deny: asked.deny } : { context: [] }
}

async function toolDone($: Host, isQuestion: boolean, shell: { command: string; cwd?: string } | null): Promise<NeutralAnswer> {
  if (isQuestion) questionDone($)
  if (shell === null) return { context: [] }
  // A checkpoint that fails leaves the command's result as it was.
  const line = await afterShell($, shell.command, shell.cwd).catch(() => null)
  return { context: line === null ? [] : [line] }
}

async function end({ $, sessionId, stateFolder }: Session, isClear: boolean, isGone: boolean): Promise<NeutralAnswer> {
  if (isClear) await clearMode($)
  // A plan outline failure never stops the session's end.
  await endPlan($, sessionId, isClear).catch(error => $.log(`the plan outline did not end: ${String(error)}`))
  if (isGone) await forgetSession(stateFolder, sessionId)
  return { context: [] }
}

/**
 * Runs the core for one event of a session, in a process that serves this event alone: the values that
 * last come back from the session's values first, and go back to them after. A mode change's note
 * can't be appended to the conversation from here, so `notes` collects each one as the host's
 * `conversation.note`, and the answer's context starts with them.
 */
export async function handle(session: Session, event: NeutralEvent, notes: readonly string[]): Promise<NeutralAnswer> {
  const { $ } = session
  await startUnattended($)
  await startMode($)
  const answer = await (async (): Promise<NeutralAnswer> => {
    switch (event.kind) {
      case 'start':
        return start(session, event.source)
      case 'prompt':
        // A subagent's prompt is its brief, not the person's: the modes describe the main conversation.
        return event.isAgent ? { context: [] } : prompt($, event.text)
      case 'tool':
        return tool($, event.isQuestion, event.isAgent)
      case 'permission': {
        const message = permissionAsked($, { isQuestion: event.isQuestion, isAgent: event.isAgent })
        return message === null ? { context: [] } : { context: [], deny: message }
      }
      case 'toolDone':
        return toolDone($, event.isQuestion, event.shell)
      case 'turnEnd':
        if (!event.isAgent) await completeMode($)
        return { context: [] }
      case 'end':
        return end(session, event.isClear, event.isGone)
    }
  })()
  if (event.kind !== 'end' || !event.isGone) await saveUnattended($)
  return { ...answer, context: [...notes, ...answer.context] }
}
