import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, On, PromptSubmitInput, SessionEndInput } from 'claude-code'

import type { PlanGoal, PlanOther, PlanStep } from '../types'
import {
  claim,
  findPlanRoot,
  goalName,
  forgetActive,
  hasGoalFile,
  holder,
  listGoals,
  loadGoal,
  pruneRecords,
  recordActive,
  recordedActive,
  release,
  removeGoal,
  saveGoal,
  type GoalFile,
  type Where,
} from './plan-store'
import {
  addSteps,
  agentsOf,
  closeSteps,
  deferStep,
  describe,
  endAgent,
  focusStep,
  markRunning,
  moveGoalInto,
  moveStep,
  newGoal,
  pathOf,
  renameStep,
  renderTree,
  slug as slugFor,
  PlanError,
  type Change,
  type Goal,
  type Kind,
  type Result,
  type Step,
} from '../core/plan-tree.ts'
import { ELSEWHERE, openAtStart, openUnlessClosed } from './plan-ui'

export const TOOL = 'mcp__waffles__plan'

// plan-ui.tsx draws types/index.d.ts's copies of Goal and Step: a change to one side alone fails to compile here.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Holds<T extends true> = T
export type PlanShapes = [Holds<Equal<Goal, PlanGoal>>, Holds<Equal<Step, PlanStep>>]

// plan-ui.tsx declares the same atoms to draw them: the scan reads an atom only where its file makes it.
const planGoal = atom({ plugin: 'waffles', key: 'planGoal' } as const, null)
const planTree = atom({ plugin: 'waffles', key: 'planTree' } as const, null)
const planError = atom({ plugin: 'waffles', key: 'planError' } as const, null)
const planOthers = atom({ plugin: 'waffles', key: 'planOthers' } as const, [])
const planChanged = atom({ plugin: 'waffles', key: 'planChanged' } as const, [])
const planKept = atom({ plugin: 'waffles', key: 'planKept' } as const, null)
const planKeptIssue = atom({ plugin: 'waffles', key: 'planKeptIssue' } as const, null)

const POLL_MS = 5_000
// Well inside STALE_MS, so a running session's lock never goes stale.
const BEAT_MS = 30_000
// A slug the model names must look like one `slug()` makes: no path separators or dots.
const SLUG = /^[\p{L}\p{M}\p{N}]+(-[\p{L}\p{M}\p{N}]+)*$/u
// A background subagent's Agent call names its step first in its description, with a colon:
// `8.1: Merge the API fixes`. The colon tells it from a count: `2 parallel searches` names no step.
const STEP_FIRST = /^(\d+(?:\.\d+)*):\s/
// An agent ID goes in the step's note, `agent=<id>`: no space, `;`, `=` or `<!--` may break it.
const AGENT_ID = /^[\w.:-]+$/
// The subagents still at work; any other status has ended.
const LIVE: readonly AgentStatus[] = ['pending', 'running', 'waiting']

const DESCRIPTION =
  'Changes the plan outline: the tree of goals and steps for this repo that the person sees beside the chat. The only way to change its goal files in .tmp/plan/. Each call returns the changes and the new path.'
const SUBAGENT = 'The plan outline is kept by the main conversation only.'
const NO_GOAL = 'No active goal. Start one with op "goal".'
const GIT_DOWN = 'git did not answer, so the plan outline was not saved. Try again.'
// The active goal has no file in the repo of the shell's working directory, most often because the shell
// moved (a cd into a submodule or another repo). A result, not a refusal: it is common, the pane already
// says so, and the call's row draws it dim. It names the folder, so Claude cds back rather than searching.
const elsewhere = (slug: string, root: Where) =>
  `${ELSEWHERE} ${goalName(slug)} isn't in ${root.outline.slice(0, -'/.tmp/plan'.length)}, the repo of the shell's working directory. If the shell moved to another repo, cd back to the active goal's repo and call again.`
const NO_GOAL_OPEN ='No active goal. Continue one with op "goal" and switch, or start one with op "goal" and title.'

const OPS = ['goal', 'add', 'focus', 'done', 'drop', 'defer', 'move', 'rename', 'show'] as const
const KINDS: readonly Kind[] = ['planned', 'work', 'research']

