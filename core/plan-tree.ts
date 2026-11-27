export type Kind = 'planned' | 'work' | 'research'
// review: a background subagent worked on the step and finished; its report waits for the main thread.
export type Stored = 'open' | 'parked' | 'review' | 'done' | 'dropped' | 'deferred'
// active: the main thread's step, or a step with work in progress under it. running: a background subagent works on it.
export type Shown = Stored | 'active' | 'running'
export type Step = {
  id: string
  title: string
  kind: Kind
  state: Stored
  parkedAt?: string
  /** The ID of the background subagent that works on the step, until it finishes. */
  agent?: string
  backlog?: string
  aliases: string[]
  children: Step[]
}
export type Goal = {
  title: string
  status: 'open' | 'done'
  current: string | null
  created: string
  updated: string
  steps: Step[]
}

export class PlanError extends Error {}

const BOX: Record<Stored, string> = { open: ' ', parked: '~', review: 'r', done: 'x', dropped: '-', deferred: '>' }
const STATE_OF = new Map<string, Stored>(Object.entries(BOX).map(([state, box]) => [box, state as Stored]))
/** A step's kind as its row shows it, ahead of the title. */
export const MARKER: Record<Kind, string> = { planned: '', research: '? ', work: '⤷ ' }
const KIND_OF: Record<string, Kind> = { '?': 'research', '⤷': 'work' }

const STEP_LINE = /^( *)- \[([ ~rx>-])\] (\S+) (?:([?⤷]) )?(.*)$/
// The greedy first group and the body free of `<!--` pick the LAST comment on the line, so a link or title holding `<!--` stays intact.
const COMMENT = /^(.*) <!-- ((?:(?!<!--).)*) -->$/
/**
 * A planned step has no marker, so a planned title that itself starts with a marker glyph and a space,
 * or is that glyph alone (a note or a link can follow it), would read back as a detour. The serializer
 * puts a backslash ahead of such a title (and ahead of one that already starts with backslashes then a
 * marker, so the pair stays unambiguous); the parser takes one backslash off a planned title of that shape.
 */
const ESCAPED = /^\\*[?⤷](?: |$)/
const LINK = /^(.*?) → (\S+)$/

/** Parses the Markdown of a plan outline file. Throws PlanError naming the first line that doesn't fit. */
export function parseGoal(text: string, file: string): Goal {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const fail: (n: number) => never = n => {
    throw new PlanError(`Can't read ${file}: line ${n}`)
  }

  if (lines[0] !== '---') fail(1)
  const front: Record<string, string> = {}
  let i = 1
  for (; i < lines.length && lines[i] !== '---'; i++) {
    const m = /^(\w+): (.*)$/.exec(lines[i] ?? '')
    if (!m) fail(i + 1)
    const key = m[1]!
    const value = m[2]!
    // Only these two lines carry a trailing note; a `#` in any other value is part of it.
    front[key] = key === 'status' || key === 'current' ? value.replace(/ +#.*$/, '') : value
  }
  if (i >= lines.length) fail(i + 1)
  const status = front.status
  if (!front.goal || (status !== 'open' && status !== 'done') || !front.current || !front.created || !front.updated) fail(i + 1)

  const steps: Step[] = []
  const stack: Step[] = []
  for (i++; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i] ?? '')) continue
    const m = STEP_LINE.exec(lines[i] ?? '')
    // Every group but the kind marker always takes part in a match of STEP_LINE.
    const indent = m?.[1]
    if (!m || indent === undefined || indent.length % 2 !== 0) return fail(i + 1)
    const depth = indent.length / 2
    if (depth > stack.length) return fail(i + 1)

    let title = m[5]!
    const marker = m[4]
    if (!marker && /^\\+[?⤷](?: |$)/.test(title)) title = title.slice(1)
    const step: Step = {
      id: m[3]!,
      title,
      kind: marker ? KIND_OF[marker]! : 'planned',
      state: STATE_OF.get(m[2]!)!,
      aliases: [],
      children: [],
    }
    const comment = COMMENT.exec(title)
    if (comment) {
      title = comment[1]!
      for (const part of comment[2]!.split(';')) {
        const [key, value] = part.trim().split('=')
        if (key === 'parked' && value) step.parkedAt = value
        else if (key === 'agent' && value) step.agent = value
        else if (key === 'aliases' && value) step.aliases = value.split(',')
        else return fail(i + 1)
      }
    }
    // Only a deferred step carries a link: an open step's title may hold ` → ` itself.
    const link = step.state === 'deferred' ? LINK.exec(title) : null
    if (link) {
      title = link[1]!
      step.backlog = link[2]
    }
    if (step.state === 'deferred' && !step.backlog) return fail(i + 1)
    step.title = title

    // An ID has one dotted part per level, and its prefix is its parent's ID.
    const parent = depth === 0 ? undefined : (stack[depth - 1] ?? fail(i + 1))
    const parts = step.id.split('.')
    if (parts.length !== depth + 1 || parts.slice(0, -1).join('.') !== (parent?.id ?? '')) return fail(i + 1)

    stack.length = depth
    if (parent) parent.children.push(step)
    else steps.push(step)
    stack.push(step)
  }

  return {
    title: front.goal,
    status,
    current: front.current === 'null' ? null : front.current,
    created: front.created,
    updated: front.updated,
    steps,
  }
}

