import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PromptSubmitInput, SessionEndInput, SessionMessage } from 'claude-code'

import type { InteractionMode, RapidBase, WafflesMode } from '../types'
import { endRun, isRunCommand, isRunning } from './unattended'

const mode = atom({ plugin: 'waffles', key: 'mode' } as const, 'production')
const rapidBase = atom({ plugin: 'waffles', key: 'rapidBase' } as const, null)

const BACKLOG_COMMAND = 'backlog-entry'
const PROD_COMMAND = 'prod'
const RAPID_COMMAND = 'rapid'

// Every statement of the current mode the model reads starts with this.
const STATEMENT = 'waffles mode:'

// A system prompt section with the same bytes in every request, so the prompt cache holds: the
// current mode goes in the conversation instead. Plain facts, since command-framed injected text
// reads as a prompt injection.
const DEFINITIONS = `# waffles modes

The waffles plugin runs the session in one of four modes:

- production (/${PROD_COMMAND}, the default): the person is present. Questions, approvals and plans for review go to them as usual, and work meets the usual standards: tests, checks, reviews and docs.
- rapid (/${RAPID_COMMAND}): the person is iterating quickly to judge a change. The requested change is made directly and quickly. No tests, linters, type checks or reviews are written or run, and no time goes to docs or polish. Nothing is committed: changes stay in the working tree, so they can be kept or discarded. The reply says briefly what changed.
- backlog (/${BACKLOG_COMMAND}): each prompt the person types is a backlog entry, not a request. Its full text goes verbatim to the waffles:backlog skill as the skill's arguments, and the reply is only that skill's report. Slash commands run as usual.
- non-interactive (a /waffles:non-interactive run): the person is away. The rules of the waffles:non-interactive skill apply. The run lasts until the person types another prompt.

A line that starts "${STATEMENT}" states the current mode. One comes with the first message of the conversation, one after each change, and one beside each prompt typed in backlog mode. The most recent statement in the conversation is the current mode. It overrides instructions from any earlier mode, including those of a skill loaded in that mode.

In production mode and during a run, work with a plan outline in .tmp/plan/ on a feature branch is committed and pushed in this order. The first commit holds the plan outline alone; the branch is pushed, and the pull request is opened as a draft. Each step of the outline is one commit, made once the repo's checks pass, with the step closed in the outline in the same commit. Commits stay local until a milestone (a top-level step done with all its child steps, or the last commit before review), and the branch is pushed then and whenever work stops short of one: the end of a session, the end of a run that does not finish, a handoff. No commit message holds a skip tag such as [skip ci]. The last step of every outline is "Remove the working files": git rm -r .tmp in its own commit, a push, then gh pr ready. The squash merge's commit body states the essence of the change in about 10 lines, then the pull request's link. The waffles:commit-prep skill states these rules in full.

Rapid work stays pending until production mode starts. The statement that starts production mode then names the rapid work and what comes before other work. Code is committed only once it meets standards: while rapid work is pending, nothing is committed in any mode, until the person picks what happens to it.

The mode describes the main conversation with the person. A subagent is exempt from it in every mode: it follows the brief from the agent that spawned it, and its questions and gaps go back to that agent as the brief asks.`

export const MODES_SECTION = { id: 'waffles:modes', scope: 'session', text: DEFINITIONS } as const

// What a change ends and what it starts; the definitions carry the rest.
const ENDED: Record<WafflesMode, string> = {
  production: '',
  rapid: 'Rapid mode has ended: changes are no longer made without tests, checks and reviews.',
  backlog: 'Backlog mode has ended: typed prompts are requests again, not backlog entries.',
  'non-interactive':
    "The non-interactive run has ended; the person is present. Questions, approvals and plans for review apply again; the run's commit rules and pull request path no longer apply: commits and pushes follow the person's own rules.",
}
const STARTED: Record<WafflesMode, string> = {
  production: '',
  rapid: 'Changes are made quickly and stay uncommitted in the working tree, with no tests, checks, reviews or polish.',
  backlog: "Each typed prompt goes verbatim to the waffles:backlog skill, and the reply is only that skill's report.",
  'non-interactive':
    "A /waffles:non-interactive run has started: the person is away until they type a prompt, and the waffles:non-interactive skill's rules apply.",
}
// Rapid mode's start says whether the work has a base to diff against.
const BASED = 'The current commit and the paths already changed are recorded as the base of the rapid work.'
const UNBASED = 'No git commit was found in the working directory, so no base is recorded for the rapid work.'

const MODES: readonly WafflesMode[] = ['production', 'rapid', 'backlog', 'non-interactive']

const note = (from: WafflesMode, to: WafflesMode, isBased = false) =>
  [`${STATEMENT} ${to}.`, ENDED[from], STARTED[to], to === 'rapid' ? (isBased ? BASED : UNBASED) : '']
    .filter(Boolean)
    .join(' ')

