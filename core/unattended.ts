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

// The run is in the session's values (`run`, `runDenials`, `runStartedAt`, `runAsking`), so every
// process that serves the session reads the same run. One process keeps, for one session, the calls
// the platform called writes (anything not read-only), by ID, until they finish, and the queue its
// changes to the run wait in.
type Vars = {
  writes: Set<string>
  queue: Promise<unknown>
}
const vars = ($: Pick<Host, 'memory'>) => memoryOf<Vars>($, 'unattended', () => ({ writes: new Set(), queue: Promise.resolve() }))

// Runs a change after the ones this process queued before it, so 2 changes at once never both read a
// value before either writes it.
function serial<T>($: Pick<Host, 'memory'>, change: () => Promise<T>): Promise<T> {
  const v = vars($)
  const done = v.queue.then(change)
  v.queue = done.catch(() => undefined)
  return done
}

export const isRunCommand = (name: string | undefined) => RUN_COMMAND.test(name ?? '')

/** A run is active, for a view. */
export async function isRunning($: Host) {
  return $.state.get('run')
}

/** A prompt was submitted: one the person typed starts a run when it is the run's command, and ends one otherwise. */
export async function submitUnattended($: Host, prompt: Prompt) {
  if (!prompt.isTyped) return
  const isRun = isRunCommand(prompt.command)
  await serial($, async () => {
    await reset($)
    await $.state.set('run', isRun)
    // Last, so a clock that can't be read never keeps a run from starting: the run then asks nothing.
    if (isRun) await $.state.set('runStartedAt', await $.clock.now().catch(() => null))
  })
}

/** Ends a run: the person changed the mode by hand, or cleared the conversation. */
export async function endRun($: Host) {
  await serial($, async () => {
    await reset($)
    await $.state.set('run', false)
  })
}

async function reset($: Host) {
  await $.state.set('runDenials', 0)
  await $.state.set('runAsking', false)
  await $.state.set('runStartedAt', null)
}

/**
 * A permission request came up. Nobody can answer one during a run, so it is denied rather than left
 * to wait all night: the text the asker reads, or null to let the request through (no run, or the
 * start question's own dialog, which the person may still be there to answer). `isCounted` is false
 * where the platform can't say whether the request reached the person: that denial isn't counted.
 */
export async function permissionAsked(
  $: Host,
  { isQuestion, isAgent, isCounted = true }: { isQuestion: boolean; isAgent: boolean; isCounted?: boolean },
): Promise<string | null> {
  return serial($, async () => {
    if (!(await $.state.get('run'))) return null
    if (isQuestion && !isAgent && (await $.state.get('runAsking'))) return null
    const denials = (await $.state.get('runDenials')) + 1
    if (isCounted) await $.state.set('runDenials', denials)
    return denials >= STUCK_DENIALS ? (isAgent ? AGENT_STUCK : MAIN_STUCK) : `${AWAY} ${isAgent ? AGENT_NEXT : MAIN_NEXT}`
  })
}

/**
 * The model asks the person a question. Outside a run it goes through (`pass`). During one, the run's
 * start question goes to the person (`ask`): the adapter shows it for START_ANSWER_MS, answers
 * NO_ANSWER or CLOSED when nobody does, and calls `questionDone` after. Every other question is
 * refused at once (`deny`), so none waits all night.
 */
export async function questionAsked($: Host, isAgent: boolean): Promise<{ pass: true } | { ask: true } | { deny: string }> {
  // The command's time is taken before the clock is read, so 2 questions at once, or a clock that
  // fails, can't both use it.
  const taken = await serial($, async (): Promise<{ pass: true } | { deny: string } | { at: number | null }> => {
    if (!(await $.state.get('run'))) return { pass: true }
    if (isAgent) return { deny: AGENT_QUESTION }
    const at = await $.state.get('runStartedAt')
    if (at !== null) await $.state.set('runStartedAt', null)
    return { at }
  })
  if (!('at' in taken)) return taken
  const { at } = taken
  const isStart = at !== null && (await $.clock.now()) - at <= START_WINDOW_MS
  if (!isStart) return { deny: MAIN_QUESTION }
  await serial($, () => $.state.set('runAsking', true))
  return { ask: true }
}

/** The start question is off the screen, answered or not. */
export async function questionDone($: Host): Promise<void> {
  await serial($, () => $.state.set('runAsking', false))
}

/** The check of a question failed. It must not leave a dialog open all night: during a run, the refusal's text; else null. */
export async function questionFailed($: Host): Promise<string | null> {
  return (await $.state.get('run')) ? MAIN_QUESTION : null
}

/** The platform checked a tool call that isn't read-only, by its ID. */
export async function writeChecked($: Host, id: string): Promise<void> {
  if (await $.state.get('run')) vars($).writes.add(id)
}

/** A tool call ended. A write that ran means approvals are flowing again: the count of denials starts over. */
export async function writeEnded($: Host, id: string, isDone: boolean): Promise<void> {
  if (vars($).writes.delete(id) && isDone) await serial($, () => $.state.set('runDenials', 0))
}