function line(step: Step, depth: number): string {
  const title = step.kind === 'planned' && ESCAPED.test(step.title) ? `\\${step.title}` : step.title
  let out = `${'  '.repeat(depth)}- [${BOX[step.state]}] ${step.id} ${MARKER[step.kind]}${title}`
  if (step.backlog) out += ` → ${step.backlog}`
  const notes: string[] = []
  if (step.parkedAt) notes.push(`parked=${step.parkedAt}`)
  if (step.agent) notes.push(`agent=${step.agent}`)
  if (step.aliases.length) notes.push(`aliases=${step.aliases.join(',')}`)
  if (notes.length) out += ` <!-- ${notes.join('; ')} -->`
  return out
}

/** Writes a goal as the Markdown of a plan outline file. */
export function serializeGoal(goal: Goal): string {
  const out = [
    '---',
    `goal: ${goal.title}`,
    `status: ${goal.status}`,
    `current: ${goal.current ?? 'null'}`,
    `created: ${goal.created}`,
    `updated: ${goal.updated}`,
    '---',
  ]
  const walk = (steps: Step[], depth: number) => {
    for (const step of steps) {
      out.push(line(step, depth))
      walk(step.children, depth + 1)
    }
  }
  walk(goal.steps, 0)
  return `${out.join('\n')}\n`
}

// A slug's most UTF-8 bytes before its `-2` suffix: a file name holds 255, and a CJK title takes 3 a character.
const SLUG_BYTES = 100
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined

// Without `Intl.Segmenter`, a code point with the marks after it.
function graphemes(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), part => part.segment)
  const out: string[] = []
  for (const point of text) {
    if (out.length > 0 && /^\p{M}$/u.test(point)) out[out.length - 1] += point
    else out.push(point)
  }
  return out
}

