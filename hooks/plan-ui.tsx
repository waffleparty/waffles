import { atom, read } from 'claude-code'
import type { EngineInterface, On, PaneCloseInput, RenderInput } from 'claude-code'

import type { PlanGoal, PlanStep } from '../types'
import { ELSEWHERE } from '../core/plan.ts'
import { collapsedFor } from '../core/plan-collapse.ts'
import { pressPlan } from './plan'
import { cut, MAIN, paneRows, stepCount, width, type Piece } from '../core/plan-view.ts'

export { cut, width }
import { MARKER, pathOf, SHOWN, shownState } from '../core/plan-tree.ts'
import type { Shown } from '../core/plan-tree.ts'

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
const planCollapsed = atom({ plugin: 'waffles', key: 'planCollapsed' } as const, null)

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
// A mark can be more than 1 code point (the parked one is 2), so the marks are alternatives, not a class.
const TREE_ROW = new RegExp(`^(?: {2})*(?:${Object.values(SHOWN).join('|')}) \\S`)
const NO_GOALS = 'No active goal and no open goals.'
const OPEN_GOALS = 'No active goal. Open goals:\n'
const OTHER_GOALS = 'Other open goals:\n'
// The result of a call made while the active goal has no file in the shell's repo draws only this row, dim.
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
  // The pane: the active goal's tree, else the kept one's, the steps changed since the person's last prompt
  // in italics. A parent step's row is a Button: a press collapses or expands it.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const goal = await read($, planTree)
    const active = await read($, planGoal)
    const kept = await read($, planKept)
    const error = await read($, planError)
    const issue = await read($, planKeptIssue)
    const others = await read($, planOthers)
    const changed = await read($, planChanged)
    const collapsed = collapsedFor(await read($, planCollapsed), active ?? kept)
    noteLayout(e.viewport?.isFullscreen)
    const { Box, Button, Text } = $.ui.resolve(e)
    const rows = paneRows(goal, active !== null, kept !== null, error, issue, others, changed, collapsed, e.props.bodyColumns)
    return (
      <Box flexDirection="column">
        {rows.map(pieces => {
          const texts = pieces.map(p => (
            <Text wrap="truncate-end" color={p.color} dimColor={p.isDim || undefined} bold={p.isBold || undefined} italic={p.isItalic || undefined}>
              {p.text}
            </Text>
          ))
          const id = pieces.find(p => p.toggle !== undefined)?.toggle
          if (id === undefined) return <Box>{texts}</Box>
          return (
            <Box>
              <Button key={`plan-step-${id}`} plain onPress={() => pressPlan($, id).catch(() => undefined)}>
                {texts}
              </Button>
            </Box>
          )
        })}
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
