import {
  commandName,
  memoryOf,
  runName,
  skillName,
  type Host,
  type InteractionMode,
  type Names,
  type Prompt,
  type RapidBase,
  type WafflesMode,
} from './host.ts'
import { endRun, isRunCommand, isRunning } from './unattended.ts'

/** The commands that change the mode, by name. */
export const BACKLOG_COMMAND = 'backlog-entry'
export const PROD_COMMAND = 'prod'
export const RAPID_COMMAND = 'rapid'

// Every statement of the current mode the model reads starts with this.
const STATEMENT = 'waffles mode:'

/**
 * The modes' definitions for the system prompt, in the platform's names. The same names give the same
 * bytes in every request, so the prompt cache holds: an adapter builds it once, and the current mode
 * goes in the conversation instead. Plain facts, since command-framed injected text reads as a prompt
 * injection.
 */
export const modesText = (names: Names): string => `# waffles modes

The waffles plugin runs the session in one of four modes:

- production (${commandName(names, PROD_COMMAND)}, the default): the person is present. Questions, approvals and plans for review go to them as usual, and work meets the usual standards: tests, checks, reviews and docs.
- rapid (${commandName(names, RAPID_COMMAND)}): the person is iterating quickly to judge a change. The requested change is made directly and quickly. No tests, linters, type checks or reviews are written or run, and no time goes to docs or polish. Nothing is committed: changes stay in the working tree, so they can be kept or discarded. The reply says briefly what changed.
- backlog (${commandName(names, BACKLOG_COMMAND)}): each prompt the person types is a backlog entry, not a request. Its full text goes verbatim to the ${skillName(names, 'backlog')} skill as the skill's arguments, and the reply is only that skill's report. Slash commands run as usual.
- non-interactive (a ${runName(names)}): the person is away. The rules of the ${skillName(names, 'non-interactive')} skill apply. The run lasts until the person types another prompt.

A line that starts "${STATEMENT}" states the current mode. One comes with the first message of the conversation, one after each change, and one beside each prompt typed in backlog mode. The most recent statement in the conversation is the current mode. It overrides instructions from any earlier mode, including those of a skill loaded in that mode.

In production mode and during a run, work with a plan outline on a feature branch is committed and pushed in this order. The plan outline is not in the working tree and is never committed. After the first commit, the branch is pushed, and the pull request is opened as a draft. Each step of the outline is one commit, made once the repo's checks pass. Commits stay local until a milestone (a top-level step done with all its child steps, or the last commit before review), and the branch is pushed then and whenever work stops short of one: the end of a session, the end of a run that does not finish, a handoff. No commit message holds a skip tag such as [skip ci]. Once the last commit is pushed, gh pr ready marks the pull request ready. The squash merge's commit body states the essence of the change in about 10 lines, then the pull request's link. The ${skillName(names, 'commit-prep')} skill states these rules in full.

Rapid work stays pending until production mode starts. The statement that starts production mode then names the rapid work and what comes before other work. Code is committed only once it meets standards: while rapid work is pending, nothing is committed in any mode, until the person picks what happens to it.

The mode describes the main conversation with the person. A subagent is exempt from it in every mode: it follows the brief from the agent that spawned it, and its questions and gaps go back to that agent as the brief asks.`

// What a change ends and what it starts; the definitions carry the rest.
const ENDED: Record<WafflesMode, string> = {
  production: '',
  rapid: 'Rapid mode has ended: changes are no longer made without tests, checks and reviews.',
  backlog: 'Backlog mode has ended: typed prompts are requests again, not backlog entries.',
  'non-interactive':
    "The non-interactive run has ended; the person is present. Questions, approvals and plans for review apply again; the run's commit rules and pull request path no longer apply: commits and pushes follow the person's own rules.",
}
const started = (names: Names): Record<WafflesMode, string> => ({
  production: '',
  rapid: 'Changes are made quickly and stay uncommitted in the working tree, with no tests, checks, reviews or polish.',
  backlog: `Each typed prompt goes verbatim to the ${skillName(names, 'backlog')} skill, and the reply is only that skill's report.`,
  'non-interactive': `A ${runName(names)} has started: the person is away until they type a prompt, and the ${skillName(names, 'non-interactive')} skill's rules apply.`,
})
// Rapid mode's start says whether the work has a base to diff against.
const BASED = 'The current commit and the paths already changed are recorded as the base of the rapid work.'
const UNBASED = 'No git commit was found in the working directory, so no base is recorded for the rapid work.'

