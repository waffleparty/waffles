import { expect, test } from 'claude-code/testing'

import {
  addSteps,
  closeSteps,
  agentsOf,
  deferStep,
  describe,
  endAgent,
  findStep,
  focusStep,
  markRunning,
  moveGoalInto,
  moveStep,
  newGoal,
  parseGoal,
  pathOf,
  renameStep,
  renderTree,
  serializeGoal,
  shownState,
  slug,
  type Goal,
} from './plan-tree'

const SPEC_EXAMPLE = `---
goal: Ship OAuth login
status: open              # open | done ("in use" and "parked" are session state, not stored here)
current: 3.2.1            # where work resumes when a session continues this goal
created: 2026-11-15T10:02:00Z
updated: 2026-11-15T11:40:12Z
---
- [x] 1 Spec
- [x] 2 Design
  - [x] 2.1 ? Compare PKCE libraries
- [ ] 3 Build
  - [x] 3.1 Provider config
  - [ ] 3.2 Callback route
    - [ ] 3.2.1 ⤷ Fix CORS on dev proxy
- [ ] 4 Ship
- [-] 5 ⤷ Refactor config loader
`

const HEAD = `---
goal: G
status: open
current: null
created: 2026-11-15T10:02:00Z
updated: 2026-11-15T10:02:00Z
---
`