const ID = { type: 'string', description: 'A step ID, such as 3.2.1.' }
const KIND = { type: 'string', enum: KINDS, description: 'planned (part of the plan, the default), work (a detour to change something), or research (a detour to research, analyze, or decide, including a question either side asks that takes research).' }
const SCHEMA = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: OPS,
      description:
        'goal: start a goal (title, steps) or continue an open one (switch); a goal started with no steps gets step 1, titled like the goal. add: add child steps (parent, kind, titles), with focus to make the first new step current. focus: make a step current (id). done, drop: close steps (ids, cascade). defer: close a step moved to the backlog (id, backlog, cascade). move: put a step under another parent (id, to), or move a whole goal under a step of the active goal (fromGoal, to). rename: retitle a step (id, title). show: return the tree (goal) and the other open goals with their slugs.',
    },
    title: { type: 'string', description: 'goal: the new goal’s title. rename: the new title.' },
    steps: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, kind: KIND }, required: ['title'] },
      description: 'goal: the top-level steps to start with.',
    },
    switch: { type: 'string', description: 'goal: the slug of an open goal to continue.' },
    parent: { type: ['string', 'null'], description: 'add: the parent step ID, or null for the top level.' },
    kind: KIND,
    titles: { type: 'array', items: { type: 'string' }, description: 'add: the new steps’ titles.' },
    focus: { type: 'boolean', description: 'add: also make the first new step current, as op "focus" does.' },
    id: ID,
    ids: { type: 'array', items: ID, description: 'done, drop: the steps to close, ranges listed out.' },
    cascade: { type: 'boolean', description: 'Also close the step’s open children. Only when the person asks.' },
    backlog: { type: 'string', description: 'defer: the backlog item’s path, such as .backlog/fix-cors.md.' },
    to: { type: ['string', 'null'], description: 'move: the new parent step ID, or null for the top level.' },
    fromGoal: { type: 'string', description: 'move: the slug of a goal whose steps move under `to`.' },
    goal: { type: 'string', description: 'show: the slug of a goal other than the active one.' },
  },
  required: ['op'],
}

type Input = {
  op: string
  title?: string
  steps?: { title: string; kind?: Kind }[]
  switch?: string
  parent?: string | null
  kind?: Kind
  titles?: string[]
  focus?: boolean
  id?: string
  ids?: string[]
  cascade?: boolean
  backlog?: string
  to?: string | null
  fromGoal?: string
  goal?: string
}

// The scalar fields and the JSON type each takes. A null in a field that takes none is no value.
const STRINGS = ['id', 'title', 'switch', 'backlog', 'fromGoal', 'goal'] as const
const NULLABLE = ['parent', 'to'] as const
const FLAGS = ['focus', 'cascade'] as const
// The other fields that take no null: kind, and the lists.
const NON_NULL = ['kind', 'steps', 'titles', 'ids'] as const

// Module variables start over on a reload: the poll then claims again at once.
let lastBeat = 0
let isPollQueued = false
let queue: Promise<unknown> = Promise.resolve()
// How many sessions have ended in this process: a poll that started before an end writes nothing after it.
let ends = 0
// The folders as git last gave them to a poll or a call. Where git fails, they fall back to the working
// directory's, which are never kept here: a poll that later finds the real ones would take them for the fallback.
let lastRoot: Where | null = null
// The session ID whose record a poll or a call last looked for: each session's goal is restored once
// per process, at its first poll or call. A reload looks again; it finds no record unless a restart left one.
let restoredFor: string | null = null

// Tool calls and polls run one at a time, so a poll never draws a tree a call just replaced.
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Writes a failure the plan outline can't report anywhere else to the debug log, with its stack. */
export function logFailure($: EngineInterface, what: string, error: unknown): void {
  $.ui.log(`plan outline: ${what}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`, { to: 'debug' })
}

/** The input with each scalar field's JSON type checked; refuses a field of the wrong type by name. */
function checked(raw: Record<string, unknown>): Input {
  const input = { ...raw }
  for (const key of [...STRINGS, ...FLAGS, ...NON_NULL]) if (input[key] === null) delete input[key]
  for (const key of STRINGS) if (input[key] !== undefined && typeof input[key] !== 'string') throw new PlanError(`${key} must be a string.`)
  for (const key of NULLABLE) {
    if (input[key] !== undefined && input[key] !== null && typeof input[key] !== 'string') throw new PlanError(`${key} must be a string or null.`)
  }
  for (const key of FLAGS) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new PlanError(`${key} must be true or false.`)
  return input as Input
}

/** The goal's current step as `<id> <title>`, or null. */
export function currentOf(goal: Goal): string | null {
  const step = pathOf(goal).at(-1)
  return step ? `${step.id} ${step.title}` : null
}

function text(lines: readonly string[], goal: Goal | null): string {
  const path = goal ? pathOf(goal) : []
  const where = path.length ? path.map(s => `${s.id} ${s.title}`).join(' › ') : 'none'
  return [...(lines.length ? lines : ['No change.']), '', `Path: ${where}`].join('\n')
}

function need<K extends keyof Input>(input: Input, key: K): NonNullable<Input[K]> {
  const value = input[key]
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
    throw new PlanError(`op "${input.op}" needs ${key}.`)
  }
  return value as NonNullable<Input[K]>
}