// What production mode's start says of rapid work not yet brought up to standards. Facts, as the
// definitions are: the model acts on them.
const pending = ({ head, dirty }: RapidBase) =>
  [
    `Rapid work since commit ${head} has not been brought up to standards.`,
    dirty.length > 0
      ? `It excludes these paths (relative to the repository root), already changed when rapid mode started: ${dirty.join(', ')}.`
      : '',
    `Before other work comes an assessment of it: the diff against ${head}, untracked files included, an estimate of the work, and what specifically brings it to spec (tests to write, checks to run, cleanup, docs).`,
    'Then the person is asked, with AskUserQuestion, which of three to do: bring it up to standards now; defer (stash), which stashes only the rapid changes, untracked files included, with git stash push -u -m "rapid: <summary>" -- <paths>; or defer (unstaged), which leaves them uncommitted in the working tree. Both defer options add one waffles:backlog item that lists the rapid changes, what they lack, and where they are (the stash message, or the working tree), and leave the paths already changed before rapid mode alone. No option discards the rapid work: the person does that themselves. Once the person picks, commits follow the new mode\'s usual rules.',
  ]
    .filter(Boolean)
    .join(' ')

// The prompt that starts the turn for that assessment when /prod ends rapid work.
const ASSESS = 'Production mode has started with rapid work pending. The latest waffles mode statement describes the rapid work and what comes before other work.'

// Every note a change appends, so compaction drops those rows and nothing else.
const NOTES = new Set(
  MODES.flatMap(from =>
    MODES.filter(to => to !== from).flatMap(to => (to === 'rapid' ? [note(from, to, true), note(from, to)] : [note(from, to)])),
  ),
)
const PRODUCTION_NOTES = MODES.filter(from => from !== 'production').map(from => `${note(from, 'production')} `)

// A note that enters production mode with rapid work pending names a commit and paths; it matches only
// the whole of what pending() writes, so a person's prompt that merely starts the same way stays.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const HEAD = '\u0000'
const PATHS = '\u0001'
const PENDING = [[], [PATHS]].map(
  dirty =>
    new RegExp(
      `^${escape(pending({ head: HEAD, dirty }))
        .replaceAll(HEAD, '[0-9a-f]{7,64}')
        .replaceAll(PATHS, '.+')}$`,
      's',
    ),
)
const isPendingNote = (text: string) =>
  PRODUCTION_NOTES.some(n => text.startsWith(n) && PENDING.some(p => p.test(text.slice(n.length))))

const isNote = (m: SessionMessage) =>
  m.role === 'user' && !m.toolResults?.length && (NOTES.has(m.text.trim()) || isPendingNote(m.text.trim()))

const COMPACT_INSTRUCTIONS = `Leave waffles mode statements (text that starts "${STATEMENT}") out of the summary: the current mode is stated again after it.`

// Module variables start over on a reload; startMode restores the mode from $.state.
let isBacklog = false
// The first message after /clear named pending rapid work; the turn that reads it takes it over.
let isPendingStated = false

/** Backlog mode is on: typed prompts become backlog items. */
export const isBacklogMode = () => isBacklog

/** The interaction mode, for the footer under the prompt. */
export async function interactionMode($: EngineInterface): Promise<InteractionMode> {
  const stored = await read($, mode)
  // A stored value that names no mode reads as production.
  return MODES.includes(stored) ? stored : 'production'
}

/** The mode the model is told: a run takes over from the interaction mode. */
export async function wafflesMode($: EngineInterface): Promise<WafflesMode> {
  return (await isRunning($)) ? 'non-interactive' : interactionMode($)
}

async function setMode($: EngineInterface, next: InteractionMode) {
  isBacklog = next === 'backlog'
  await update($, mode, () => next)
}

