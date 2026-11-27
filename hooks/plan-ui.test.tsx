import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeDisk } from './plan-testing'
import { newGoal, serializeGoal } from '../core/plan-tree.ts'
import { cut, paneClosed, width } from './plan-ui'

const TOOL = 'mcp__waffles__plan'
const NOW = Date.parse('2026-11-15T12:00:00Z')
const ISO = new Date(NOW).toISOString()
const ME = 'session-me'
const ROOT = '/repo/.git/waffles/plan'
const STATE = '/repo/.git/waffles'
const file = (slug: string) => `${ROOT}/${slug}.md`
const SURFACES = ['terminal', 'desktop'] as const

// The spec's example: 3.2.1 closed and focus back on 3.2.
const SPEC = `---
goal: Ship OAuth login
status: open
current: 3.2
created: ${ISO}
updated: ${ISO}
---
- [x] 1 Spec
- [x] 2 Design
- [ ] 3 Build
  - [x] 3.1 Provider config
  - [ ] 3.2 Callback route
    - [x] 3.2.1 ⤷ Fix CORS on dev proxy
  - [-] 3.3 ? Try implicit flow
- [ ] 4 Ship
`

type Pane = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }

// The disk, the session's ID, a clock and a store beneath the plugin, and an engine that keeps the
// open panes: `opened` holds each `ui.open`, `panes` what `$.ui.panes()` lists; `state` the session's values.
function world(on: On, stored: Record<string, unknown> = {}) {
  const disk = fakeDisk(on)
  on('session.id', () => ({ value: ME }) as never)
  const clock = mock.clock(on, { now: NOW })
  const store = { ...stored }
  on('store.get', ($, e) => ({ value: store[e.key] }) as never)
  on('store.set', ($, e) => {
    if (fails.set) throw new Error('set failed')
    store[e.key] = e.value
    return { value: undefined } as never
  })
  const opened: unknown[] = []
  const panes: Pane[] = []
  // `fails` makes a call throw; `during.open` runs in the middle of an open, as another call would.
  const fails = { open: false, set: false }
  const during: { open?: () => void } = {}
  on('ui.open', ($, e) => {
    if (fails.open) throw new Error('open failed')
    during.open?.()
    opened.push(e)
    if (!panes.some(p => p.id === e.id)) panes.push({ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true })
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    const at = panes.findIndex(p => p.id === e.id)
    if (at >= 0) panes.splice(at, 1)
    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: panes }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  // What the plugin's other modules ask of the engine at the session's start.
  const commands: unknown[] = []
  on('tool.register', ($, e) => ({ value: { tool: `mcp__waffles__${e.name}` } }) as never)
  on('command.register', ($, e) => (commands.push(e), { value: { command: e.name } }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  // The last value the plugin wrote to each session key.
  const state: Record<string, unknown> = {}
  on('state.set', ($, e, next) => ((state[e.key] = e.value), next(e)))
  return { disk, clock, opened, panes, store, commands, fails, during, state }
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

const call = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: TOOL, ...input } as never)
const toggle = ($: Engine) => $.command.run({ command: 'waffles:plan', args: '' } as never)

/** Puts the spec's example on disk with one other goal parked, and continues it. */
async function specExample($: Engine, disk: ReturnType<typeof fakeDisk>) {
  disk.files.set(file('ship-oauth-login'), SPEC)
  disk.files.set(file('fix-flaky-test'), serializeGoal(newGoal('Fix flaky test', [{ title: 'Repro' }], ISO)))
  await call($, { op: 'goal', switch: 'ship-oauth-login' })
}

const paneProps = (bodyColumns: number) =>
  ({ title: 'Plan outline', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} }) as never
type Node = string | { type: string; props?: Record<string, unknown>; children?: Node[] }
const flat = (node: Node): string => (typeof node === 'string' ? node : (node.children ?? []).map(flat).join(''))

/** The rows a drawing shows: the children of its outer column Box, each as plain text. */
async function rowsOf(ui: { findAll: (q: { type: string }) => Promise<{ children: unknown[] }[]> }) {
  const [outer] = await ui.findAll({ type: 'Box' })
  return (outer?.children ?? []).map(child => flat(child as Node))
}

async function drawPane($: Engine, bodyColumns = 40, surface: (typeof SURFACES)[number] = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'waffles', component: 'Pane', requestId: 'plan-outline', surface, props: paneProps(bodyColumns) })
  const rows = await rowsOf(ui)
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return { rows, texts }
}

const HINT = '? for shortcuts'
// The footer's parts left of the plan outline item in this world: the mode, then the effort.
const LEFT = '● production · effort: auto'
// What the left hint, the parts left of the item, and the gaps take: N is the columns less this.
// The hint's 2 columns of margin are in it too.
const TAKEN = 15 + 2 + 27 + 3 + 2 + 2

/** Draws the hint line under the prompt, as the engine does at every redraw: the plugin keeps its width. */
async function drawHint($: Engine, hint = HINT, tail?: string) {
  const props = { isDraft: false, isWorking: false, hint, ...(tail === undefined ? {} : { tail }) }
  const ui = await $.ui.mount({ plugin: 'waffles', component: 'PromptHint', surface: 'terminal', props: props as never })
  const engine = await ui.find({ type: 'engine' })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return { engine, texts: texts.map(t => t.text) }
}

const footer = ($: Engine, columns: number | undefined, isFullscreen = true, surface: (typeof SURFACES)[number] = 'terminal') =>
  $.ui.mount({
    plugin: 'waffles',
    component: 'SessionMode',
    surface,
    props: { modes: [] },
    ...(columns === undefined ? {} : { viewport: { columns, rows: 50, isFullscreen } }),
  })

/** The footer's right end at that width: its line as plain text, its Texts and Buttons. */
async function drawFooter($: Engine, columns: number | undefined, isFullscreen = true, surface: (typeof SURFACES)[number] = 'terminal') {
  const ui = await footer($, columns, isFullscreen, surface)
  const texts = await ui.findAll({ type: 'Text' })
  const buttons = await ui.findAll({ type: 'Button' })
  await ui.unmount()
  return { line: texts.map(t => t.text).join(''), texts, buttons }
}

// Draws the footer on a terminal of that layout, as the engine does at every redraw: the plugin learns
// from it whether a pane it opens unasked docks beside the transcript. The plugin keeps the last one
// seen, so each test that opens the pane unasked says its layout first.
async function layout($: Engine, isFullscreen: boolean) {
  return (await drawFooter($, 160, isFullscreen)).line
}

async function drawCall($: Engine, props: Record<string, unknown>, surface: (typeof SURFACES)[number] = 'terminal') {
  const ui = await $.ui.mount({
    plugin: 'waffles',
    component: 'ToolUse',
    requestId: 'toolu_1',
    surface,
    props: { tool_use_id: 'toolu_1', tool: TOOL, input: {}, isRunning: false, isErrored: false, isInterrupted: false, isExpanded: false, ...props } as never,
  })
  const texts = await ui.findAll({ type: 'Text' })
  const engine = await ui.find({ type: 'engine' })
  await ui.unmount()
  return { texts, isEngine: Boolean(engine) }
}