// A title is one line of the goal file: a line break in it would end the step there, and a `<!--`
// would read as the step's note.
function titleOf(title: unknown): string {
  if (typeof title !== 'string' || !title.trim()) throw new PlanError('A title must be text.')
  if (/[\r\n]/.test(title)) throw new PlanError(`A title can't hold a line break: ${JSON.stringify(title)}`)
  if (title.includes('<!--')) throw new PlanError(`A title can't hold "<!--": ${JSON.stringify(title)}`)
  return title
}

function texts(input: Input, key: 'ids' | 'titles'): string[] {
  const value: unknown = need(input, key)
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) throw new PlanError(`"${key}" must be a list of text.`)
  return value
}

function stepsOf(steps: unknown): { title: string; kind: Kind }[] {
  if (steps === undefined) return []
  if (!Array.isArray(steps) || !steps.every(s => typeof s === 'object' && s !== null)) throw new PlanError('"steps" must be a list of { title, kind }.')
  return steps.map((s: { title?: unknown; kind?: Kind | null }) => ({ title: titleOf(s.title), kind: kindOf(s.kind ?? undefined) }))
}

function kindOf(kind: Kind | undefined): Kind {
  if (kind !== undefined && !KINDS.includes(kind)) throw new PlanError(`Unknown kind ${kind}.`)
  return kind ?? 'planned'
}

/**
 * One line per open goal, `- <slug>: <title>, at <id> <title>`, leaving out `except`. A goal another
 * session holds is left out, or with `isInUseShown` marked so.
 */
export async function openGoalLines(
  $: EngineInterface,
  files: readonly GoalFile[],
  root: Where,
  { except, isInUseShown }: { except?: string | null; isInUseShown: boolean },
): Promise<string[]> {
  const [now, me] = [await $.clock.now(), await $.session.id()]
  const lines: string[] = []
  for (const f of files) {
    if (f.slug === except || !('goal' in f) || f.goal.status !== 'open') continue
    const who = await holder($, f.slug, now, root.state)
    const inUse = who !== null && who !== me
    if (inUse && !isInUseShown) continue
    lines.push(`- ${f.slug}: ${f.goal.title}, at ${currentOf(f.goal) ?? 'no step'}${inUse ? ' (in use by another session)' : ''}`)
  }
  return lines
}

/** The goal a slug from the model names; refuses a slug that isn't one or names no goal file, listing the open goals. */
async function named($: EngineInterface, files: readonly GoalFile[], root: Where, slug: string): Promise<Goal> {
  const found = SLUG.test(slug) ? files.find(f => f.slug === slug) : undefined
  if (!found) {
    const lines = await openGoalLines($, files, root, { isInUseShown: true })
    throw new PlanError([lines.length ? `No goal ${slug}. Open goals:` : `No goal ${slug}.`, ...lines].join('\n'))
  }
  if ('error' in found) throw new PlanError(found.error)
  return found.goal
}

/**
 * Redraws the active goal and the other open goals from one listing, writing only what changed. With
 * no active goal, the kept goal's tree stays drawn; a kept file that is gone or unreadable leaves it as it was.
 * `active` draws that goal as the active one before it is set; once `isEnded` holds, nothing is written.
 */
async function refresh(
  $: EngineInterface,
  files: readonly GoalFile[],
  root: Where,
  { active, isEnded = () => false }: { active?: string; isEnded?: () => boolean } = {},
) {
  const slug = active ?? (await read($, planGoal))
  const shown = slug ?? (await read($, planKept))
  const mine = shown === null ? undefined : files.find(f => f.slug === shown)
  const isRead = mine !== undefined && 'goal' in mine
  const error = slug === null ? null : !mine ? `No goal file ${goalName(slug)}` : 'error' in mine ? mine.error : null
  // With no active goal, the kept goal's tree stays drawn though its file is gone or unreadable: the pane says so.
  const issue = slug !== null || shown === null || isRead ? null : mine ? 'unreadable' : 'missing'
  const others: PlanOther[] = []
  const rest = files.filter(f => f.slug !== shown && 'goal' in f && f.goal.status === 'open')
  if (rest.length) {
    const [now, me] = [await $.clock.now(), await $.session.id()]
    for (const f of rest) {
      if (!('goal' in f)) continue
      const who = await holder($, f.slug, now, root.state)
      others.push({ slug: f.slug, title: f.goal.title, current: currentOf(f.goal), inUse: who !== null && who !== me })
    }
  }
  if (slug !== null || isRead) {
    const tree = isRead ? mine.goal : null
    if (!isEnded() && !same(await read($, planTree), tree)) await update($, planTree, () => tree)
  }
  if (!isEnded() && (await read($, planKeptIssue)) !== issue) await update($, planKeptIssue, () => issue)
  if (!isEnded() && (await read($, planError)) !== error) await update($, planError, () => error)
  if (!isEnded() && !same(await read($, planOthers), others)) await update($, planOthers, () => others)
}

