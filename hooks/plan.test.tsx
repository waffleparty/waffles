import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { STALE_MS } from './plan-store'
import { fakeDisk, inRepo } from './plan-testing'
import { newGoal, parseGoal, serializeGoal } from './plan-tree'

const TOOL = 'mcp__waffles__plan'
const DESCRIPTION =
  'Changes the plan outline: the tree of goals and steps for this repo that the person sees beside the chat. The only way to change its goal files in .tmp/plan/. Each call returns the changes and the new path.'
const NOW = Date.parse('2026-11-15T12:00:00Z')
const ISO = new Date(NOW).toISOString()
const ME = 'session-me'
const ROOT = '/repo/.tmp/plan'
const STATE = '/repo/.git/waffles'
const file = (slug: string) => `${ROOT}/${slug}.md`
const lockFile = (slug: string) => `${STATE}/locks/${slug}.json`
const lock = (session: string, at: number) => JSON.stringify({ session, heartbeat: new Date(at).toISOString() })
const recordFile = (session: string) => `${STATE}/sessions/${session}.json`
const record = (slug: string) => JSON.stringify({ goal: slug })
const OAUTH = { op: 'goal', title: 'Ship OAuth login', steps: [{ title: 'Spec' }, { title: 'Build' }] }

// The disk, this session's ID and a clock at NOW, all beneath the plugin; `state` holds the last
// value the plugin wrote to each key (a test's own `$` has no state to read).
// `me` answers this session's ID: a function for an ID that changes, as at /resume.
function world(on: On, me: string | (() => string) = ME) {
  const disk = fakeDisk(on)
  on('session.id', () => ({ value: typeof me === 'string' ? me : me() }) as never)
  const clock = mock.clock(on, { now: NOW })
  const state: Record<string, unknown> = {}
  // Every write, in order, as `[key, value]`.
  const sets: [string, unknown][] = []
  on('state.set', ($, e, next) => ((state[e.key] = e.value), sets.push([e.key, e.value]), next(e)))
  return { disk, clock, state, sets }
}