const MODES: readonly WafflesMode[] = ['production', 'rapid', 'backlog', 'non-interactive']

const note = (names: Names, from: WafflesMode, to: WafflesMode, isBased = false) =>
  [`${STATEMENT} ${to}.`, ENDED[from], started(names)[to], to === 'rapid' ? (isBased ? BASED : UNBASED) : '']
    .filter(Boolean)
    .join(' ')

// What production mode's start says of rapid work not yet brought up to standards. Facts, as the
// definitions are: the model acts on them.
const pending = ({ head, dirty }: RapidBase, names: Names) =>
  [
    `Rapid work since commit ${head} has not been brought up to standards.`,
    dirty.length > 0
      ? `It excludes these paths (relative to the repository root), already changed when rapid mode started: ${dirty.join(', ')}.`
      : '',
    `Before other work comes an assessment of it: the diff against ${head}, untracked files included, an estimate of the work, and what specifically brings it to spec (tests to write, checks to run, cleanup, docs).`,
    `Then the person is asked, with ${names.ask}, which of three to do: bring it up to standards now; defer (stash), which stashes only the rapid changes, untracked files included, with git stash push -u -m "rapid: <summary>" -- <paths>; or defer (unstaged), which leaves them uncommitted in the working tree. Both defer options add one ${skillName(names, 'backlog')} item that lists the rapid changes, what they lack, and where they are (the stash message, or the working tree), and leave the paths already changed before rapid mode alone. No option discards the rapid work: the person does that themselves. Once the person picks, commits follow the new mode's usual rules.`,
  ]
    .filter(Boolean)
    .join(' ')

// The prompt that starts the turn for that assessment when /prod ends rapid work.
const ASSESS = 'Production mode has started with rapid work pending. The latest waffles mode statement describes the rapid work and what comes before other work.'

// A note that enters production mode with rapid work pending names a commit and paths; it matches only
// the whole of what pending() writes, so a person's prompt that merely starts the same way stays.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const HEAD = '\u0000'
const PATHS = '\u0001'
const ASK = '\u0002'

// Every note a change appends in the platform's names, so compaction drops those rows and nothing
// else. Made once for each names object. The question tool's place takes any one word, or the
// platform's own phrase.
const NOTES = new WeakMap<Names, (text: string) => boolean>()
function notesOf(names: Names): (text: string) => boolean {
  const known = NOTES.get(names)
  if (known) return known
  const notes = new Set(
    MODES.flatMap(from =>
      MODES.filter(to => to !== from).flatMap(to =>
        to === 'rapid' ? [note(names, from, to, true), note(names, from, to)] : [note(names, from, to)],
      ),
    ),
  )
  const productionNotes = MODES.filter(from => from !== 'production').map(from => `${note(names, from, 'production')} `)
  const patterns = [[], [PATHS]].map(
    dirty =>
      new RegExp(
        `^${escape(pending({ head: HEAD, dirty }, { ...names, ask: ASK }))
          .replaceAll(HEAD, '[0-9a-f]{7,64}')
          .replaceAll(PATHS, '.+')
          .replaceAll(ASK, `(?:\\S+|${escape(names.ask)})`)}$`,
        's',
      ),
  )
  const isPendingNote = (text: string) => productionNotes.some(n => text.startsWith(n) && patterns.some(p => p.test(text.slice(n.length))))
  const isNote = (text: string) => notes.has(text) || isPendingNote(text)
  NOTES.set(names, isNote)
  return isNote
}