/** Sets the goal whose tree the pane keeps while no goal is active; null once one is. */
async function keep($: EngineInterface, slug: string | null) {
  if ((await read($, planKept)) !== slug) await update($, planKept, () => slug)
}

/** The active goal is no longer this session's: its tree stays drawn, marked not active. */
async function lose($: EngineInterface, slug: string) {
  await keep($, slug)
  await update($, planGoal, () => null)
}

/** The session no longer has the goal active: its record goes, so a resume doesn't bring the goal back. */
async function forget($: EngineInterface, me: string, root: Where) {
  await forgetActive($, me, root.state).catch(error => logFailure($, "couldn't remove the session's record", error))
}

/** Lets go of the active goal: its lock, and where it stopped, for the result. */
async function park($: EngineInterface, slug: string, me: string, root: Where): Promise<{ title: string; slug: string; at: string } | undefined> {
  await release($, slug, me, root.state)
  try {
    const goal = await loadGoal($, slug, root.outline)
    const at = currentOf(goal)
    return at === null ? undefined : { title: goal.title, slug, at }
  } catch (error) {
    if (error instanceof PlanError) return undefined
    throw error
  }
}

const parkedNote = (parked: { title: string; slug: string; at: string } | undefined) =>
  parked ? ` (${parked.title} [${parked.slug}] parked at ${parked.at})` : ''

/** The IDs of the step with this ID (aliases aside) and of every step under it; empty when there is none. */
function subtreeIds(steps: readonly Step[], id: string): string[] {
  for (const step of steps) {
    if (step.id === id) {
      const ids: string[] = []
      const walk = (s: Step) => {
        ids.push(s.id)
        s.children.forEach(walk)
      }
      walk(step)
      return ids
    }
    const hit = subtreeIds(step.children, id)
    if (hit.length) return hit
  }
  return []
}

/** The IDs a change touched (a moved step's whole subtree, by its new IDs), and the current step when it moved. */
function touched(before: Goal, { goal, changes }: Result): string[] {
  const ids = changes.flatMap(c => {
    switch (c.type) {
      case 'added':
      case 'closed':
      case 'renamed':
      case 'focus':
      case 'parked':
      case 'running':
      case 'review':
        return [c.id]
      case 'moved': {
        const moved = subtreeIds(goal.steps, c.to)
        return moved.length ? moved : [c.to]
      }
      default:
        return []
    }
  })
  if (goal.current !== null && goal.current !== before.current) ids.push(goal.current)
  return ids
}

function operate(goal: Goal, input: Input, now: string): Result {
  switch (input.op) {
    case 'add':
      return addSteps(goal, input.parent ?? null, kindOf(input.kind), texts(input, 'titles').map(titleOf), now, { focus: input.focus ?? false })
    case 'focus':
      return focusStep(goal, need(input, 'id'), now)
    case 'done':
    case 'drop':
      return closeSteps(goal, texts(input, 'ids'), input.op === 'done' ? 'done' : 'dropped', input.cascade ?? false, now)
    case 'defer':
      return deferStep(goal, need(input, 'id'), need(input, 'backlog'), input.cascade ?? false, now)
    case 'move':
      return moveStep(goal, need(input, 'id'), input.to ?? null, now)
    case 'rename':
      return renameStep(goal, need(input, 'id'), titleOf(need(input, 'title')), now)
    default:
      throw new PlanError(`Unknown op ${input.op}.`)
  }
}

/** The tree of the goal named, else the active one, then the other open goals; with neither, the open goals. */
async function show($: EngineInterface, root: Where, slug: string | undefined, active: string | null): Promise<string> {
  const files = await listGoals($, root.outline)
  const shown = slug ?? active
  if (shown !== null) {
    const goal = slug !== undefined ? await named($, files, root, slug) : await loadGoal($, active!, root.outline)
    const tree = renderTree(goal)
    const others = await openGoalLines($, files, root, { except: shown, isInUseShown: true })
    return [
      ...(tree.length ? tree : [`${goal.title}: no steps.`]),
      ...(others.length ? ['', 'Other open goals:', ...others] : []),
    ].join('\n')
  }
  const lines = await openGoalLines($, files, root, { isInUseShown: true })
  return lines.length ? ['No active goal. Open goals:', ...lines].join('\n') : 'No active goal and no open goals.'
}