// Starts the session as the engine does, answering what the plugin's other modules ask of it at start.
async function start($: Engine, on: On) {
  const tools: unknown[] = []
  on('tool.register', ($, e) => (tools.push(e), { value: { tool: `mcp__waffles__${e.name}` } }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  mock.store(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  return tools
}

const call = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: TOOL, ...input } as never)

// The lines the plugin writes to the debug log.
function debugLog(on: On) {
  const lines: string[] = []
  on('ui.log', ($, e) => {
    if (e.to === 'debug') lines.push(e.text)
    return { value: undefined }
  })
  return lines
}

// A typed prompt, after which the highlights start over. The test answers prompt.submit.
async function typePrompt($: Engine) {
  await $.prompt.submit({ origin: { kind: 'composer' }, wait: false, text: 'Go on' })
  // The reset is queued behind plan outline work, so a call waits for it.
  await call($, { op: 'show' })
}

test('the plugin reads goal files through the test’s disk', async ($, on) => {
  const { disk } = world(on)
  disk.files.set(file('g'), serializeGoal(newGoal('G', [{ title: 'A' }, { title: 'B' }], ISO)))

  expect(await call($, { op: 'show', goal: 'g' })).toEqual({ result: '▶ 1 A\n○ 2 B' })
})

test('the plan tool is registered with its schema in the prompt', async ($, on) => {
  world(on)
  const tools = await start($, on)

  expect(tools).toEqual([
    expect.objectContaining({
      name: 'plan',
      description: DESCRIPTION,
      isDeferred: false,
      inputSchema: expect.objectContaining({
        type: 'object',
        required: ['op'],
        properties: expect.objectContaining({
          op: expect.objectContaining({ enum: ['goal', 'add', 'focus', 'done', 'drop', 'defer', 'move', 'rename', 'show'] }),
          focus: expect.objectContaining({ type: 'boolean' }),
        }),
      }),
    }),
  ])
})

test('goal starts a goal file and the result names the change and the path', async ($, on) => {
  const { disk, state } = world(on)

  const r = await call($, OAUTH)

  expect(r).toEqual({ result: '◇ new goal: Ship OAuth login [ship-oauth-login]\n\nPath: 1 Spec' })
  const goal = newGoal('Ship OAuth login', [{ title: 'Spec' }, { title: 'Build' }], ISO)
  expect(parseGoal(disk.files.get(file('ship-oauth-login'))!, 'x')).toEqual(goal)
  // Committed on the branch: no .gitignore in .tmp/plan.
  expect(disk.writes.filter(path => path.startsWith(ROOT) && path.endsWith('.gitignore'))).toEqual([])
  expect(JSON.parse(disk.files.get(lockFile('ship-oauth-login'))!)).toEqual({ session: ME, heartbeat: ISO })
  expect(state.planGoal).toBe('ship-oauth-login')
  expect(state.planTree).toEqual(goal)
  expect(state.planChanged).toEqual(['1', '2'])
})

test('a second goal parks the first and says where', async ($, on) => {
  const { disk, state } = world(on)
  await call($, OAUTH)
  await call($, { op: 'focus', id: '2' })

  const r = await call($, { op: 'goal', title: 'Fix flaky test' })

  expect(r).toEqual({ result: '◇ new goal: Fix flaky test [fix-flaky-test] (Ship OAuth login [ship-oauth-login] parked at 2 Build)\n\nPath: 1 Fix flaky test' })
  expect(disk.files.has(lockFile('ship-oauth-login'))).toBe(false)
  expect(JSON.parse(disk.files.get(lockFile('fix-flaky-test'))!).session).toBe(ME)
  expect(state.planGoal).toBe('fix-flaky-test')
  expect(state.planOthers).toEqual([{ slug: 'ship-oauth-login', title: 'Ship OAuth login', current: '2 Build', inUse: false }])
})

test('add, done, and the return to the parent show in the result', async ($, on) => {
  const { state } = world(on)
  await call($, OAUTH)

  const added = await call($, { op: 'add', parent: '1', kind: 'research', titles: ['Compare PKCE libraries'] })
  const focused = await call($, { op: 'focus', id: '1.1' })
  const done = await call($, { op: 'done', ids: ['1.1'] })

  expect(added).toEqual({ result: '+ 1.1 ? Compare PKCE libraries under 1\n\nPath: 1 Spec' })
  expect(focused).toEqual({ result: '▶ 1.1 Compare PKCE libraries\n\nPath: 1 Spec › 1.1 Compare PKCE libraries' })
  expect(done).toEqual({ result: '✔ 1.1 Compare PKCE libraries → back to 1 Spec\n\nPath: 1 Spec' })
  expect(state.planChanged).toEqual(['1', '2', '1.1'])
})

test('add with focus makes the first new step current in one row, parking the old path', async ($, on) => {
  const { disk, state } = world(on)
  await call($, OAUTH)

  const under = await call($, { op: 'add', parent: '1', kind: 'work', titles: ['Fix CORS on dev proxy'], focus: true })
  expect(under).toEqual({ result: '+ 1.1 ⤷ Fix CORS on dev proxy under 1 → current\n\nPath: 1 Spec › 1.1 Fix CORS on dev proxy' })

  const away = await call($, { op: 'add', parent: '2', kind: 'research', titles: ['Compare PKCE libraries'], focus: true })
  expect(away).toEqual({
    result: '+ 2.1 ? Compare PKCE libraries under 2 → current\n⏸ 1 Spec\n⏸ 1.1 Fix CORS on dev proxy\n\nPath: 2 Build › 2.1 Compare PKCE libraries',
  })
  const saved = parseGoal(disk.files.get(file('ship-oauth-login'))!, 'x')
  expect(saved.current).toBe('2.1')
  expect(saved.steps[0]?.state).toBe('parked')
  expect(saved.steps[0]?.children[0]?.state).toBe('parked')
  expect((state.planTree as { current: string }).current).toBe('2.1')
})

test('closing the last steps ends the goal and frees it', async ($, on) => {
  const { disk, state } = world(on)
  await call($, OAUTH)

  const r = await call($, { op: 'done', ids: ['1', '2'] })

  expect(r).toEqual({ result: '✔ 1 Spec\n✔ 2 Build\n✔ goal done: Ship OAuth login\n\nPath: none' })
  expect(parseGoal(disk.files.get(file('ship-oauth-login'))!, 'x').status).toBe('done')
  expect(disk.files.has(lockFile('ship-oauth-login'))).toBe(false)
  expect(state.planGoal).toBe(null)
  // The pane keeps the ended goal's tree until another goal becomes active.
  expect(state.planTree).toEqual(expect.objectContaining({ title: 'Ship OAuth login', status: 'done', current: null }))
  expect(await call($, { op: 'goal', switch: 'ship-oauth-login' })).toEqual({ deny: '"Ship OAuth login" is done.' })
})

test('an op other than goal or show needs an active goal', async ($, on) => {
  const { disk } = world(on)

  expect(await call($, { op: 'focus', id: '1' })).toEqual({ deny: 'No active goal. Start one with op "goal".' })
  expect(disk.writes).toEqual([])
})

test('with the shell in a submodule, a call on the active goal is a quiet result that names the folder; back in the repo it applies', async ($, on) => {
  const { disk } = world(on)
  await call($, OAUTH)
  // A cd into the submodule /repo/sub: git answers its top level and git dir.
  disk.git = argv =>
    argv.includes('--git-dir') ? { exitCode: 0, stdout: '/repo/sub\n/repo/.git/modules/sub\n/repo/.git/modules/sub\n' } : { exitCode: 0, stdout: '' }
  const writes = disk.writes.length
  const quiet = {
    result:
      "Nothing changed: .tmp/plan/ship-oauth-login.md isn't in /repo/sub, the repo of the shell's working directory. If the shell moved to another repo, cd back to the active goal's repo and call again.",
  }

  expect(await call($, { op: 'done', ids: ['1'] })).toEqual(quiet)
  expect(await call($, { op: 'show' })).toEqual(quiet)
  expect(disk.writes.length).toBe(writes)

  disk.git = inRepo
  expect(await call($, { op: 'done', ids: ['1'] })).toEqual({ result: '✔ 1 Spec → back to 2 Build\n\nPath: 2 Build' })
})

test('with no active goal, an op names the open goals to continue, so a resumed conversation finds its goal', async ($, on) => {
  const { disk } = world(on)
  disk.files.set(file('a'), serializeGoal(newGoal('Goal A', [{ title: 'Spec' }], ISO)))
  disk.files.set(file('b'), serializeGoal(newGoal('Goal B', [{ title: 'Build' }], ISO)))
  disk.files.set(lockFile('b'), lock('session-other', NOW))
  disk.files.set(file('c'), serializeGoal({ ...newGoal('Goal C', [], ISO), status: 'done' }))

  expect(await call($, { op: 'focus', id: '1' })).toEqual({
    deny: 'No active goal. Continue one with op "goal" and switch, or start one with op "goal" and title. Open goals:\n- a: Goal A, at 1 Spec',
  })
  expect(disk.writes).toEqual([])
})

test('show with a goal active appends the other open goals with their slugs', async ($, on) => {
  const { disk } = world(on)
  disk.files.set(file('a'), serializeGoal(newGoal('Goal A', [{ title: 'Spec' }], ISO)))
  disk.files.set(file('b'), serializeGoal(newGoal('Goal B', [{ title: 'Build' }], ISO)))
  disk.files.set(lockFile('b'), lock('session-other', NOW))
  await call($, OAUTH)

  expect(await call($, { op: 'show' })).toEqual({
    result: '▶ 1 Spec\n○ 2 Build\n\nOther open goals:\n- a: Goal A, at 1 Spec\n- b: Goal B, at 1 Build (in use by another session)',
  })
  expect(await call($, { op: 'show', goal: 'a' })).toEqual({
    result: '▶ 1 Spec\n\nOther open goals:\n- b: Goal B, at 1 Build (in use by another session)\n- ship-oauth-login: Ship OAuth login, at 1 Spec',
  })
})

test('a goal named by an unknown slug is refused with the open goals listed', async ($, on) => {
  const { disk } = world(on)
  disk.files.set(file('a'), serializeGoal(newGoal('Goal A', [{ title: 'Spec' }], ISO)))
  await call($, OAUTH)

  const listed = 'Open goals:\n- a: Goal A, at 1 Spec\n- ship-oauth-login: Ship OAuth login, at 1 Spec'
  expect(await call($, { op: 'goal', switch: 'nope' })).toEqual({ deny: `No goal nope. ${listed}` })
  expect(await call($, { op: 'show', goal: 'nope' })).toEqual({ deny: `No goal nope. ${listed}` })
  expect(await call($, { op: 'move', fromGoal: 'nope', to: '2' })).toEqual({ deny: `No goal nope. ${listed}` })
})

test('a subagent call is refused', async ($, on) => {
  const { disk } = world(on)

  expect(await call($, { ...OAUTH, agentId: 'a1' })).toEqual({ deny: 'The plan outline is kept by the main conversation only.' })
  expect(disk.writes).toEqual([])
})

test('a call during a non-interactive run changes the plan outline', async ($, on) => {
  const { disk, state } = world(on)
  on('state.get', ($, e, next) => (e.key === 'run' ? { value: { value: true, version: 1 } } : next(e)) as never)

  expect(await call($, OAUTH)).toEqual({ result: '◇ new goal: Ship OAuth login [ship-oauth-login]\n\nPath: 1 Spec' })
  expect(disk.files.has(file('ship-oauth-login'))).toBe(true)
  expect(state.planGoal).toBe('ship-oauth-login')
})

test('switching to a goal another live session holds is refused', async ($, on) => {
  const { disk, state } = world(on)
  disk.files.set(file('other-work'), serializeGoal(newGoal('Other work', [{ title: 'A' }], ISO)))
  disk.files.set(lockFile('other-work'), lock('session-other', NOW - 10_000))

  expect(await call($, { op: 'goal', switch: 'other-work' })).toEqual({ deny: '"Other work" is in use by another session.' })
  expect(state.planGoal).toBeUndefined()
})

test('switching to a parked goal continues it and parks the active one', async ($, on) => {
  const { disk, state } = world(on)
  disk.files.set(file('other-work'), serializeGoal(newGoal('Other work', [{ title: 'A' }], ISO)))
  disk.files.set(lockFile('other-work'), lock('session-other', NOW - STALE_MS - 1_000))
  await call($, OAUTH)

  const r = await call($, { op: 'goal', switch: 'other-work' })

  expect(r).toEqual({ result: '◇ continued goal: Other work [other-work] (Ship OAuth login [ship-oauth-login] parked at 1 Spec)\n\nPath: 1 A' })
  expect(JSON.parse(disk.files.get(lockFile('other-work'))!).session).toBe(ME)
  expect(disk.files.has(lockFile('ship-oauth-login'))).toBe(false)
  expect(state.planGoal).toBe('other-work')
})

test('a goal named by a bad or unknown slug is refused', async ($, on) => {
  world(on)

  expect(await call($, { op: 'goal', switch: '../etc/passwd' })).toEqual({ deny: 'No goal ../etc/passwd.' })
  expect(await call($, { op: 'show', goal: 'nope' })).toEqual({ deny: 'No goal nope.' })
  expect(await call($, { op: 'goal', switch: 'café/..' })).toEqual({ deny: 'No goal café/...' })
})

test('a goal with a non-ASCII title can be continued by its slug', async ($, on) => {
  world(on)

  const started = await call($, { op: 'goal', title: 'Café menu', steps: [{ title: 'Prices' }] })
  expect(started).toEqual({ result: '◇ new goal: Café menu [café-menu]\n\nPath: 1 Prices' })
  await call($, { op: 'goal', title: 'Other', steps: [{ title: 'X' }] })

  const r = await call($, { op: 'goal', switch: 'café-menu' })
  expect('result' in r && String(r.result).startsWith('◇ continued goal: Café menu [café-menu]')).toBe(true)
})

test('an unreadable goal file refuses with its line number', async ($, on) => {
  const { disk } = world(on)
  await call($, OAUTH)
  disk.files.set(file('ship-oauth-login'), '---\ngoal: Ship OAuth login\nnonsense\n')

  expect(await call($, { op: 'add', parent: null, kind: 'planned', titles: ['Ship'] })).toEqual({
    deny: "Can't read .tmp/plan/ship-oauth-login.md: line 3",
  })
})

test('moving a whole goal under a step of the active goal removes the other file', async ($, on) => {
  const { disk, state } = world(on)
  disk.files.set(file('cors-fix'), serializeGoal(newGoal('CORS fix', [{ title: 'Repro' }, { title: 'Patch' }], ISO)))
  await call($, OAUTH)

  const r = await call($, { op: 'move', fromGoal: 'cors-fix', to: '2' })

  expect(r).toEqual({ result: 'moved 1 → 2.1\nmoved 2 → 2.2\n\nPath: 1 Spec' })
  expect(disk.removed).toContain(file('cors-fix'))
  expect(disk.files.has(file('cors-fix'))).toBe(false)
  // Claimed for the move, then released.
  expect(disk.writes).toContain(lockFile('cors-fix'))
  expect(disk.files.has(lockFile('cors-fix'))).toBe(false)
  const target = parseGoal(disk.files.get(file('ship-oauth-login'))!, 'x')
  expect(target.steps[1]?.children.map(s => `${s.id} ${s.title}`)).toEqual(['2.1 Repro', '2.2 Patch'])
  expect(state.planChanged).toEqual(['1', '2', '2.1', '2.2'])
  expect(state.planOthers).toEqual([])
})

test('a poll in a checkout without .tmp/plan writes nothing', async ($, on) => {
  const { disk, clock, state } = world(on)
  await start($, on)

  await clock.advance(60_000)

  expect(disk.writes).toEqual([])
  expect(Object.keys(state).filter(key => key.startsWith('plan'))).toEqual([])
})

test('the poll redraws a goal changed on disk and refreshes the lock every 30 s', async ($, on) => {
  const { disk, clock, state } = world(on)
  await start($, on)
  await call($, OAUTH)
  const changed = newGoal('Ship OAuth login', [{ title: 'Write the spec' }, { title: 'Build' }], ISO)
  disk.files.set(file('ship-oauth-login'), serializeGoal(changed))

  await clock.advance(5_000)
  const tree = state.planTree
  const beatEarly = JSON.parse(disk.files.get(lockFile('ship-oauth-login'))!).heartbeat
  await clock.advance(30_000)

  expect(tree).toEqual(changed)
  expect(beatEarly).toBe(ISO)
  expect(JSON.parse(disk.files.get(lockFile('ship-oauth-login'))!).heartbeat).toBe(new Date(NOW + 30_000).toISOString())
})

test('show with no active goal lists the open goals, and no goal is needed for it', async ($, on) => {
  const { disk } = world(on)
  disk.files.set(file('a'), serializeGoal(newGoal('Goal A', [{ title: 'Spec' }], ISO)))
  disk.files.set(file('b'), serializeGoal(newGoal('Goal B', [{ title: 'Build' }], ISO)))
  disk.files.set(lockFile('b'), lock('session-other', NOW))

  expect(await call($, { op: 'show' })).toEqual({
    result: 'No active goal. Open goals:\n- a: Goal A, at 1 Spec\n- b: Goal B, at 1 Build (in use by another session)',
  })
  expect(disk.writes).toEqual([])
})

test('a title with a line break is refused before anything is written', async ($, on) => {
  const { disk } = world(on)

  expect(await call($, { op: 'goal', title: 'Ship\n- [x] 9 Fake' })).toEqual({ deny: 'A title can\'t hold a line break: "Ship\\n- [x] 9 Fake"' })
  expect(disk.writes).toEqual([])
})

test('a title with <!-- in it is refused before anything is written', async ($, on) => {
  const { disk } = world(on)

  expect(await call($, { op: 'goal', title: 'Ship <!-- x -->' })).toEqual({ deny: 'A title can\'t hold "<!--": "Ship <!-- x -->"' })
  expect(await call($, { op: 'goal', title: 'Ship', steps: [{ title: 'A <!-- parked=x -->' }] })).toEqual({
    deny: 'A title can\'t hold "<!--": "A <!-- parked=x -->"',
  })
  expect(disk.writes).toEqual([])
})

test('a new goal skips a slug another live session has locked, and saves only after its claim', async ($, on) => {
  const { disk, state } = world(on)
  disk.files.set(lockFile('ship-oauth-login'), lock('session-other', NOW - 10_000))

  const r = await call($, OAUTH)

  expect(r).toEqual({ result: '◇ new goal: Ship OAuth login [ship-oauth-login-2]\n\nPath: 1 Spec' })
  expect(disk.files.has(file('ship-oauth-login'))).toBe(false)
  expect(JSON.parse(disk.files.get(lockFile('ship-oauth-login'))!).session).toBe('session-other')
  expect(JSON.parse(disk.files.get(lockFile('ship-oauth-login-2'))!).session).toBe(ME)
  expect(disk.writes.indexOf(lockFile('ship-oauth-login-2'))).toBeLessThan(disk.writes.indexOf(file('ship-oauth-login-2')))
  expect(state.planGoal).toBe('ship-oauth-login-2')
})

test('list fields that are not lists are refused and change nothing', async ($, on) => {
  const { disk } = world(on)
  await call($, OAUTH)
  const before = disk.files.get(file('ship-oauth-login'))

  expect(await call($, { op: 'done', ids: '12' })).toEqual({ deny: '"ids" must be a list of text.' })
  expect(await call($, { op: 'add', parent: null, titles: 'Ship' })).toEqual({ deny: '"titles" must be a list of text.' })
  expect(await call($, { op: 'add', parent: null, titles: ['Ship', 3] })).toEqual({ deny: '"titles" must be a list of text.' })
  expect(await call($, { op: 'goal', title: 'Other', steps: 'Spec' })).toEqual({ deny: '"steps" must be a list of { title, kind }.' })
  expect(await call($, { op: 'goal', title: 'Other', steps: ['Spec'] })).toEqual({ deny: '"steps" must be a list of { title, kind }.' })
  expect(disk.files.get(file('ship-oauth-login'))).toBe(before)
  expect(disk.files.has(file('other'))).toBe(false)
})

test('a poll runs git once however many goal files there are', async ($, on) => {
  const { disk, clock } = world(on)
  for (const name of ['a', 'b', 'c']) disk.files.set(file(name), serializeGoal(newGoal(name, [{ title: 'A' }], ISO)))
  await start($, on)
  disk.ran.length = 0

  await clock.advance(5_000)

  expect(disk.ran.filter(argv => argv.includes('--git-dir'))).toHaveLength(1)
})

// The plan outline rules, word for word as the spec gives them.
const RULES = `# waffles plan outline

The waffles plugin keeps a plan outline: a tree of the work in this checkout, stored as one goal file per goal in .tmp/plan/ and shown to the person beside the chat. It shows the path from the goal to the current step, so the person can find the way back after side quests. Change it only with the mcp__waffles__plan tool, never by editing its goal files. The plan outline is not Claude Code's plan mode.

A session has 1 goal at a time. With no active goal, start one for any work that isn't done in the same reply; a question answered or a single change finished in the same reply gets none. When a prompt makes 2 or more steps, start the goal with those steps before starting the work. When a single change grows more steps, start the goal then. When the work matches an open goal named in the plan outline context, continue it with switch instead. While a goal is active, never start or switch to another goal, even for work that seems unrelated: it goes into the active goal's tree, so the way back stays in 1 tree. The other open goals are the work of other sessions.

A step is work with its own outcome that its parent depends on: a phase (spec, design, build, ship), a planned sub-step, or a detour. Kinds: planned (part of the agreed plan), work (a detour to change something), research (a detour to research, analyze, or decide). A detour is any topic that opens while a goal is active, whoever opens it: work the current step turns out to need, a question you put to the person, one they ask, or new work they bring. It gets a step when it takes research (reading code, history, or docs), settles a decision a step depends on, or takes more than a single edit or command, even if it opens and closes in one reply. A one-line factual answer, a single edit, or a single command gets none. On each prompt from the person, and when a skill steers the conversation, check whether it opens or settles a detour. A detour goes under the current step. When it is not clear that it belongs there, ask the person with AskUserQuestion before you add it, with these options: the current step, by ID and title (recommended); another step that could fit, if there is one; a new top-level step of the active goal; and another step, whose ID the person types. During a non-interactive run, add it under the current step without asking. Add a detour with focus when it opens, and close it with done in the same reply that settles it; the tool moves focus back and says where. Drop a step that is no longer needed.

A step with 2 or more parts gets a child step for each part as soon as the parts are known, whoever names them. A step has 1 outcome: never list parts in its title. Before you report what is left of a step, add its parts as child steps.

When you start a background subagent for a step, begin the Agent call's description with the step's ID and a colon, such as "8.1: Merge the API fixes". The plan outline then shows that step as the subagent's while it works, and focus moving on doesn't park it. When the subagent finishes, the step shows ◐: read its report, then close the step, or focus it to take the work over.

The person steers by step ID in plain language. "drop 1.1": drop with cascade. "close out 1.1.1–1.1.3": done with the IDs listed out. "move on to 2" or "skip ahead to 2.1.3": focus. "that's a detour under 4": move. "backlog 3.4": the waffles:backlog skill writes the item, then defer with its file. Set cascade only when the person asks to close a step with its children.

The person sees each plan outline change in the transcript, so a reply needs to mention one only when it matters to what comes next. Keep it during a non-interactive run too, so the person can see where the run stands when they return. Subagents don't use the plan outline.`

const compose = { model: 'opus', promptModel: 'opus', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const
const typed = { origin: { kind: 'composer' }, wait: false } as const

// Stands in for the engine beneath the plugin, which sends the first message's blocks as given;
// returns what reads the plan outline block of a first message.
function firstMessage(on: On) {
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  return async ($: Engine) => {
    const { blocks } = await $.prompt.context({ blocks: [{ name: 'currentDate', text: "Today's date is 2026-11-15." }] })
    return blocks.find(b => b.name === 'planOutline')
  }
}

test('the system prompt gets the plan outline rules as one section that never changes', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))

  // No .tmp/plan yet: the rules tell Claude how to start the first goal.
  const first = await $.prompt.compose(compose)
  await call($, OAUTH)
  const withGoal = await $.prompt.compose(compose)
  await call($, { op: 'done', ids: ['1', '2'] })
  const afterDone = await $.prompt.compose(compose)

  expect(first.sections.filter(s => s.id === 'waffles:plan-outline')).toEqual([{ id: 'waffles:plan-outline', scope: 'session', text: RULES }])
  expect(withGoal).toEqual(first)
  expect(afterDone).toEqual(first)
})