test('the pane draws the spec example with markers and the current path active', async ($, on) => {
  const { disk } = world(on)
  await specExample($, disk)

  for (const surface of SURFACES) {
    const { rows, texts } = await drawPane($, 40, surface)

    expect(rows).toEqual([
      'Ship OAuth login',
      '  ✔ 1 Spec',
      '  ✔ 2 Design',
      '⌄ ▶ 3 Build',
      '    ✔ 3.1 Provider config',
      '  ⌄ ▶ 3.2 Callback route',
      '      ✔ 3.2.1 ⤷ Fix CORS on dev proxy',
      '    ✗ 3.3 ? Try implicit flow',
      '  ○ 4 Ship',
      ' ',
      '1 other goal parked',
    ])
    expect(texts.find(t => t.text === 'Ship OAuth login')?.props.bold).toBe(true)
    const dropped = texts.filter(t => /3\.3|implicit/.test(t.text))
    expect(dropped.length).toBeGreaterThan(0)
    expect(dropped.every(t => t.props.dimColor === true)).toBe(true)
    expect(texts.some(t => t.props.dimColor === true && /Build|Spec/.test(t.text))).toBe(false)
  }
})

test('steps changed since the last prompt are italic, with no dot and their indent kept', async ($, on) => {
  const { disk } = world(on)
  await specExample($, disk)
  await call($, { op: 'add', parent: '3.2', kind: 'work', titles: ['Retry token exchange'] })

  const { rows, texts } = await drawPane($)

  expect(rows).toContain('      ○ 3.2.2 ⤷ Retry token exchange')
  expect(rows.some(row => row.includes('•'))).toBe(false)
  const added = texts.find(t => t.text.includes('Retry token exchange'))
  expect(added?.props.italic).toBe(true)
  expect(added?.props.bold).toBeUndefined()
  expect(added?.props.color).toBeUndefined()
  expect(texts.find(t => t.text.includes('Provider config'))?.props.italic).toBeUndefined()
})

test('state markers are colored: done green, open amber, the main thread’s step bold cyan, its parents bold', async ($, on) => {
  const { disk } = world(on)
  await specExample($, disk)

  const { rows, texts } = await drawPane($)

  expect(rows).toContain('  ✔ 1 Spec')
  const marks = (glyph: string) => texts.filter(t => t.text === glyph).map(t => t.props.color)
  expect(marks('✔').length).toBeGreaterThan(0)
  expect(marks('✔').every(c => c === 'success')).toBe(true)
  // 3.2 is current, 3 is its parent.
  expect(marks('▶')).toEqual([undefined, 'cyan'])
  expect(texts.filter(t => t.text === '▶').every(t => t.props.bold === true)).toBe(true)
  expect(texts.find(t => t.text === ' 3 Build')?.props).toMatchObject({ bold: true })
  expect(texts.find(t => t.text === ' 3 Build')?.props.color).toBeUndefined()
  expect(marks('○').length).toBeGreaterThan(0)
  expect(marks('○').every(c => c === 'warning')).toBe(true)
  // The rest of an unchanged row keeps the default color.
  expect(texts.find(t => t.text.includes('Spec') && !t.text.includes('✔'))?.props.color).toBeUndefined()
})

test('the current step’s title is cyan, and only it', async ($, on) => {
  const { disk } = world(on)
  await specExample($, disk)

  const { texts } = await drawPane($)

  const cyan = texts.filter(t => t.props.color === 'cyan' && t.text !== '▶').map(t => t.text)
  // The fixture's current step is 3.2; its ancestor 3 is active too but not cyan.
  expect(cyan).toEqual([' 3.2 Callback route'])
})

test('changed top-level steps stay aligned with the rest', async ($, on) => {
  world(on)
  await call($, { op: 'goal', title: 'Ship OAuth login', steps: [{ title: 'Spec' }, { title: 'Build' }] })

  const { rows, texts } = await drawPane($)
  expect(rows).toEqual(['Ship OAuth login', '  ▶ 1 Spec', '  ○ 2 Build'])
  expect(texts.find(t => t.text.includes('Build'))?.props.italic).toBe(true)
})

test('the pane shows a parse error instead of a tree', async ($, on) => {
  const { disk } = world(on)
  await specExample($, disk)
  disk.files.set(file('ship-oauth-login'), '---\ngoal: Ship OAuth login\nnonsense\n')
  await start($)

  expect((await drawPane($, 80)).rows).toEqual(["Can't read /repo/.git/waffles/plan/ship-oauth-login.md: line 3"])
})

test('the pane says so when there is no active goal, and counts goals in use by another session', async ($, on) => {
  const { disk } = world(on)
  expect((await drawPane($)).rows).toEqual(['No active goal.'])

  disk.files.set(file('ship-oauth-login'), SPEC)
  for (const slug of ['a', 'b']) disk.files.set(file(slug), serializeGoal(newGoal(`Goal ${slug}`, [{ title: 'S' }], ISO)))
  disk.files.set(file('c'), serializeGoal(newGoal('Goal c', [{ title: 'S' }], ISO)))
  disk.files.set(`${STATE}/locks/c.json`, JSON.stringify({ session: 'session-other', heartbeat: ISO }))
  await call($, { op: 'goal', switch: 'ship-oauth-login' })

  expect((await drawPane($)).rows.slice(-3)).toEqual([' ', '2 other goals parked', '1 in use: other session'])
})

test('a 24-column pane cuts titles with … and keeps markers and IDs', async ($, on) => {
  const { disk } = world(on)
  await specExample($, disk)
  await call($, { op: 'add', parent: '3.2', kind: 'research', titles: ['Compare PKCE libraries for the callback'] })

  const { rows } = await drawPane($, 24)

  expect(rows).toEqual([
    'Ship OAuth login',
    '  ✔ 1 Spec',
    '  ✔ 2 Design',
    '⌄ ▶ 3 Build',
    '    ✔ 3.1 Provider conf…',
    '  ⌄ ▶ 3.2 Callback route',
    '      ✔ 3.2.1 ⤷ Fix COR…',
    '      ○ 3.2.2 ? Compare…',
    '    ✗ 3.3 ? Try implici…',
    '  ○ 4 Ship',
    ' ',
    '1 other goal parked',
  ])
  expect(rows.every(row => [...row].length <= 24)).toBe(true)
  expect((await drawPane($, 12)).rows[0]).toBe('Ship OAuth…')
})

/** Presses a parent step's row in the pane, as a click on it does. */
async function pressRow($: Engine, id: string) {
  const ui = await $.ui.mount({ plugin: 'waffles', component: 'Pane', requestId: 'plan-outline', surface: 'terminal', props: paneProps(40) })
  await ui.press({ key: `plan-step-${id}` })
  await ui.unmount()
}