// Makes the goal active once its tree is drawn and the kept one is let go. Between letting the kept
// goal go and drawing the new tree, the pane can show the old tree for one frame without its
// done/not active row; accepted. `changed` replaces the highlights; null leaves them.
// The session's record names the goal, so a resume of the session makes it active again.
// False, with the goal not made active, once `isEnded` holds.
async function activate(
  $: EngineInterface,
  slug: string,
  me: string,
  files: readonly GoalFile[],
  root: Where,
  changed: string[] | null,
  isEnded: () => boolean = () => false,
): Promise<boolean> {
  // The goal is active without it: a resume then lists the open goals, as before the record.
  await recordActive($, me, slug, root.state).catch(error => logFailure($, `couldn't record ${slug} as the session's goal`, error))
  if (isEnded()) return false
  await keep($, null)
  if (changed !== null) await update($, planChanged, () => changed)
  await refresh($, files, root, { active: slug, isEnded })
  if (isEnded()) return false
  await update($, planGoal, () => slug)
  return true
}

async function apply($: EngineInterface, raw: Record<string, unknown>): Promise<string> {
  const input = checked(raw)
  const nowMs = await $.clock.now()
  const now = new Date(nowMs).toISOString()
  const me = await $.session.id()
  // One git run per call: every read and write below goes to this root.
  const { isFromGit, isGitDown, ...root } = await findPlanRoot($)
  // The fallback folders would be in the working tree, where a lock or record could be committed.
  if (isGitDown) throw new PlanError(GIT_DOWN)
  // A call that comes before the first poll of a resumed session finds its goal active.
  // A restore that fails leaves the call to work as with no record.
  if ((await read($, planGoal)) === null) {
    await restore($, me, root, isFromGit, nowMs).catch(error => logFailure($, "couldn't restore the session's goal", error))
  }
  const active = await read($, planGoal)
  const isElsewhere = active !== null && !(await hasGoalFile($, active, root))
  if (input.op === 'show') return isElsewhere && input.goal === undefined ? elsewhere(active, root) : show($, root, input.goal, active)

  if (input.op === 'goal' && input.switch === undefined) {
    const title = titleOf(need(input, 'title'))
    const goal = newGoal(title, stepsOf(input.steps), now)
    const files = await listGoals($, root.outline)
    // Claimed before it is saved: a slug another session has locked (its file not written yet, or
    // deleted) is taken too, so two sessions never share one goal file.
    const taken = files.map(f => f.slug)
    let slug = slugFor(title, taken)
    while (!(await claim($, slug, me, nowMs, root.state))) {
      taken.push(slug)
      slug = slugFor(title, taken)
    }
    try {
      await saveGoal($, slug, goal, root.outline)
    } catch (error) {
      // The claim goes with the goal it was for; the save's error is the one reported.
      await release($, slug, me, root.state).catch(failure => logFailure($, `couldn't release the lock on ${slug}`, failure))
      throw error
    }
    lastBeat = nowMs
    if (isFromGit) lastRoot = root
    const parked = active === null ? undefined : await park($, active, me, root)
    await activate($, slug, me, [...files, { slug, goal }], root, goal.steps.map(s => s.id))
    if (active === null) await openUnlessClosed($)
    return text([describe({ type: 'goal', title, slug, parked })], goal)
  }

  if (input.op === 'goal') {
    const slug = need(input, 'switch')
    const files = await listGoals($, root.outline)
    const goal = await named($, files, root, slug)
    if (goal.status === 'done') throw new PlanError(`"${goal.title}" is done.`)
    if (!(await claim($, slug, me, nowMs, root.state))) throw new PlanError(`"${goal.title}" is in use by another session.`)
    lastBeat = nowMs
    if (isFromGit) lastRoot = root
    const isSwept = (await sweepAgents($, slug, goal, root, nowMs).catch(error => sweepFailed($, slug, error))).length > 0
    const parked = active === null || active === slug ? undefined : await park($, active, me, root)
    await activate($, slug, me, isSwept ? await listGoals($, root.outline) : files, root, active !== slug ? [] : null)
    if (active === null) await openUnlessClosed($)
    return text([`◇ continued goal: ${goal.title} [${slug}]${parkedNote(parked)}`], goal)
  }

  if (active === null) {
    // The conversation can still hold a goal this process didn't restore (another session took it,
    // or the session has no record): switch comes first, so Claude continues it rather than starting a copy.
    const lines = await openGoalLines($, await listGoals($, root.outline), root, { isInUseShown: false })
    throw new PlanError(lines.length ? [`${NO_GOAL_OPEN} Open goals:`, ...lines].join('\n') : NO_GOAL)
  }
  if (isElsewhere) return elsewhere(active, root)
  const before = await loadGoal($, active, root.outline)
  // The lock can have gone stale since the last heartbeat, and another session taken the goal.
  if (!(await claim($, active, me, nowMs, root.state))) {
    await lose($, active)
    await forget($, me, root)
    await refresh($, await listGoals($, root.outline), root)
    throw new PlanError(`"${before.title}" is now in use by another session.`)
  }
  lastBeat = nowMs
  if (isFromGit) lastRoot = root
  let result: Result
  if (input.op === 'move' && input.fromGoal !== undefined) {
    const from = input.fromGoal
    const source = await named($, await listGoals($, root.outline), root, from)
    if (from === active) throw new PlanError(`"${source.title}" is the active goal.`)
    const to = need(input, 'to')
    // Claimed rather than checked, so no other session takes the goal between the check and the removal.
    if (!(await claim($, from, me, nowMs, root.state))) throw new PlanError(`"${source.title}" is in use by another session.`)
    try {
      result = moveGoalInto(source, before, to, now)
      await saveGoal($, active, result.goal, root.outline)
      await removeGoal($, from, root.outline)
    } finally {
      // A lock left behind goes stale in STALE_MS: the move's own outcome is the one reported.
      await release($, from, me, root.state).catch(error => logFailure($, `couldn't release the lock on ${from}`, error))
    }
  } else {
    result = operate(before, input, now)
    if (result.changes.length) await saveGoal($, active, result.goal, root.outline)
  }

  const isDone = result.goal.status === 'done'
  if (isDone) {
    await release($, active, me, root.state)
    await forget($, me, root)
    // Kept first, so the pane never draws the tree with neither: its `done` row shows only while kept.
    await lose($, active)
  }
  const ids = touched(before, result)
  await update($, planChanged, changed => [...new Set([...changed, ...ids])])
  await refresh($, await listGoals($, root.outline), root)
  return text(result.changes.map((c: Change) => describe(c)), isDone ? null : result.goal)
}