test('the first message carries the active goal tree', async ($, on) => {
  world(on)
  const outlineBlock = firstMessage(on)
  await call($, OAUTH)
  await call($, { op: 'add', parent: '1', kind: 'research', titles: ['Compare PKCE libraries'] })

  expect(await outlineBlock($)).toEqual({
    name: 'planOutline',
    text: 'plan outline: Ship OAuth login (.tmp/plan/ship-oauth-login.md)\n▶ 1 Spec\n  ○ 1.1 ? Compare PKCE libraries\n○ 2 Build',
  })
})

test('with no active goal the first message lists the open goals not in use', async ($, on) => {
  const { disk } = world(on)
  const outlineBlock = firstMessage(on)
  disk.files.set(file('a'), serializeGoal(newGoal('Goal A', [{ title: 'Spec' }], ISO)))
  disk.files.set(file('b'), serializeGoal(newGoal('Goal B', [{ title: 'Build' }], ISO)))
  disk.files.set(lockFile('b'), lock('session-other', NOW))
  disk.files.set(file('c'), serializeGoal({ ...newGoal('Goal C', [], ISO), status: 'done' }))

  const listed = await outlineBlock($)
  disk.files.delete(file('a'))
  const none = await outlineBlock($)

  expect(listed).toEqual({ name: 'planOutline', text: 'plan outline: no active goal. Open goals:\n- a: Goal A, at 1 Spec' })
  expect(none).toEqual({ name: 'planOutline', text: 'plan outline: no active goal and no open goals.' })
  expect(disk.writes).toEqual([])
})