const PLAIN_EXAMPLE = SPEC_EXAMPLE.replace(/ +#.*$/gm, (note) => (note.includes('open | done') || note.includes('where work') ? '' : note))

test('a file without notes round-trips byte for byte', async () => {
  const goal = parseGoal(PLAIN_EXAMPLE, 'x.md')

  expect(PLAIN_EXAMPLE).not.toContain('#')
  expect(serializeGoal(goal)).toBe(PLAIN_EXAMPLE)
  expect(goal.current).toBe('3.2.1')
  expect(goal.steps[2]?.children[1]?.children[0]).toMatchObject({ id: '3.2.1', kind: 'work', title: 'Fix CORS on dev proxy', state: 'open' })
  expect(goal.steps[4]).toMatchObject({ id: '5', state: 'dropped' })
})

test('a file with the old notes parses to the same goal, and is written back without them', async () => {
  const goal = parseGoal(SPEC_EXAMPLE, 'x.md')

  expect(goal).toEqual(parseGoal(PLAIN_EXAMPLE, 'x.md'))
  expect(serializeGoal(goal)).toBe(PLAIN_EXAMPLE)
})

test('parked time, aliases, and a backlog link survive a round trip', async () => {
  const text = `${HEAD}- [ ] 3 Build\n  - [~] 3.4 ? Survey token stores <!-- parked=2026-11-15T11:40:12Z; aliases=1 -->\n- [>] 6 Add retry → .backlog/add-retry.md\n`
  const goal = parseGoal(text, 'x.md')

  expect(goal.current).toBe(null)
  expect(goal.steps[0]?.children[0]).toMatchObject({ state: 'parked', kind: 'research', parkedAt: '2026-11-15T11:40:12Z', aliases: ['1'] })
  expect(goal.steps[1]).toMatchObject({ state: 'deferred', title: 'Add retry', backlog: '.backlog/add-retry.md', aliases: [] })
  expect(serializeGoal(goal)).toBe(text)
})

test('a line that is not a step names its line number', async () => {
  expect(() => parseGoal(`${HEAD}- [x] 1 A\nhello\n`, 'g.md')).toThrow("Can't read g.md: line 9")
})

test('a child indented more than one level under its parent is refused', async () => {
  expect(() => parseGoal(`${HEAD}- [x] 1 A\n    - [x] 1.1 B\n`, 'g.md')).toThrow("Can't read g.md: line 9")
})

test('slugs are lowercase words joined by dashes, and a taken slug gets a number', async () => {
  expect(slug('Ship OAuth login!', [])).toBe('ship-oauth-login')
  expect(slug('Ship OAuth login', ['ship-oauth-login'])).toBe('ship-oauth-login-2')
  expect(slug('???', [])).toBe('goal')
})

test('odd indentation is refused', async () => {
  expect(() => parseGoal(`${HEAD}- [x] 1 A\n - [x] 1.1 B\n`, 'g.md')).toThrow("Can't read g.md: line 9")
})

test('a deferred step without a link is refused', async () => {
  expect(() => parseGoal(`${HEAD}- [>] 1 Later\n`, 'g.md')).toThrow("Can't read g.md: line 8")
})

test('an unknown comment key is refused', async () => {
  expect(() => parseGoal(`${HEAD}- [ ] 1 A <!-- colour=red -->\n`, 'g.md')).toThrow("Can't read g.md: line 8")
})

test('bad front matter is refused', async () => {
  expect(() => parseGoal('- [ ] 1 A\n', 'g.md')).toThrow("Can't read g.md: line 1")
  expect(() => parseGoal(HEAD.replace('status: open', 'status: parked') + '- [ ] 1 A\n', 'g.md')).toThrow("Can't read g.md: line 7")
  expect(() => parseGoal(HEAD.replace('goal: G\n', '') + '- [ ] 1 A\n', 'g.md')).toThrow("Can't read g.md: line 6")
  expect(() => parseGoal('---\ngoal G\n---\n', 'g.md')).toThrow("Can't read g.md: line 2")
  expect(() => parseGoal('---\ngoal: G\n', 'g.md')).toThrow("Can't read g.md")
})

test('a deferred step with a link and a comment on one line reads both', async () => {
  const text = `${HEAD}- [>] 1 Later → .backlog/later.md <!-- aliases=2 -->\n`
  const goal = parseGoal(text, 'x.md')

  expect(goal.steps[0]).toMatchObject({ title: 'Later', backlog: '.backlog/later.md', aliases: ['2'] })
  expect(serializeGoal(goal)).toBe(text)
})

test('a link that contains a comment opener still parses, with the last comment as the comment', async () => {
  const text = `${HEAD}- [>] 1 Later → .backlog/a<!--b.md <!-- parked=2026-11-15T11:40:12Z -->\n- [>] 2 Plain → .backlog/c<!--d.md\n`
  const goal = parseGoal(text, 'x.md')

  expect(goal.steps[0]).toMatchObject({ title: 'Later', backlog: '.backlog/a<!--b.md', parkedAt: '2026-11-15T11:40:12Z' })
  expect(goal.steps[1]).toMatchObject({ title: 'Plain', backlog: '.backlog/c<!--d.md' })
  expect(serializeGoal(goal)).toBe(text)
})

test('a planned step titled with a marker glyph stays planned through a round trip', async () => {
  for (const title of ['? Why', '⤷ Detour', '\\? Literal', '\\\\⤷ Twice']) {
    const goal = newGoal('G', [{ title }, { title, kind: 'research' }, { title, kind: 'work' }], T)
    const back = parseGoal(serializeGoal(goal), 'x.md')

    expect(back.steps.map((s) => [s.kind, s.title])).toEqual([['planned', title], ['research', title], ['work', title]])
  }
  expect(serializeGoal(newGoal('G', [{ title: '? Why' }], T))).toContain('- [ ] 1 \\? Why\n')
  expect(parseGoal(`${HEAD}- [ ] 1 ?Not a marker\n`, 'x.md').steps[0]).toMatchObject({ kind: 'planned', title: '?Not a marker' })
})

test('a planned step titled just a marker glyph stays planned with a note or a backlog link', async () => {
  for (const title of ['?', '⤷', '\\?', '\\\\⤷']) {
    const goal = newGoal('G', [{ title: 'A' }], T)
    goal.steps = [
      { id: '1', title, kind: 'planned', state: 'open', aliases: ['9'], children: [] },
      { id: '2', title, kind: 'planned', state: 'deferred', backlog: '.backlog/x.md', aliases: [], children: [] },
      { id: '3', title, kind: 'planned', state: 'deferred', backlog: '.backlog/y.md', aliases: ['8'], children: [] },
      { id: '4', title, kind: 'planned', state: 'parked', parkedAt: T, aliases: [], children: [] },
      { id: '5', title, kind: 'research', state: 'deferred', backlog: '.backlog/z.md', aliases: ['7'], children: [] },
      { id: '6', title, kind: 'planned', state: 'open', aliases: [], children: [] },
    ]

    expect(parseGoal(serializeGoal(goal), 'x.md')).toEqual(goal)
  }
  const goal = newGoal('G', [{ title: '?' }], T)
  goal.steps[0]!.aliases = ['9']
  expect(serializeGoal(goal)).toContain('- [ ] 1 \\? <!-- aliases=9 -->\n')
})

test('CRLF line endings parse, and the file is written back with LF', async () => {
  const goal = parseGoal(PLAIN_EXAMPLE.replace(/\n/g, '\r\n'), 'x.md')

  expect(goal).toEqual(parseGoal(PLAIN_EXAMPLE, 'x.md'))
  expect(serializeGoal(goal)).toBe(PLAIN_EXAMPLE)
})

test('blank lines between steps are ignored', async () => {
  const goal = parseGoal(`${HEAD}- [ ] 1 A\n\n  - [ ] 1.1 B\n\n- [ ] 2 C\n\n`, 'x.md')

  expect(goal.steps.map((s) => s.id)).toEqual(['1', '2'])
  expect(goal.steps[0]?.children.map((s) => s.id)).toEqual(['1.1'])
})

test('a step ID that does not match its depth or its parent is refused', async () => {
  expect(() => parseGoal(`${HEAD}- [ ] 1.1 A\n`, 'g.md')).toThrow("Can't read g.md: line 8")
  expect(() => parseGoal(`${HEAD}- [ ] 1 A\n  - [ ] 2 B\n`, 'g.md')).toThrow("Can't read g.md: line 9")
  expect(() => parseGoal(`${HEAD}- [ ] 1 A\n  - [ ] 2.1 B\n`, 'g.md')).toThrow("Can't read g.md: line 9")
  expect(() => parseGoal(`${HEAD}- [ ] 1 A\n  - [ ] 1.1 B\n    - [ ] 1.1 C\n`, 'g.md')).toThrow("Can't read g.md: line 10")
})

test('slugs keep Unicode letters and digits', async () => {
  expect(slug('Café Ünï 2', [])).toBe('café-ünï-2')
  expect(slug('Cafe\u0301', [])).toBe('café')
  expect(slug('登录 流程', [])).toBe('登录-流程')
  expect(slug('登录', ['登录'])).toBe('登录-2')
  expect(slug('!!!', [])).toBe('goal')
  expect(slug('Ship OAuth login', [])).toMatch(/^[\p{L}\p{M}\p{N}]+(-[\p{L}\p{M}\p{N}]+)*$/u)
})

test('a long Unicode title gives a slug of at most 100 bytes, cut between characters', async () => {
  const bytes = (text: string) => new TextEncoder().encode(text).length
  const cjk = '登录流程'.repeat(23)
  const cyrillic = 'Вход через OAuth для всех пользователей '.repeat(4)

  for (const title of [cjk, cyrillic, `${'a'.repeat(99)} 登录`]) {
    const base = slug(title, [])
    expect(bytes(base)).toBeLessThanOrEqual(100)
    expect(base).toMatch(/^[\p{L}\p{M}\p{N}]+(-[\p{L}\p{M}\p{N}]+)*$/u)
    expect(title.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').startsWith(base)).toBe(true)
    expect(bytes(`${slug(title, [base])}.json`)).toBeLessThanOrEqual(255)
    expect(slug(title, [base])).toBe(`${base}-2`)
  }
  expect(bytes(cjk)).toBeGreaterThan(255)
  expect(slug(cjk, [])).toBe('登录流程'.repeat(8) + '登')
  // The cut lands after a dash, which goes.
  expect(slug(`${'a'.repeat(99)} 登录`, [])).toBe('a'.repeat(99))
  // A letter and its combining mark stay together.
  expect(slug(`${'a'.repeat(98)}q\u0301`, [])).toBe('a'.repeat(98))
})

test('a goal title with a # in it survives a round trip', async () => {
  const text = HEAD.replace('goal: G', 'goal: Fix bug #12 # now')
  const goal = parseGoal(text, 'x.md')

  expect(goal.title).toBe('Fix bug #12 # now')
  expect(serializeGoal(goal)).toBe(text)
})

const T = '2026-11-16T09:00:00Z'
const LATER = '2026-11-16T10:00:00Z'

const TREE = `---
goal: Ship OAuth login
status: open
current: 3.2.1
created: 2026-11-15T10:02:00Z
updated: 2026-11-15T11:40:12Z
---
- [x] 1 Spec
- [x] 2 Design
  - [x] 2.1 ? Compare PKCE libraries
- [ ] 3 Build
  - [x] 3.1 Provider config
  - [ ] 3.2 Callback route
    - [ ] 3.2.1 ⤷ Fix CORS on dev proxy
  - [ ] 3.3 Token storage
- [ ] 4 Ship
- [-] 5 ⤷ Refactor config loader
`

const tree = (): Goal => parseGoal(TREE, 't.md')
const at = (goal: Goal, id: string) => {
  const found = (function walk(steps: Goal['steps']): Goal['steps'][number] | undefined {
    for (const s of steps) {
      if (s.id === id) return s
      const hit = walk(s.children)
      if (hit) return hit
    }
  })(goal.steps)
  return found!
}

test('a new goal makes its first step current', async () => {
  const goal = newGoal('Ship OAuth login', [{ title: 'Spec' }, { title: 'Design', kind: 'research' }], T)

  expect(goal).toMatchObject({ status: 'open', current: '1', created: T, updated: T })
  expect(goal.steps.map((s) => [s.id, s.kind])).toEqual([['1', 'planned'], ['2', 'research']])
})

test('a goal started with no steps gets one step titled like the goal, and can become done', async () => {
  const goal = newGoal('Empty', [], T)

  expect(goal.steps).toMatchObject([{ id: '1', title: 'Empty', kind: 'planned', state: 'open' }])
  expect(goal.current).toBe('1')
  expect(closeSteps(goal, ['1'], 'done', false, LATER).goal).toMatchObject({ status: 'done', current: null })
})

test('added steps get the next unused number, past dropped steps', async () => {
  const goal = tree()
  const top = addSteps(goal, null, 'planned', ['Launch'], T)
  expect(top.goal.steps[5]?.id).toBe('6')

  const sub = addSteps(goal, '3.2', 'work', ['Fix CORS', 'Fix CSP'], T)
  expect(sub.changes.map(describe)).toEqual(['+ 3.2.2 ⤷ Fix CORS under 3.2', '+ 3.2.3 ⤷ Fix CSP under 3.2'])
  expect(addSteps(goal, null, 'planned', ['Ship'], T).changes.map(describe)).toEqual(['+ 6 Ship'])
  expect(() => addSteps(goal, '9', 'work', ['x'], T)).toThrow('No step 9 in "Ship OAuth login"')
})

test('add with focus makes the first new step current in the same call, parking the old path', async () => {
  const under = addSteps(tree(), '3.2.1', 'work', ['Fix proxy config'], T, { focus: true })
  expect(under.goal.current).toBe('3.2.1.1')
  expect(under.changes.map(describe)).toEqual(['+ 3.2.1.1 ⤷ Fix proxy config under 3.2.1 → current'])

  const away = addSteps(tree(), '4', 'planned', ['Deploy', 'Announce'], T, { focus: true })
  expect(away.goal.current).toBe('4.1')
  for (const id of ['3', '3.2', '3.2.1']) expect(at(away.goal, id)).toMatchObject({ state: 'parked', parkedAt: T })
  expect(away.changes.map(describe)).toEqual([
    '+ 4.1 Deploy under 4 → current',
    '+ 4.2 Announce under 4',
    '⏸ 3 Build',
    '⏸ 3.2 Callback route',
    '⏸ 3.2.1 Fix CORS on dev proxy',
  ])
  // Without focus the current step stays.
  expect(addSteps(tree(), '4', 'planned', ['Deploy'], T).goal.current).toBe('3.2.1')
})

test('rule 1: closing a step with open children is refused and names them', async () => {
  expect(() => closeSteps(tree(), ['3'], 'done', false, T)).toThrow('3 has open steps: 3.2, 3.2.1, 3.3')
})

test('rule 1: with cascade, the step and its open children close', async () => {
  const { goal, changes } = closeSteps(tree(), ['3'], 'done', true, T)

  expect(['3', '3.2', '3.2.1', '3.3'].map((id) => at(goal, id).state)).toEqual(['done', 'done', 'done', 'done'])
  expect(goal.current).toBe('4')
  expect(changes.map(describe)).toEqual(['✔ 3 Build → back to 4 Ship'])
})

test('rule 2: a parent stays open when its last child closes', async () => {
  const { goal } = closeSteps(tree(), ['3.2.1'], 'done', false, T)

  expect(at(goal, '3.2').state).toBe('open')
  expect(at(goal, '3').state).toBe('open')
})

test('rule 3: closing the current step returns to its parent', async () => {
  const { goal, changes } = closeSteps(tree(), ['3.2.1'], 'done', false, T)

  expect(goal.current).toBe('3.2')
  expect(changes.map(describe)).toEqual(['✔ 3.2.1 Fix CORS on dev proxy → back to 3.2 Callback route'])
})

test('rule 3: closing a top-level step goes to the next open top-level step, else the first before it', async () => {
  const mk = (current: string) => ({ ...tree(), current })
  const a = closeSteps(mk('3'), ['3'], 'dropped', true, T).goal
  expect(a.current).toBe('4')

  const b = closeSteps(focusStep(tree(), '4', T).goal, ['4'], 'done', false, T).goal
  expect(b.current).toBe('3.2.1')

  // With no open step after it, and none parked, the first open one before it is next.
  const c = closeSteps({ ...newGoal('G', [{ title: 'A' }, { title: 'B' }, { title: 'C' }], T), current: '3' }, ['3'], 'done', false, T).goal
  expect(c.current).toBe('1')
})

test('rule 3: a closed step that is not on the path leaves the current step alone', async () => {
  const { goal, changes } = closeSteps(tree(), ['4'], 'done', false, T)

  expect(goal.current).toBe('3.2.1')
  expect(changes.map(describe)).toEqual(['✔ 4 Ship'])
})

test('rule 3: several closes run in order and only the last focus move shows a back', async () => {
  const { goal, changes } = closeSteps(tree(), ['3.2.1', '3.2'], 'done', false, T)

  expect(goal.current).toBe('3')
  expect(changes.map(describe)).toEqual(['✔ 3.2.1 Fix CORS on dev proxy', '✔ 3.2 Callback route → back to 3 Build'])
})

test('rule 4: moving focus parks started steps and leaves never-started steps open', async () => {
  const { goal, changes } = focusStep(tree(), '4', T)

  expect(goal.current).toBe('4')
  for (const id of ['3', '3.2', '3.2.1']) expect(at(goal, id)).toMatchObject({ state: 'parked', parkedAt: T })
  expect(at(goal, '3.3').state).toBe('open')
  expect(changes.map(describe)).toEqual([
    '⏸ 3 Build',
    '⏸ 3.2 Callback route',
    '⏸ 3.2.1 Fix CORS on dev proxy',
    '▶ 4 Ship',
  ])
})

test('rule 5: focus lands on the most recently parked step', async () => {
  const away = focusStep(tree(), '4', T).goal
  const { goal, changes } = closeSteps(away, ['4'], 'done', false, T)

  expect(goal.current).toBe('3.2.1')
  expect(changes.map(describe)).toEqual(['✔ 4 Ship → back to 3.2.1 Fix CORS on dev proxy (was parked)'])
  for (const id of ['3', '3.2', '3.2.1']) expect(at(goal, id)).toMatchObject({ state: 'open' })
  expect(at(goal, '3.2.1').parkedAt).toBe(undefined)
  expect(shownState(goal, at(goal, '3.2.1'))).toBe('active')

  const back = focusStep(away, '3', LATER).goal
  expect(back.current).toBe('3.2.1')
})

test('rule 6: closing the last open top-level step makes the goal done', async () => {
  const goal = newGoal('G', [{ title: 'A' }, { title: 'B' }], T)
  const one = closeSteps(goal, ['1'], 'done', false, T)
  expect(one.goal.current).toBe('2')

  const { goal: done, changes } = closeSteps(one.goal, ['2'], 'done', false, T)
  expect(done).toMatchObject({ status: 'done', current: null })
  expect(changes.map(describe)).toEqual(['✔ 2 B', '✔ goal done: G'])
})

test('rule 6: a multi-ID close that ends the goal shows no back', async () => {
  const goal = newGoal('G', [{ title: 'A' }, { title: 'B' }], T)
  const { goal: done, changes } = closeSteps(goal, ['1', '2'], 'done', false, T)

  expect(done.current).toBe(null)
  expect(changes.map(describe)).toEqual(['✔ 1 A', '✔ 2 B', '✔ goal done: G'])
})

test('a missing or closed ID is refused by name', async () => {
  expect(() => focusStep(tree(), '3.9', T)).toThrow('No step 3.9 in "Ship OAuth login"')
  expect(() => focusStep(tree(), '1', T)).toThrow('1 is closed')
  expect(() => closeSteps(tree(), ['1'], 'done', false, T)).toThrow('1 is closed')
  expect(() => renameStep(tree(), '9', 'x', T)).toThrow('No step 9 in "Ship OAuth login"')
})

test('focus on the current step changes nothing and returns a copy', async () => {
  const goal = tree()
  const result = focusStep(goal, '3.2.1', LATER)

  expect(result.changes).toEqual([])
  expect(result.goal).toEqual(goal)
  expect(result.goal).not.toBe(goal)
  expect(result.goal.updated).toBe(goal.updated)
  expect(focusStep(goal, '3.2.1', LATER).goal.steps).not.toBe(goal.steps)
})

test('a closed step is named by its own ID, not the alias it was asked by', async () => {
  const goal = moveStep(tree(), '1', '4', T).goal
  expect(() => focusStep(goal, '1', T)).toThrow('4.1 is closed')
  expect(() => addSteps(goal, '1', 'planned', ['x'], T)).toThrow('4.1 is closed')
})

test('findStep finds a step by its ID or by an alias', async () => {
  const goal = moveStep(tree(), '3.3', '4', T).goal

  expect(findStep(goal, '4.1')?.title).toBe('Token storage')
  expect(findStep(goal, '3.3')?.id).toBe('4.1')
  expect(findStep(goal, '9')).toBeUndefined()
})

test('deferring the current step goes back to its parent', async () => {
  const { goal, changes } = deferStep(tree(), '3.2.1', '.backlog/cors.md', false, T)

  expect(at(goal, '3.2.1')).toMatchObject({ state: 'deferred', backlog: '.backlog/cors.md' })
  expect(goal.current).toBe('3.2')
  expect(changes.map(describe)).toEqual(['↗ 3.2.1 Fix CORS on dev proxy → back to 3.2 Callback route'])
})

test('a cascade defer links every step it closes to the backlog item', async () => {
  const { goal } = deferStep(tree(), '3', '.backlog/build.md', true, T)

  for (const id of ['3', '3.2', '3.2.1', '3.3']) expect(at(goal, id)).toMatchObject({ state: 'deferred', backlog: '.backlog/build.md' })
  expect(at(goal, '3.1')).toMatchObject({ state: 'done' })
  expect(at(goal, '3.1').backlog).toBeUndefined()
})

test('defer closes the step as deferred with its backlog link', async () => {
  const { goal, changes } = deferStep(tree(), '3.3', '.backlog/token-storage.md', false, T)

  expect(at(goal, '3.3')).toMatchObject({ state: 'deferred', backlog: '.backlog/token-storage.md' })
  expect(changes.map(describe)).toEqual(['↗ 3.3 Token storage'])
})

test('rename changes the title', async () => {
  const { goal, changes } = renameStep(tree(), '3.3', 'Token store', T)

  expect(at(goal, '3.3').title).toBe('Token store')
  expect(changes.map(describe)).toEqual(['renamed 3.3 to Token store'])
})

test('describe covers the goal, parked, and moved rows', async () => {
  expect(describe({ type: 'goal', title: 'A', slug: 'a' })).toBe('◇ new goal: A [a]')
  expect(describe({ type: 'goal', title: 'A', slug: 'a', parked: { title: 'B', slug: 'b', at: '2' } })).toBe('◇ new goal: A [a] (B [b] parked at 2)')
  expect(describe({ type: 'moved', from: '1', to: '2', title: 'x' })).toBe('moved 1 → 2')
})

test('shownState marks the path active, and the tree renders with it', async () => {
  const goal = tree()

  expect(pathOf(goal).map((s) => s.id)).toEqual(['3', '3.2', '3.2.1'])
  expect(shownState(goal, at(goal, '3.2'))).toBe('active')
  expect(shownState(goal, at(goal, '4'))).toBe('open')
  expect(shownState(goal, at(goal, '1'))).toBe('done')
  expect(renderTree(goal)).toEqual([
    '✔ 1 Spec',
    '✔ 2 Design',
    '  ✔ 2.1 ? Compare PKCE libraries',
    '▶ 3 Build',
    '  ✔ 3.1 Provider config',
    '  ▶ 3.2 Callback route',
    '    ▶ 3.2.1 ⤷ Fix CORS on dev proxy',
    '  ○ 3.3 Token storage',
    '○ 4 Ship',
    '✗ 5 ⤷ Refactor config loader',
  ])
})

test('operations never change their input', async () => {
  const goal = tree()
  const before = JSON.stringify(goal)

  addSteps(goal, '3', 'work', ['x'], T)
  focusStep(goal, '4', T)
  closeSteps(goal, ['3'], 'done', true, T)
  deferStep(goal, '3.3', 'b', false, T)
  renameStep(goal, '4', 'y', T)

  expect(JSON.stringify(goal)).toBe(before)
  expect(focusStep(goal, '4', T).goal.updated).toBe(T)
})

// Written out: steps can't be added under 5, which is closed.
const withSubtree = (): Goal => parseGoal(`${TREE}  - [ ] 5.1 Sub\n`, 't.md')

test('move renumbers the subtree under the new parent and keeps the old IDs as aliases', async () => {
  const { goal, changes } = moveStep(withSubtree(), '5', '4', T)

  expect(at(goal, '4').children.map((s) => s.id)).toEqual(['4.1'])
  expect(at(goal, '4.1').children.map((s) => s.id)).toEqual(['4.1.1'])
  expect(findStep(goal, '5')?.id).toBe('4.1')
  expect(findStep(goal, '5.1')?.id).toBe('4.1.1')
  expect(goal.steps.map((s) => s.id)).toEqual(['1', '2', '3', '4'])
  expect(goal.updated).toBe(T)
  expect(changes).toEqual([{ type: 'moved', from: '5', to: '4.1', title: 'Refactor config loader' }])
  expect(changes.map(describe)).toEqual(['moved 5 → 4.1'])
})

test('an alias is never handed out again as a new ID', async () => {
  const { goal } = moveStep(withSubtree(), '5', '4', T)

  expect(addSteps(goal, null, 'planned', ['Next'], T).changes.map(describe)).toEqual(['+ 6 Next'])
})

test('moving the current step keeps it current under its new ID', async () => {
  const { goal } = moveStep(tree(), '3.2', null, T)

  expect(goal.steps.map((s) => s.id)).toEqual(['1', '2', '3', '4', '5', '6'])
  expect(goal.current).toBe('6.1')
  expect(findStep(goal, '3.2.1')?.id).toBe('6.1')
  expect(at(goal, '6')).toMatchObject({ aliases: ['3.2'] })
})

test('a step cannot move under itself or its own children', async () => {
  expect(() => moveStep(tree(), '3', '3.2', T)).toThrow("Can't move 3 under 3.2: 3.2 is inside 3")
  expect(() => moveStep(tree(), '3', '3', T)).toThrow("Can't move 3 under 3: 3 is inside 3")
})

test('a step cannot move under a closed step, but a closed step can move', async () => {
  expect(() => moveStep(tree(), '3.3', '1', T)).toThrow("Can't move 3.3 under 1: 1 is closed")
  expect(() => moveStep(tree(), '3.3', '9', T)).toThrow('No step 9 in "Ship OAuth login"')
  expect(moveStep(tree(), '1', '4', T).goal.steps.map((s) => s.id)).toEqual(['2', '3', '4', '5'])
})

test('moving a step to the parent it already has changes nothing', async () => {
  expect(moveStep(tree(), '3.3', '3', T).changes).toEqual([])
  expect(moveStep(tree(), '4', null, T).changes).toEqual([])
})

test('a no-op move returns a copy of the goal, unchanged', async () => {
  const goal = tree()
  const result = moveStep(goal, '3.3', '3', LATER)

  expect(result.goal).toEqual(goal)
  expect(result.goal).not.toBe(goal)
  expect(result.goal.updated).toBe(goal.updated)
})

test('a same-parent move is a no-op even when the parent is closed', async () => {
  const goal = parseGoal(`${TREE}  - [ ] 5.1 Sub\n`, 't.md')
  expect(moveStep(goal, '5.1', '5', T).changes).toEqual([])
})

test('moving the current subtree parks the old ancestors it left, and rule 5 returns there', async () => {
  const { goal, changes } = moveStep(tree(), '3.2.1', '4', T)

  expect(goal.current).toBe('4.1')
  expect(at(goal, '3')).toMatchObject({ state: 'parked', parkedAt: T })
  expect(at(goal, '3.2')).toMatchObject({ state: 'parked', parkedAt: T })
  expect(at(goal, '4')).toMatchObject({ state: 'open' })
  expect(changes.map(describe)).toEqual(['moved 3.2.1 → 4.1', '⏸ 3 Build', '⏸ 3.2 Callback route'])

  const back = closeSteps(goal, ['4'], 'done', true, LATER)
  expect(back.goal.current).toBe('3.2')
})

test('moving a step off the current path parks nothing', async () => {
  const { goal, changes } = moveStep(tree(), '3.3', '4', T)

  expect(at(goal, '3')).toMatchObject({ state: 'open' })
  expect(changes.map(describe)).toEqual(['moved 3.3 → 4.1'])
  expect(goal.current).toBe('3.2.1')
})

test('moving the current subtree to the top level parks its old parent', async () => {
  const { goal, changes } = moveStep(tree(), '3.2', null, T)

  expect(at(goal, '3')).toMatchObject({ state: 'parked', parkedAt: T })
  expect(changes.map(describe)).toEqual(['moved 3.2 → 6', '⏸ 3 Build'])
  expect(goal.current).toBe('6.1')
})

test('aliases a moved step already had are kept, and states are unchanged', async () => {
  const once = moveStep(tree(), '3.2', '4', T).goal
  const twice = moveStep(once, '4.1', null, T).goal

  expect(at(twice, '6').aliases).toEqual(['3.2', '4.1'])
  expect(at(twice, '6.1').aliases).toEqual(['3.2.1', '4.1.1'])
  expect(findStep(twice, '3.2.1')?.id).toBe('6.1')
  expect(at(twice, '6.1').state).toBe('open')
})

test('moving a goal into another puts its top-level steps under the parent with new IDs and no aliases', async () => {
  const source = newGoal('Other', [{ title: 'One' }, { title: 'Two' }], T)
  const target = tree()
  const { goal, changes } = moveGoalInto(source, target, '4', T)

  expect(at(goal, '4').children.map((s) => [s.id, s.title])).toEqual([['4.1', 'One'], ['4.2', 'Two']])
  expect(findStep(goal, '1')?.title).toBe('Spec')
  expect(at(goal, '4.1').aliases).toEqual([])
  expect(goal.current).toBe('3.2.1')
  expect(changes.map(describe)).toEqual(['moved 1 → 4.1', 'moved 2 → 4.2'])
  expect(() => moveGoalInto(source, target, '1', T)).toThrow('1 is closed')
  expect(source.steps.map((s) => s.id)).toEqual(['1', '2'])
})

test('a moved subtree never takes an ID that one of its own aliases names', async () => {
  const away = moveStep(tree(), '3.3', '4', T).goal
  const six = addSteps(away, null, 'planned', ['Six'], T).goal
  const nested = moveStep(six, '4.1', '6', T).goal
  expect(at(nested, '6.1').aliases).toEqual(['3.3', '4.1'])
  const { goal } = moveStep(nested, '6', '3', T)

  expect(at(goal, '3').children.map((s) => s.id)).toEqual(['3.1', '3.2', '3.4'])
  expect(findStep(goal, '3.3')?.id).toBe('3.4.1')
  expect(findStep(goal, '3.3')?.title).toBe('Token storage')
})

test('moving a step out and back never gives it an alias equal to its own ID', async () => {
  const down = moveStep(tree(), '5', '4', T).goal
  const { goal } = moveStep(down, '4.1', null, T)
  const step = goal.steps[goal.steps.length - 1]

  expect(step?.id).toBe('6')
  expect(step?.aliases).toEqual(['5', '4.1'])
  expect(step?.aliases).not.toContain(step?.id)
})

test('a planned step titled with an arrow keeps its whole title; only a deferred step reads a backlog link', async () => {
  const goal = newGoal('G', [{ title: 'Migrate v1 → v2' }], T)
  const deferred = deferStep(addSteps(goal, null, 'planned', ['Move a → b'], T).goal, '2', '.backlog/move.md', false, T).goal
  const back = parseGoal(serializeGoal(deferred), 'x.md')

  expect(back.steps[0]).toMatchObject({ title: 'Migrate v1 → v2', state: 'open' })
  expect(back.steps[0]?.backlog).toBeUndefined()
  expect(back.steps[1]).toMatchObject({ title: 'Move a → b', state: 'deferred', backlog: '.backlog/move.md' })
})

test('a backlog path with whitespace in it is refused', async () => {
  expect(() => deferStep(tree(), '3.3', '.backlog/token storage.md', false, T)).toThrow('A backlog path is one word with no spaces: ".backlog/token storage.md"')
  expect(() => deferStep(tree(), '3.3', '.backlog/a.md\n- [x] 9 Fake', false, T)).toThrow('A backlog path is one word with no spaces')
  expect(() => deferStep(tree(), '3.3', '', false, T)).toThrow('A backlog path is one word with no spaces: ""')
})

test('steps cannot be added under a closed step', async () => {
  expect(() => addSteps(tree(), '1', 'planned', ['More'], T)).toThrow('1 is closed')
})

test('moving a goal with nested steps keeps its tree shape under the new IDs', async () => {
  const source = parseGoal(`${HEAD}- [ ] 1 One\n  - [ ] 1.1 Inner\n    - [ ] 1.1.1 Deep\n- [ ] 2 Two\n`, 's.md')
  const { goal, changes } = moveGoalInto(source, tree(), '4', T)

  expect(at(goal, '4').children.map((s) => s.id)).toEqual(['4.1', '4.2'])
  expect(at(goal, '4.1').children[0]?.children.map((s) => s.id)).toEqual(['4.1.1.1'])
  expect(at(goal, '4.1.1').title).toBe('Inner')
  expect(changes.map(describe)).toEqual(['moved 1 → 4.1', 'moved 2 → 4.2'])
})

test('moving a goal under a parked step leaves that step parked', async () => {
  const away = focusStep(tree(), '4', T).goal
  const source = newGoal('Other', [{ title: 'One' }], T)
  const { goal } = moveGoalInto(source, away, '3', LATER)

  expect(at(goal, '3')).toMatchObject({ state: 'parked', parkedAt: T })
  expect(at(goal, '3.4').title).toBe('One')
  expect(goal.current).toBe('4')
})

test('moving a goal numbers past aliases the target already holds and drops the source aliases', async () => {
  const target = moveStep(tree(), '3.3', '4', T).goal
  const source = parseGoal(`${HEAD}- [ ] 1 One <!-- aliases=9 -->\n`, 's.md')
  const { goal } = moveGoalInto(source, target, '3', LATER)

  // 3.3 is an alias of 4.1, so the next child of 3 is 3.4.
  expect(at(goal, '3').children.map((s) => s.id)).toEqual(['3.1', '3.2', '3.4'])
  expect(at(goal, '3.4').aliases).toEqual([])
})

test('a subagent mark and the review state survive a round trip', async () => {
  const text = `${HEAD}- [ ] 1 A <!-- agent=a1b2 -->\n- [r] 2 B\n- [~] 3 C <!-- parked=${T}; agent=c3 -->\n`
  const goal = parseGoal(text, 'x')

  expect(goal.steps.map(s => [s.state, s.agent])).toEqual([
    ['open', 'a1b2'],
    ['review', undefined],
    ['parked', 'c3'],
  ])
  expect(serializeGoal(goal)).toBe(text)
  expect(agentsOf(goal)).toEqual(['a1b2', 'c3'])
})

test('a step a subagent works on shows running, its parents active, and the tree says so', async () => {
  const goal = markRunning(tree(), '3.3', 'agent-1', LATER)!.goal

  expect(goal.current).toBe('3.2.1')
  expect(shownState(goal, at(goal, '3.3'))).toBe('running')
  expect(shownState(goal, at(goal, '3'))).toBe('active')
  expect(renderTree(goal)).toContain('  ▶ 3.3 Token storage (subagent)')
})

test('focus leaving a step a subagent works on parks neither it nor its parents', async () => {
  const running = markRunning(tree(), '3.2.1', 'agent-1', LATER)!.goal
  const { goal, changes } = focusStep(running, '4', LATER)

  expect(goal.current).toBe('4')
  for (const id of ['3', '3.2', '3.2.1']) expect(at(goal, id).state).toBe('open')
  expect(shownState(goal, at(goal, '3'))).toBe('active')
  expect(shownState(goal, at(goal, '3.2.1'))).toBe('running')
  expect(changes.map(describe)).toEqual(['▶ 4 Ship'])
})

test('marking a parked step keeps its parked time for rule 5, shows it running, and leaves focus where it is', async () => {
  const away = focusStep(tree(), '4', T).goal
  const { goal, changes } = markRunning(away, '3.2', 'agent-1', LATER)!

  expect(goal.current).toBe('4')
  for (const id of ['3', '3.2', '3.2.1']) expect([at(goal, id).state, at(goal, id).parkedAt]).toEqual(['parked', T])
  expect(shownState(goal, at(goal, '3'))).toBe('active')
  expect(shownState(goal, at(goal, '3.2'))).toBe('running')
  expect(changes.map(describe)).toEqual(['▶ 3.2 Callback route (subagent)'])
  // Rule 5 still finds where the main thread stopped.
  expect(closeSteps(goal, ['4'], 'done', false, LATER).goal.current).toBe('3.2.1')
  expect(markRunning(away, '1', 'agent-2', LATER)).toBe(null)
  expect(markRunning(away, '9', 'agent-2', LATER)).toBe(null)
})

test('focus on the current step takes over the report waiting there', async () => {
  const running = markRunning(tree(), '3.2.1', 'agent-1', T)!.goal
  const review = endAgent(running, 'agent-1', 'review', T)!.goal
  expect(shownState(review, at(review, '3.2.1'))).toBe('review')

  const { goal, changes } = focusStep(review, '3.2.1', LATER)

  expect(at(goal, '3.2.1').state).toBe('open')
  expect(shownState(goal, at(goal, '3.2.1'))).toBe('active')
  expect(changes.map(describe)).toEqual(['▶ 3.2.1 Fix CORS on dev proxy'])
})

test('a subagent that stopped unseen leaves a step on the current path open', async () => {
  const running = markRunning(tree(), '3.2.1', 'agent-1', T)!.goal
  const { goal, changes } = endAgent(running, 'agent-1', 'parked', LATER)!

  expect([at(goal, '3.2.1').state, at(goal, '3.2.1').agent]).toEqual(['open', undefined])
  expect(shownState(goal, at(goal, '3.2.1'))).toBe('active')
  expect(changes).toEqual([])
})

test('a finished subagent leaves its step for review, which focus leaving does not park', async () => {
  const running = markRunning(tree(), '3.3', 'agent-1', T)!.goal
  const { goal, changes } = endAgent(running, 'agent-1', 'review', LATER)!

  expect([at(goal, '3.3').state, at(goal, '3.3').agent]).toEqual(['review', undefined])
  expect(shownState(goal, at(goal, '3.3'))).toBe('review')
  expect(renderTree(goal)).toContain('  ◐ 3.3 Token storage (subagent finished: review its report)')
  expect(changes.map(describe)).toEqual(['◐ 3.3 Token storage (subagent finished: review its report)'])

  const away = focusStep(goal, '4', LATER).goal
  expect(at(away, '3.3').state).toBe('review')
  // A step left for review is open: its parent can't close without it.
  expect(() => closeSteps(away, ['3'], 'done', false, LATER)).toThrow('3 has open steps: 3.2, 3.2.1, 3.3')
})

test('focusing a step left for review makes it the main thread’s', async () => {
  const review = endAgent(markRunning(tree(), '3.3', 'agent-1', T)!.goal, 'agent-1', 'review', T)!.goal
  const { goal } = focusStep(review, '3.3', LATER)

  expect(goal.current).toBe('3.3')
  expect(at(goal, '3.3').state).toBe('open')
  expect(shownState(goal, at(goal, '3.3'))).toBe('active')
})

test('a subagent that stopped unseen leaves its step parked, and an unknown one changes nothing', async () => {
  const running = markRunning(tree(), '3.3', 'agent-1', T)!.goal
  const { goal } = endAgent(running, 'agent-1', 'parked', LATER)!

  expect([at(goal, '3.3').state, at(goal, '3.3').parkedAt, at(goal, '3.3').agent]).toEqual(['parked', LATER, undefined])
  expect(endAgent(running, 'agent-9', 'review', LATER)).toBe(null)
})

test('closing a step a subagent works on ends its mark', async () => {
  const running = markRunning(tree(), '3.3', 'agent-1', T)!.goal
  const { goal } = closeSteps(running, ['3.3'], 'done', false, LATER)

  expect([at(goal, '3.3').state, at(goal, '3.3').agent]).toEqual(['done', undefined])
  expect(goal.current).toBe('3.2.1')
  expect(endAgent(goal, 'agent-1', 'review', LATER)).toBe(null)
})