/**
 * Applies a change a hook makes to the active goal, outside a tool call: a subagent that started or
 * finished. Nothing happens with no active goal, no change, or a lock another session took.
 */
async function changeActive($: EngineInterface, change: (goal: Goal, now: string) => Result | null) {
  // A change that lands after the session ended would claim the lock its end released.
  const at = ends
  const isEnded = () => ends !== at
  const slug = await read($, planGoal)
  if (slug === null) return
  const nowMs = await $.clock.now()
  const me = await $.session.id()
  const { isGitDown, ...root } = await findPlanRoot($)
  if (isGitDown) return
  const before = await loadGoal($, slug, root.outline)
  const result = change(before, new Date(nowMs).toISOString())
  if (result === null || isEnded()) return
  // Only while this session holds the lock: a session that exited released it, and keeps its goal set.
  if ((await holder($, slug, nowMs, root.state)) !== me) return
  if (!(await claim($, slug, me, nowMs, root.state))) return
  if (isEnded()) return await release($, slug, me, root.state)
  lastBeat = nowMs
  await saveGoal($, slug, result.goal, root.outline)
  const ids = touched(before, result)
  await update($, planChanged, changed => [...new Set([...changed, ...ids])])
  await refresh($, await listGoals($, root.outline), root)
}

/**
 * Ends the marks of subagents that no longer work: a finished one's step waits for review, and one this
 * session doesn't list (it ended with an earlier process) leaves its step parked. Runs where the session
 * takes up a goal, and at each heartbeat, for a finish whose change was lost. Returns the IDs of the steps
 * it changed. Call with the goal's lock held.
 */
async function sweepAgents($: EngineInterface, slug: string, goal: Goal, root: Where, nowMs: number): Promise<string[]> {
  const ids = agentsOf(goal)
  if (!ids.length) return []
  const agents = await $.agent.list()
  const now = new Date(nowMs).toISOString()
  let next = goal
  const changed: string[] = []
  for (const id of ids) {
    const agent = agents.find(a => a.id === id)
    if (agent && LIVE.includes(agent.status)) continue
    const result = endAgent(next, id, agent ? 'review' : 'parked', now)
    if (!result) continue
    next = result.goal
    changed.push(...touched(goal, result))
  }
  if (next === goal) return []
  await saveGoal($, slug, next, root.outline)
  return changed
}

function sweepFailed($: EngineInterface, slug: string, error: unknown): string[] {
  logFailure($, `couldn't end the subagent marks of ${slug}`, error)
  return []
}

/**
 * Makes the goal the session's record names active again, once per session ID per process: after
 * `claude --resume` or `--continue` the process goes on under the ID the session had, and after
 * `/resume` the poll finds the new ID. A goal that is gone, done, or held by another live session is
 * not restored, and its record goes. Where git failed, a root that names no record is looked at again.
 */
