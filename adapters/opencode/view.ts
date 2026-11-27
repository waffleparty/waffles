import type { Rpc } from '@opencode/plugin'

import type { SessionState } from '../../core/host.ts'
import { currentOf } from '../../core/plan.ts'
import type { Goal } from '../../core/plan-tree.ts'
import { cut, paneRows, width, type Piece } from '../../core/plan-view.ts'

/**
 * What the terminal UI part draws, from the `waffles` value the server part keeps in a session's
 * metadata. The terminal UI can run on another machine than the server, so it reads nothing else.
 */
type Kept = Partial<Pick<SessionState, 'mode' | 'run' | 'planTree' | 'planCollapsed'>>

const keptOf = (metadata: unknown): Kept => {
  const kept = (metadata as { waffles?: unknown } | null | undefined)?.waffles
  return typeof kept === 'object' && kept !== null ? (kept as Kept) : {}
}

const goalOf = (kept: Kept): Goal | null => (kept.planTree && Array.isArray(kept.planTree.steps) ? kept.planTree : null)

// The server part keeps the collapsed steps of the tree it keeps, so they are the drawn goal's.
const collapsedOf = (kept: Kept): string[] => {
  const ids = kept.planCollapsed?.ids
  return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []
}

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

/**
 * The session's metadata key that holds the last line a command has for the person: a command's executor
 * has no reply of its own on OpenCode, so the terminal UI part shows it as a toast.
 */
export const NOTICE = 'waffles.notice'

/**
 * The line a command left for the person to read, as a toast shows it: null when there is none, or when
 * it is the one `seen` already names. `at` tells one line from the next, so each shows once.
 */
export function noticeOf(metadata: unknown, seen: number | null): { text: string; at: number } | null {
  const notice = (metadata as Record<string, unknown> | null | undefined)?.[NOTICE] as { text?: unknown; at?: unknown } | undefined
  if (typeof notice?.text !== 'string' || typeof notice.at !== 'number' || notice.at === seen) return null
  return { text: notice.text, at: notice.at }
}

/** The plan outline's rows for a panel `room` columns wide, as on Claude Code; empty with no goal drawn. */
export function outlineRows(metadata: unknown, room: number): Piece[][] {
  const kept = keptOf(metadata)
  const goal = goalOf(kept)
  return goal ? paneRows(goal, true, false, null, null, [], [], collapsedOf(kept), room) : []
}

/** The ID of the step a click on the row collapses or expands; undefined for a row of no parent step. */
export const toggleOf = (row: readonly Piece[]): string | undefined => row.find(piece => piece.toggle !== undefined)?.toggle

/**
 * The server part's RPC that the terminal UI part calls on a click on a parent step's row: `press`
 * collapses or expands the step in the session's plan outline, as a press does on Claude Code.
 */
export const PLAN_RPC = {
  id: 'waffles.plan',
  methods: {
    press: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' }, id: { type: 'string' } },
        required: ['sessionID', 'id'],
        additionalProperties: false,
      },
      output: { type: 'object' },
    },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition

/** The input of a `press`, or null when it is not one. */
export function pressOf(input: unknown): { sessionID: string; id: string } | null {
  const { sessionID, id } = (input ?? {}) as { sessionID?: unknown; id?: unknown }
  return typeof sessionID === 'string' && typeof id === 'string' ? { sessionID, id } : null
}
