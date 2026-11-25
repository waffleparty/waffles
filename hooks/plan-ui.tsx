import { atom, read } from 'claude-code'
import type { EngineInterface, On, PaneCloseInput, RenderInput } from 'claude-code'

import type { PlanGoal, PlanStep } from '../types'
import { MARKER, pathOf, SHOWN, shownState } from './plan-tree'
import type { Shown } from './plan-tree'

export const PANE = 'plan-outline'
const TOOL = 'mcp__waffles__plan'

// plan.ts owns and writes these; a file reads an atom only where it makes it, so they are made here too.
const planGoal = atom({ plugin: 'waffles', key: 'planGoal' } as const, null)
const planTree = atom({ plugin: 'waffles', key: 'planTree' } as const, null)
const planError = atom({ plugin: 'waffles', key: 'planError' } as const, null)
const planKept = atom({ plugin: 'waffles', key: 'planKept' } as const, null)
const planKeptIssue = atom({ plugin: 'waffles', key: 'planKeptIssue' } as const, null)
const planOthers = atom({ plugin: 'waffles', key: 'planOthers' } as const, [])
const planChanged = atom({ plugin: 'waffles', key: 'planChanged' } as const, [])

// State marker colors: done green and open amber follow the theme.
const MARK_COLOR: Partial<Record<Shown, string>> = { done: 'success', open: 'warning' }
// Whose work a step is: the main thread's current step, a step a background subagent works on, and a
// step whose subagent finished and whose report waits for the main thread. The footer's ▶ is MAIN too.
const MAIN = 'cyan'
const AGENT = 'magenta'
const REVIEW = 'yellow'
// `$.store` key: the person's last choice, 'open' or 'closed', kept across sessions.
const CHOICE = 'planPane'
// The footer's separator between its parts.
const SEP = ' · '
// Columns between the hint line on the left of the footer's row and the right end.
const GAP = 2
// Added to the measured hint width: it comes from the hint's screen-reader text (one space between
// parts), where the drawn hint may pad its pills with a cell or two more. Too wide a margin only
// shortens the title; too narrow a one overflows the row.
const HINT_MARGIN = 2
// Under this many columns for the current step's title, the footer item shows the step count instead.
const MIN_TITLE = 36

type Piece = { text: string; color?: string; isDim?: boolean; isBold?: boolean; isItalic?: boolean }

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

/** Opens the pane; with `focus`, raises it from behind another pane's tab too. */
export async function openPane($: EngineInterface, { focus = false } = {}): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Plan outline', ...(focus ? { focus: true as const } : {}) })
}

// Whether the surface last drawn docks a pane beside the transcript (the fullscreen layout); undefined
// until a drawing or a command says. Fixed per session on the terminal, and unknown again after a reload.
let isDocking: boolean | undefined
// A goal was active at a start whose layout was unknown (a reload): the first footer that knows the layout opens the pane.
let isPendingOpen = false
// The columns of the hint line, which shares the footer's row on its left: `? for shortcuts` until it is drawn.
let hintWidth = width('? for shortcuts')

function noteLayout(isFullscreen: boolean | undefined) {
  if (isFullscreen !== undefined) isDocking = isFullscreen
}

/**
 * Opens the pane when a goal becomes active, unless the person closed it. Only where it docks beside
 * the transcript: on the main screen it would sit over the chat, so the footer shows the current step
 * and /waffles:plan opens it. A narrow fullscreen terminal leaves it undrawn.
 */
export async function openUnlessClosed($: EngineInterface): Promise<void> {
  if (isDocking !== true) return
  try {
    if ((await $.store.get(CHOICE)) === 'closed') return
    await openPane($)
    // A /waffles:plan close that landed while the open ran stored `closed` before the pane was there to close.
    if ((await $.store.get(CHOICE)) === 'closed') await $.ui.close({ id: PANE })
  } catch {
    // An open that fails leaves the footer to show the current step.
  }
}