function utf8Bytes(text: string): number {
  let n = 0
  for (const point of text) {
    const code = point.codePointAt(0)!
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return n
}

/** The text cut to at most `max` UTF-8 bytes, between graphemes. */
function cutBytes(text: string, max: number): string {
  let out = ''
  let used = 0
  for (const g of graphemes(text)) {
    used += utf8Bytes(g)
    if (used > max) break
    out += g
  }
  return out
}

/**
 * Turns a title into a file-name slug that isn't in `taken`; a taken slug gets `-2`, `-3`, and so on.
 * Unicode letters, marks, and digits stay, so `Café` is `café` and a CJK title keeps its characters.
 * A long title's slug is cut to SLUG_BYTES, between characters.
 */
export function slug(title: string, taken: readonly string[]): string {
  const words = title.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  const base = cutBytes(words, SLUG_BYTES).replace(/-+$/, '') || 'goal'
  let out = base
  for (let n = 2; taken.includes(out); n++) out = `${base}-${n}`
  return out
}

/** One row of a plan tool result. */
export type Change =
  | { type: 'goal'; title: string; slug: string; parked?: { title: string; slug: string; at: string } }
  | { type: 'added'; id: string; title: string; kind: Kind; parent: string | null; isCurrent?: true }
  | { type: 'closed'; id: string; title: string; state: 'done' | 'dropped' | 'deferred'; back: string | null; wasParked: boolean }
  | { type: 'parked'; id: string; title: string }
  | { type: 'focus'; id: string; title: string }
  | { type: 'moved'; from: string; to: string; title: string }
  | { type: 'renamed'; id: string; title: string }
  | { type: 'running'; id: string; title: string }
  | { type: 'review'; id: string; title: string }
  | { type: 'goal-done'; title: string }

export type Result = { goal: Goal; changes: Change[] }

const CLOSED: readonly Stored[] = ['done', 'dropped', 'deferred']
const isClosed = (step: Step) => CLOSED.includes(step.state)
const isOpen = (step: Step) => step.state === 'open' || step.state === 'parked' || step.state === 'review'
/** A background subagent works on the step. */
const isRunning = (step: Step) => step.agent !== undefined && !isClosed(step)
/**
 * The parked mark: ⏸ with U+FE0E, the text presentation selector. Without it, iPadOS draws ⏸ as a grey
 * emoji. The selector takes no column.
 */
export const PARKED = '\u23F8\uFE0E'
/** A step's shown state as its row shows it. */
export const SHOWN: Record<Shown, string> = { open: '○', active: '▶', running: '▶', parked: PARKED, review: '◐', done: '✔', dropped: '✗', deferred: '↗' }

function lastNumber(id: string): number {
  return Number(id.slice(id.lastIndexOf('.') + 1))
}

/** The next unused number among the children of `owner` (null for the top level), past every number ever given, aliases included. */
function nextNumber(goal: Goal, owner: Step | null): number {
  const prefix = owner === null ? '' : `${owner.id}.`
  let max = (owner ? owner.children : goal.steps).reduce((m, s) => Math.max(m, lastNumber(s.id)), 0)
  const walk = (steps: readonly Step[]) => {
    for (const step of steps) {
      for (const alias of step.aliases) {
        if (alias.startsWith(prefix) && !alias.slice(prefix.length).includes('.')) max = Math.max(max, lastNumber(alias))
      }
      walk(step.children)
    }
  }
  walk(goal.steps)
  return max + 1
}

function build(title: string, kind: Kind, id: string): Step {
  return { id, title, kind, state: 'open', aliases: [], children: [] }
}

/** Creates a goal whose first step is current. A goal given no steps gets one, titled like the goal, so it can become done. */
export function newGoal(title: string, steps: readonly { title: string; kind?: Kind }[], now: string): Goal {
  const given: readonly { title: string; kind?: Kind }[] = steps.length ? steps : [{ title }]
  const built = given.map((s, i) => build(s.title, s.kind ?? 'planned', String(i + 1)))
  return { title, status: 'open', current: built[0]!.id, created: now, updated: now, steps: built }
}

/** Finds a step by ID or alias. */
export function findStep(goal: Goal, id: string): Step | undefined {
  const walk = (steps: readonly Step[]): Step | undefined => {
    for (const step of steps) {
      if (step.id === id || step.aliases.includes(id)) return step
      const hit = walk(step.children)
      if (hit) return hit
    }
  }
  return walk(goal.steps)
}

/** The steps from the top level down to the current step. Empty when there is no current step. */
export function pathOf(goal: Goal): Step[] {
  if (goal.current === null) return []
  return pathTo(goal, goal.current)
}

function pathTo(goal: Goal, id: string): Step[] {
  const walk = (steps: readonly Step[], route: Step[]): Step[] | undefined => {
    for (const step of steps) {
      const here = [...route, step]
      if (step.id === id || step.aliases.includes(id)) return here
      const hit = walk(step.children, here)
      if (hit) return hit
    }
  }
  return walk(goal.steps, []) ?? []
}

/**
 * The state shown for a step: a step a background subagent works on is running; an open step on the
 * current path, or with a running step under it, is active.
 */
export function shownState(goal: Goal, step: Step): Shown {
  if (isRunning(step)) return 'running'
  // A parked step keeps its parked time under a running step, so rule 5 can still return to it.
  if ((step.state === 'open' || step.state === 'parked') && subtree(step).some(isRunning)) return 'active'
  if (step.state !== 'open') return step.state
  return pathOf(goal).some(s => s.id === step.id) ? 'active' : 'open'
}

function subtree(step: Step): Step[] {
  return [step, ...step.children.flatMap(subtree)]
}

/** Focus leaving a step parks it, unless a subagent works on it or under it, or its report waits for review. */
function isParkable(step: Step): boolean {
  return step.state === 'open' && !subtree(step).some(isRunning)
}

/** Parks the steps of the path focus left that aren't on the path it went to (rule 4). */
function parkLeft(left: readonly Step[], to: readonly Step[], now: string, changes: Change[]) {
  for (const step of left) {
    if (to.includes(step) || !isParkable(step)) continue
    step.state = 'parked'
    step.parkedAt = now
    changes.push({ type: 'parked', id: step.id, title: step.title })
  }
}

/** Opens the parked steps of a path focus went to; a step whose report waited is now the main thread's. */
function unpark(path: readonly Step[]) {
  for (const step of path) {
    if (step.state === 'parked' || step.state === 'review') {
      step.state = 'open'
      delete step.parkedAt
    }
  }
}

function copy(goal: Goal, now: string): Goal {
  return { ...structuredClone(goal), updated: now }
}

/** A no-op returns the goal as a copy, so a caller never holds its own object as the result. */
function unchanged(goal: Goal): Result {
  return { goal: structuredClone(goal), changes: [] }
}

function need(goal: Goal, id: string): Step {
  const step = findStep(goal, id)
  if (!step) throw new PlanError(`No step ${id} in "${goal.title}"`)
  return step
}

function needOpen(goal: Goal, id: string): Step {
  const step = need(goal, id)
  if (isClosed(step)) throw new PlanError(`${step.id} is closed`)
  return step
}

/**
 * Adds steps under a parent (null for the top level), numbered after the highest number already used.
 * With `focus`, the first new step becomes current as focusStep makes it: its row ends `→ current`.
 */
export function addSteps(goal: Goal, parent: string | null, kind: Kind, titles: readonly string[], now: string, { focus = false } = {}): Result {
  const next = copy(goal, now)
  const owner = parent === null ? null : needOpen(next, parent)
  const siblings = owner ? owner.children : next.steps
  const changes: Change[] = []
  let n = nextNumber(next, owner)
  for (const title of titles) {
    const step = build(title, kind, owner ? `${owner.id}.${n++}` : String(n++))
    siblings.push(step)
    changes.push({ type: 'added', id: step.id, title, kind, parent: owner?.id ?? null })
  }
  if (next.current === null && next.status === 'open' && next.steps.length) next.current = next.steps[0]!.id
  const first = changes[0]
  if (!focus || first?.type !== 'added') return { goal: next, changes }
  const focused = focusStep(next, first.id, now)
  first.isCurrent = true
  // The add's row says where focus went, so focusStep's own row is left out; its parked rows stay.
  return { goal: focused.goal, changes: [...changes, ...focused.changes.filter(c => c.type !== 'focus')] }
}

/** Follows rule 5 from a step down to where work stopped, then returns the path to it. */
function descend(step: Step): Step {
  let at = step
  for (;;) {
    const parked = at.children.filter((c) => c.state === 'parked' && c.parkedAt)
    if (!parked.length) return at
    at = parked.reduce((a, b) => (b.parkedAt! > a.parkedAt! ? b : a))
  }
}

/** Moves focus to a landing step (rule 4), unparks the path to it, and sets it current. */
function land(goal: Goal, landing: Step, now: string, changes: Change[]) {
  const to = pathTo(goal, landing.id)
  parkLeft(pathOf(goal), to, now, changes)
  unpark(to)
  goal.current = landing.id
}

/**
 * Moves focus to an open step, or to where work stopped beneath it. Focus on the current step takes over
 * a report waiting there, or a step parked on its path, and otherwise changes nothing.
 */
export function focusStep(goal: Goal, id: string, now: string): Result {
  const step = needOpen(goal, id)
  if (step.id === goal.current) {
    if (!pathOf(goal).some(s => s.state === 'review' || s.state === 'parked')) return unchanged(goal)
    const next = copy(goal, now)
    unpark(pathOf(next))
    return { goal: next, changes: [{ type: 'focus', id: step.id, title: step.title }] }
  }
  const next = copy(goal, now)
  const landing = descend(needOpen(next, id))
  const changes: Change[] = []
  land(next, landing, now, changes)
  changes.push({ type: 'focus', id: landing.id, title: landing.title })
  return { goal: next, changes }
}

function close(goal: Goal, id: string, state: 'done' | 'dropped' | 'deferred', backlog: string | undefined, cascade: boolean, now: string): Result {
  const next = copy(goal, now)
  const step = needOpen(next, id)
  const open = subtree(step).slice(1).filter(isOpen)
  if (open.length && !cascade) throw new PlanError(`${step.id} has open steps: ${open.map((s) => s.id).join(', ')}`)

  const onPath = pathOf(next).includes(step)
  for (const s of [step, ...open]) {
    s.state = state
    delete s.parkedAt
    delete s.agent
    if (backlog) s.backlog = backlog
  }

  const change: Change = { type: 'closed', id: step.id, title: step.title, state, back: null, wasParked: false }
  const changes: Change[] = [change]
  if (next.steps.every(isClosed)) {
    next.status = 'done'
    next.current = null
    changes.push({ type: 'goal-done', title: next.title })
    return { goal: next, changes }
  }
  if (!onPath) return { goal: next, changes }

  const route = pathTo(next, step.id)
  const parent = route.length > 1 ? route[route.length - 2] : null
  let landing: Step
  if (parent) landing = parent
  else {
    const at = next.steps.indexOf(step)
    const live = (s: Step) => isOpen(s)
    landing = next.steps.slice(at + 1).find(live) ?? next.steps.slice(0, at).find(live)!
  }
  landing = descend(landing)
  const parkedBefore = landing.state === 'parked'
  land(next, landing, now, changes)
  Object.assign(change, { back: `${landing.id} ${landing.title}`, wasParked: parkedBefore })
  return { goal: next, changes }
}

/** Closes steps as done or dropped, in the order given. */
export function closeSteps(goal: Goal, ids: readonly string[], state: 'done' | 'dropped', cascade: boolean, now: string): Result {
  let current = goal
  const changes: Change[] = []
  for (const id of ids) {
    const result = close(current, id, state, undefined, cascade, now)
    current = result.goal
    changes.push(...result.changes)
  }
  // Only the last change that moved focus keeps its "back to" text.
  // When the goal ended, none does: there is no step to go back to.
  const moved = changes.filter((c) => c.type === 'closed' && c.back !== null)
  for (const c of current.current === null ? moved : moved.slice(0, -1)) if (c.type === 'closed') Object.assign(c, { back: null, wasParked: false })
  return { goal: current === goal ? copy(goal, now) : current, changes }
}

/** Closes a step as deferred, linking the backlog item it moved to. */
export function deferStep(goal: Goal, id: string, backlog: string, cascade: boolean, now: string): Result {
  // The link is the last word of the step's line: a space or line break in it would misread the file.
  if (!/^\S+$/.test(backlog)) throw new PlanError(`A backlog path is one word with no spaces: ${JSON.stringify(backlog)}`)
  return close(goal, id, 'deferred', backlog, cascade, now)
}

/** Renames a step. */
export function renameStep(goal: Goal, id: string, title: string, now: string): Result {
  const next = copy(goal, now)
  const step = need(next, id)
  step.title = title
  return { goal: next, changes: [{ type: 'renamed', id: step.id, title }] }
}

/** Gives a step and its descendants new IDs under `id`, optionally keeping each old ID as an alias. */
function renumber(step: Step, id: string, alias: boolean) {
  const old = step.id
  const walk = (s: Step) => {
    const was = s.id
    const now = id + was.slice(old.length)
    if (alias) {
      if (!s.aliases.includes(was)) s.aliases.push(was)
    } else s.aliases = []
    s.aliases = s.aliases.filter((a) => a !== now)
    s.id = now
    s.children.forEach(walk)
  }
  walk(step)
}

/** Moves a step and its subtree under another step (null for the top level); old IDs stay as aliases. */
export function moveStep(goal: Goal, id: string, parent: string | null, now: string): Result {
  const next = copy(goal, now)
  const step = need(next, id)
  const owner = parent === null ? null : need(next, parent)
  if (owner && subtree(step).includes(owner)) throw new PlanError(`Can't move ${id} under ${parent}: ${parent} is inside ${id}`)

  const route = pathTo(next, step.id)
  const from = route.length > 1 ? route[route.length - 2] : null
  if ((from?.id ?? null) === (owner?.id ?? null)) return unchanged(goal)

  if (owner && isClosed(owner)) throw new PlanError(`Can't move ${id} under ${parent}: ${parent} is closed`)

  const old = step.id
  const siblings = owner ? owner.children : next.steps
  const oldPath = pathOf(next)
  // Counted before the splice, so the aliases on the moved subtree count too.
  const n = nextNumber(next, owner)
  const home = from ? from.children : next.steps
  home.splice(home.indexOf(step), 1)
  const to = owner ? `${owner.id}.${n}` : String(n)
  renumber(step, to, true)
  siblings.push(step)
  if (next.current !== null && (next.current === old || next.current.startsWith(`${old}.`))) next.current = to + next.current.slice(old.length)
  const changes: Change[] = [{ type: 'moved', from: old, to, title: step.title }]
  // Steps the move took off the current path are parked, so rule 5 can return to them.
  const newPath = pathOf(next)
  parkLeft(oldPath, newPath, now, changes)
  unpark(newPath)
  return { goal: next, changes }
}

/** Moves the top-level steps of one goal under a step of another. Returns the target; the caller deletes the source. */
export function moveGoalInto(source: Goal, target: Goal, parent: string, now: string): Result {
  const next = copy(target, now)
  const owner = needOpen(next, parent)
  const changes: Change[] = []
  for (const step of structuredClone(source.steps)) {
    const from = step.id
    const to = `${owner.id}.${nextNumber(next, owner)}`
    // Aliases of the source name steps of the other goal, so they don't carry over.
    renumber(step, to, false)
    owner.children.push(step)
    changes.push({ type: 'moved', from, to, title: step.title })
  }
  return { goal: next, changes }
}

/**
 * Marks the step a background subagent starts on; a report waiting there is the subagent's again. Parked
 * steps keep their parked time, so rule 5 still returns to them, and focus stays where it is. Null when
 * no open step has the ID.
 */
export function markRunning(goal: Goal, id: string, agent: string, now: string): Result | null {
  const found = findStep(goal, id)
  if (!found || isClosed(found)) return null
  const next = copy(goal, now)
  const step = need(next, id)
  step.agent = agent
  if (step.state === 'review') step.state = 'open'
  return { goal: next, changes: [{ type: 'running', id: step.id, title: step.title }] }
}

/**
 * Ends a subagent's mark on its step: a subagent that finished leaves its report for review; one that
 * stopped unseen leaves the step parked, or open where it is on the current path. Null when no step has
 * the subagent.
 */
export function endAgent(goal: Goal, agent: string, state: 'review' | 'parked', now: string): Result | null {
  const has = (steps: readonly Step[]): Step | undefined => steps.flatMap(subtree).find(s => s.agent === agent)
  if (!has(goal.steps)) return null
  const next = copy(goal, now)
  const step = has(next.steps)!
  delete step.agent
  if (isClosed(step)) return { goal: next, changes: [] }
  if (state === 'parked' && pathOf(next).includes(step)) return { goal: next, changes: [] }
  step.state = state
  if (state === 'parked' && step.parkedAt === undefined) step.parkedAt = now
  if (state === 'review') delete step.parkedAt
  return { goal: next, changes: [state === 'review' ? { type: 'review', id: step.id, title: step.title } : { type: 'parked', id: step.id, title: step.title }] }
}

/** The IDs of the subagents that work on the goal's steps. */
export function agentsOf(goal: Goal): string[] {
  return goal.steps.flatMap(subtree).flatMap(s => (s.agent === undefined ? [] : [s.agent]))
}

/** Writes one change as a row of a plan tool result. */
export function describe(change: Change): string {
  switch (change.type) {
    case 'goal':
      return `◇ new goal: ${change.title} [${change.slug}]${change.parked ? ` (${change.parked.title} [${change.parked.slug}] parked at ${change.parked.at})` : ''}`
    case 'added':
      return `+ ${change.id} ${MARKER[change.kind]}${change.title}${change.parent === null ? '' : ` under ${change.parent}`}${change.isCurrent ? ' → current' : ''}`
    case 'closed': {
      const mark = { done: '✔', dropped: '✗', deferred: '↗' }[change.state]
      const back = change.back === null ? '' : ` → back to ${change.back}${change.wasParked ? ' (was parked)' : ''}`
      return `${mark} ${change.id} ${change.title}${back}`
    }
    case 'parked':
      return `${PARKED} ${change.id} ${change.title}`
    case 'focus':
      return `▶ ${change.id} ${change.title}`
    case 'moved':
      return `moved ${change.from} → ${change.to}`
    case 'renamed':
      return `renamed ${change.id} to ${change.title}`
    case 'running':
      return `▶ ${change.id} ${change.title} (subagent)`
    case 'review':
      return `◐ ${change.id} ${change.title} (subagent finished: review its report)`
    case 'goal-done':
      return `✔ goal done: ${change.title}`
  }
}

// What the model reads after a step's title, where its glyph alone doesn't say whose work it is.
const NOTE: Partial<Record<Shown, string>> = { running: ' (subagent)', review: ' (subagent finished: review its report)' }

/** The tree as lines for the model, indented 2 per level. */
export function renderTree(goal: Goal): string[] {
  const out: string[] = []
  const walk = (steps: readonly Step[], depth: number) => {
    for (const s of steps) {
      const state = shownState(goal, s)
      out.push(`${'  '.repeat(depth)}${SHOWN[state]} ${s.id} ${MARKER[s.kind]}${s.title}${NOTE[state] ?? ''}`)
      walk(s.children, depth + 1)
    }
  }
  walk(goal.steps, 0)
  return out
}