test('a parent step’s row is a Button: a press collapses it to its count, and another expands it', async ($, on) => {
  const { disk } = world(on)
  await specExample($, disk)
  await call($, { op: 'focus', id: '4' })
  await call($, { op: 'add', parent: '4', titles: ['Tag', 'Release'] })

  const ui = await $.ui.mount({ plugin: 'waffles', component: 'Pane', requestId: 'plan-outline', surface: 'terminal', props: paneProps(40) })
  const buttons = await ui.findAll({ type: 'Button' })
  await ui.unmount()
  // A Button for each parent, 3, 3.2 and 4, and none for a leaf.
  expect(buttons.map(b => b.key)).toEqual(['plan-step-3', 'plan-step-3.2', 'plan-step-4'])

  await pressRow($, '3')
  expect((await drawPane($)).rows.slice(1, 6)).toEqual(['  ✔ 1 Spec', '  ✔ 2 Design', '› ⏸\uFE0E 3 Build (3)', '⌄ ▶ 4 Ship', '    ○ 4.1 Tag'])
  await pressRow($, '3')
  expect((await drawPane($)).rows[3]).toBe('⌄ ⏸\uFE0E 3 Build')
  expect((await drawPane($)).rows[5]).toBe('  ⌄ ⏸\uFE0E 3.2 Callback route')
})

test('a press that would hide the current step changes nothing; on the current step it hides the steps under it', async ($, on) => {
  const { disk, state } = world(on)
  await specExample($, disk)

  // 3 holds the current step, 3.2.
  await pressRow($, '3')
  expect((await drawPane($)).rows[3]).toBe('⌄ ▶ 3 Build')
  expect(state.planCollapsed ?? null).toBe(null)

  await pressRow($, '3.2')
  expect((await drawPane($)).rows.slice(3, 7)).toEqual(['⌄ ▶ 3 Build', '    ✔ 3.1 Provider config', '  › ▶ 3.2 Callback route (1)', '    ✗ 3.3 ? Try implicit flow'])
})

test('a collapsed step stays collapsed under its new ID after a move, and another goal starts expanded', async ($, on) => {
  const { disk, state } = world(on)
  await specExample($, disk)
  await call($, { op: 'add', parent: '4', titles: ['Tag'] })
  await pressRow($, '4')
  expect(state.planCollapsed).toEqual({ goal: 'ship-oauth-login', ids: ['4'] })

  await call($, { op: 'move', id: '4', to: '3' })
  expect(state.planCollapsed).toEqual({ goal: 'ship-oauth-login', ids: ['3.4'] })
  expect((await drawPane($)).rows).toContain('  › ○ 3.4 Ship (1)')

  await call($, { op: 'goal', switch: 'fix-flaky-test' })
  expect(state.planCollapsed).toBe(null)
})

// A main-thread turn's end and a background subagent's start, as the engine raises them; the test answers both beneath the plugin.
const FINISHED = { answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
const SPAWN = { prompt: 'Do it', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', fork: false, background: true }

test('the pane collapses and expands steps by itself at each turn’s end, as in the mockups’ 4 turns', async ($, on) => {
  world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }) as never)
  const rows = async () => (await drawPane($, 60)).rows.slice(1)
  const begin = () => $.prompt.submit({ origin: { kind: 'composer' }, wait: false, text: 'Go on' })
  // The turn's end is queued behind plan outline work: a call waits for it.
  const end = async () => {
    await $.turn.complete(FINISHED)
    await call($, { op: 'show' })
    return rows()
  }

  // Turn 1: the goal starts with 1, 2, 3 and their steps, and 1.1 starts. Every step is new.
  await begin()
  await call($, { op: 'goal', title: 'Add SSO login', steps: [{ title: 'Research the SSO providers' }, { title: 'Build the callback route' }, { title: 'Deploy to staging' }] })
  await call($, { op: 'add', parent: '1', titles: ['Compare Okta and Auth0', 'Pick a provider'], focus: true })
  await call($, { op: 'add', parent: '2', titles: ['Parse the token', 'Validate the state param'] })
  await call($, { op: 'add', parent: '3', titles: ['Add the secrets', 'Run the migration'] })
  expect(await end()).toEqual([
    '⌄ ▶ 1 Research the SSO providers',
    '    ▶ 1.1 Compare Okta and Auth0',
    '    ○ 1.2 Pick a provider',
    '⌄ ○ 2 Build the callback route',
    '    ○ 2.1 Parse the token',
    '    ○ 2.2 Validate the state param',
    '⌄ ○ 3 Deploy to staging',
    '    ○ 3.1 Add the secrets',
    '    ○ 3.2 Run the migration',
  ])

  // Turn 2: 1.1 done, 1.2 started. 2 and 3 are idle, and their steps were there when the turn began.
  await begin()
  await call($, { op: 'done', ids: ['1.1'] })
  await call($, { op: 'focus', id: '1.2' })
  expect(await end()).toEqual([
    '⌄ ▶ 1 Research the SSO providers',
    '    ✔ 1.1 Compare Okta and Auth0',
    '    ▶ 1.2 Pick a provider',
    '› ○ 2 Build the callback route (2)',
    '› ○ 3 Deploy to staging (2)',
  ])

  // Turn 3: 1.2 and 1 done; 2.1 started, with a new detour under it. Mid-turn, nothing collapses yet,
  // and the current step is revealed at once.
  await begin()
  await call($, { op: 'done', ids: ['1.2', '1'] })
  await call($, { op: 'focus', id: '2.1' })
  await call($, { op: 'add', parent: '2.1', kind: 'work', titles: ['Fix CORS on dev proxy'], focus: true })
  expect((await rows()).slice(0, 4)).toEqual(['⌄ ✔ 1 Research the SSO providers', '    ✔ 1.1 Compare Okta and Auth0', '    ✔ 1.2 Pick a provider', '⌄ ▶ 2 Build the callback route'])
  expect(await end()).toEqual([
    '› ✔ 1 Research the SSO providers (2)',
    '⌄ ▶ 2 Build the callback route',
    '  ⌄ ▶ 2.1 Parse the token',
    '      ▶ 2.1.1 ⤷ Fix CORS on dev proxy',
    '    ○ 2.2 Validate the state param',
    '› ○ 3 Deploy to staging (2)',
  ])

  // Turn 4: 2.1.1 and 2.1 done, 2.2 started, and a background subagent takes 3.1, which shows at once.
  await begin()
  await call($, { op: 'done', ids: ['2.1.1', '2.1'] })
  await call($, { op: 'focus', id: '2.2' })
  await $.agent.spawn({ ...SPAWN, description: '3.1: Add the secrets' } as never)
  await call($, { op: 'show' })
  expect((await rows()).slice(-3)).toEqual(['⌄ ▶ 3 Deploy to staging', '    ▶ 3.1 Add the secrets', '    ○ 3.2 Run the migration'])
  expect(await end()).toEqual([
    '› ✔ 1 Research the SSO providers (2)',
    '⌄ ▶ 2 Build the callback route',
    '  › ✔ 2.1 Parse the token (1)',
    '    ▶ 2.2 Validate the state param',
    '⌄ ▶ 3 Deploy to staging',
    '    ▶ 3.1 Add the secrets',
    '    ○ 3.2 Run the migration',
  ])
})

