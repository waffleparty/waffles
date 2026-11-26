import type { SessionState } from '../../core/host.ts'
import { currentOf } from '../../core/plan.ts'
import type { Goal } from '../../core/plan-tree.ts'
import { cut, paneRows, width, type Piece } from '../../core/plan-view.ts'

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
const MODE_COLORS: Record<string, string> = { production: '#6495ed', backlog: '#a855f7', rapid: '#7fff00' }

/** The colors of the plan outline's pieces, by the name the core gives them. */
export const PIECE_COLORS: Record<string, string> = {
  success: '#22c55e',
  warning: '#f59e0b',
  cyan: '#22d3ee',
  magenta: '#d946ef',
  yellow: '#eab308',
}

/**
 * The columns the footer item may take in all. Its row is shared with the folder and OpenCode's own
 * hints, and a longer item wraps onto a second row.
 */
export const FOOTER_ROOM = 26
// Under this many columns for the current step, the footer shows its ID alone.
const MIN_STEP = 8

/**
 * The footer's parts: the mode (or a run over it) with its mark's color, then the plan outline's
 * current step when a goal is drawn, cut so the whole item fits `room` columns.
 */
export function footerParts(metadata: unknown, room = FOOTER_ROOM): { mark: string; color: string; mode: string; step: string | null } {
  const kept = keptOf(metadata)
  const goal = goalOf(kept)
  const isRun = kept.run === true
  const mode = isRun ? 'non-interactive' : (kept.mode ?? 'production')
  const mark = isRun ? '▶' : '●'
  const color = isRun ? RUN : (MODE_COLORS[mode] ?? MODE_COLORS.production!)
  const current = goal ? currentOf(goal) : null
  if (current === null) return { mark, color, mode, step: null }
  // The item reads `<mark> <mode> · <step>`.
  const left = room - width(`${mark} ${mode} · `)
  const step = left >= MIN_STEP ? cut(current, left) : (current.split(' ')[0] ?? null)
  return { mark, color, mode, step }
}

/** The plan outline's rows for a panel `room` columns wide, as on Claude Code; empty with no goal drawn. */
export function outlineRows(metadata: unknown, room: number): Piece[][] {
  const goal = goalOf(keptOf(metadata))
  return goal ? paneRows(goal, true, false, null, null, [], [], room) : []
}
