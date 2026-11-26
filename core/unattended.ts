import { memoryOf, type Host, type Prompt } from './host.ts'

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
const START_WINDOW_MS = 300_000
/** How long the run's start question waits for the person. */
export const START_ANSWER_MS = 60_000
/** The answer to a start question nobody answered in time. */
export const NO_ANSWER = `No answer in ${START_ANSWER_MS / 1000} seconds. The user has stepped away. Take what the waffles:non-interactive skill says for no answer, and ask nothing else during this run.`
/** The answer to a start question closed without an answer. */
export const CLOSED = 'The question was closed without an answer. Take what the waffles:non-interactive skill says for no answer, and ask nothing else during this run.'
const MAIN_QUESTION = "Denied: The user is away during a /waffles:non-interactive run and can't answer. A run asks 1 question, at its start. Make the decision yourself, note it on its step in the plan outline if it is worth checking, and keep going."
const AGENT_QUESTION = "Denied: The user is away during a /waffles:non-interactive run and can't answer. Report the question in your result, and carry on with the rest of your piece."

// What one process keeps for one session. `startUnattended` reads the run back from the session's
// values, with the denials, the start question's time and its dialog, which `saveUnattended` writes
// back for an adapter whose process serves one event. A process that lasts keeps them here alone.
type Vars = {
  isRun: boolean
  denials: number
  // When the run's command was typed; null with no run, and once its question is asked. A process
  // that starts after a reload leaves it null: the run then asks nothing, which the skill treats as no answer.
  startedAt: number | null
  // The start question is on screen.
  isAsking: boolean
  // Calls the platform called writes (anything not read-only), until they finish.
  writes: Set<string>
}
const vars = ($: Pick<Host, 'memory'>) =>
  memoryOf<Vars>($, 'unattended', () => ({ isRun: false, denials: 0, startedAt: null, isAsking: false, writes: new Set() }))

export const isRunCommand = (name: string | undefined) => RUN_COMMAND.test(name ?? '')

/** A run is active, for a view. */
export async function isRunning($: Host) {
  return $.state.get('run')
}

/** The session started, or the process did: the run comes back from the session's values. */
export async function startUnattended($: Host) {
  const v = vars($)
  v.isRun = await $.state.get('run')
  v.denials = await $.state.get('runDenials')
  v.startedAt = await $.state.get('runStartedAt')
  v.isAsking = await $.state.get('runAsking')
}

/**
 * Writes what this process changed of the run to the session's values, for the next process. An adapter
 * whose process serves one event calls it at the event's end, after `startUnattended` at its start.
 */
export async function saveUnattended($: Host) {
  const v = vars($)
  if ((await $.state.get('runDenials')) !== v.denials) await $.state.set('runDenials', v.denials)
  if ((await $.state.get('runStartedAt')) !== v.startedAt) await $.state.set('runStartedAt', v.startedAt)
  if ((await $.state.get('runAsking')) !== v.isAsking) await $.state.set('runAsking', v.isAsking)
}

/** A prompt was submitted: one the person typed starts a run when it is the run's command, and ends one otherwise. */
export async function submitUnattended($: Host, prompt: Prompt) {
  if (!prompt.isTyped) return
  const v = vars($)
  v.isRun = isRunCommand(prompt.command)
  v.denials = 0
  v.isAsking = false
  v.startedAt = null
  await $.state.set('run', v.isRun)
  // Last, so a clock that can't be read never keeps a run from starting: the run then asks nothing.
  if (v.isRun) v.startedAt = await $.clock.now().catch(() => null)
}

/** Ends a run: the person changed the mode by hand, or cleared the conversation. */
export async function endRun($: Host) {
  const v = vars($)
  v.isRun = false
  v.denials = 0
  v.isAsking = false
  v.startedAt = null
  await $.state.set('run', false)
}

/**
 * A permission request came up. Nobody can answer one during a run, so it is denied rather than left
 * to wait all night: the text the asker reads, or null to let the request through (no run, or the
 * start question's own dialog, which the person may still be there to answer).
 */
export function permissionAsked($: Pick<Host, 'memory'>, { isQuestion, isAgent }: { isQuestion: boolean; isAgent: boolean }): string | null {
  const v = vars($)
  if (!v.isRun) return null
  if (v.isAsking && isQuestion && !isAgent) return null
  v.denials += 1
  return v.denials >= STUCK_DENIALS ? (isAgent ? AGENT_STUCK : MAIN_STUCK) : `${AWAY} ${isAgent ? AGENT_NEXT : MAIN_NEXT}`
}

/**
 * The model asks the person a question. Outside a run it goes through (`pass`). During one, the run's
 * start question goes to the person (`ask`): the adapter shows it for START_ANSWER_MS, answers
 * NO_ANSWER or CLOSED when nobody does, and calls `questionDone` after. Every other question is
 * refused at once (`deny`), so none waits all night.
 */
export async function questionAsked($: Host, isAgent: boolean): Promise<{ pass: true } | { ask: true } | { deny: string }> {
  const v = vars($)
  if (!v.isRun) return { pass: true }
  if (isAgent) return { deny: AGENT_QUESTION }
  // Taken before the clock is read, so 2 questions at once, or a clock that fails, can't both use it.
  const at = v.startedAt
  v.startedAt = null
  const isStart = at !== null && (await $.clock.now()) - at <= START_WINDOW_MS
  if (!isStart) return { deny: MAIN_QUESTION }
  v.isAsking = true
  return { ask: true }
}

/** The start question is off the screen, answered or not. */
export function questionDone($: Pick<Host, 'memory'>): void {
  vars($).isAsking = false
}

/** The check of a question failed. It must not leave a dialog open all night: during a run, the refusal's text; else null. */
export function questionFailed($: Pick<Host, 'memory'>): string | null {
  return vars($).isRun ? MAIN_QUESTION : null
}

/** The platform checked a tool call that isn't read-only, by its ID. */
export function writeChecked($: Pick<Host, 'memory'>, id: string): void {
  const v = vars($)
  if (v.isRun) v.writes.add(id)
}

/** A tool call ended. A write that ran means approvals are flowing again: the count of denials starts over. */
export function writeEnded($: Pick<Host, 'memory'>, id: string, isDone: boolean): void {
  const v = vars($)
  if (v.writes.delete(id) && isDone) v.denials = 0
}