test('a press holds until the next turn’s end, where the rules decide again; a turn ends once', async ($, on) => {
  const { disk } = world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await specExample($, disk)
  await call($, { op: 'add', parent: '4', titles: ['Tag'] })
  const begin = () => $.prompt.submit({ origin: { kind: 'composer' }, wait: false, text: 'Go on' })
  const end = async () => {
    await $.turn.complete(FINISHED)
    await call($, { op: 'show' })
  }
  const row4 = async () => (await drawPane($)).rows.find(row => row.includes(' 4 Ship'))

  await begin()
  await end()
  // 4 is idle, and its step was there when the turn began: collapsed.
  expect(await row4()).toBe('› ○ 4 Ship (1)')
  // Expanded by hand, it stays so until a turn ends; a second stop of the same turn changes nothing.
  await pressRow($, '4')
  expect(await row4()).toBe('⌄ ○ 4 Ship')
  await end()
  expect(await row4()).toBe('⌄ ○ 4 Ship')
  // At the next turn's end the rules decide again.
  await begin()
  await end()
  expect(await row4()).toBe('› ○ 4 Ship (1)')
})

test('a plan call draws its change lines; expanded, it draws the normal row', async ($, on) => {
  const { disk } = world(on)
  disk.files.set(file('ship-oauth-login'), SPEC)
  const continued = (await call($, { op: 'goal', switch: 'ship-oauth-login' })) as { result: string }
  const added = (await call($, { op: 'add', parent: '3.2', kind: 'work', titles: ['Fix CSP'] })) as { result: string }
  const created = (await call($, { op: 'goal', title: 'Fix flaky test' })) as { result: string }

  const words = async (props: Record<string, unknown>, surface: (typeof SURFACES)[number] = 'terminal') =>
    (await drawCall($, props, surface)).texts.map(t => t.text)
  for (const surface of SURFACES) {
    expect(await words({ output: continued.result }, surface)).toEqual(['⏺', ' plan outline', '◇ continued goal: Ship OAuth login [ship-oauth-login]'])
  }
  expect(await words({ output: added.result })).toEqual(['⏺', ' plan outline', '+ 3.2.2 ⤷ Fix CSP under 3.2'])
  expect(await words({ output: created.result })).toEqual([
    '⏺',
    ' plan outline',
    '◇ new goal: Fix flaky test [fix-flaky-test] (Ship OAuth login [ship-oauth-login] parked at 3.2 Callback route)',
  ])
  expect(await words({ output: '✔ 1 Spec\n✔ 2 Build\n✔ goal done: Ship\n\nPath: none' })).toEqual([
    '⏺',
    ' plan outline',
    '✔ 1 Spec',
    '✔ 2 Build',
    '✔ goal done: Ship',
  ])

  const refused = await drawCall($, { isErrored: true, output: 'No active goal. Start one with op "goal".' })
  expect(refused.texts.map(t => t.text)).toEqual(['⏺', ' plan outline', 'No active goal. Start one with op "goal".'])
  expect(refused.texts[2]?.props.dimColor).toBe(true)

  expect(await drawCall($, { isExpanded: true, output: added.result })).toEqual({ texts: [], isEngine: true })
  expect(await drawCall($, { isRunning: true })).toEqual({ texts: [], isEngine: true })
  expect(await drawCall($, { tool: 'Bash', output: 'x' })).toEqual({ texts: [], isEngine: true })
})

async function drawResult($: Engine, props: Record<string, unknown>) {
  const ui = await $.ui.mount({
    plugin: 'waffles',
    component: 'ToolResult',
    requestId: 'toolu_1',
    surface: 'terminal',
    props: { tool_use_id: 'toolu_1', tool: TOOL, output: 'x', isErrored: false, isExpanded: false, ...props } as never,
  })
  const texts = await ui.findAll({ type: 'Text' })
  const engine = await ui.find({ type: 'engine' })
  await ui.unmount()
  return { texts: texts.map(t => t.text), isEngine: Boolean(engine) }
}

test('a plan call’s result block draws nothing under its change lines; expanded, the engine draws it', async ($, on) => {
  world(on)
  const output = '+ 3.2.2 ⤷ Fix CSP under 3.2\n\nPath: 3 Build › 3.2 Callback route'

  expect(await drawResult($, { output })).toEqual({ texts: [], isEngine: false })
  expect(await drawResult($, { output: 'No goal x.', isErrored: true })).toEqual({ texts: [], isEngine: false })
  expect(await drawResult($, { output, isExpanded: true })).toEqual({ texts: [], isEngine: true })
  // Where the row is the engine's own, so is the result.
  expect(await drawResult($, { output: { unexpected: true } })).toEqual({ texts: [], isEngine: true })
  expect(await drawResult($, { tool: 'Bash', output: 'x' })).toEqual({ texts: [], isEngine: true })
})

