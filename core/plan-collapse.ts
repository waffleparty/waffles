import { findStep, shownState, type Goal, type Shown, type Step } from './plan-tree.ts'

/**
 * Which parent steps the plan outline's pane draws collapsed. It is view state: each session keeps its
 * own, and no goal file holds it. A step is named by its ID, and a step whose ID is not listed is
 * expanded. A moved step keeps its state: its old ID is its alias, and resolves to it.
 */

/** The drawn goal's collapsed steps: the goal's slug, and the IDs of its collapsed steps. */
export type Collapsed = { goal: string; ids: string[] }

/**
 * The tree drawn at the last turn boundary, for the rules at the next one: the drawn goal's slug (null
 * with none) and its tree (null when it could not be read). `isOpen` holds from the prompt the person
 * typed to begin a turn until that turn's end; otherwise the tree is the one the rules last ran on.
 */
export type Turn = { goal: string | null; tree: Goal | null; isOpen: boolean }

/** Whether the step is listed: by its ID, or by an old ID that a move left as its alias. */
export function isCollapsed(step: Step, ids: readonly string[]): boolean {
  return ids.includes(step.id) || step.aliases.some(alias => ids.includes(alias))
}

/**
 * The IDs as the goal names its steps now: an old ID becomes the step's ID. An ID with no step goes, and
 * so does a step with no children, which has nothing to collapse.
 */
export function currentIds(goal: Goal, ids: readonly string[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    const step = findStep(goal, id)
    if (step && step.children.length > 0 && !out.includes(step.id)) out.push(step.id)
  }
  return out
}

/** The collapsed IDs of the goal drawn as `slug`: none when they were kept for another goal. */
export function collapsedFor(collapsed: Collapsed | null, slug: string | null): string[] {
  return collapsed !== null && collapsed.goal === slug ? collapsed.ids : []
}

/** The value kept for the goal: null when no step of it is collapsed. */
export function collapsedOf(slug: string, ids: readonly string[]): Collapsed | null {
  return ids.length ? { goal: slug, ids: [...ids] } : null
}

// A step where work happens, or with work under it: the shown states the rules call active. Parked is not.
const ACTIVE: readonly Shown[] = ['active', 'running', 'review']
const isActive = (goal: Goal, step: Step) => ACTIVE.includes(shownState(goal, step))
const isClosed = (step: Step) => step.state === 'done' || step.state === 'dropped' || step.state === 'deferred'

/** The step of `before` that is `step`: by its ID, or by an old ID a move left as its alias. */
function earlier(before: Goal, step: Step): Step | undefined {
  for (const id of [step.id, ...step.aliases]) {
    const found = findStep(before, id)
    if (found) return found
  }
  return undefined
}

/** Each parent step of the goal with the IDs of its ancestors, top level first, in the tree's order. */
function parents(goal: Goal): { step: Step; above: string[] }[] {
  const out: { step: Step; above: string[] }[] = []
  const walk = (steps: readonly Step[], above: string[]) => {
    for (const step of steps) {
      if (step.children.length === 0) continue
      out.push({ step, above })
      walk(step.children, [...above, step.id])
    }
  }
  walk(goal.steps, [])
  return out
}

/** The IDs of the steps of `after` that `before` has no step for: the steps added since. With no `before`, every step. */
export function newIds(before: Goal | null, after: Goal): string[] {
  const out: string[] = []
  const walk = (steps: readonly Step[]) => {
    for (const step of steps) {
      if (before === null || !earlier(before, step)) out.push(step.id)
      walk(step.children)
    }
  }
  walk(after.steps)
  return out
}

/**
 * The IDs with every step that must be visible shown: the main thread's current step, a step a subagent
 * works on, and a step whose report waits for review. Their ancestors are expanded.
 */
export function reveal(goal: Goal, ids: readonly string[]): string[] {
  const hidden = new Set<string>()
  const walk = (steps: readonly Step[], above: string[]) => {
    for (const step of steps) {
      const shown = shownState(goal, step)
      if (step.id === goal.current || shown === 'running' || shown === 'review') for (const id of above) hidden.add(id)
      walk(step.children, [...above, step.id])
    }
  }
  walk(goal.steps, [])
  return currentIds(goal, ids).filter(id => !hidden.has(id))
}

/**
 * The collapsed IDs at the end of a turn. `before` is the tree when the turn began (null when no tree of
 * this goal was drawn then), `after` the tree now, `ids` the collapsed IDs, and `added` the IDs of the
 * steps added during the turn. For each parent step P, the first rule here that holds decides:
 *
 * - Every child of P is closed: P collapses. This wins over the next two rules, also when the children
 *   were added this turn.
 * - A child of P was started (it became active, running, or waiting for review): P and its ancestors expand.
 * - A child of P is new: P and its ancestors expand, so the new step is visible.
 * - No child of P is active, and each was there when the turn began: P collapses.
 * - Otherwise P keeps its state, as the rules or a press left it.
 *
 * An ancestor that the second or third rule expands stays expanded whatever its own rule says. Last,
 * every step that must be visible is shown (`reveal`).
 *
 * With `isExpandOnly`, for a stop with no turn of the person's open (a turn a notification started), the
 * rules that collapse keep P's state instead: steps collapse once per person's turn, at its end. A step
 * in `held` (pressed during the turn) keeps the state the press gave it, whatever the rules say.
 */
export function endTurn(
  before: Goal | null,
  after: Goal,
  ids: readonly string[],
  added: readonly string[],
  { isExpandOnly = false, held = [] }: { isExpandOnly?: boolean; held?: readonly string[] } = {},
): string[] {
  const given = new Set(currentIds(after, ids))
  const kept = new Set(held.flatMap(id => findStep(after, id)?.id ?? []))
  const collapsed = new Set(given)
  const opened = new Set<string>()
  const wasActive = (step: Step) => {
    const was = before === null ? undefined : earlier(before, step)
    return was !== undefined && isActive(before!, was)
  }
  for (const { step, above } of parents(after)) {
    const kids = step.children
    if (kids.every(isClosed)) {
      if (!isExpandOnly) collapsed.add(step.id)
    } else if (kids.some(kid => isActive(after, kid) && !wasActive(kid)) || kids.some(kid => added.includes(kid.id))) {
      for (const id of [...above, step.id]) opened.add(id)
    } else if (!isExpandOnly && !kids.some(kid => isActive(after, kid))) collapsed.add(step.id)
  }
  const out = parents(after)
    .map(p => p.step.id)
    .filter(id => (kept.has(id) ? given.has(id) : collapsed.has(id) && !opened.has(id)))
  return reveal(after, out)
}

/**
 * The IDs after a press on the step's row: a collapsed step expands, and an expanded one collapses. A
 * step the press would hide work under stays expanded, and a step with no children has no state.
 */
export function toggle(goal: Goal, ids: readonly string[], id: string): string[] {
  const step = findStep(goal, id)
  const kept = currentIds(goal, ids)
  if (!step || step.children.length === 0) return kept
  const next = isCollapsed(step, kept) ? kept.filter(k => k !== step.id) : [...kept, step.id]
  return reveal(goal, next)
}