/**
 * Whether a row of the conversation, by its text, is a note a change of mode appended in the platform's
 * names: compaction drops those rows and nothing else.
 */
export const isModeNote = (names: Names, text: string) => notesOf(names)(text.trim())

/** What a compaction is told: the notes would outlive the mode they state in a summary; the next first message states it. */
export const COMPACT_INSTRUCTIONS = `Leave waffles mode statements (text that starts "${STATEMENT}") out of the summary: the current mode is stated again after it.`

/** The prompt that starts the turn for the assessment when /prod ends rapid work. */
export const ASSESS_PROMPT = ASSESS

// What one process keeps for one session; `startMode` reads the mode back from the session's values.
type Vars = {
  isBacklog: boolean
}
const vars = ($: Pick<Host, 'memory'>) => memoryOf<Vars>($, 'modes', () => ({ isBacklog: false }))

/** The interaction mode, for a view. */
export async function interactionMode($: Host): Promise<InteractionMode> {
  const stored = await $.state.get('mode')
  // A stored value that names no mode reads as production.
  return (MODES as readonly string[]).includes(stored) ? stored : 'production'
}

/** The mode the model is told: a run takes over from the interaction mode. */
export async function wafflesMode($: Host): Promise<WafflesMode> {
  return (await isRunning($)) ? 'non-interactive' : interactionMode($)
}

async function setMode($: Host, next: InteractionMode) {
  vars($).isBacklog = next === 'backlog'
  await $.state.set('mode', next)
}

// Where rapid work starts: HEAD and the paths `git status` already lists. Null outside a git
// repository or before its first commit.
async function recordBase($: Host): Promise<RapidBase | null> {
  const head = await $.process.run(['git', 'rev-parse', 'HEAD']).catch(() => undefined)
  if (head?.exitCode !== 0) return null
  const status = await $.process.run(['git', 'status', '--porcelain', '-z']).catch(() => undefined)
  if (status?.exitCode !== 0) return null
  // `XY path\0`, and a rename or copy's source after it as `orig\0`.
  const dirty: string[] = []
  const fields = status.stdout.split('\0')
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!
    if (field.length < 4) continue
    dirty.push(field.slice(3))
    if (field[0] === 'R' || field[0] === 'C') {
      i += 1
      if (fields[i]) dirty.push(fields[i]!)
    }
  }
  return { head: head.stdout.trim(), dirty }
}

// The model reads a change as a new row at the end: what a thread has sent stays as sent. Entering
// production mode hands any pending rapid work to the model and clears it; returns whether it did.
async function announce($: Host, before: WafflesMode): Promise<boolean> {
  const after = await wafflesMode($)
  if (after === before) return false
  const base = await $.state.get('rapidBase')
  const isHandover = after === 'production' && base !== null
  const text = isHandover ? `${note($.names, before, after)} ${pending(base, $.names)}` : note($.names, before, after, base !== null)
  // A platform may refuse the row; the mode still holds, and the next first message or backlog
  // prompt states it. Pending rapid work stays pending.
  const isAppended = await $.conversation.note(text).catch(() => false)
  if (!isHandover || !isAppended) return false
  await $.state.set('rapidBase', null)
  return true
}

/** The session started, or the process did: the mode comes back from the session's values. */
export async function startMode($: Host) {
  vars($).isBacklog = (await $.state.get('mode')) === 'backlog'
}

/**
 * A prompt was submitted, after `submitUnattended`; `before` is the mode before it. Returns the line to
 * add to the prompt's context, or null: a prompt typed in backlog mode carries the mode beside it.
 */
export async function submitMode($: Host, prompt: Prompt, before: WafflesMode): Promise<string | null> {
  // A run takes over the session; when it ends, the session is in production mode.
  if (prompt.isPerson && isRunCommand(prompt.command) && (await interactionMode($)) !== 'production') await setMode($, 'production')
  await announce($, before)
  if (!prompt.isPerson || !vars($).isBacklog || prompt.command !== undefined || prompt.isMeta || !prompt.text.trim()) return null
  return `${STATEMENT} backlog`
}