test('a checkout without .tmp/plan adds no plan outline block', async ($, on) => {
  const { disk } = world(on)
  const outlineBlock = firstMessage(on)

  expect(await outlineBlock($)).toBeUndefined()
  expect(disk.writes).toEqual([])
})

test('a typed prompt clears the highlighted steps; a notification does not', async ($, on) => {
  const { state } = world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await call($, OAUTH)

  await $.prompt.submit({ text: 'Agent finished', origin: { kind: 'task-notification' }, wait: false } as never)
  const afterNotification = state.planChanged
  await $.prompt.submit({ ...typed, text: 'Go on' })
  // The reset is queued behind plan outline work, so a call waits for it.
  await call($, { op: 'show' })

  expect(afterNotification).toEqual(['1', '2'])
  expect(state.planChanged).toEqual([])
})

test('a slash command keeps the highlighted steps, /waffles:plan included; a typed prompt after it clears them', async ($, on) => {
  const { state } = world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await call($, OAUTH)

  await $.prompt.submit({ ...typed, text: '/waffles:plan', command: { name: 'waffles:plan', args: '' } })
  await $.prompt.submit({ ...typed, text: '/waffles:backlog-review', command: { name: 'waffles:backlog-review', args: '' } })
  await $.prompt.submit({ ...typed, text: 'Expanded skill body', isMeta: true } as never)
  await call($, { op: 'show' })
  const afterCommands = state.planChanged
  await $.prompt.submit({ ...typed, text: 'Go on' })
  // The reset doesn't hold the prompt: a plan call queues behind it.
  await call($, { op: 'show' })

  expect(afterCommands).toEqual(['1', '2'])
  expect(state.planChanged).toEqual([])
})

test('a plan outline that fails to start still starts the dev-server poll', async ($, on) => {
  const { disk, clock } = world(on)
  on('tool.register', () => ({ deny: 'no tools' }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  mock.store(on)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true }).catch(() => undefined)
  await clock.advance(5_000)

  expect(disk.ran.filter(argv => argv[0] === 'lsof').length).toBeGreaterThan(0)
})

test('a prompt typed while a poll waits on git still gets the backlog mode', async ($, on) => {
  const { disk, clock } = world(on)
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', ($, e) => (seen.push(e.context), { text: e.text }))
  await start($, on)
  await call($, OAUTH)
  await $.command.run({ command: 'backlog-entry', args: '' } as never)
  let release = () => undefined as void
  disk.gitGate = new Promise<void>(resolve => (release = resolve))

  await clock.advance(5_000)
  await $.prompt.submit({ ...typed, text: 'Add dark mode' })
  release()

  expect(seen).toEqual([['waffles mode: backlog']])
})

test('the session end releases the lock', async ($, on) => {
  const { disk, state } = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await call($, OAUTH)

  await $.session.end({ reason: 'prompt_input_exit', sessionId: ME, resume: { id: ME } })

  expect(disk.files.has(lockFile('ship-oauth-login'))).toBe(false)
  expect(state.planGoal).toBe('ship-oauth-login')
})

test('a session replaced by a resume releases the lock and leaves no active goal', async ($, on) => {
  const { disk, state } = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await call($, OAUTH)

  await $.session.end({ reason: 'resume', sessionId: ME, resume: { id: ME } })

  expect(disk.files.has(lockFile('ship-oauth-login'))).toBe(false)
  expect(state.planGoal).toBe(null)
  expect(state.planTree).toEqual(expect.objectContaining({ title: 'Ship OAuth login', status: 'open' }))
  expect(state.planChanged).toEqual([])
})

test('a call that fails for a reason other than the plan outline is refused with the reason', async ($, on) => {
  const { disk, state } = world(on)
  disk.isWriteBroken = true

  const r = await call($, OAUTH)

  expect(r).toEqual({ deny: expect.stringMatching(/^plan outline failed: .*EROFS/) })
  expect(state.planGoal).toBeUndefined()
})

test('a poll that loses git keeps its heartbeat out of the working directory', async ($, on) => {
  const { disk, clock } = world(on)
  await start($, on)
  await call($, OAUTH)
  disk.git = { exitCode: 128, stdout: '' }
  disk.writes.length = 0

  await clock.advance(35_000)

  expect(disk.writes.filter(path => path.startsWith('/cwd/'))).toEqual([])
})