test('every result shape a plan call returns draws once: in the row, not again in the result block', async ($, on) => {
  const { disk } = world(on)
  const resultOf = async (input: Record<string, unknown>) => ((await call($, input)) as { result: string }).result
  const shapes: Record<string, string> = {}
  shapes.none = await resultOf({ op: 'show' })
  disk.files.set(file('later'), serializeGoal({ ...newGoal('Later', [{ title: 'A' }, { title: 'B' }], ISO), current: '2' }))
  disk.files.set(file('empty'), serializeGoal({ ...newGoal('Empty', [{ title: 'A' }], ISO), current: null, steps: [] }))
  shapes.open = await resultOf({ op: 'show' })
  shapes.created = await resultOf({ op: 'goal', title: 'Ship', steps: [{ title: 'Spec' }, { title: 'Build' }] })
  shapes.noChange = await resultOf({ op: 'focus', id: '1' })
  shapes.tree = await resultOf({ op: 'show' })
  shapes.openFirst = await resultOf({ op: 'show', goal: 'later' })
  shapes.noSteps = await resultOf({ op: 'show', goal: 'empty' })
  // A parked step's mark is 2 code points (⏸ and U+FE0E): the row is still a tree row.
  await resultOf({ op: 'add', parent: '1', titles: ['Draft'], focus: true })
  await resultOf({ op: 'focus', id: '2' })
  shapes.parked = await resultOf({ op: 'show' })

  expect(shapes).toEqual({
    none: 'No active goal and no open goals.',
    open: 'No active goal. Open goals:\n- empty: Empty, at no step\n- later: Later, at 2 B',
    created: '◇ new goal: Ship [ship]\n\nPath: 1 Spec',
    noChange: 'No change.\n\nPath: 1 Spec',
    tree: '▶ 1 Spec\n○ 2 Build\n\nOther open goals:\n- empty: Empty, at no step\n- later: Later, at 2 B',
    openFirst: '○ 1 A\n▶ 2 B\n\nOther open goals:\n- empty: Empty, at no step\n- ship: Ship, at 1 Spec',
    noSteps: 'Empty: no steps.\n\nOther open goals:\n- later: Later, at 2 B\n- ship: Ship, at 1 Spec',
    parked: '⏸\uFE0E 1 Spec\n  ⏸\uFE0E 1.1 Draft\n▶ 2 Build\n\nOther open goals:\n- empty: Empty, at no step\n- later: Later, at 2 B',
  })
  for (const output of Object.values(shapes)) {
    const row = (await drawCall($, { output })).texts.map(t => t.text)
    expect(row.slice(0, 2)).toEqual(['⏺', ' plan outline'])
    expect(row.slice(2)).toEqual(output.split('\n\n')[0]!.split('\n'))
    expect(await drawResult($, { output })).toEqual({ texts: [], isEngine: false })
    expect(await drawResult($, { output: [{ type: 'text', text: output }] })).toEqual({ texts: [], isEngine: false })
  }
  shapes.lone = 'Empty: no steps.'
  expect(await drawResult($, { output: shapes.lone })).toEqual({ texts: [], isEngine: false })

  // An interrupt's notice is no plan outline shape: the row and the result block are the engine's.
  for (const output of ['Interrupted by user', "The user doesn't want to proceed with this tool use. The tool use was rejected."]) {
    expect(await drawCall($, { output })).toEqual({ texts: [], isEngine: true })
    expect(await drawResult($, { output })).toEqual({ texts: [], isEngine: true })
  }
})

test('a call made outside the goal’s repo draws one dim row, not a refusal, and no result block', async ($, on) => {
  world(on)
  const output = "Nothing changed: the active goal ship has no goal file in /repo/sub, the repo of the shell's working directory. If the shell moved to another repo, cd back to the active goal's repo and call again."

  const row = await drawCall($, { output })
  expect(row.texts.map(t => t.text)).toEqual(['⏺', ' plan outline', "not changed: the shell is outside the goal's repo"])
  expect(row.texts.map(t => t.props.dimColor)).toEqual([true, true, true])
  expect(row.texts[0]?.props.color).toBe(undefined)
  expect(await drawResult($, { output })).toEqual({ texts: [], isEngine: false })
})

test('/waffles:plan toggles the pane and remembers the choice', async ($, on) => {
  const { opened, panes, store, commands } = world(on)
  await start($)
  // /waffles:plan comes from the skill skills/plan: no command is registered, and plan alone is Claude Code's.
  expect(commands).not.toContainEqual(expect.objectContaining({ name: 'plan' }))

  expect(await toggle($)).toEqual({ text: 'Plan outline pane: open.' })
  expect(opened).toEqual([expect.objectContaining({ id: 'plan-outline', title: 'Plan outline' })])
  expect(store.planPane).toBe('open')

  expect(await toggle($)).toEqual({ text: 'Plan outline pane: closed.' })
  expect(panes).toEqual([])
  expect(store.planPane).toBe('closed')
})

test('a new active goal opens the pane in the fullscreen layout unless the person closed it', async ($, on) => {
  const { opened, panes, store } = world(on)
  await layout($, true)
  await call($, { op: 'goal', title: 'Ship', steps: [{ title: 'Spec' }] })
  expect(opened).toEqual([expect.objectContaining({ id: 'plan-outline', title: 'Plan outline' })])

  // A reload with a goal active opens it again.
  opened.length = 0
  await start($)
  expect(opened).toEqual([expect.objectContaining({ id: 'plan-outline' })])

  // The person closes it with the engine's mark (the kit can't raise that close, so the hook's
  // handler gets it as the engine would): it stays closed for the next goal.
  const set: [string, unknown][] = []
  const fake = { store: { set: async (key: string, value: unknown) => void set.push([key, value]) }, ui: { invalidate: () => undefined } }
  await paneClosed(fake as never, { id: 'plan-outline', origin: { kind: 'plugin' } })
  expect(set).toEqual([])
  await paneClosed(fake as never, { id: 'plan-outline', origin: { kind: 'person' } })
  expect(set).toEqual([['planPane', 'closed']])
  store.planPane = 'closed'
  await call($, { op: 'done', ids: ['1'] })
  opened.length = 0
  await call($, { op: 'goal', title: 'Fix flaky test', steps: [{ title: 'Repro' }] })
  expect(opened).toEqual([])

  // /waffles:plan opens it again, and the next goal opens it.
  panes.length = 0
  await toggle($)
  await layout($, true)
  await call($, { op: 'done', ids: ['1'] })
  opened.length = 0
  await call($, { op: 'goal', title: 'Third', steps: [{ title: 'A' }] })
  expect(opened).toEqual([expect.objectContaining({ id: 'plan-outline' })])
})

test('a closed choice stored in an earlier session keeps the pane closed at start', async ($, on) => {
  const { opened } = world(on, { planPane: 'closed' })
  await layout($, true)
  await call($, { op: 'goal', title: 'Ship', steps: [{ title: 'Spec' }] })
  await start($)

  expect(opened).toEqual([])
})

test('on the main screen a new goal leaves the pane closed and the footer shows the current step', async ($, on) => {
  const { opened, panes } = world(on)
  await drawHint($)
  expect(await layout($, false)).toBe(LEFT)

  await call($, { op: 'goal', title: 'Ship OAuth login', steps: [{ title: 'Spec' }, { title: 'Build' }] })
  await start($)

  expect(opened).toEqual([])
  expect(panes).toEqual([])
  expect(await layout($, false)).toBe(`${LEFT} · ▶ Spec`)
})

test('on the main screen /waffles:plan still opens the pane', async ($, on) => {
  const { opened } = world(on)
  await layout($, false)
  await call($, { op: 'goal', title: 'Ship', steps: [{ title: 'Spec' }] })

  expect(await toggle($)).toEqual({ text: 'Plan outline pane: open.' })
  expect(opened).toEqual([expect.objectContaining({ id: 'plan-outline', title: 'Plan outline' })])
})

// The footer's plan outline item: `▶ <current step's title>`, cut to the room the footer leaves it, or
// `▶ X of Y steps` where that room is under 36 columns.
const LONG = 'Compare PKCE libraries for the callback route and choose one'

