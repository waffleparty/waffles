import { isCollapsed, reveal } from './plan-collapse.ts'
import { MARKER, SHOWN, shownState, type Goal, type Shown, type Step } from './plan-tree.ts'

/**
 * The plan outline as rows to draw: what each row says and how it is marked. Every platform that draws
 * the outline draws these rows, so the tree looks the same everywhere; an adapter turns a piece's color
 * name and its flags into its platform's own styling.
 */

// State marker colors: done green and open amber follow the theme.
const MARK_COLOR: Partial<Record<Shown, string>> = { done: 'success', open: 'warning' }
// Whose work a step is: the main thread's current step, a step a background subagent works on, and a
// step whose subagent finished and whose report waits for the main thread. The footer's ▶ is MAIN too.
export const MAIN = 'cyan'
const AGENT = 'magenta'
const REVIEW = 'yellow'

/**
 * A run of text in one style. `color` is a name: `success`, `warning`, `cyan`, `magenta`, or `yellow`.
 * `toggle`, on a parent step's disclosure glyph, is the ID of the step a press on its row collapses or expands.
 */
export type Piece = { text: string; color?: string; isDim?: boolean; isBold?: boolean; isItalic?: boolean; toggle?: string }

// A parent step's disclosure glyph, dim, in a gutter of 2 columns before the state mark: `›` collapsed,
// `⌄` expanded, then a space. A step with no children has 2 blank columns there, so the state marks of
// one depth line up.
const COLLAPSED = '›'
const EXPANDED = '⌄'
const GUTTER = '  '

// Terminal cells, not code points: wide characters take 2 and combining marks 0, and a cut never splits a grapheme.
const ZERO = /^[\p{M}\u200B-\u200D\u2060\uFEFF\uFE00-\uFE0F]$/u
const WIDE =
  /^[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]$/u
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined

/** The graphemes of the text. Without `Intl.Segmenter`: a code point with the marks and joined parts after it. */
function graphemes(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), part => part.segment)
  const out: string[] = []
  let isJoined = false
  for (const point of text) {
    if (out.length > 0 && (isJoined || ZERO.test(point))) out[out.length - 1] += point
    else out.push(point)
    isJoined = point === '\u200D'
  }
  return out
}

function cells(grapheme: string): number {
  if (EMOJI.test(grapheme)) return 2
  let n = 0
  for (const point of grapheme) n += ZERO.test(point) ? 0 : WIDE.test(point) ? 2 : 1
  return Math.min(n, 2)
}

/** The columns the text takes in a terminal. */
export const width = (text: string) => graphemes(text).reduce((n, g) => n + cells(g), 0)

/** The text cut to `room` columns, its last one `…` when cut. */
export function cut(text: string, room: number): string {
  if (width(text) <= room) return text
  if (room <= 0) return ''
  let kept = ''
  let used = 0
  for (const g of graphemes(text)) {
    if (used + cells(g) > room - 1) break
    kept += g
    used += cells(g)
  }
  return `${kept.trimEnd()}…`
}

// The step where work happens takes its owner's color, its marker bold: the main thread's current step
// cyan, a subagent's step magenta, a step whose report waits yellow. A step with that work under it is
// bold in the text color. A step changed since the person's last prompt is italic. None moves the row.
// A collapsed step's row ends with the count of the steps right under it, dim: `Build (5)`.
export function stepRow(goal: Goal, step: Step, depth: number, isChanged: boolean, isShut: boolean, room: number): Piece[] {
  const state = shownState(goal, step)
  const hasChildren = step.children.length > 0
  const indent = '  '.repeat(depth)
  const gutter = hasChildren ? `${isShut ? COLLAPSED : EXPANDED} ` : GUTTER
  const mark = SHOWN[state]
  const head = ` ${step.id} ${MARKER[step.kind]}`
  const count = hasChildren && isShut ? ` (${step.children.length})` : ''
  // The room left for the title, after the gutter and the count: a long title is cut, never the count.
  // A cut title ends `…`, and 1 space goes between it and the count: `Long title… (5)`.
  const title = cut(step.title, room - width(indent) - width(gutter) - width(mark) - width(head) - width(count))
  const color = state === 'running' ? AGENT : state === 'review' ? REVIEW : state === 'active' && step.id === goal.current ? MAIN : undefined
  const isParent = state === 'active' && color === undefined
  const isDim = state === 'dropped'
  const isItalic = isChanged || undefined
  return [
    ...(hasChildren ? [...(indent ? [{ text: indent }] : []), { text: gutter, isDim: true, toggle: step.id }] : [{ text: indent + gutter }]),
    { text: mark, color: isDim ? undefined : (color ?? MARK_COLOR[state]), isDim, isBold: color !== undefined || isParent, isItalic },
    // With no room for a title at all, the count follows the ID after 1 space too.
    { text: title === '' && count ? head.trimEnd() : head + title, color, isDim, isBold: isParent, isItalic },
    ...(count ? [{ text: count, isDim: true }] : []),
  ]
}

/**
 * The pane's rows: the goal's title, a note when it is not active, each step, then the count of other
 * goals. `collapsed` holds the IDs of the collapsed steps, whose children are not drawn; work in progress
 * is drawn even under one (core/plan-collapse.ts's `reveal`). `room` is the width in columns.
 */
export function paneRows(
  goal: Goal | null,
  isActive: boolean,
  isKept: boolean,
  error: string | null,
  issue: 'missing' | 'unreadable' | null,
  others: readonly { inUse: boolean }[],
  changed: readonly string[],
  collapsed: readonly string[],
  room: number,
): Piece[][] {
  if (error !== null) return [[{ text: cut(error, room) }]]
  if (goal === null) return [[{ text: cut('No active goal.', room), isDim: true }]]
  const rows: Piece[][] = [[{ text: cut(goal.title, room), isBold: true }]]
  // A goal kept after it ended, or after /clear or a resume, until a goal becomes active. A new goal's
  // tree is drawn a moment before it is active, with nothing kept: it gets no row.
  if (!isActive && isKept) {
    const note = issue === 'missing' ? ' · file missing' : issue === 'unreadable' ? " · can't read the file" : ''
    rows.push([{ text: cut(`${goal.status === 'done' ? 'done' : 'not active'}${note}`, room), isDim: true }])
  }
  const shut = reveal(goal, collapsed)
  const walk = (steps: readonly Step[], depth: number) => {
    for (const step of steps) {
      const isShut = step.children.length > 0 && isCollapsed(step, shut)
      rows.push(stepRow(goal, step, depth, changed.includes(step.id), isShut, room))
      if (!isShut) walk(step.children, depth + 1)
    }
  }
  walk(goal.steps, 0)
  const parked = others.filter(o => !o.inUse).length
  const inUse = others.length - parked
  // A blank row between the tree and the counts under it. A space: an empty Text draws no row.
  if (parked > 0 || inUse > 0) rows.push([{ text: ' ' }])
  if (parked > 0) rows.push([{ text: cut(`${parked} other ${parked === 1 ? 'goal' : 'goals'} parked`, room), isDim: true }])
  if (inUse > 0) rows.push([{ text: cut(`${inUse} in use: other session`, room), isDim: true }])
  return rows
}

/** The steps closed (done, dropped, or deferred) and all steps, at every depth. */
export function stepCount(steps: readonly Step[]): { closed: number; all: number } {
  let closed = 0
  let all = 0
  const walk = (list: readonly Step[]) => {
    for (const step of list) {
      all++
      if (step.state === 'done' || step.state === 'dropped' || step.state === 'deferred') closed++
      walk(step.children)
    }
  }
  walk(steps)
  return { closed, all }
}