/** Opens the pane at the start with a goal active; after a reload, once the footer records the layout. */
export async function openAtStart($: EngineInterface): Promise<void> {
  if (isDocking === undefined) isPendingOpen = true
  else await openUnlessClosed($)
}

/** The person closed the pane with the engine's mark or ctrl+x x: it stays closed until /waffles:plan. */
export async function paneClosed($: EngineInterface, e: PaneCloseInput): Promise<void> {
  if (e.origin.kind === 'person') await $.store.set(CHOICE, 'closed')
}

/** The pane as the engine lists it: undefined while closed. */
async function paneOf($: EngineInterface) {
  try {
    return (await $.ui.panes()).find(pane => pane.id === PANE)
  } catch {
    return undefined
  }
}

/**
 * Opens the pane, raises it, or closes it, and keeps the choice: what /waffles:plan and the footer item do.
 * A pane in a tab behind another pane is raised with focus, which the surface grants only while the
 * prompt has the keys over an empty composer. A pane that waits undrawn on a narrow terminal counts as
 * closed: the person's open places it.
 */
async function togglePane($: EngineInterface): Promise<'open' | 'closed'> {
  // The person's choice stands over an open still pending from a reload.
  isPendingOpen = false
  const pane = await paneOf($)
  if (pane?.isPlaced && pane.isShown) {
    await $.ui.close({ id: PANE })
    await $.store.set(CHOICE, 'closed')
    return 'closed'
  }
  await openPane($, { focus: pane?.isPlaced === true })
  await $.store.set(CHOICE, 'open')
  return 'open'
}

// The step where work happens takes its owner's color, its marker bold: the main thread's current step
// cyan, a subagent's step magenta, a step whose report waits yellow. A step with that work under it is
// bold in the text color. A step changed since the person's last prompt is italic. None moves the row.
function stepRow(goal: PlanGoal, step: PlanStep, depth: number, isChanged: boolean, room: number): Piece[] {
  const state = shownState(goal, step)
  const indent = '  '.repeat(depth)
  const mark = SHOWN[state]
  const head = ` ${step.id} ${MARKER[step.kind]}`
  const title = cut(step.title, room - width(indent) - width(mark) - width(head))
  const color = state === 'running' ? AGENT : state === 'review' ? REVIEW : state === 'active' && step.id === goal.current ? MAIN : undefined
  const isParent = state === 'active' && color === undefined
  const isDim = state === 'dropped'
  const isItalic = isChanged || undefined
  return [
    ...(indent ? [{ text: indent }] : []),
    { text: mark, color: isDim ? undefined : (color ?? MARK_COLOR[state]), isDim, isBold: color !== undefined || isParent, isItalic },
    { text: head + title, color, isDim, isBold: isParent, isItalic },
  ]
}