test('/clear releases the lock and leaves no active goal, so the next first message lists it', async ($, on) => {
  const { disk, state } = world(on)
  const outlineBlock = firstMessage(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await call($, OAUTH)

  await $.session.end({ reason: 'clear', sessionId: ME, resume: { id: ME } })

  expect(disk.files.has(lockFile('ship-oauth-login'))).toBe(false)
  expect(state.planGoal).toBe(null)
  expect(state.planTree).toEqual(expect.objectContaining({ title: 'Ship OAuth login', status: 'open' }))
  expect(state.planChanged).toEqual([])
  expect(await outlineBlock($)).toEqual({
    name: 'planOutline',
    text: 'plan outline: no active goal. Open goals:\n- ship-oauth-login: Ship OAuth login, at 1 Spec',
  })
})

test('a lock that can’t be removed at /clear still clears the plan outline and resets the mode', async ($, on) => {
  const { disk, state } = world(on)
  const logs = debugLog(on)
  const ended: string[] = []
  on('session.end', ($, e) => (ended.push(e.sessionId), { sessionId: e.sessionId }))
  await start($, on)
  await call($, OAUTH)
  await $.command.run({ command: 'backlog-entry', args: '' } as never)
  const modeBefore = state.mode
  disk.isRmBroken = true

  await $.session.end({ reason: 'clear', sessionId: ME, resume: { id: ME } })

  expect(disk.files.has(lockFile('ship-oauth-login'))).toBe(true)
  expect(state.planGoal).toBe(null)
  expect(state.planChanged).toEqual([])
  expect(modeBefore).toBe('backlog')
  expect(state.mode).toBe('production')
  expect(ended).toEqual([ME])
  expect(logs).toEqual([expect.stringMatching(/^plan outline: couldn't release the lock on ship-oauth-login: .*EPERM/s)])
})

test('defer closes a step linked to its backlog item', async ($, on) => {
  const { disk, state } = world(on)
  await call($, OAUTH)

  const r = await call($, { op: 'defer', id: '2', backlog: '.backlog/build.md' })

  expect(r).toEqual({ result: '↗ 2 Build\n\nPath: 1 Spec' })
  const saved = parseGoal(disk.files.get(file('ship-oauth-login'))!, 'x')
  expect(saved.steps[1]).toEqual(expect.objectContaining({ state: 'deferred', backlog: '.backlog/build.md' }))
  expect((state.planTree as { steps: { state: string }[] }).steps[1]?.state).toBe('deferred')
})

test('drop closes a step as dropped', async ($, on) => {
  const { disk } = world(on)
  await call($, OAUTH)

  const r = await call($, { op: 'drop', ids: ['2'] })

  expect(r).toEqual({ result: '✗ 2 Build\n\nPath: 1 Spec' })
  expect(parseGoal(disk.files.get(file('ship-oauth-login'))!, 'x').steps[1]?.state).toBe('dropped')
})

test('rename retitles a step', async ($, on) => {
  const { disk, state } = world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await call($, OAUTH)
  await typePrompt($)

  const r = await call($, { op: 'rename', id: '2', title: 'Build the flow' })

  expect(r).toEqual({ result: 'renamed 2 to Build the flow\n\nPath: 1 Spec' })
  expect(parseGoal(disk.files.get(file('ship-oauth-login'))!, 'x').steps[1]?.title).toBe('Build the flow')
  expect(state.planChanged).toEqual(['2'])
})

test('a step move highlights the whole moved subtree by its new IDs and the steps it parked', async ($, on) => {
  const { disk, state } = world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await call($, OAUTH)
  await call($, { op: 'add', parent: '1', titles: ['Draft'], focus: true })
  await call($, { op: 'add', parent: '1.1', titles: ['Outline'] })
  await typePrompt($)

  const r = await call($, { op: 'move', id: '1.1', to: '2' })

  expect(r).toEqual({ result: 'moved 1.1 → 2.1\n⏸ 1 Spec\n\nPath: 2 Build › 2.1 Draft' })
  const saved = parseGoal(disk.files.get(file('ship-oauth-login'))!, 'x')
  expect(saved.steps[1]?.children[0]?.children.map(s => s.id)).toEqual(['2.1.1'])
  expect(state.planChanged).toEqual(['2.1', '2.1.1', '1'])
})

test('moving the active goal into itself, or a goal another session holds, is refused', async ($, on) => {
  const { disk } = world(on)
  disk.files.set(file('cors-fix'), serializeGoal(newGoal('CORS fix', [{ title: 'Repro' }], ISO)))
  disk.files.set(lockFile('cors-fix'), lock('session-other', NOW - 10_000))
  await call($, OAUTH)
  const target = disk.files.get(file('ship-oauth-login'))
  disk.writes.length = 0

  expect(await call($, { op: 'move', fromGoal: 'ship-oauth-login', to: '2' })).toEqual({ deny: '"Ship OAuth login" is the active goal.' })
  expect(await call($, { op: 'move', fromGoal: 'cors-fix', to: '2' })).toEqual({ deny: '"CORS fix" is in use by another session.' })
  expect(disk.files.has(file('cors-fix'))).toBe(true)
  expect(JSON.parse(disk.files.get(lockFile('cors-fix'))!).session).toBe('session-other')
  expect(disk.writes).not.toContain(lockFile('cors-fix'))
  expect(disk.files.get(file('ship-oauth-login'))).toBe(target)
})

test('a goal move that fails after its claim releases the claim and keeps the source', async ($, on) => {
  const { disk } = world(on)
  disk.files.set(file('cors-fix'), serializeGoal(newGoal('CORS fix', [{ title: 'Repro' }], ISO)))
  await call($, OAUTH)

  const r = await call($, { op: 'move', fromGoal: 'cors-fix', to: '9' })

  expect(r).toEqual({ deny: expect.stringContaining('9') })
  expect(disk.writes).toContain(lockFile('cors-fix'))
  expect(disk.files.has(lockFile('cors-fix'))).toBe(false)
  expect(disk.files.has(file('cors-fix'))).toBe(true)
})

test('an op on the active goal claims it again, and stops when another session took it', async ($, on) => {
  const { disk, clock, state } = world(on)
  await call($, OAUTH)
  await clock.advance(10_000)

  await call($, { op: 'focus', id: '2' })
  const beat = JSON.parse(disk.files.get(lockFile('ship-oauth-login'))!).heartbeat
  disk.files.set(lockFile('ship-oauth-login'), lock('session-other', NOW + 10_000))
  const saved = disk.files.get(file('ship-oauth-login'))
  const r = await call($, { op: 'focus', id: '1' })

  expect(beat).toBe(new Date(NOW + 10_000).toISOString())
  expect(r).toEqual({ deny: '"Ship OAuth login" is now in use by another session.' })
  expect(disk.files.get(file('ship-oauth-login'))).toBe(saved)
  expect(JSON.parse(disk.files.get(lockFile('ship-oauth-login'))!).session).toBe('session-other')
  // The tree stays drawn, marked not active.
  expect(state.planGoal).toBe(null)
  expect(state.planKept).toBe('ship-oauth-login')
  expect(state.planTree).toEqual(expect.objectContaining({ title: 'Ship OAuth login', current: '2' }))
})

test('the poll that finds another session’s lock on the active goal stops holding it and keeps its tree', async ($, on) => {
  const { disk, clock, state } = world(on)
  await start($, on)
  await call($, OAUTH)
  disk.files.set(lockFile('ship-oauth-login'), lock('session-other', NOW + 20_000))

  await clock.advance(30_000)

  expect(state.planGoal).toBe(null)
  expect(state.planKept).toBe('ship-oauth-login')
  expect(state.planTree).toEqual(expect.objectContaining({ title: 'Ship OAuth login' }))
  expect(JSON.parse(disk.files.get(lockFile('ship-oauth-login'))!).session).toBe('session-other')
})

test('the poll marks a kept goal whose file is deleted or unreadable, and clears the mark when it reads again', async ($, on) => {
  const { disk, clock, state } = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await start($, on)
  await call($, OAUTH)
  const saved = disk.files.get(file('ship-oauth-login'))!
  await $.session.end({ reason: 'clear', sessionId: ME, resume: { id: ME } })
  expect(state.planKeptIssue ?? null).toBe(null)

  disk.files.delete(file('ship-oauth-login'))
  await clock.advance(5_000)
  expect(state.planKeptIssue).toBe('missing')
  expect(state.planTree).toEqual(expect.objectContaining({ title: 'Ship OAuth login' }))
  expect(state.planError ?? null).toBe(null)

  disk.files.set(file('ship-oauth-login'), '---\ngoal: Ship OAuth login\nnonsense\n')
  await clock.advance(5_000)
  expect(state.planKeptIssue).toBe('unreadable')
  expect(state.planTree).toEqual(expect.objectContaining({ title: 'Ship OAuth login' }))

  disk.files.set(file('ship-oauth-login'), saved)
  await clock.advance(5_000)
  expect(state.planKeptIssue ?? null).toBe(null)
})

test('the poll sets the error of an active goal file it can’t parse', async ($, on) => {
  const { disk, clock, state } = world(on)
  await start($, on)
  await call($, OAUTH)
  disk.files.set(file('ship-oauth-login'), '---\ngoal: Ship OAuth login\nnonsense\n')

  await clock.advance(5_000)

  expect(state.planError).toBe("Can't read .tmp/plan/ship-oauth-login.md: line 3")
})

test('a poll whose git fails leaves the pane as the last poll drew it', async ($, on) => {
  const { disk, clock, state } = world(on)
  await start($, on)
  await call($, OAUTH)
  await clock.advance(5_000)
  const tree = state.planTree
  disk.git = { exitCode: 128, stdout: '' }

  await clock.advance(5_000)

  expect(state.planError ?? null).toBe(null)
  expect(state.planTree).toEqual(tree)
  expect(state.planGoal).toBe('ship-oauth-login')
})

test('after a reload whose first poll loses git, the next poll that finds git heartbeats and redraws', async ($, on) => {
  const { disk, clock, state } = world(on)
  const goal = newGoal('Ship OAuth login', [{ title: 'Spec' }, { title: 'Build' }], ISO)
  disk.files.set(file('ship-oauth-login'), serializeGoal(goal))
  disk.files.set(lockFile('ship-oauth-login'), lock(ME, NOW - 60_000))
  // The goal was active before the reload: the state outlives the module, whose variables start over.
  on('state.get', ($, e, next) =>
    e.key === 'planGoal' && !('planGoal' in state) ? ({ value: { version: 1, value: 'ship-oauth-login' } } as never) : next(e),
  )
  disk.git = { exitCode: 128, stdout: '' }

  await start($, on)

  expect(state.planError ?? null).toBe(null)
  expect(disk.writes.filter(path => path.startsWith('/cwd/'))).toEqual([])

  disk.git = inRepo
  await clock.advance(5_000)

  expect(JSON.parse(disk.files.get(lockFile('ship-oauth-login'))!)).toEqual({ session: ME, heartbeat: new Date(NOW + 5_000).toISOString() })
  expect(state.planTree).toEqual(goal)
  expect(state.planError ?? null).toBe(null)
  expect(state.planGoal ?? 'ship-oauth-login').toBe('ship-oauth-login')
})

test('outside git the poll heartbeats and redraws in the working directory’s .tmp/plan', async ($, on) => {
  const { disk, clock, state } = world(on)
  disk.git = { exitCode: 128, stdout: '' }
  await start($, on)
  await call($, OAUTH)
  disk.files.set('/cwd/.tmp/plan/ship-oauth-login.md', disk.files.get('/cwd/.tmp/plan/ship-oauth-login.md')!.replace('- [ ] 2 Build', '- [ ] 2 Build later'))

  await clock.advance(35_000)

  expect(JSON.parse(disk.files.get('/cwd/.tmp/waffles/locks/ship-oauth-login.json')!)).toEqual({ session: ME, heartbeat: new Date(NOW + 30_000).toISOString() })
  expect((state.planTree as { steps: { title: string }[] }).steps[1]?.title).toBe('Build later')
})

test('outside any repository the first lock writes .tmp/waffles/.gitignore with * first', async ($, on) => {
  const { disk } = world(on)
  disk.git = { exitCode: 128, stdout: '' }

  expect(await call($, OAUTH)).toEqual({ result: expect.stringContaining('◇ new goal: Ship OAuth login') })
  expect(disk.files.get('/cwd/.tmp/waffles/.gitignore')).toBe('*\n')
  expect(disk.writes.indexOf('/cwd/.tmp/waffles/.gitignore')).toBeLessThan(disk.writes.indexOf('/cwd/.tmp/waffles/locks/ship-oauth-login.json'))
})

test('when git fails inside a repository, a call is refused and nothing is written in the working tree', async ($, on) => {
  const { disk, clock, state } = world(on)
  // A worktree's .git is a file, 2 folders above the working directory.
  disk.cwd = '/wt/src/app'
  disk.files.set('/wt/.git', 'gitdir: /repo/.git/worktrees/wt\n')
  disk.git = { exitCode: 128, stdout: '' }
  await start($, on)

  expect(await call($, OAUTH)).toEqual({ deny: 'git did not answer, so the plan outline was not saved. Try again.' })
  await clock.advance(35_000)

  expect(disk.writes).toEqual([])
  expect(state.planGoal ?? null).toBe(null)
})

test('outside git a deleted goal file shows its error at the next poll', async ($, on) => {
  const { disk, clock, state } = world(on)
  disk.git = { exitCode: 128, stdout: '' }
  await start($, on)
  await call($, OAUTH)
  // The folder stays, as on a disk: the fake disk has no empty folders.
  disk.files.set('/cwd/.tmp/plan/.keep', '')
  disk.files.delete('/cwd/.tmp/plan/ship-oauth-login.md')

  await clock.advance(5_000)

  expect(state.planError).toBe('No goal file .tmp/plan/ship-oauth-login.md')
})

test('when git times out, a stray .tmp/plan in the working directory does not replace the known root', async ($, on) => {
  const { disk, clock, state } = world(on)
  await start($, on)
  await call($, OAUTH)
  await clock.advance(5_000)
  const tree = state.planTree
  // The working directory holds its own .tmp/plan with the same goal; git then fails.
  disk.files.set('/cwd/.tmp/plan/ship-oauth-login.md', disk.files.get(file('ship-oauth-login'))!.replace('- [ ] 2 Build', '- [ ] 2 Stray'))
  disk.git = { exitCode: 128, stdout: '' }
  disk.writes.length = 0

  await clock.advance(35_000)

  expect(disk.writes.filter(path => path.startsWith('/cwd/'))).toEqual([])
  expect(state.planTree).toEqual(tree)
})

test('a call runs git once', async ($, on) => {
  const { disk } = world(on)
  await call($, OAUTH)
  disk.ran.length = 0

  await call($, { op: 'add', parent: '1', titles: ['Draft'], focus: true })
  await call($, { op: 'goal', title: 'Fix flaky test' })

  expect(disk.ran.filter(argv => argv.includes('--git-dir'))).toHaveLength(2)
})

test('a new goal whose save fails releases its claim, and the stack goes to the debug log', async ($, on) => {
  const { disk, state } = world(on)
  const logs = debugLog(on)
  // The goal file alone can't be written; its lock can.
  const set = disk.files.set.bind(disk.files)
  disk.files.set = (path: string, text: string) => {
    if (path === file('ship-oauth-login')) throw new Error(`EROFS ${path}`)
    return set(path, text)
  }

  const r = await call($, OAUTH)

  expect(r).toEqual({ deny: expect.stringMatching(/^plan outline failed: .*EROFS/) })
  expect(disk.writes).toContain(lockFile('ship-oauth-login'))
  expect(disk.files.has(lockFile('ship-oauth-login'))).toBe(false)
  expect(state.planGoal).toBeUndefined()
  expect(logs).toEqual([expect.stringMatching(/^plan outline: a call failed: .*EROFS.*\n\s+at /s)])
})

test('scalar fields of the wrong type are refused by name and change nothing', async ($, on) => {
  const { disk } = world(on)
  await call($, OAUTH)
  const before = disk.files.get(file('ship-oauth-login'))

  expect(await call($, { op: 'focus', id: 2 })).toEqual({ deny: 'id must be a string.' })
  expect(await call($, { op: 'add', parent: null, titles: ['Ship'], focus: 'true' })).toEqual({ deny: 'focus must be true or false.' })
  expect(await call($, { op: 'add', parent: 1, titles: ['Ship'] })).toEqual({ deny: 'parent must be a string or null.' })
  expect(await call($, { op: 'move', id: '2', to: 1 })).toEqual({ deny: 'to must be a string or null.' })
  expect(await call($, { op: 'done', ids: ['2'], cascade: 'yes' })).toEqual({ deny: 'cascade must be true or false.' })
  expect(await call($, { op: 'defer', id: '2', backlog: ['.backlog/a.md'] })).toEqual({ deny: 'backlog must be a string.' })
  expect(await call($, { op: 'rename', id: '2', title: 7 })).toEqual({ deny: 'title must be a string.' })
  expect(await call($, { op: 'goal', switch: 3 })).toEqual({ deny: 'switch must be a string.' })
  expect(await call($, { op: 'move', fromGoal: true, to: '2' })).toEqual({ deny: 'fromGoal must be a string.' })
  expect(await call($, { op: 'show', goal: {} })).toEqual({ deny: 'goal must be a string.' })
  expect(disk.files.get(file('ship-oauth-login'))).toBe(before)
})

test('a null in a field that takes no null counts as left out', async ($, on) => {
  const { state } = world(on)

  const r = await call($, { op: 'goal', title: 'Fix flaky test', switch: null, focus: null })

  expect(r).toEqual({ result: '◇ new goal: Fix flaky test [fix-flaky-test]\n\nPath: 1 Fix flaky test' })
  expect(state.planGoal).toBe('fix-flaky-test')
})

test('a null kind or list counts as left out, and a list a call needs is still asked for', async ($, on) => {
  const { disk } = world(on)

  expect(await call($, { op: 'goal', title: 'Ship', steps: null, kind: null, titles: null, ids: null })).toEqual({ result: '◇ new goal: Ship [ship]\n\nPath: 1 Ship' })
  expect(await call($, { op: 'add', parent: null, kind: null, titles: ['Spec'] })).toEqual({ result: '+ 2 Spec\n\nPath: 1 Ship' })
  expect(await call($, { op: 'goal', title: 'Fix', steps: [{ title: 'Repro', kind: null }] })).toEqual({
    result: '◇ new goal: Fix [fix] (Ship [ship] parked at 1 Ship)\n\nPath: 1 Repro',
  })
  expect(parseGoal(disk.files.get(file('fix'))!, 'x').steps[0]).toMatchObject({ title: 'Repro', kind: 'planned' })
  expect(await call($, { op: 'add', parent: null, titles: null })).toEqual({ deny: 'op "add" needs titles.' })
  expect(await call($, { op: 'done', ids: null })).toEqual({ deny: 'op "done" needs ids.' })
})

test('a new goal and a switch draw the new tree before they make it active', async ($, on) => {
  const { disk, sets } = world(on)
  disk.files.set(file('other-work'), serializeGoal(newGoal('Other work', [{ title: 'A' }], ISO)))
  await call($, OAUTH)
  await call($, { op: 'done', ids: ['1', '2'] })
  const order = (from: number) =>
    sets.slice(from).map(([key, value]) => (key === 'planTree' ? `planTree ${(value as { title: string }).title}` : `${key} ${JSON.stringify(value)}`))

  let mark = sets.length
  await call($, { op: 'goal', title: 'Fix flaky test' })
  const started = order(mark)
  mark = sets.length
  await call($, { op: 'goal', switch: 'other-work' })
  const switched = order(mark)

  const isBefore = (list: string[], a: string, b: string) => list.indexOf(a) >= 0 && list.indexOf(a) < list.indexOf(b)
  expect(isBefore(started, 'planKept null', 'planGoal "fix-flaky-test"')).toBe(true)
  expect(isBefore(started, 'planTree Fix flaky test', 'planGoal "fix-flaky-test"')).toBe(true)
  expect(isBefore(switched, 'planTree Other work', 'planGoal "other-work"')).toBe(true)
})

test('a session end doesn’t wait for a poll stuck on git, and the poll writes nothing after it', async ($, on) => {
  const { disk, clock } = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await start($, on)
  await call($, OAUTH)
  let open = () => undefined as void
  disk.gitGate = new Promise<void>(resolve => (open = resolve))
  // The first poll waits on git; when it goes on, the heartbeat is due.
  await clock.advance(30_000)
  disk.writes.length = 0

  // Resolves with git still waiting: an end that waited for the poll would never get here.
  await $.session.end({ reason: 'prompt_input_exit', sessionId: ME, resume: { id: ME } })
  const isReleased = !disk.files.has(lockFile('ship-oauth-login'))
  open()
  // Queued behind the poll, so the poll has finished.
  await call($, { op: 'show' })

  expect(isReleased).toBe(true)
  expect(disk.files.has(lockFile('ship-oauth-login'))).toBe(false)
  expect(disk.writes).toEqual([])
})

test('a typed prompt from the bridge clears the highlighted steps', async ($, on) => {
  const { state } = world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await call($, OAUTH)

  await $.prompt.submit({ origin: { kind: 'bridge' }, wait: false, text: 'Go on' } as never)
  await call($, { op: 'show' })

  expect(state.planChanged).toEqual([])
})

test('the first message carries the mode block, then the plan outline block', async ($, on) => {
  world(on)
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  await call($, OAUTH)

  const { blocks } = await $.prompt.context({ blocks: [{ name: 'currentDate', text: "Today's date is 2026-11-15." }] })

  expect(blocks.map(b => b.name)).toEqual(['currentDate', 'wafflesMode', 'planOutline'])
  expect(blocks[1]?.text).toMatch(/^waffles mode: production/)
  expect(blocks[2]?.text).toMatch(/^plan outline: Ship OAuth login/)
})

test('a plan outline block that fails leaves the mode block, and says why in the debug log', async ($, on) => {
  const { disk } = world(on)
  const logs = debugLog(on)
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('state.get', ($, e, next) => (e.key === 'planGoal' ? { deny: 'state unavailable' } : next(e)) as never)
  disk.files.set(file('a'), serializeGoal(newGoal('Goal A', [{ title: 'Spec' }], ISO)))

  const { blocks } = await $.prompt.context({ blocks: [] })

  expect(blocks.map(b => b.name)).toEqual(['wafflesMode'])
  expect(logs).toEqual([expect.stringMatching(/^plan outline: the first message goes without its plan outline block: .*state unavailable/s)])
})

test('a .tmp/plan that is a file adds no plan outline block', async ($, on) => {
  const { disk } = world(on)
  const outlineBlock = firstMessage(on)
  disk.files.set(ROOT, 'not a folder')

  expect(await outlineBlock($)).toBeUndefined()
})

test('/clear in a repo with no plan outline writes nothing', async ($, on) => {
  const { disk, state } = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))

  await $.session.end({ reason: 'clear', sessionId: ME, resume: { id: ME } })

  expect(disk.writes).toEqual([])
  expect(disk.removed).toEqual([])
  expect(Object.keys(state).filter(key => key.startsWith('plan'))).toEqual([])
})

// Each session's goal is restored once per process, and the module outlives a test: each test of a
// restore runs under an ID of its own.
test('a goal made active is recorded under the session, and the record outlives the session end', async ($, on) => {
  const { disk } = world(on)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await call($, OAUTH)
  await call($, { op: 'goal', title: 'Fix CORS' })

  await $.session.end({ reason: 'prompt_input_exit', sessionId: ME, resume: { id: ME } })

  expect(disk.files.get(recordFile(ME))).toBe(record('fix-cors'))
  expect(disk.files.has(lockFile('fix-cors'))).toBe(false)
})

test('a resumed session makes its recorded goal active again at start, before the first prompt', async ($, on) => {
  const me = 'session-resumed-start'
  const { disk, state } = world(on, me)
  const outlineBlock = firstMessage(on)
  const goal = newGoal('Ship OAuth login', [{ title: 'Spec' }, { title: 'Build' }], ISO)
  disk.files.set(file('ship-oauth-login'), serializeGoal(goal))
  disk.files.set(recordFile(me), record('ship-oauth-login'))

  await start($, on)

  expect(state.planGoal).toBe('ship-oauth-login')
  expect(state.planTree).toEqual(goal)
  expect(state.planKept ?? null).toBe(null)
  expect(JSON.parse(disk.files.get(lockFile('ship-oauth-login'))!).session).toBe(me)
  expect((await outlineBlock($))?.text).toMatch(/^plan outline: Ship OAuth login \(\.tmp\/plan\/ship-oauth-login\.md\)/)
  expect(await call($, { op: 'add', parent: '2', titles: ['Callback route'] })).toEqual({ result: expect.stringContaining('+ 2.1') })
})

test('a call that comes before the first poll of a resumed session finds its goal active', async ($, on) => {
  const me = 'session-resumed-call'
  const { disk, state } = world(on, me)
  disk.files.set(file('ship-oauth-login'), serializeGoal(newGoal('Ship OAuth login', [{ title: 'Spec' }], ISO)))
  disk.files.set(recordFile(me), record('ship-oauth-login'))

  const r = await call($, { op: 'done', ids: ['1'] })

  expect(r).toEqual({ result: expect.stringContaining('✔ 1 Spec') })
  // The goal ended: it is no longer the session's to come back to.
  expect(state.planGoal).toBe(null)
  expect(disk.files.has(recordFile(me))).toBe(false)
})

test('a recorded goal that is done, gone, or held by another live session is not restored, and its record goes', async ($, on) => {
  const cases = [
    ['session-resumed-done', (disk: ReturnType<typeof fakeDisk>) => {
      const done = { ...newGoal('Ship OAuth login', [{ title: 'Spec' }], ISO), status: 'done' as const }
      disk.files.set(file('ship-oauth-login'), serializeGoal(done))
    }],
    ['session-resumed-gone', () => undefined],
    ['session-resumed-held', (disk: ReturnType<typeof fakeDisk>) => {
      disk.files.set(file('ship-oauth-login'), serializeGoal(newGoal('Ship OAuth login', [{ title: 'Spec' }], ISO)))
      disk.files.set(lockFile('ship-oauth-login'), lock('session-other', NOW))
    }],
  ] as const
  let me = ''
  const { disk, state } = world(on, () => me)
  await start($, on)
  for (const [id, seed] of cases) {
    me = id
    seed(disk)
    disk.files.set(recordFile(id), record('ship-oauth-login'))

    await call($, { op: 'show' })

    expect([id, state.planGoal ?? null]).toEqual([id, null])
    expect([id, disk.files.has(recordFile(id))]).toEqual([id, false])
    disk.files.delete(file('ship-oauth-login'))
    disk.files.delete(lockFile('ship-oauth-login'))
  }
})

test('a record whose goal file can’t be read stays for the next process', async ($, on) => {
  const me = 'session-resumed-unreadable'
  const { disk, state } = world(on, me)
  disk.files.set(file('ship-oauth-login'), 'not a goal file')
  disk.files.set(recordFile(me), record('ship-oauth-login'))

  await start($, on)

  expect(state.planGoal ?? null).toBe(null)
  expect(disk.files.get(recordFile(me))).toBe(record('ship-oauth-login'))
})

test('a record that names no slug is removed without reading a file outside .tmp/plan', async ($, on) => {
  const me = 'session-resumed-bad-slug'
  const { disk, state } = world(on, me)
  disk.files.set(recordFile(me), record('../escape'))

  await start($, on)

  expect(state.planGoal ?? null).toBe(null)
  expect(disk.files.has(recordFile(me))).toBe(false)
  expect(disk.reads.filter(path => path.includes('escape'))).toEqual([])
})

test('/resume in a running process restores the resumed session’s goal at the next poll', async ($, on) => {
  let me = 'session-before-resume'
  const { disk, clock, state } = world(on, () => me)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await start($, on)
  await call($, OAUTH)
  disk.files.set(file('fix-cors'), serializeGoal(newGoal('Fix CORS', [{ title: 'Proxy' }], ISO)))
  disk.files.set(recordFile('session-after-resume'), record('fix-cors'))

  await $.session.end({ reason: 'resume', sessionId: me, resume: { id: me } })
  // Written just now: the restore's pruning keeps it.
  disk.files.stamps.set(recordFile('session-before-resume'), NOW)
  me = 'session-after-resume'
  await clock.advance(5_000)

  expect(state.planGoal).toBe('fix-cors')
  expect(state.planKept).toBe(null)
  expect(JSON.parse(disk.files.get(lockFile('fix-cors'))!).session).toBe('session-after-resume')
  // The session left behind keeps its record, for a resume of it.
  expect(disk.files.get(recordFile('session-before-resume'))).toBe(record('ship-oauth-login'))
  expect(disk.files.has(lockFile('ship-oauth-login'))).toBe(false)
})

test('/clear leaves the new conversation with no active goal, and the old session’s record in place', async ($, on) => {
  let me = 'session-before-clear'
  const { disk, clock, state } = world(on, () => me)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await start($, on)
  await call($, OAUTH)

  await $.session.end({ reason: 'clear', sessionId: me, resume: { id: me } })
  // Written just now: the new session's pruning keeps it.
  disk.files.stamps.set(recordFile('session-before-clear'), NOW)
  me = 'session-after-clear'
  await clock.advance(5_000)

  expect(state.planGoal).toBe(null)
  expect(disk.files.get(recordFile('session-before-clear'))).toBe(record('ship-oauth-login'))
})

test('the poll that finds another session’s lock on the active goal removes the session’s record', async ($, on) => {
  const { disk, clock } = world(on)
  await start($, on)
  await call($, OAUTH)
  disk.files.set(lockFile('ship-oauth-login'), lock('session-other', NOW + 20_000))

  await clock.advance(30_000)

  expect(disk.files.has(recordFile(ME))).toBe(false)
})

test('a restore removes other sessions’ records older than 30 days and keeps newer ones', async ($, on) => {
  const me = 'session-resumed-prune'
  const { disk } = world(on, me)
  disk.files.set(file('ship-oauth-login'), serializeGoal(newGoal('Ship OAuth login', [{ title: 'Spec' }], ISO)))
  disk.files.set(recordFile(me), record('ship-oauth-login'))
  disk.files.set(recordFile('session-old'), record('ship-oauth-login'))
  disk.files.stamps.set(recordFile('session-old'), NOW - 31 * 24 * 60 * 60 * 1000)
  disk.files.set(recordFile('session-recent'), record('ship-oauth-login'))
  disk.files.stamps.set(recordFile('session-recent'), NOW - 24 * 60 * 60 * 1000)

  await start($, on)

  expect(disk.files.has(recordFile('session-old'))).toBe(false)
  expect(disk.files.has(recordFile('session-recent'))).toBe(true)
  expect(disk.files.has(recordFile(me))).toBe(true)
})

test('a start with no record of its own still removes other sessions’ old records', async ($, on) => {
  const { disk } = world(on, 'session-fresh-prune')
  disk.files.set(recordFile('session-old'), record('ship-oauth-login'))
  disk.files.stamps.set(recordFile('session-old'), NOW - 31 * 24 * 60 * 60 * 1000)

  await start($, on)

  expect(disk.files.has(recordFile('session-old'))).toBe(false)
})

test('a restore that fails on the disk is tried again by the next poll', async ($, on) => {
  const me = 'session-resumed-retry'
  const { disk, clock, state } = world(on, me)
  disk.files.set(file('ship-oauth-login'), serializeGoal(newGoal('Ship OAuth login', [{ title: 'Spec' }], ISO)))
  disk.files.set(recordFile(me), record('ship-oauth-login'))
  disk.isWriteBroken = true

  await start($, on)
  const before = state.planGoal ?? null
  disk.isWriteBroken = false
  await clock.advance(5_000)

  expect(before).toBe(null)
  expect(state.planGoal).toBe('ship-oauth-login')
})

test('a call whose restore fails on the disk still runs its op', async ($, on) => {
  const me = 'session-resumed-call-fails'
  const { disk } = world(on, me)
  disk.files.set(file('ship-oauth-login'), serializeGoal(newGoal('Ship OAuth login', [{ title: 'Spec' }], ISO)))
  disk.files.set(recordFile(me), record('ship-oauth-login'))
  disk.isWriteBroken = true

  const r = await call($, { op: 'show' })

  expect(r).toEqual({ result: expect.any(String) })
})

test('a first poll whose git fails restores nothing, and the next poll with git restores the goal', async ($, on) => {
  const me = 'session-resumed-git'
  const { disk, clock, state } = world(on, me)
  disk.files.set(file('ship-oauth-login'), serializeGoal(newGoal('Ship OAuth login', [{ title: 'Spec' }], ISO)))
  disk.files.set(recordFile(me), record('ship-oauth-login'))
  disk.git = { exitCode: 128, stdout: '' }

  await start($, on)
  const before = state.planGoal ?? null
  disk.git = inRepo
  await clock.advance(5_000)

  expect(before).toBe(null)
  expect(state.planGoal).toBe('ship-oauth-login')
})

test('a switch records the goal it continues', async ($, on) => {
  const { disk } = world(on)
  await call($, OAUTH)
  await call($, { op: 'goal', title: 'Fix CORS' })

  await call($, { op: 'goal', switch: 'ship-oauth-login' })

  expect(disk.files.get(recordFile(ME))).toBe(record('ship-oauth-login'))
})

test('a session resumed soon after a crash takes back its own live lock', async ($, on) => {
  const me = 'session-resumed-crash'
  const { disk, state } = world(on, me)
  disk.files.set(file('ship-oauth-login'), serializeGoal(newGoal('Ship OAuth login', [{ title: 'Spec' }], ISO)))
  disk.files.set(recordFile(me), record('ship-oauth-login'))
  disk.files.set(lockFile('ship-oauth-login'), lock(me, NOW - 10_000))

  await start($, on)

  expect(state.planGoal).toBe('ship-oauth-login')
  expect(JSON.parse(disk.files.get(lockFile('ship-oauth-login'))!).heartbeat).toBe(ISO)
})

test('a goal another live session holds is not restored by the poll, and the record goes', async ($, on) => {
  const me = 'session-resumed-held-poll'
  const { disk, state } = world(on, me)
  disk.files.set(file('ship-oauth-login'), serializeGoal(newGoal('Ship OAuth login', [{ title: 'Spec' }], ISO)))
  disk.files.set(recordFile(me), record('ship-oauth-login'))
  disk.files.set(lockFile('ship-oauth-login'), lock('session-other', NOW))

  await start($, on)

  expect(state.planGoal ?? null).toBe(null)
  expect(disk.files.has(recordFile(me))).toBe(false)
  expect(JSON.parse(disk.files.get(lockFile('ship-oauth-login'))!).session).toBe('session-other')
})

// A background subagent's start and end as the engine raises them; the test answers both beneath the plugin.
const SPAWN = { prompt: 'Do it', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', fork: false, background: true }
const FINISHED = { answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
function agents(on: On, ids: string[]) {
  const queue = [...ids]
  on('agent.spawn', () => ({ model: 'haiku', agentId: queue.shift() }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
}
const spawn = ($: Engine, input: Record<string, unknown>) => $.agent.spawn({ ...SPAWN, ...input } as never)
const finish = ($: Engine, agentId: string) => $.turn.complete({ ...FINISHED, agentId })

test('a background subagent named by its step marks that step, and its finish leaves the step for review', async ($, on) => {
  const { disk, state } = world(on)
  agents(on, ['agent-1'])
  await call($, OAUTH)

  await spawn($, { description: '2: Build the callback route' })
  // The hooks queue their change behind the calls: a call waits for it.
  expect(await call($, { op: 'show' })).toEqual({ result: '▶ 1 Spec\n▶ 2 Build (subagent)' })

  const running = parseGoal(disk.files.get(file('ship-oauth-login'))!, 'x')
  expect(running.current).toBe('1')
  expect(running.steps[1]).toMatchObject({ state: 'open', agent: 'agent-1' })
  expect(state.planTree).toEqual(running)
  expect(state.planChanged).toContain('2')

  await finish($, 'agent-1')
  expect(await call($, { op: 'show' })).toEqual({ result: '▶ 1 Spec\n◐ 2 Build (subagent finished: review its report)' })

  const review = parseGoal(disk.files.get(file('ship-oauth-login'))!, 'x')
  expect([review.steps[1]!.state, review.steps[1]!.agent]).toEqual(['review', undefined])
})

test('only a background subagent the main thread starts with a step ID and a colon marks a step', async ($, on) => {
  const { disk } = world(on)
  agents(on, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'])
  await call($, OAUTH)
  const before = disk.files.get(file('ship-oauth-login'))

  await spawn($, { description: 'Build the callback route' })
  await spawn($, { description: '2 parallel searches' })
  await spawn($, { description: '9: No such step' })
  await spawn($, { description: '2: Build', background: false })
  await spawn($, { description: '2: Build', parentAgentId: 'a1' })
  await spawn($, { description: '2: Build', isTeammate: true })
  await spawn($, { description: '2: Build', workflow: { runId: 'wf_1', agentIndex: 1 } })
  await spawn($, { description: '2: Build', resume: { agentId: 'a1' } })
  // A main-thread turn, and a subagent no step names.
  await $.turn.complete(FINISHED)
  await finish($, 'a2')
  await call($, { op: 'show' })

  expect(disk.files.get(file('ship-oauth-login'))).toBe(before)
})

test('a subagent that finishes after its session ended changes nothing and claims no lock', async ($, on) => {
  const { disk } = world(on)
  agents(on, ['agent-1'])
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await call($, OAUTH)
  await spawn($, { description: '2: Build' })
  await call($, { op: 'show' })
  const marked = disk.files.get(file('ship-oauth-login'))

  await $.session.end({ reason: 'prompt_input_exit', sessionId: ME, resume: { id: ME } })
  await finish($, 'agent-1')
  await call($, { op: 'show' }).catch(() => undefined)

  expect(disk.files.get(file('ship-oauth-login'))).toBe(marked)
  expect(disk.files.has(lockFile('ship-oauth-login'))).toBe(false)
})

test('a subagent that finishes while another session holds the goal changes nothing', async ($, on) => {
  const { disk } = world(on)
  agents(on, ['agent-1'])
  await call($, OAUTH)
  await spawn($, { description: '2: Build' })
  await call($, { op: 'show' })
  const marked = disk.files.get(file('ship-oauth-login'))
  disk.files.set(lockFile('ship-oauth-login'), lock('session-other', NOW))

  await finish($, 'agent-1')
  await call($, { op: 'show' })

  expect(disk.files.get(file('ship-oauth-login'))).toBe(marked)
})

test('a heartbeat ends the mark of a subagent whose finish was lost', async ($, on) => {
  const { disk, clock, state } = world(on)
  on('agent.list', () => ({ value: [{ id: 'agent-1', status: 'completed', description: '2: Build', type: 'general-purpose' }] }) as never)
  await start($, on)
  await call($, OAUTH)
  // The finish's change never landed: the file still marks the step.
  disk.files.set(file('ship-oauth-login'), serializeGoal({ ...parseGoal(disk.files.get(file('ship-oauth-login'))!, 'x'), steps: [
    { id: '1', title: 'Spec', kind: 'planned', state: 'open', aliases: [], children: [] },
    { id: '2', title: 'Build', kind: 'planned', state: 'open', agent: 'agent-1', aliases: [], children: [] },
  ] }))
  await clock.advance(5_000)

  await clock.advance(30_000)

  expect(parseGoal(disk.files.get(file('ship-oauth-login'))!, 'x').steps[1]!.state).toBe('review')
  expect(state.planChanged).toContain('2')
})

test('a resumed session ends the marks of its subagents that no longer work', async ($, on) => {
  const me = 'session-resumed-sweep'
  const { disk, state } = world(on, me)
  on('agent.list', () => ({ value: [] }) as never)
  disk.files.set(file('ship-oauth-login'), `---
goal: Ship OAuth login
status: open
current: 1
created: ${ISO}
updated: ${ISO}
---
- [ ] 1 Spec
- [ ] 2 Build <!-- agent=agent-old -->
`)
  disk.files.set(recordFile(me), record('ship-oauth-login'))

  await start($, on)

  const goal = parseGoal(disk.files.get(file('ship-oauth-login'))!, 'x')
  expect([goal.steps[1]!.state, goal.steps[1]!.agent]).toEqual(['parked', undefined])
  expect(state.planTree).toEqual(goal)
})

test('continuing a goal ends the marks of its subagents that no longer work', async ($, on) => {
  const { disk } = world(on)
  on('agent.list', () => ({ value: [
    { id: 'agent-done', status: 'completed', description: '1 A', type: 'general-purpose' },
    { id: 'agent-live', status: 'running', description: '3 C', type: 'general-purpose' },
  ] }) as never)
  disk.files.set(file('other-work'), `---
goal: Other work
status: open
current: 4
created: ${ISO}
updated: ${ISO}
---
- [ ] 1 A <!-- agent=agent-done -->
- [ ] 2 B <!-- agent=agent-gone -->
- [ ] 3 C <!-- agent=agent-live -->
- [ ] 4 D
`)

  await call($, { op: 'goal', switch: 'other-work' })

  const goal = parseGoal(disk.files.get(file('other-work'))!, 'x')
  expect(goal.steps.map(s => [s.state, s.agent ?? null])).toEqual([
    ['review', null],
    ['parked', null],
    ['open', 'agent-live'],
    ['open', null],
  ])
})
