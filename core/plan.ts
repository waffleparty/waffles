import { memoryOf, type Host, type OtherGoal } from './host.ts'
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
} from './plan-store.ts'
import { collapsedFor, collapsedOf, endTurn, newIds, reveal, toggle } from './plan-collapse.ts'
import { restorePlan } from './plan-mirror.ts'
import type { CoreTool } from './tools.ts'
import {
  addSteps,
  agentsOf,
  closeSteps,
  deferStep,
  describe,
  endAgent,
  findStep,
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
} from './plan-tree.ts'

/** Opens the result of a call made while the active goal has no file in the shell's repo. */
export const ELSEWHERE = 'Nothing changed:'

/** How often an adapter with a timer calls `tickPlan`. */
export const POLL_MS = 5_000
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
const LIVE: readonly string[] = ['pending', 'running', 'waiting']

const DESCRIPTION =
  "Changes the plan outline: the tree of goals and steps for this repo that the person sees beside the chat. The only way to change its goal files, which are kept in the checkout's git folder, outside the working tree. Each call returns the changes and the new path."
const NO_GOAL = 'No active goal. Start one with op "goal".'
const GIT_DOWN = 'git did not answer, so the plan outline was not saved. Try again.'
// The active goal has no file in the repo of the shell's working directory, most often because the shell
// moved (a cd into a submodule or another repo). A result, not a refusal: it is common, the pane already
// says so, and the call's row draws it dim. It names the folder, so Claude cds back rather than searching.
const elsewhere = (slug: string, root: Where) =>
  `${ELSEWHERE} the active goal ${slug} has no goal file in ${root.top}, the repo of the shell's working directory. If the shell moved to another repo, cd back to the active goal's repo and call again.`
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

// What one process keeps for one session. It starts over with the process: the poll then claims again at once.
type Vars = {
  lastBeat: number
  isPollQueued: boolean
  queue: Promise<unknown>
  // How many times the session has ended in this process: a poll that started before an end writes nothing after it.
  ends: number
  // The folders as git last gave them to a poll or a call. Where git fails, they fall back to the working
  // directory's, which are never kept here: a poll that later finds the real ones would take them for the fallback.
  lastRoot: Where | null
  // The session ID whose record a poll or a call last looked for: each session's goal is restored once
  // per process, at its first poll or call. A new process looks again; it finds no record unless one was left.
  restoredFor: string | null
}
const vars = ($: Pick<Host, 'memory'>) =>
  memoryOf<Vars>($, 'plan', () => ({ lastBeat: 0, isPollQueued: false, queue: Promise.resolve(), ends: 0, lastRoot: null, restoredFor: null }))