async function restore($: EngineInterface, me: string, root: Where, isFromGit: boolean, nowMs: number, isEnded: () => boolean = () => false) {
  if (restoredFor === me) return
  // Set before the work, so a poll and a call never restore at once; cleared again where the work
  // fails, so the next poll or call tries again.
  restoredFor = me
  try {
    if (isFromGit) await pruneRecords($, me, nowMs, root.state).catch(error => logFailure($, "couldn't remove old session records", error))
    const slug = await recordedActive($, me, root.state)
    if (slug === null) {
      // A root that isn't git's can be the wrong one: a later poll with git looks again.
      if (!isFromGit) restoredFor = null
      return
    }
    if (!SLUG.test(slug)) return await forget($, me, root)
    const files = await listGoals($, root.outline)
    const found = files.find(f => f.slug === slug)
    // A file being edited may not parse for a moment: the record stays for the next process.
    if (found && 'error' in found) return
    if (!found || found.goal.status !== 'open') return await forget($, me, root)
    if (isEnded()) return
    if (!(await claim($, slug, me, nowMs, root.state))) return await forget($, me, root)
    lastBeat = nowMs
    if (isFromGit) lastRoot = root
    const isSwept = (await sweepAgents($, slug, found.goal, root, nowMs).catch(error => sweepFailed($, slug, error))).length > 0
    const shown = isSwept ? await listGoals($, root.outline) : files
    // The session can end while the goal is made active: the lock claimed for it goes.
    if (!(await activate($, slug, me, shown, root, [], isEnded))) {
      await release($, slug, me, root.state).catch(error => logFailure($, `couldn't release the lock on ${slug}`, error))
      return
    }
    await openUnlessClosed($)
  } catch (error) {
    restoredFor = null
    throw error
  }
}

/** One poll: the heartbeat every BEAT_MS, then the redraw, with 1 git run. Writes nothing in a checkout with no `.tmp/plan/`. */
async function poll($: EngineInterface) {
  const at = ends
  const isEnded = () => ends !== at
  // Read before git, which can outlast the session: a lock is claimed only under the ID of the session it is for.
  const me = await $.session.id()
  const { isFromGit, isGitDown, ...root } = await findPlanRoot($)
  // Git failed inside a repository: the fallback folders are in the working tree, so nothing is written
  // or redrawn there, and the pane keeps what it shows.
  if (isEnded() || isGitDown) return
  const slug = await read($, planGoal)
  // Where git failed (a timeout), the root is the working directory's: while a tree is drawn, the pane
  // keeps it rather than an error, and no lock is written there. Once git has given a
  // root, only that root is trusted; before that (outside git), the working directory's .tmp/plan is,
  // since the drawn goal was created there.
  const shown = slug ?? (await read($, planKept))
  const isUntrusted = lastRoot !== null ? root.outline !== lastRoot.outline : !(await $.fs.exists(root.outline))
  if (!isFromGit && shown !== null && isUntrusted) return
  const now = await $.clock.now()
  // Only from a root git gave, or, before git has given one, the working directory's.
  if (slug === null && (isFromGit || lastRoot === null)) {
    await restore($, me, root, isFromGit, now, isEnded)
    // The restore drew the tree and claimed the lock: the next heartbeat is due in BEAT_MS.
    if ((await read($, planGoal)) !== null) return
  }
  // With no root found yet, the heartbeat waits for a poll that finds the goal's file.
  if (slug !== null && now - lastBeat >= BEAT_MS && (await hasGoalFile($, slug, root))) {
    if (isEnded()) return
    lastBeat = now
    const isHeld = await claim($, slug, me, now, root.state)
    // The session ended during the claim and released its lock: the claim mustn't outlive it.
    if (isEnded()) {
      if (isHeld) await release($, slug, me, root.state).catch(error => logFailure($, `couldn't release the lock on ${slug}`, error))
      return
    }
    // Another session took the goal after this one's lock went stale: it is no longer active here.
    if (!isHeld) {
      await lose($, slug)
      await forget($, me, root)
    }
    const tree = await read($, planTree)
    if (isHeld && tree !== null && agentsOf(tree).length) {
      const swept = await loadGoal($, slug, root.outline)
        .then(goal => sweepAgents($, slug, goal, root, now))
        .catch(error => sweepFailed($, slug, error))
      if (swept.length) await update($, planChanged, changed => [...new Set([...changed, ...swept])])
    }
  }
  const files = await listGoals($, root.outline)
  if (isEnded()) return
  await refresh($, files, root, { isEnded })
  if (isFromGit) lastRoot = root
}