function paneRows(
  goal: PlanGoal | null,
  isActive: boolean,
  isKept: boolean,
  error: string | null,
  issue: 'missing' | 'unreadable' | null,
  others: readonly { inUse: boolean }[],
  changed: readonly string[],
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
  const walk = (steps: readonly PlanStep[], depth: number) => {
    for (const step of steps) {
      rows.push(stepRow(goal, step, depth, changed.includes(step.id), room))
      walk(step.children, depth + 1)
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
function stepCount(steps: readonly PlanStep[]): { closed: number; all: number } {
  let closed = 0
  let all = 0
  const walk = (list: readonly PlanStep[]) => {
    for (const step of list) {
      all++
      if (step.state === 'done' || step.state === 'dropped' || step.state === 'deferred') closed++
      walk(step.children)
    }
  }
  walk(steps)
  return { closed, all }
}

/**
 * The footer's plan outline item, last in its right end: `▶` and the current step's title, cut to the
 * columns left; under 36 of them, or with no current step, `▶ X of Y steps`; where that doesn't fit
 * either, or no goal is active, null. `left` holds the text of each part drawn left of it.
 *
 * The footer draws in every session, so it records the layout for the pane's open on a new goal.
 */
export async function footerItem($: EngineInterface, e: RenderInput<'SessionMode'>, left: readonly string[]) {
  noteLayout(e.viewport?.isFullscreen)
  const isActive = (await read($, planGoal)) !== null
  if (isPendingOpen && isDocking !== undefined) {
    isPendingOpen = false
    // Only in the fullscreen layout, as openUnlessClosed checks. Not awaited: a drawing
    // mustn't wait on a pane open, which may wait on drawing.
    if (isActive) void openUnlessClosed($)
  }
  const goal = isActive ? await read($, planTree) : null
  if (!goal) return null
  const used = left.reduce((n, text) => n + width(text), 0) + width(SEP) * Math.max(0, left.length - 1)
  // Where the surface hasn't measured, the title shows whole.
  const room = (e.viewport?.columns ?? Infinity) - hintWidth - HINT_MARGIN - used - width(SEP) - GAP
  const step = pathOf(goal).at(-1)
  const titleRoom = room - width('▶ ')
  let text: string
  let label: string
  if (step && titleRoom >= MIN_TITLE) {
    text = ` ${cut(step.title, titleRoom)}`
    label = `Plan outline: ${step.title}`
  } else {
    const { closed, all } = stepCount(goal.steps)
    text = ` ${closed} of ${all} steps`
    if (width('▶') + width(text) > room) return null
    label = `Plan outline:${text}`
  }
  const { Button, Text } = $.ui.resolve(e)
  return (
    <Button key="plan-outline" label={label} plain onPress={() => void togglePane($).catch(() => undefined)}>
      <Text color={MAIN}>▶</Text>
      <Text wrap="truncate-end" dimColor>{text}</Text>
    </Button>
  )
}

/** The tool result's text: a string, or the text of its blocks. */
function textOf(output: unknown): string | null {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    const texts = output.flatMap(b => (typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string' ? [(b as { text: string }).text] : []))
    return texts.length ? texts.join('\n') : null
  }
  if (typeof output === 'object' && output !== null) {
    const { result, text } = output as { result?: unknown; text?: unknown }
    if (typeof result === 'string') return result
    if (typeof text === 'string') return text
  }
  return null
}

// The texts plan.ts returns. A change, or none, ends with its path line. `show` returns the tree, a
// state glyph opening each row, or `<title>: no steps.`, then any other open goals after a blank line;
// with no goal active, the open goals, or that there are none. Titles hold no line breaks.
const PATH_LINE = /\n\nPath: [^\n]*$/
const TREE_ROW = new RegExp(`^(?: {2})*[${Object.values(SHOWN).join('')}] \\S`)
const NO_GOALS = 'No active goal and no open goals.'
const OPEN_GOALS = 'No active goal. Open goals:\n'
const OTHER_GOALS = 'Other open goals:\n'
/** Opens the result of a call made while the active goal has no file in the shell's repo; its row draws only {@link ELSEWHERE_ROW}, dim. */
export const ELSEWHERE = 'Nothing changed:'
const ELSEWHERE_ROW = "not changed: the shell is outside the goal's repo"

/** Whether the text is a result plan.ts returns, which the call's row draws: a refusal, a change, or a `show`. */
function isPlanText(text: string, isErrored: boolean): boolean {
  if (isErrored || PATH_LINE.test(text) || text === NO_GOALS || text.startsWith(OPEN_GOALS) || text.startsWith(ELSEWHERE)) return true
  const [head = '', ...rest] = text.split('\n\n')
  if (rest.length > 1 || (rest.length === 1 && !rest[0]!.startsWith(OTHER_GOALS))) return false
  const rows = head.split('\n')
  return rows.every(row => TREE_ROW.test(row)) || (rows.length === 1 && head.endsWith(': no steps.'))
}

export function registerPlanUi(on: On): void {
  // The pane: the active goal's tree, else the kept one's, the steps changed since the person's last prompt in italics.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const goal = await read($, planTree)
    const isActive = (await read($, planGoal)) !== null
    const isKept = (await read($, planKept)) !== null
    const error = await read($, planError)
    const issue = await read($, planKeptIssue)
    const others = await read($, planOthers)
    const changed = await read($, planChanged)
    noteLayout(e.viewport?.isFullscreen)
    const { Box, Text } = $.ui.resolve(e)
    const rows = paneRows(goal, isActive, isKept, error, issue, others, changed, e.props.bodyColumns)
    return (
      <Box flexDirection="column">
        {rows.map(pieces => (
          <Box>
            {pieces.map(p => (
              <Text wrap="truncate-end" color={p.color} dimColor={p.isDim || undefined} bold={p.isBold || undefined} italic={p.isItalic || undefined}>
                {p.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })

  // The hint line on the left of the footer's row: its width, for the room the footer's plan outline item has.
  // It draws as it was handed; a change of width draws the footer again.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const drawn = width(e.props.hint) + width(e.props.tail ?? '')
    if (drawn !== hintWidth) {
      hintWidth = drawn
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // A plan call's row: its change lines in place of the call's own row; ctrl+o shows that row. Text
  // of no plan outline shape (an interrupt's notice) gets the engine's row.
  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e, next) => {
    const { tool, isExpanded, isRunning, isInterrupted, isErrored, output } = e.props
    if (tool !== TOOL || isExpanded || isRunning || isInterrupted) return next(e)
    const text = textOf(output)
    if (text === null || !isPlanText(text, isErrored)) return next(e)
    // A result is its change lines, a blank line, then the path; a refusal is its text. A call made
    // outside the goal's repo draws one dim line, all of it dim: the pane already says the file is missing.
    const isElsewhere = !isErrored && text.startsWith(ELSEWHERE)
    const lines = isElsewhere ? [ELSEWHERE_ROW] : (isErrored ? text : text.split('\n\n')[0] ?? '').split('\n')
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color={isErrored ? 'error' : isElsewhere ? undefined : 'success'} dimColor={isElsewhere || undefined}>
          ⏺
        </Text>
        <Text bold={!isElsewhere || undefined} dimColor={isElsewhere || undefined}>{' plan outline'}</Text>
        <Box flexDirection="column" marginLeft={2}>
          {lines.map(line => (
            <Text dimColor={isErrored || isElsewhere || undefined}>{line}</Text>
          ))}
        </Box>
      </Box>
    )
  })

  // A plan call's result block, which the engine draws under a standalone row: the row above already
  // shows its lines, so it draws nothing; ctrl+o shows it. The block has no isInterrupted, so it hides
  // what the row draws, by the same test: a refusal (isErrored) or text of a plan outline shape. Anything else
  // (an interrupt's notice, an unknown shape) is the engine's own block.
  on('ui.render', { component: 'ToolResult', props: { tool: TOOL } }, async ($, e, next) => {
    const { tool, isExpanded, isErrored, output } = e.props
    if (tool !== TOOL || isExpanded) return next(e)
    const text = textOf(output)
    if (text === null || !isPlanText(text, isErrored)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // The skill skills/plan makes /waffles:plan; this hook answers it, so the skill's text never runs. A
  // registered command can't be named waffles:plan, and plan alone is Claude Code's plan mode.
  on('command.run', { command: 'waffles:plan' }, async ($, e) => {
    noteLayout(e.presentation?.isFullscreen)
    try {
      return { text: `Plan outline pane: ${await togglePane($)}.` }
    } catch {
      return { text: "Plan outline pane: couldn't change it." }
    }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    // The close stands whatever the store says.
    await paneClosed($, e).catch(() => undefined)
    return closed
  })
}