test('a wide footer shows the current step’s title after the effort, the ▶ in the main thread’s cyan', async ($, on) => {
  const { disk } = world(on)
  await specExample($, disk)
  await drawHint($)

  for (const surface of SURFACES) {
    const { line, texts } = await drawFooter($, 120, true, surface)
    expect(line).toBe(`${LEFT} · ▶ Callback route`)
    expect(texts.map(t => t.text).slice(-3)).toEqual([' · ', '▶', ' Callback route'])
    expect(texts.at(-2)?.props.color).toBe('cyan')
    expect(texts.at(-1)?.props.dimColor).toBe(true)
    expect(texts.at(-3)?.props.dimColor).toBe(true)
  }
  // At N = 36 the title form still shows.
  expect((await drawFooter($, TAKEN + 36)).line).toBe(`${LEFT} · ▶ Callback route`)
})

test('a middle-width footer cuts the title with … to exactly N columns', async ($, on) => {
  world(on)
  await call($, { op: 'goal', title: 'Pick a PKCE library', steps: [{ title: LONG }] })
  await drawHint($)

  const n = 40
  const { line, texts } = await drawFooter($, TAKEN + n)
  const title = `${[...LONG].slice(0, n - 1).join('')}…`
  expect(line).toBe(`${LEFT} · ▶ ${title}`)
  expect([...(texts.at(-1)?.text ?? '')].length - 1).toBe(n)
  expect(texts.at(-1)?.props.dimColor).toBe(true)
})

test('under 36 columns of room the footer counts the closed steps instead', async ($, on) => {
  const { disk } = world(on)
  await specExample($, disk)
  await drawHint($)

  // Of the spec example's 8 steps, 1, 2, 3.1 and 3.2.1 are done and 3.3 dropped.
  const { line, texts } = await drawFooter($, TAKEN + 35)
  expect(line).toBe(`${LEFT} · ▶ 5 of 8 steps`)
  expect(texts.at(-2)?.props.color).toBe('cyan')
  expect(texts.at(-1)?.text).toBe(' 5 of 8 steps')
  expect(texts.at(-1)?.props.dimColor).toBe(true)

  // A deferred step counts as closed too, at every depth.
  await call($, { op: 'defer', id: '4', backlog: '.backlog/ship.md' })
  expect((await drawFooter($, TAKEN + 35)).line).toBe(`${LEFT} · ▶ 6 of 8 steps`)
})

test('a goal with no current step shows the count at any width', async ($, on) => {
  const { disk } = world(on)
  // A started goal always has a step now, so the file is written without one.
  disk.files.set(file('ship'), serializeGoal({ ...newGoal('Ship', [{ title: 'A' }], ISO), steps: [], current: null }))
  await call($, { op: 'goal', switch: 'ship' })
  await drawHint($)

  expect((await drawFooter($, 160)).line).toBe(`${LEFT} · ▶ 0 of 0 steps`)
})

test('a footer too narrow for the count draws no plan outline item and no separator', async ($, on) => {
  const { disk } = world(on)
  await specExample($, disk)
  await drawHint($)

  // The count `▶ 5 of 8 steps` takes 14 columns: the room is the columns less the hint, the parts, the separator and the gap.
  const room = 15 + 2 + 27 + 3 + 2
  expect((await drawFooter($, room + 14)).line).toBe(`${LEFT} · ▶ 5 of 8 steps`)
  const { line, buttons } = await drawFooter($, room + 13)
  expect(line).toBe(LEFT)
  expect(buttons).toEqual([])
})

test('with no active goal the footer is unchanged', async ($, on) => {
  world(on)
  await drawHint($)

  const { texts, buttons } = await drawFooter($, 160)
  expect(texts.map(t => t.text)).toEqual(['●', ' production', ' · ', 'effort: auto'])
  expect(buttons).toEqual([])
})

test('pressing the plan outline item toggles the pane and keeps the choice; it shows while the pane is open', async ($, on) => {
  const { disk, opened, panes, store } = world(on)
  await specExample($, disk)
  panes.length = 0
  opened.length = 0
  await drawHint($)

  const ui = await footer($, 120, false)
  const button = await ui.find({ type: 'Button' })
  expect(button?.props.label).toBe('Plan outline: Callback route')
  await ui.press({ key: 'plan-outline' })
  await ui.unmount()
  expect(opened).toEqual([expect.objectContaining({ id: 'plan-outline', title: 'Plan outline' })])
  expect(store.planPane).toBe('open')

  const again = await footer($, 120, false)
  expect((await again.findAll({ type: 'Text' })).map(t => t.text).join('')).toBe(`${LEFT} · ▶ Callback route`)
  await again.press({ key: 'plan-outline' })
  await again.unmount()
  expect(panes).toEqual([])
  expect(store.planPane).toBe('closed')
})

test('the hint line passes through unchanged, and a longer one leaves the plan outline item less room', async ($, on) => {
  const { disk } = world(on)
  await specExample($, disk)

  expect(await drawHint($)).toEqual({ engine: expect.anything(), texts: [] })
  expect((await drawFooter($, TAKEN + 36)).line).toBe(`${LEFT} · ▶ Callback route`)

  // 5 more columns of hint, from its text and its tail, take N under 36.
  const drawn = await drawHint($, '? for shortcuts!!', ' ··')
  expect(drawn).toEqual({ engine: expect.anything(), texts: [] })
  expect((await drawFooter($, TAKEN + 36)).line).toBe(`${LEFT} · ▶ 5 of 8 steps`)
  expect((await drawFooter($, TAKEN + 41)).line).toBe(`${LEFT} · ▶ Callback route`)

  await drawHint($)
})

test('in the fullscreen layout recorded from the footer, a new goal opens the pane', async ($, on) => {
  const { opened } = world(on)
  await drawHint($)
  await drawFooter($, 160, false)
  await call($, { op: 'goal', title: 'Ship', steps: [{ title: 'Spec' }] })
  expect(opened).toEqual([])

  await call($, { op: 'done', ids: ['1'] })
  await drawFooter($, 160, true)
  await call($, { op: 'goal', title: 'Next', steps: [{ title: 'Spec' }] })
  expect(opened).toEqual([expect.objectContaining({ id: 'plan-outline', title: 'Plan outline' })])
})

// A pane placed but not shown: a tab behind another pane.
const hidden = (): Pane => ({ id: 'plan-outline', title: 'Plan outline', isShown: false, isFocused: false, isPlaced: true })

test('/waffles:plan raises the pane from behind another tab with focus; shown, it closes; closed, it opens', async ($, on) => {
  const { opened, panes, store } = world(on)
  panes.push(hidden())

  expect(await toggle($)).toEqual({ text: 'Plan outline pane: open.' })
  expect(opened).toEqual([expect.objectContaining({ id: 'plan-outline', title: 'Plan outline', focus: true })])
  expect(panes.map(p => p.id)).toEqual(['plan-outline'])
  expect(store.planPane).toBe('open')

  panes[0]!.isShown = true
  expect(await toggle($)).toEqual({ text: 'Plan outline pane: closed.' })
  expect(panes).toEqual([])
  expect(store.planPane).toBe('closed')

  opened.length = 0
  expect(await toggle($)).toEqual({ text: 'Plan outline pane: open.' })
  expect(opened).toEqual([expect.objectContaining({ id: 'plan-outline', title: 'Plan outline' })])
  expect((opened[0] as { focus?: boolean }).focus).toBeUndefined()
  expect(store.planPane).toBe('open')
})