/**
 * A turn of the main conversation ended. A platform may ask for the first message's context more than
 * once before sending it, so pending rapid work it states is cleared once a turn has run with it, not
 * when it is stated.
 */
export async function completeMode($: Host) {
  // A session value, since the first message may be made in another process than the turn's end.
  if (!(await $.state.get('rapidStated'))) return
  await $.state.set('rapidStated', false)
  await $.state.set('rapidBase', null)
}

/** The first message's mode block: the mode current when it is made, and any rapid work still pending. */
export async function modeContext($: Host): Promise<string> {
  const current = await wafflesMode($)
  const base = current === 'production' ? await $.state.get('rapidBase') : null
  if ((await $.state.get('rapidStated')) !== (base !== null)) await $.state.set('rapidStated', base !== null)
  return base === null ? `${STATEMENT} ${current}` : `${STATEMENT} ${current}. ${pending(base, $.names)}`
}

/**
 * The conversation was cleared and the process goes on. The new conversation holds no note; its first
 * message states the mode, and any rapid work still pending.
 */
export async function clearMode($: Host) {
  await endRun($)
  await setMode($, 'production')
}

/** /backlog-entry: what the person reads. */
export async function runBacklog($: Host): Promise<string> {
  const before = await wafflesMode($)
  await endRun($)
  await setMode($, 'backlog')
  await announce($, before)
  return `Backlog mode: on. Every prompt you type becomes backlog items. ${commandName($.names, PROD_COMMAND)} or /clear returns to production mode.`
}

/** /rapid: what the person reads. */
export async function runRapid($: Host): Promise<string> {
  const before = await wafflesMode($)
  if (before === 'rapid') return 'Already in rapid mode.'
  await endRun($)
  // Rapid work not yet handed over keeps its base: the new work adds to it.
  let base = await $.state.get('rapidBase')
  if (base === null) {
    base = await recordBase($)
    await $.state.set('rapidBase', base)
  }
  await setMode($, 'rapid')
  await announce($, before)
  const unbased = base === null ? ' No git commit was found here, so no base is recorded.' : ''
  return `Rapid mode: on. Changes are made quickly, without tests, checks or commits. ${commandName($.names, PROD_COMMAND)} offers to bring them up to standards or defer them.${unbased}`
}

/**
 * /prod: what the person reads, and whether pending rapid work was handed to the model. On a handover
 * the adapter submits `ASSESS_PROMPT` once the command is done, so the assessment starts now, not at
 * the next prompt.
 */
export async function runProd($: Host): Promise<{ text: string; isHandover: boolean }> {
  const before = await wafflesMode($)
  await endRun($)
  await setMode($, 'production')
  const isHandover = await announce($, before)
  const review = isHandover ? ` ${$.names.assistant} reviews the rapid work, then asks whether to bring it up to standards now or defer it.` : ''
  const text =
    before === 'rapid'
      ? `Rapid mode: off. Back in production mode.${review}`
      : before === 'backlog'
        ? `Backlog mode: off. Back in production mode.${review}`
        : before === 'non-interactive'
          ? `Non-interactive run: ended. Back in production mode.${review}`
          : 'Already in production mode.'
  return { text, isHandover }
}

/** What each command is for, as the person reads it in the command list, in the platform's names. */
export function commandsOf(names: Pick<Names, 'command'>) {
  const typed = (command: string) => commandName(names, command)
  return [
    { name: BACKLOG_COMMAND, description: `Turn every prompt you type into backlog items, until ${typed(PROD_COMMAND)}` },
    { name: PROD_COMMAND, description: `Return to production mode from ${typed(RAPID_COMMAND)}, ${typed(BACKLOG_COMMAND)} or a run` },
    { name: RAPID_COMMAND, description: `Make changes quickly, without tests or commits, until ${typed(PROD_COMMAND)}` },
  ] as const
}
