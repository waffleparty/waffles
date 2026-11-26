import type { SessionState } from '../../core/host.ts'
import { currentOf } from '../../core/plan.ts'
import { renderTree, type Goal } from '../../core/plan-tree.ts'

/**
 * What the terminal UI part draws, from the `waffles` value the server part keeps in a session's
 * metadata. The terminal UI can run on another machine than the server, so it reads nothing else.
 */
type Kept = Partial<Pick<SessionState, 'mode' | 'run' | 'planTree'>>

const keptOf = (metadata: unknown): Kept => {
  const kept = (metadata as { waffles?: unknown } | null | undefined)?.waffles
  return typeof kept === 'object' && kept !== null ? (kept as Kept) : {}
}

const goalOf = (kept: Kept): Goal | null => (kept.planTree && Array.isArray(kept.planTree.steps) ? kept.planTree : null)

// The mark's color for each mode, as on Claude Code: a run, production, backlog, rapid.
const RUN = '#f97316'
const COLORS: Record<string, string> = { production: '#6495ed', backlog: '#a855f7', rapid: '#7fff00' }

/** The footer's parts: the mode (or a run over it) with its mark's color, then the plan outline's current step when a goal is drawn. */
export function footerParts(metadata: unknown): { mark: string; color: string; mode: string; step: string | null } {
  const kept = keptOf(metadata)
  const goal = goalOf(kept)
  const step = goal ? currentOf(goal) : null
  if (kept.run === true) return { mark: '▶', color: RUN, mode: 'non-interactive', step }
  const mode = kept.mode ?? 'production'
  return { mark: '●', color: COLORS[mode] ?? COLORS.production!, mode, step }
}

/** The plan outline for the sidebar: the goal's title, then its tree, one line each; empty with no goal drawn. */
export function outlineLines(metadata: unknown): string[] {
  const goal = goalOf(keptOf(metadata))
  return goal ? [goal.title, ...renderTree(goal)] : []
}