test('pressing the plan outline item raises the pane from behind another tab', async ($, on) => {
  const { disk, opened, panes, store } = world(on)
  await specExample($, disk)
  panes.length = 0
  opened.length = 0
  panes.push(hidden())
  await drawHint($)

  const ui = await footer($, 120, false)
  await ui.press({ key: 'plan-outline' })
  await ui.unmount()

  expect(opened).toEqual([expect.objectContaining({ id: 'plan-outline', focus: true })])
  expect(panes.map(p => p.id)).toEqual(['plan-outline'])
  expect(store.planPane).toBe('open')
})

test('/waffles:plan answers while a poll waits on git', async ($, on) => {
  const { disk, clock } = world(on)
  await start($)
  disk.gitGate = new Promise<void>(() => undefined)
  await clock.advance(5_000)

  expect(await toggle($)).toEqual({ text: 'Plan outline pane: open.' })
})

test('after done ends the goal the pane keeps its tree with a dim done row, the poll keeps it, and a new goal replaces it', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await call($, { op: 'goal', title: 'Ship', steps: [{ title: 'Spec' }, { title: 'Build' }] })
  await call($, { op: 'done', ids: ['1', '2'] })

  const ended = ['Ship', 'done', '  ✔ 1 Spec', '  ✔ 2 Build']
  const { rows, texts } = await drawPane($)
  expect(rows).toEqual(ended)
  expect(texts.find(t => t.text === 'done')?.props.dimColor).toBe(true)

  await drawHint($)
  expect((await drawFooter($, 160)).buttons).toEqual([])

  await clock.advance(5_000)
  expect((await drawPane($)).rows).toEqual(ended)

  await call($, { op: 'goal', title: 'Next', steps: [{ title: 'Repro' }] })
  expect((await drawPane($)).rows).toEqual(['Next', '  ▶ 1 Repro'])
})

test('after /clear the pane keeps the tree marked not active, the poll keeps it, and a switch makes it active again', async ($, on) => {
  const { disk, clock } = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await start($)
  await specExample($, disk)

  await $.session.end({ reason: 'clear', sessionId: ME, resume: { id: ME } })

  const kept = [
    'Ship OAuth login',
    'not active',
    '  ✔ 1 Spec',
    '  ✔ 2 Design',
    '⌄ ▶ 3 Build',
    '    ✔ 3.1 Provider config',
    '  ⌄ ▶ 3.2 Callback route',
    '      ✔ 3.2.1 ⤷ Fix CORS on dev proxy',
    '    ✗ 3.3 ? Try implicit flow',
    '  ○ 4 Ship',
    ' ',
    '1 other goal parked',
  ]
  const { rows, texts } = await drawPane($)
  expect(rows).toEqual(kept)
  expect(texts.find(t => t.text === 'not active')?.props.dimColor).toBe(true)
  await drawHint($)
  expect((await drawFooter($, 160)).buttons).toEqual([])

  await clock.advance(5_000)
  expect((await drawPane($)).rows).toEqual(kept)

  await call($, { op: 'goal', switch: 'ship-oauth-login' })
  expect((await drawPane($)).rows.slice(0, 2)).toEqual(['Ship OAuth login', '  ✔ 1 Spec'])
})

test('a new goal’s tree drawn a moment before it is active, with no goal kept, has no not-active row', async ($, on) => {
  world(on)
  // Between a kept goal's let-go and the new goal's start: its tree is written, nothing is active or kept.
  const tree = newGoal('Fix flaky test', [{ title: 'Repro' }], ISO)
  on('state.get', ($, e, next) => (e.key === 'planTree' ? ({ value: { version: 1, value: tree } } as never) : next(e)))

  expect((await drawPane($)).rows).toEqual(['Fix flaky test', '  ▶ 1 Repro'])
})

test('the dim row under a kept goal says its file is missing or unreadable, and returns to normal when it reads again', async ($, on) => {
  const { disk, clock } = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await start($)
  await specExample($, disk)
  const saved = disk.files.get(file('ship-oauth-login'))!
  await $.session.end({ reason: 'clear', sessionId: ME, resume: { id: ME } })
  const second = async () => (await drawPane($)).rows.slice(0, 2)

  disk.files.delete(file('ship-oauth-login'))
  await clock.advance(5_000)
  expect(await second()).toEqual(['Ship OAuth login', 'not active · file missing'])
  expect((await drawPane($)).texts.find(t => t.text === 'not active · file missing')?.props.dimColor).toBe(true)

  disk.files.set(file('ship-oauth-login'), '---\ngoal: Ship OAuth login\nnonsense\n')
  await clock.advance(5_000)
  expect(await second()).toEqual(['Ship OAuth login', "not active · can't read the file"])

  disk.files.set(file('ship-oauth-login'), saved)
  await clock.advance(5_000)
  expect(await second()).toEqual(['Ship OAuth login', 'not active'])
})

// Each test loads the plugin anew, as a reload does: the layout is unknown until the next drawing.
test('after a reload with a goal active, the first fullscreen footer opens the pane, once', async ($, on) => {
  const { opened } = world(on)
  await call($, { op: 'goal', title: 'Ship', steps: [{ title: 'Spec' }] })
  expect(opened).toEqual([])

  await start($)
  expect(opened).toEqual([])

  await drawHint($)
  await drawFooter($, 160, true)
  expect(opened).toEqual([expect.objectContaining({ id: 'plan-outline', title: 'Plan outline' })])
  await drawFooter($, 160, true)
  expect(opened).toHaveLength(1)
})

test('after a reload the pending open does nothing when the stored choice is closed', async ($, on) => {
  const { opened } = world(on, { planPane: 'closed' })
  await call($, { op: 'goal', title: 'Ship', steps: [{ title: 'Spec' }] })

  await start($)
  await drawFooter($, 160, true)

  expect(opened).toEqual([])
})

test('after a reload the pending open does nothing on the main screen', async ($, on) => {
  const { opened } = world(on)
  await call($, { op: 'goal', title: 'Ship', steps: [{ title: 'Spec' }] })

  await start($)
  await drawFooter($, 160, false)
  await drawFooter($, 160, false)

  expect(opened).toEqual([])
})

