import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PromptSubmitInput, Timer } from 'claude-code'

const running = atom({ plugin: 'waffles', key: 'run' } as const, false)

// A /waffles:non-interactive run lasts from its command until the person types a prompt.
const RUN_COMMAND = /(^|:)non-interactive$/
// Auto mode pauses after 3 classifier blocks in a row and prompts for every write until one
// is approved. If a deny doesn't lift that, every write is denied: past this many in a row
// the run is stuck, so it wraps up instead.
const STUCK_DENIALS = 5

const AWAY = "Denied: The user is away during a /waffles:non-interactive run and can't approve this. Sending the same action again gets the same answer."
const MAIN_NEXT = "Reach the goal another way if there is one. If there is none, leave the step to the user in the plan outline, with the exact command or step and this denial's text as the reason, and carry on with the rest of the work."
const AGENT_NEXT = 'Reach the goal another way if there is one. If there is none, report it in your result, with the exact command or step, and carry on with the rest of your piece.'
const MAIN_STUCK = `${STUCK_DENIALS} permission requests in a row have been denied, so work that needs approval can't go on. Start nothing new: leave what's blocked to the user in the plan outline, and finish as the skill's Finishing section says.`
const AGENT_STUCK = `${STUCK_DENIALS} permission requests in a row have been denied, so work that needs approval can't go on. Stop and report what you finished and what's left.`

// A run asks 1 question, at its start, while the person may still be there: the first one its
// main loop asks within START_WINDOW_MS of the command. The dialog has no timeout of its own, so
// the question ends here after START_ANSWER_MS.
const QUESTION = 'AskUserQuestion'
const START_WINDOW_MS = 300_000
const START_ANSWER_MS = 60_000
const NO_ANSWER = `No answer in ${START_ANSWER_MS / 1000} seconds. The user has stepped away. Take what the waffles:non-interactive skill says for no answer, and ask nothing else during this run.`
const CLOSED = 'The question was closed without an answer. Take what the waffles:non-interactive skill says for no answer, and ask nothing else during this run.'
const MAIN_QUESTION = "Denied: The user is away during a /waffles:non-interactive run and can't answer. A run asks 1 question, at its start. Make the decision yourself, note it on its step in the plan outline if it is worth checking, and keep going."
const AGENT_QUESTION = "Denied: The user is away during a /waffles:non-interactive run and can't answer. Report the question in your result, and carry on with the rest of your piece."

// Module variables start over on a reload; startUnattended restores the run from $.state.
let isRun = false
let denials = 0
// When the run's command was typed; null with no run, and once its question is asked. A reload
// leaves it null: the run then asks nothing, which the skill treats as no answer.
let startedAt: number | null = null
// The start question is on screen.
let isAsking = false
// Calls the engine called writes (anything not read-only), until they finish.
const writes = new Set<string>()

export const isRunCommand = (name: string | undefined) => RUN_COMMAND.test(name ?? '')

// Typed by the person, not a notification, a trigger or a message delivered mid-turn.
export const isTypedPrompt = (e: PromptSubmitInput) =>
  (e.origin.kind === 'composer' || e.origin.kind === 'bridge') && !e.turnId

/** A run is active, for the footer under the prompt. */
export async function isRunning($: EngineInterface) {
  return read($, running)
}

// The module's one session.start hook calls this.
export async function startUnattended($: EngineInterface) {
  isRun = await read($, running)
}

// The module's one prompt.submit hook calls this.
export async function submitUnattended($: EngineInterface, e: PromptSubmitInput) {
  if (!isTypedPrompt(e)) return
  isRun = isRunCommand(e.command?.name)
  denials = 0
  isAsking = false
  startedAt = null
  await update($, running, () => isRun)
  // Last, so a clock that can't be read never keeps a run from starting: the run then asks nothing.
  if (isRun) startedAt = await $.clock.now().catch(() => null)
}

/** Ends a run: the person changed the mode by hand, or cleared the conversation. */
export async function endRun($: EngineInterface) {
  isRun = false
  denials = 0
  isAsking = false
  startedAt = null
  await update($, running, () => false)
}

export function registerUnattended(on: On) {
  // Nobody can answer a prompt during a run, so deny it rather than wait all night.
  on('classic.PermissionRequest', ($, e, next) => {
    if (!isRun) return next(e)
    // The start question's own dialog: the person may still be there to answer it.
    if (isAsking && e.tool_name === QUESTION && e.agent_id === undefined) return next(e)
    denials += 1
    const isAgent = e.agent_id !== undefined
    const message =
      denials >= STUCK_DENIALS ? (isAgent ? AGENT_STUCK : MAIN_STUCK) : `${AWAY} ${isAgent ? AGENT_NEXT : MAIN_NEXT}`
    return { decision: { behavior: 'deny', message } }
  })

  // The run's start question goes to the person for START_ANSWER_MS; every other question during
  // a run is refused at once, so none waits all night.
  on('tool.call', { tool: QUESTION }, async ($, e, next) => {
    if (!isRun) return next(e)
    if (e.agentId !== undefined) return { deny: AGENT_QUESTION }
    // Taken before the clock is read, so 2 questions at once, or a clock that fails, can't both use it.
    const at = startedAt
    startedAt = null
    const isStart = at !== null && (await $.clock.now()) - at <= START_WINDOW_MS
    if (!isStart) return { deny: MAIN_QUESTION }

    isAsking = true
    let timer: Timer | undefined
    const timeout = new Promise<'timeout'>(resolve => {
      timer = $.clock.after(START_ANSWER_MS, () => resolve('timeout'))
    })
    try {
      // Settling here while the dialog is open ends the dispatch beneath, and with it the dialog.
      const answer = await Promise.race([next(e).catch(() => 'closed' as const), timeout])
      if (answer === 'timeout') return { deny: NO_ANSWER }
      if (answer === 'closed') return { deny: CLOSED }
      return answer
    } finally {
      timer?.cancel()
      isAsking = false
    }
    // A check that fails must not leave a dialog open all night: during a run, refuse.
  }).catch(($, e, next) => (isRun ? { deny: MAIN_QUESTION } : next(e)))

  // A write that ran means approvals are flowing again: the count starts over.
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (isRun && e.tool_use_id && !e.isReadOnly) writes.add(e.tool_use_id)
    return r
  })
  on('classic.PostToolUse', ($, e, next) => {
    if (writes.delete(e.tool_use_id)) denials = 0
    return next(e)
  })
  on('classic.PostToolUseFailure', ($, e, next) => {
    writes.delete(e.tool_use_id)
    return next(e)
  })
}