// Where rapid work starts: HEAD and the paths `git status` already lists. Null outside a git
// repository or before its first commit.
async function recordBase($: EngineInterface): Promise<RapidBase | null> {
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
async function announce($: EngineInterface, before: WafflesMode): Promise<boolean> {
  const after = await wafflesMode($)
  if (after === before) return false
  const base = await read($, rapidBase)
  const isHandover = after === 'production' && base !== null
  const text = isHandover ? `${note(before, after)} ${pending(base)}` : note(before, after, base !== null)
  // A session no plugin may shape refuses the row, as may a plugin above; the mode still holds,
  // and the next first message or backlog prompt states it. Pending rapid work stays pending.
  const isAppended = await $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    .then(r => r.deny === undefined)
    .catch(() => false)
  if (!isHandover || !isAppended) return false
  await update($, rapidBase, () => null)
  return true
}

// The module's one session.start hook calls this.
export async function startMode($: EngineInterface) {
  await $.command.register({
    name: BACKLOG_COMMAND,
    description: `Turn every prompt you type into backlog items, until /${PROD_COMMAND}`,
  })
  await $.command.register({
    name: PROD_COMMAND,
    description: `Return to production mode from /${RAPID_COMMAND}, /${BACKLOG_COMMAND} or a run`,
  })
  await $.command.register({
    name: RAPID_COMMAND,
    description: `Make changes quickly, without tests or commits, until /${PROD_COMMAND}`,
  })
  isBacklog = (await read($, mode)) === 'backlog'
}

// The module's one prompt.submit hook calls this, with the mode before the prompt, after
// submitUnattended; it passes on what this returns.
export async function submitMode($: EngineInterface, e: PromptSubmitInput, before: WafflesMode): Promise<PromptSubmitInput> {
  // From the person: typed, including over a running turn, not a notification or a trigger.
  const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
  // A non-interactive run takes over the session; when it ends, the session is in production mode.
  if (isPerson && isRunCommand(e.command?.name) && (await interactionMode($)) !== 'production') await setMode($, 'production')
  await announce($, before)
  if (!isPerson || !isBacklog || e.command || e.isMeta || !e.text.trim()) return e
  return { ...e, context: [...(e.context ?? []), `${STATEMENT} backlog`] }
}

// The module's one turn.complete hook calls this, for a main-chat turn. The engine may ask for the
// first message's context more than once before sending it, so pending rapid work it states is
// cleared once a turn has run with it, not when it is stated.
export async function completeMode($: EngineInterface) {
  if (!isPendingStated) return
  isPendingStated = false
  await update($, rapidBase, () => null)
}

// The module's one prompt.context hook calls this for the wafflesMode block: the mode current when the
// first message is made, and any rapid work still pending.
export async function modeContext($: EngineInterface): Promise<string> {
  const current = await wafflesMode($)
  const base = current === 'production' ? await read($, rapidBase) : null
  isPendingStated = base !== null
  return base === null ? `${STATEMENT} ${current}` : `${STATEMENT} ${current}. ${pending(base)}`
}

// The module's one session.end hook calls this. /clear ends the conversation without a
// session.start for the new one. The new conversation holds no note; its first message states the
// mode, and any rapid work still pending.
export async function endMode($: EngineInterface, e: SessionEndInput) {
  if (e.reason !== 'clear') return
  await endRun($)
  await setMode($, 'production')
}

export function registerMode(on: On) {
  on('command.run', { command: BACKLOG_COMMAND }, async $ => {
    const before = await wafflesMode($)
    await endRun($)
    await setMode($, 'backlog')
    await announce($, before)
    return {
      text: `Backlog mode: on. Every prompt you type becomes backlog items. /${PROD_COMMAND} or /clear returns to production mode.`,
    }
  })

  on('command.run', { command: RAPID_COMMAND }, async $ => {
    const before = await wafflesMode($)
    if (before === 'rapid') return { text: 'Already in rapid mode.' }
    await endRun($)
    // Rapid work not yet handed over keeps its base: the new work adds to it.
    let base = await read($, rapidBase)
    if (base === null) {
      base = await recordBase($)
      await update($, rapidBase, () => base)
    }
    await setMode($, 'rapid')
    await announce($, before)
    const unbased = base === null ? ' No git commit was found here, so no base is recorded.' : ''
    return {
      text: `Rapid mode: on. Changes are made quickly, without tests, checks or commits. /${PROD_COMMAND} offers to bring them up to standards or defer them.${unbased}`,
    }
  })

  on('command.run', { command: PROD_COMMAND }, async $ => {
    const before = await wafflesMode($)
    await endRun($)
    await setMode($, 'production')
    const isHandover = await announce($, before)
    // The assessment starts now, not at the next prompt. A command.run hook may not submit a
    // prompt (it would wait on the turn the hook holds), so a timer submits it once the command is
    // done; the prompt runs once the session is idle.
    if (isHandover) $.clock.after(1, () => void $.prompt.submit({ text: ASSESS }).catch(() => undefined))
    const review = isHandover ? ' Claude reviews the rapid work, then asks whether to bring it up to standards now or defer it.' : ''
    if (before === 'rapid') return { text: `Rapid mode: off. Back in production mode.${review}` }
    if (before === 'backlog') return { text: `Backlog mode: off. Back in production mode.${review}` }
    if (before === 'non-interactive') return { text: `Non-interactive run: ended. Back in production mode.${review}` }
    return { text: 'Already in production mode.' }
  })

  // The notes would outlive the mode they state in a summary; the next first message states it.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const instructions = [e.instructions, COMPACT_INSTRUCTIONS].filter(Boolean).join('\n\n')
    return next({ ...e, messages: e.messages.filter(m => !isNote(m)), instructions })
  })
}