test('widths count terminal cells: wide characters 2, marks and joiners 0, and a cut never splits a grapheme', () => {
  // The cut below relies on Intl.Segmenter in the plugin runtime; the code-point fallback is for runtimes without it.
  expect(typeof Intl.Segmenter).toBe('function')

  expect(width('abc')).toBe(3)
  expect(width('日本語')).toBe(6)
  expect(width('ｱ')).toBe(1)
  expect(width('Ａ')).toBe(2)
  expect(width('é')).toBe(1)
  expect(width('🚀')).toBe(2)
  expect(width('👨‍👩‍👧')).toBe(2)
  expect(width('🇯🇵')).toBe(2)
  expect(width('❤️')).toBe(2)
  expect(width('✔▶⏸\uFE0E')).toBe(3)

  expect(cut('日本語日本語', 6)).toBe('日本…')
  expect(cut('日本語日本語', 5)).toBe('日本…')
  expect(cut('日本語', 6)).toBe('日本語')
  expect(cut('ab👨‍👩‍👧cd', 4)).toBe('ab…')
  expect(cut('ab👨‍👩‍👧cd', 5)).toBe('ab👨‍👩‍👧…')
  expect(cut('café au lait', 5)).toBe('café…')
  expect(cut('日本語', 1)).toBe('…')
  expect(cut('日本語', 0)).toBe('')
})

test('the pane and footer cut wide titles to their cells, and their Texts truncate as a backstop', async ($, on) => {
  world(on)
  const title = '日本語のタイトルを長く書く'
  await call($, { op: 'goal', title, steps: [{ title }] })

  const { rows, texts } = await drawPane($, 20)
  expect(rows.every(row => width(row) <= 20)).toBe(true)
  expect(rows[0]).toBe('日本語のタイトルを…')
  expect(rows[1]).toBe('  ▶ 1 日本語のタイ…')
  expect(texts.length).toBeGreaterThan(0)
  expect(texts.every(t => t.props.wrap === 'truncate-end')).toBe(true)

  await drawHint($)
  const n = 40
  const drawn = await drawFooter($, TAKEN + n)
  expect(width(drawn.texts.at(-1)?.text ?? '') - 1).toBeLessThanOrEqual(n)
  expect(drawn.texts.at(-1)?.props.wrap).toBe('truncate-end')
})

test('the footer leaves 2 columns of margin for the hint’s padding', async ($, on) => {
  const { disk } = world(on)
  await specExample($, disk)
  await drawHint($)

  // N = 36 shows the title and 35 the count only because the margin is in TAKEN.
  expect((await drawFooter($, TAKEN + 36)).line).toBe(`${LEFT} · ▶ Callback route`)
  expect((await drawFooter($, TAKEN - 2 + 36)).line).toBe(`${LEFT} · ▶ 5 of 8 steps`)
})

test('a failed open or store write in /waffles:plan answers with a short text, not a rejection', async ($, on) => {
  const { fails } = world(on)
  fails.open = true
  expect(await toggle($)).toEqual({ text: "Plan outline pane: couldn't change it." })

  fails.open = false
  fails.set = true
  expect(await toggle($)).toEqual({ text: "Plan outline pane: couldn't change it." })
})

test('pressing the plan outline item when the pane fails to open leaves nothing unhandled', async ($, on) => {
  const { disk, fails, store } = world(on)
  await specExample($, disk)
  await drawHint($)
  fails.open = true

  // press awaits the item's onPress: a failure it let through would reject here.
  const ui = await footer($, 120, false)
  await ui.press({ key: 'plan-outline' })
  await ui.unmount()
  expect(store.planPane).toBeUndefined()
})

test('a result block of an interrupted or unknown-shape call is the engine’s; change lines and refusals are hidden', async ($, on) => {
  world(on)

  // An interrupt's notice has text, but not the change-lines shape.
  expect(await drawResult($, { output: "The user doesn't want to proceed with this tool use. The tool use was rejected." })).toEqual({ texts: [], isEngine: true })
  expect(await drawResult($, { output: [{ type: 'text', text: 'Interrupted by user' }] })).toEqual({ texts: [], isEngine: true })
  for (const line of ['+ 3.2.2 Fix', '✔ 1 Spec', '✗ 3.3 x', '↗ 3 Build', '⏸\uFE0E paused', '◇ new goal: Ship', '▶ 2 Next', 'moved 3.2 under 4', 'renamed 3 to Y']) {
    expect(await drawResult($, { output: `${line}\n\nPath: none` })).toEqual({ texts: [], isEngine: false })
  }
  expect(await drawResult($, { output: [{ type: 'text', text: '✔ 1 Spec\n\nPath: none' }] })).toEqual({ texts: [], isEngine: false })
})

test('a new goal does not open the pane when /waffles:plan closes it while the open runs', async ($, on) => {
  const { opened, panes, store, during } = world(on)
  await layout($, true)
  // The /waffles:plan close lands inside the open: it stores `closed` before the pane exists to close.
  during.open = () => void (store.planPane = 'closed')

  await call($, { op: 'goal', title: 'Ship', steps: [{ title: 'Spec' }] })

  expect(opened).toHaveLength(1)
  expect(panes).toEqual([])
})

// The `ui.close → paneClosed` wiring has no test: the kit's `$` has no `ui.close` to raise a person-origin
// close (tried: `$.ui.close` is undefined), so the wiring is checked by reading, and paneClosed's rule by the
// direct calls in the test above.

test('a subagent’s step is bold magenta, a step whose report waits bold yellow, and their parents bold', async ($, on) => {
  const { disk } = world(on)
  on('agent.list', () => ({ value: [{ id: 'agent-1', status: 'running', description: '2.1 Merge', type: 'general-purpose' }] }) as never)
  disk.files.set(file('ship-apis'), `---
goal: Ship the APIs
status: open
current: 1
created: ${ISO}
updated: ${ISO}
---
- [ ] 1 Survey the queue
- [ ] 2 Fix the APIs
  - [ ] 2.1 Merge the 2 API fixes <!-- agent=agent-1 -->
  - [r] 2.2 Archive ITEM-91
  - [ ] 2.3 Close the epic
`)
  await call($, { op: 'goal', switch: 'ship-apis' })

  const { rows, texts } = await drawPane($)

  expect(rows).toEqual(['Ship the APIs', '  ▶ 1 Survey the queue', '⌄ ▶ 2 Fix the APIs', '    ▶ 2.1 Merge the 2 API fixes', '    ◐ 2.2 Archive ITEM-91', '    ○ 2.3 Close the epic'])
  const style = (text: string) => {
    const props = texts.find(t => t.text === text)?.props ?? {}
    return [props.color, props.bold]
  }
  expect(style(' 1 Survey the queue')).toEqual(['cyan', undefined])
  expect(style(' 2 Fix the APIs')).toEqual([undefined, true])
  expect(style(' 2.1 Merge the 2 API fixes')).toEqual(['magenta', undefined])
  expect(style(' 2.2 Archive ITEM-91')).toEqual(['yellow', undefined])
  expect(texts.filter(t => t.text === '▶').map(t => [t.props.color, t.props.bold])).toEqual([['cyan', true], [undefined, true], ['magenta', true]])
  expect(style('◐')).toEqual(['yellow', true])
})
