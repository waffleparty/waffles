import { findStep, type Goal, type Step } from './plan-tree.ts'

/**
 * Which parent steps the plan outline's pane draws collapsed. It is view state: each session keeps its
 * own, and no goal file holds it. A step is named by its ID, and a step whose ID is not listed is
 * expanded. A moved step keeps its state: its old ID is its alias, and resolves to it.
 */

/** The drawn goal's collapsed steps: the goal's slug, and the IDs of its collapsed steps. */
export type Collapsed = { goal: string; ids: string[] }

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