/** The slug of this session's active goal, or null. */
export async function activeGoal($: EngineInterface): Promise<string | null> {
  return read($, planGoal)
}

// The module's one prompt.submit hook calls this. The highlights mark what changed since the person
// last typed, so a prompt they type clears them; a notification, a trigger or a slash command (/waffles:plan
// opens the pane that shows them) leaves them. The reset waits its turn behind a poll or a call, so
// it is not awaited: the prompt never waits on the plan outline.
export function submitPlan($: EngineInterface, e: PromptSubmitInput): void {
  if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return
  if (e.command || e.isMeta) return
  void serial(async () => {
    if ((await read($, planChanged)).length) await update($, planChanged, () => [])
  }).catch(() => undefined)
}

// The module's one session.end hook calls this. The lock is released under the ending session's ID;
// its record stays, so a later resume of it makes its goal active again. After /clear the process goes
// on under a new ID with no active goal: the new conversation's first message lists the open goals,
// and Claude continues one with switch. After /resume the next poll restores the resumed session's goal.
//
// It has session.end's time budget, so it doesn't queue behind a poll that may be waiting on git, and
// it runs git only when git hasn't yet given the root to a poll or a call. A poll under way writes nothing after it.
export async function endPlan($: EngineInterface, e: SessionEndInput) {
  ends += 1
  const slug = await read($, planGoal)
  // A lock that can't be removed goes stale in STALE_MS; the session still ends with no goal.
  if (slug !== null) {
    await release($, slug, e.sessionId, lastRoot?.state).catch(error => logFailure($, `couldn't release the lock on ${slug}`, error))
  }
  if (e.reason !== 'clear' && e.reason !== 'resume') return
  // Only what holds a value is written, so a repo with no plan outline sees no writes. The pane keeps the
  // goal's tree, marked not active, until a goal becomes active.
  if (slug !== null) await lose($, slug)
  if ((await read($, planError)) !== null) await update($, planError, () => null)
  if ((await read($, planChanged)).length) await update($, planChanged, () => [])
}

// The module's one turn.complete hook calls this for a subagent's turn: its run ended, so its step
// waits for the main thread to review the report. A failure goes to the debug log.
// Queued, not awaited: the subagent's report never waits on the plan outline. A subagent no step names
// costs nothing.
export async function completePlan($: EngineInterface, agent: string) {
  const tree = await read($, planTree)
  if (tree === null || !agentsOf(tree).includes(agent)) return
  void serial(() => changeActive($, (goal, now) => endAgent(goal, agent, 'review', now))).catch(error =>
    logFailure($, `couldn't end the mark of subagent ${agent}`, error),
  )
}

export function registerPlan(on: On) {
  // A background subagent the main thread starts for a step, named first in the Agent call's
  // description, marks that step while it works. Queued, not awaited: the Agent call never waits on
  // the plan outline, and a failure here never stops the subagent.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.agentId === undefined || !AGENT_ID.test(r.agentId)) return r
    if (!e.background || e.parentAgentId !== undefined || e.isTeammate || e.workflow || e.resume) return r
    const id = STEP_FIRST.exec(e.description.trim())?.[1]
    if (id === undefined) return r
    const agent = r.agentId
    void serial(() => changeActive($, (goal, now) => markRunning(goal, id, agent, now))).catch(error =>
      logFailure($, `couldn't mark step ${id} for subagent ${agent}`, error),
    )
    return r
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    try {
      return { result: await serial(() => apply($, e as unknown as Record<string, unknown>)) }
    } catch (error) {
      if (error instanceof PlanError) return { deny: error.message }
      // A failure of the disk or of git: the model reads what went wrong, not a skipped hook; the stack goes to the debug log.
      logFailure($, 'a call failed', error)
      return { deny: `plan outline failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
}

// The module's one session.start hook calls this.
export async function startPlan($: EngineInterface) {
  await $.tool.register({ name: 'plan', description: DESCRIPTION, inputSchema: SCHEMA, isDeferred: false })
  // /waffles:plan comes from the skill skills/plan, and plan-ui.tsx answers it: the toggle never waits on serial().
  // A poll that fails has no one to tell: the next one tries again.
  const tick = async () => {
    if (isPollQueued) return
    isPollQueued = true
    await serial(() => poll($))
      .catch(() => undefined)
      .finally(() => {
        isPollQueued = false
      })
  }
  // The first poll is awaited, so the tree is drawn before the first prompt.
  await tick()
  // A goal still active at start shows again where the layout docks the pane. After a reload the
  // layout is unknown until the next drawing: the first footer drawn in the fullscreen layout opens it.
  if ((await read($, planGoal)) !== null) await openAtStart($)
  $.clock.every(POLL_MS, () => void tick())
}