// Tool calls and polls run one at a time, so a poll never draws a tree a call just replaced.
function serial<T>($: Pick<Host, 'memory'>, work: () => Promise<T>): Promise<T> {
  const v = vars($)
  const run = v.queue.then(work, work)
  v.queue = run.catch(() => undefined)
  return run
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Writes a failure the plan outline can't report anywhere else to the debug log, with its stack. */
export function logFailure($: Host, what: string, error: unknown): void {
  $.log(`plan outline: ${what}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
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
  $: Host,
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
async function named($: Host, files: readonly GoalFile[], root: Where, slug: string): Promise<Goal> {
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
  $: Host,
  files: readonly GoalFile[],
  root: Where,
  { active, isEnded = () => false }: { active?: string; isEnded?: () => boolean } = {},
) {
  const slug = active ?? (await $.state.get('planGoal'))
  const shown = slug ?? (await $.state.get('planKept'))
  const mine = shown === null ? undefined : files.find(f => f.slug === shown)
  const isRead = mine !== undefined && 'goal' in mine
  const error = slug === null ? null : !mine ? `No goal file ${goalName(root.outline, slug)}` : 'error' in mine ? mine.error : null
  // With no active goal, the kept goal's tree stays drawn though its file is gone or unreadable: the pane says so.
  const issue = slug !== null || shown === null || isRead ? null : mine ? 'unreadable' : 'missing'
  const others: OtherGoal[] = []
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
    // Before the tree, so a tree is never drawn with the collapsed steps of another goal.
    if (tree !== null && shown !== null && !isEnded()) await syncCollapsed($, shown, tree)
    if (!isEnded() && !same(await $.state.get('planTree'), tree)) await $.state.set('planTree', tree)
  }
  if (!isEnded() && (await $.state.get('planKeptIssue')) !== issue) await $.state.set('planKeptIssue', issue)
  if (!isEnded() && (await $.state.get('planError')) !== error) await $.state.set('planError', error)
  if (!isEnded() && !same(await $.state.get('planOthers'), others)) await $.state.set('planOthers', others)
}

/**
 * Keeps the collapsed steps in step with the tree drawn: none for a goal other than the one they were
 * kept for, and each named by its ID in the tree, so a moved step keeps its state under its new ID. Work
 * that became active is revealed at once, mid-turn too; a step collapses only at a turn's end or a press.
 */
async function syncCollapsed($: Host, slug: string, tree: Goal) {
  const kept = await $.state.get('planCollapsed')
  const next = collapsedOf(slug, reveal(tree, collapsedFor(kept, slug)))
  if (!same(kept, next)) await $.state.set('planCollapsed', next)
}

/** The slug of the goal drawn: the active one, else the kept one; null with neither. */
async function drawnSlug($: Host): Promise<string | null> {
  return (await $.state.get('planGoal')) ?? (await $.state.get('planKept'))
}

/**
 * Runs the collapse rules (core/plan-collapse.ts's `endTurn`) at a turn boundary: a stop (`isStop`), or a
 * prompt that begins a turn. The person's turn is ended once: at its stop, else at the next prompt; the
 * tree when it began is the one before. A later stop with no turn of the person's open (a turn a
 * notification started) runs only the rules that expand, on what changed since the rules last ran. A
 * tree of another goal counts as none, so each step of this one is new. The tree now is kept for the next.
 */
async function finishTurn($: Host, isStop: boolean) {
  const turn = await $.state.get('planTurn')
  if (!isStop && turn?.isOpen !== true) return
  const tree = await $.state.get('planTree')
  const slug = await drawnSlug($)
  await $.state.set('planTurn', { goal: slug, tree, isOpen: false })
  if (turn === null || tree === null || slug === null) return
  const before = turn.goal === slug ? turn.tree : null
  const kept = await $.state.get('planCollapsed')
  const held = await $.state.get('planPressed')
  const next = collapsedOf(slug, endTurn(before, tree, collapsedFor(kept, slug), newIds(before, tree), { isExpandOnly: !turn.isOpen, held }))
  if (!same(kept, next)) await $.state.set('planCollapsed', next)
}

/** Sets the goal whose tree the pane keeps while no goal is active; null once one is. */
async function keep($: Host, slug: string | null) {
  if ((await $.state.get('planKept')) !== slug) await $.state.set('planKept', slug)
}

/** The active goal is no longer this session's: its tree stays drawn, marked not active. */
async function lose($: Host, slug: string) {
  await keep($, slug)
  await $.state.set('planGoal', null)
}

/** The session no longer has the goal active: its record goes, so a resume doesn't bring the goal back. */
async function forget($: Host, me: string, root: Where) {
  await forgetActive($, me, root.state).catch(error => logFailure($, "couldn't remove the session's record", error))
}

/** Lets go of the active goal: its lock, and where it stopped, for the result. */
async function park($: Host, slug: string, me: string, root: Where): Promise<{ title: string; slug: string; at: string } | undefined> {
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
async function show($: Host, root: Where, slug: string | undefined, active: string | null): Promise<string> {
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
  $: Host,
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
  if (changed !== null) await $.state.set('planChanged', changed)
  await refresh($, files, root, { active: slug, isEnded })
  if (isEnded()) return false
  await $.state.set('planGoal', slug)
  return true
}

async function apply($: Host, raw: Record<string, unknown>): Promise<string> {
  const input = checked(raw)
  const nowMs = await $.clock.now()
  const now = new Date(nowMs).toISOString()
  const me = await $.session.id()
  // One git run per call: every read and write below goes to this root.
  const { isFromGit, isGitDown, ...root } = await findPlanRoot($)
  // The fallback folders would be in the working tree, where a lock or record could be committed.
  if (isGitDown) throw new PlanError(GIT_DOWN)
  if (isFromGit) await fetchOnce($, root)
  // A call that comes before the first poll of a resumed session finds its goal active.
  // A restore that fails leaves the call to work as with no record.
  if ((await $.state.get('planGoal')) === null) {
    await restore($, me, root, isFromGit, nowMs).catch(error => logFailure($, "couldn't restore the session's goal", error))
  }
  const active = await $.state.get('planGoal')
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
    vars($).lastBeat = nowMs
    if (isFromGit) vars($).lastRoot = root
    const parked = active === null ? undefined : await park($, active, me, root)
    await activate($, slug, me, [...files, { slug, goal }], root, goal.steps.map(s => s.id))
    if (active === null) await $.view.planActive('call')
    return text([describe({ type: 'goal', title, slug, parked })], goal)
  }

  if (input.op === 'goal') {
    const slug = need(input, 'switch')
    const files = await listGoals($, root.outline)
    const goal = await named($, files, root, slug)
    if (goal.status === 'done') throw new PlanError(`"${goal.title}" is done.`)
    if (!(await claim($, slug, me, nowMs, root.state))) throw new PlanError(`"${goal.title}" is in use by another session.`)
    vars($).lastBeat = nowMs
    if (isFromGit) vars($).lastRoot = root
    const isSwept = (await sweepAgents($, slug, goal, root, nowMs).catch(error => sweepFailed($, slug, error))).length > 0
    const parked = active === null || active === slug ? undefined : await park($, active, me, root)
    await activate($, slug, me, isSwept ? await listGoals($, root.outline) : files, root, active !== slug ? [] : null)
    if (active === null) await $.view.planActive('call')
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
  vars($).lastBeat = nowMs
  if (isFromGit) vars($).lastRoot = root
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
  await mark($, ids)
  await refresh($, await listGoals($, root.outline), root)
  return text(result.changes.map((c: Change) => describe(c)), isDone ? null : result.goal)
}

/** Adds step IDs to the ones changed since the person's last prompt. */
async function mark($: Host, ids: readonly string[]) {
  const changed = await $.state.get('planChanged')
  await $.state.set('planChanged', [...new Set([...changed, ...ids])])
}

/**
 * Applies a change a hook makes to the active goal, outside a tool call: a subagent that started or
 * finished. Nothing happens with no active goal, no change, or a lock another session took.
 */
async function changeActive($: Host, change: (goal: Goal, now: string) => Result | null) {
  // A change that lands after the session ended would claim the lock its end released.
  const at = vars($).ends
  const isEnded = () => vars($).ends !== at
  const slug = await $.state.get('planGoal')
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
  vars($).lastBeat = nowMs
  await saveGoal($, slug, result.goal, root.outline)
  const ids = touched(before, result)
  await mark($, ids)
  await refresh($, await listGoals($, root.outline), root)
}

/**
 * Ends the marks of subagents that no longer work: a finished one's step waits for review, and one this
 * session doesn't list (it ended with an earlier process) leaves its step parked. Runs where the session
 * takes up a goal, and at each heartbeat, for a finish whose change was lost. Returns the IDs of the steps
 * it changed. Call with the goal's lock held.
 */
async function sweepAgents($: Host, slug: string, goal: Goal, root: Where, nowMs: number): Promise<string[]> {
  const ids = agentsOf(goal)
  if (!ids.length) return []
  const agents = await $.agents.list()
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

function sweepFailed($: Host, slug: string, error: unknown): string[] {
  logFailure($, `couldn't end the subagent marks of ${slug}`, error)
  return []
}

/**
 * Makes the goal the session's record names active again, once per session ID per process: after
 * `claude --resume` or `--continue` the process goes on under the ID the session had, and after
 * `/resume` the poll finds the new ID. A goal that is gone, done, or held by another live session is
 * not restored, and its record goes. Where git failed, a root that names no record is looked at again.
 */
async function restore($: Host, me: string, root: Where, isFromGit: boolean, nowMs: number, isEnded: () => boolean = () => false) {
  if (vars($).restoredFor === me) return
  // Set before the work, so a poll and a call never restore at once; cleared again where the work
  // fails, so the next poll or call tries again.
  vars($).restoredFor = me
  try {
    if (isFromGit) await pruneRecords($, me, nowMs, root.state).catch(error => logFailure($, "couldn't remove old session records", error))
    const slug = await recordedActive($, me, root.state)
    if (slug === null) {
      // A root that isn't git's can be the wrong one: a later poll with git looks again.
      if (!isFromGit) vars($).restoredFor = null
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
    vars($).lastBeat = nowMs
    if (isFromGit) vars($).lastRoot = root
    const isSwept = (await sweepAgents($, slug, found.goal, root, nowMs).catch(error => sweepFailed($, slug, error))).length > 0
    const shown = isSwept ? await listGoals($, root.outline) : files
    // The session can end while the goal is made active: the lock claimed for it goes.
    if (!(await activate($, slug, me, shown, root, [], isEnded))) {
      await release($, slug, me, root.state).catch(error => logFailure($, `couldn't release the lock on ${slug}`, error))
      return
    }
    await $.view.planActive('call')
  } catch (error) {
    vars($).restoredFor = null
    throw error
  }
}

/**
 * Once per session, at its first poll or call in a repository: a plan folder with no file takes the
 * files of the branch's copy on the remote, so a fresh clone or another machine finds the goals pushed
 * from elsewhere. The session's record of its active goal is restored after it. A failure goes to the
 * debug log, and the poll or the call goes on as with no copy.
 */
async function fetchOnce($: Host, root: Where) {
  if (await $.state.get('planFetched')) return
  // Set first: a process that serves one event never repeats the network round trip.
  await $.state.set('planFetched', true)
  try {
    const names = await restorePlan($, root.outline)
    if (names.length) $.log(`plan outline: restored ${names.join(', ')} from the remote`)
  } catch (error) {
    logFailure($, "couldn't restore the plan outline from the remote", error)
  }
}

/**
 * One poll: the heartbeat every BEAT_MS, then the redraw, with 1 git run. Writes nothing in a checkout
 * with no goal file, apart from the files the session's first poll restores from the remote.
 */
async function poll($: Host) {
  const at = vars($).ends
  const isEnded = () => vars($).ends !== at
  // Read before git, which can outlast the session: a lock is claimed only under the ID of the session it is for.
  const me = await $.session.id()
  const { isFromGit, isGitDown, ...root } = await findPlanRoot($)
  // Git failed inside a repository: the fallback folders are in the working tree, so nothing is written
  // or redrawn there, and the pane keeps what it shows.
  if (isEnded() || isGitDown) return
  const slug = await $.state.get('planGoal')
  // Where git failed (a timeout), the root is the working directory's: while a tree is drawn, the pane
  // keeps it rather than an error, and no lock is written there. Once git has given a
  // root, only that root is trusted; before that (outside git), the working directory's .waffles/plan is,
  // since the drawn goal was created there.
  const shown = slug ?? (await $.state.get('planKept'))
  const { lastRoot } = vars($)
  const isUntrusted = lastRoot !== null ? root.outline !== lastRoot.outline : !(await $.fs.exists(root.outline))
  if (!isFromGit && shown !== null && isUntrusted) return
  if (isFromGit) await fetchOnce($, root)
  if (isEnded()) return
  const now = await $.clock.now()
  // Only from a root git gave, or, before git has given one, the working directory's.
  if (slug === null && (isFromGit || vars($).lastRoot === null)) {
    await restore($, me, root, isFromGit, now, isEnded)
    // The restore drew the tree and claimed the lock: the next heartbeat is due in BEAT_MS.
    if ((await $.state.get('planGoal')) !== null) return
  }
  // With no root found yet, the heartbeat waits for a poll that finds the goal's file.
  if (slug !== null && now - vars($).lastBeat >= BEAT_MS && (await hasGoalFile($, slug, root))) {
    if (isEnded()) return
    vars($).lastBeat = now
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
    const tree = await $.state.get('planTree')
    if (isHeld && tree !== null && agentsOf(tree).length) {
      const swept = await loadGoal($, slug, root.outline)
        .then(goal => sweepAgents($, slug, goal, root, now))
        .catch(error => sweepFailed($, slug, error))
      if (swept.length) await mark($, swept)
    }
  }
  const files = await listGoals($, root.outline)
  if (isEnded()) return
  await refresh($, files, root, { isEnded })
  if (isFromGit) vars($).lastRoot = root
}

/** The slug of this session's active goal, or null. */
export async function activeGoal($: Host): Promise<string | null> {
  return $.state.get('planGoal')
}

/**
 * The person typed a prompt. The highlights mark what changed since they last typed, so it clears
 * them; an adapter leaves out a notification, a trigger and a slash command. With `isTurn`, a prompt
 * typed between turns and no command, a new turn begins: the turn before ends here if its stop did not
 * end it, and the tree drawn now is kept for the rules at this turn's end. A prompt delivered into a
 * running turn begins none, so the rules never run in the middle of one. The work waits its turn behind
 * a poll or a call, so it is not awaited: the prompt never waits on the plan outline.
 */
export function submitPlan($: Host, isTurn: boolean): void {
  void serial($, async () => {
    if ((await $.state.get('planChanged')).length) await $.state.set('planChanged', [])
    if (!isTurn) return
    await finishTurn($, false)
    await $.state.set('planTurn', { goal: await drawnSlug($), tree: await $.state.get('planTree'), isOpen: true })
    // A press holds through the end of the turn it was made in; at this turn's end the rules decide again.
    if ((await $.state.get('planPressed')).length) await $.state.set('planPressed', [])
  }).catch(() => undefined)
}

/**
 * The main thread's turn stopped, also one a notification started: the collapse rules run for it.
 * Queued, not awaited, as submitPlan is.
 */
export function stopPlan($: Host): void {
  void serial($, () => finishTurn($, true)).catch(error => logFailure($, "couldn't collapse the plan outline at the turn's end", error))
}

/**
 * A press on a parent step's row in a view: the step collapses or expands now, unless that would hide
 * work in progress. It holds through the end of the turn it is made in (between turns, the next one);
 * at the end of the turn after, the automatic rules decide again. Queued behind a poll or a call, so a
 * redraw never writes over the press.
 */
export async function pressPlan($: Host, id: string): Promise<void> {
  await serial($, async () => {
    const tree = await $.state.get('planTree')
    const slug = await drawnSlug($)
    if (tree === null || slug === null) return
    const kept = await $.state.get('planCollapsed')
    const next = collapsedOf(slug, toggle(tree, collapsedFor(kept, slug), id))
    if (same(kept, next)) return
    await $.state.set('planCollapsed', next)
    const step = findStep(tree, id)
    const pressed = await $.state.get('planPressed')
    if (step && !pressed.includes(step.id)) await $.state.set('planPressed', [...pressed, step.id])
  })
}

/**
 * The session ended. The lock is released under the ending session's ID; its record stays, so a later
 * resume of it makes its goal active again. Where the process goes on under another session
 * (`isProcessKept`: a clear, or a resume of another session), the new one starts with no active goal:
 * its first message lists the open goals, and the next poll restores a resumed session's goal.
 *
 * It has the session end's time budget, so it doesn't queue behind a poll that may be waiting on git, and
 * it runs git only when git hasn't yet given the root to a poll or a call. A poll under way writes nothing after it.
 */
export async function endPlan($: Host, sessionId: string, isProcessKept: boolean) {
  vars($).ends += 1
  const slug = await $.state.get('planGoal')
  // A lock that can't be removed goes stale in STALE_MS; the session still ends with no goal.
  if (slug !== null) {
    await release($, slug, sessionId, vars($).lastRoot?.state).catch(error => logFailure($, `couldn't release the lock on ${slug}`, error))
  }
  if (!isProcessKept) return
  // Only what holds a value is written, so a repo with no plan outline sees no writes. A view keeps the
  // goal's tree, marked not active, until a goal becomes active.
  if (slug !== null) await lose($, slug)
  if ((await $.state.get('planError')) !== null) await $.state.set('planError', null)
  if ((await $.state.get('planChanged')).length) await $.state.set('planChanged', [])
  // The collapsed steps and the turn are the ended session's view: the new one starts with every step expanded.
  if ((await $.state.get('planCollapsed')) !== null) await $.state.set('planCollapsed', null)
  if ((await $.state.get('planTurn')) !== null) await $.state.set('planTurn', null)
  if ((await $.state.get('planPressed')).length) await $.state.set('planPressed', [])
}

/**
 * A subagent's run ended, so its step waits for the main thread to review the report. A failure goes
 * to the debug log. Queued, not awaited: the subagent's report never waits on the plan outline. A
 * subagent no step names costs nothing.
 */
export async function completePlan($: Host, agent: string) {
  const tree = await $.state.get('planTree')
  if (tree === null || !agentsOf(tree).includes(agent)) return
  void serial($, () => changeActive($, (goal, now) => endAgent(goal, agent, 'review', now))).catch(error =>
    logFailure($, `couldn't end the mark of subagent ${agent}`, error),
  )
}

/**
 * The main thread started a background subagent. One whose description names its step first, with a
 * colon, marks that step while it works. Queued, not awaited: the start never waits on the plan
 * outline, and a failure here never stops the subagent.
 */
export function spawnPlan($: Host, description: string, agent: string): void {
  if (!AGENT_ID.test(agent)) return
  const id = STEP_FIRST.exec(description.trim())?.[1]
  if (id === undefined) return
  void serial($, () => changeActive($, (goal, now) => markRunning(goal, id, agent, now))).catch(error =>
    logFailure($, `couldn't mark step ${id} for subagent ${agent}`, error),
  )
}

/** The plan outline tool, as an adapter registers it: its name there, what it is for, and its input's JSON Schema. */
export const PLAN_TOOL = { name: 'plan', description: DESCRIPTION, inputSchema: SCHEMA } as const

/** The answer to a subagent that calls the tool. */
export const SUBAGENT = 'The plan outline is kept by the main conversation only.'

/**
 * One call of the plan outline tool by the main conversation: the text the model reads, or why the
 * call was refused. A failure of the disk or of git is a refusal too: the model reads what went wrong,
 * and the stack goes to the debug log.
 */
export async function callPlan($: Host, input: Record<string, unknown>): Promise<{ result: string } | { deny: string }> {
  try {
    return { result: await serial($, () => apply($, input)) }
  } catch (error) {
    if (error instanceof PlanError) return { deny: error.message }
    logFailure($, 'a call failed', error)
    return { deny: `plan outline failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * The plan outline tool as a core tool. It is not in `TOOLS` (core/tools.ts): each adapter registers it
 * itself, since it refuses a subagent, starts the session's goal first, and tells a view of each change.
 */
export const planTool: CoreTool = {
  ...PLAN_TOOL,
  call: async ($, input) => {
    const answer = await callPlan($, input)
    return 'deny' in answer ? { refusal: answer.deny } : { text: answer.result }
  },
}

/**
 * One poll, unless one is already waiting its turn: the heartbeat, then the redraw. An adapter with a
 * timer calls it every POLL_MS; one whose process serves one event calls it once per event. A poll
 * that fails has no one to tell: the next one tries again.
 */
export async function tickPlan($: Host): Promise<void> {
  const v = vars($)
  if (v.isPollQueued) return
  v.isPollQueued = true
  await serial($, () => poll($))
    .catch(() => undefined)
    .finally(() => {
      v.isPollQueued = false
    })
}

/**
 * The session started: the first poll is awaited, so the tree is drawn before the first prompt, and a
 * goal still active tells the view.
 */
export async function startPlan($: Host): Promise<void> {
  await tickPlan($)
  if ((await $.state.get('planGoal')) !== null) await $.view.planActive('start')
}
