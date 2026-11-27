import assert from 'node:assert/strict'
import { test } from 'node:test'

import { addSteps, closeSteps, focusStep, markRunning, newGoal, type Goal } from './plan-tree.ts'
import { paneRows, width, type Piece } from './plan-view.ts'

const NOW = '2026-11-15T12:00:00.000Z'
const textOf = (rows: Piece[][]) => rows.map(row => row.map(piece => piece.text).join(''))
const rowsOf = (goal: Goal, collapsed: string[], room = 60) => paneRows(goal, true, false, null, null, [], [], collapsed, room)

// 1 done with 1.1 and 1.2 done; 2 current with 2.1 and 2.2; 3 with 3.1 to 3.5; 4 with no children.
function sample(): Goal {
  let goal = newGoal('Add SSO login', [{ title: 'Research' }, { title: 'Build' }, { title: 'Deploy' }, { title: 'Docs' }], NOW)
  goal = addSteps(goal, '1', 'planned', ['Compare', 'Pick'], NOW).goal
  goal = addSteps(goal, '2', 'planned', ['Parse', 'Validate'], NOW).goal
  goal = addSteps(goal, '3', 'planned', ['Secrets', 'Keys', 'Migrate', 'Smoke', 'Load'], NOW).goal
  return closeSteps(goal, ['1.1', '1.2', '1'], 'done', false, NOW).goal
}

test('a parent row has a dim disclosure glyph before its mark, and a leaf 2 blank columns, so marks line up', () => {
  const rows = rowsOf(sample(), [])
  assert.deepEqual(textOf(rows), [
    'Add SSO login',
    '⌄ ✔ 1 Research',
    '    ✔ 1.1 Compare',
    '    ✔ 1.2 Pick',
    '⌄ ▶ 2 Build',
    '    ○ 2.1 Parse',
    '    ○ 2.2 Validate',
    '⌄ ○ 3 Deploy',
    '    ○ 3.1 Secrets',
    '    ○ 3.2 Keys',
    '    ○ 3.3 Migrate',
    '    ○ 3.4 Smoke',
    '    ○ 3.5 Load',
    '  ○ 4 Docs',
  ])
  // The glyph is a piece of its own, dim, naming the step a press on its row toggles.
  assert.deepEqual(rows[1]?.[0], { text: '⌄ ', isDim: true, toggle: '1' })
  assert.deepEqual(rows[5]?.[0], { text: '    ' })
  assert.deepEqual(rows[13]?.[0], { text: '  ' })
  assert.equal(rows[13]?.some(piece => piece.toggle !== undefined), false)
})

test('a collapsed step draws no children, and its row ends with the dim count of its direct children', () => {
  const rows = rowsOf(sample(), ['1', '3'])
  assert.deepEqual(textOf(rows), ['Add SSO login', '› ✔ 1 Research (2)', '⌄ ▶ 2 Build', '    ○ 2.1 Parse', '    ○ 2.2 Validate', '› ○ 3 Deploy (5)', '  ○ 4 Docs'])
  assert.deepEqual(rows[1]?.[0], { text: '› ', isDim: true, toggle: '1' })
  assert.deepEqual(rows[1]?.at(-1), { text: ' (2)', isDim: true })
  // The marks keep their colors: done green, open amber.
  assert.equal(rows[1]?.[1]?.color, 'success')
  assert.equal(rows[5]?.[1]?.color, 'warning')
})

test('the count is of direct children only, and a nested collapsed step is drawn under an expanded parent', () => {
  let goal = sample()
  goal = addSteps(goal, '3.1', 'planned', ['Vault', 'Env'], NOW).goal
  assert.deepEqual(textOf(rowsOf(goal, ['3'])).at(-2), '› ○ 3 Deploy (5)')
  assert.deepEqual(textOf(rowsOf(goal, ['3.1'])).slice(8, 10), ['  › ○ 3.1 Secrets (2)', '    ○ 3.2 Keys'])
})

test('work in progress under a collapsed step is drawn: the current step, and a subagent’s step', () => {
  const goal = sample()
  // The current step 2 is drawn collapsed; with the current step 2.1 under it, 2 is drawn expanded.
  assert.deepEqual(textOf(rowsOf(goal, ['2']))[4], '› ▶ 2 Build (2)')
  const under = focusStep(goal, '2.1', NOW).goal
  assert.deepEqual(textOf(rowsOf(under, ['2'])).slice(4, 7), ['⌄ ▶ 2 Build', '    ▶ 2.1 Parse', '    ○ 2.2 Validate'])
  const running = markRunning(goal, '3.4', 'agent-1', NOW)!.goal
  assert.ok(textOf(rowsOf(running, ['3'])).includes('    ▶ 3.4 Smoke'))
  // An ID that names no parent changes nothing.
  assert.deepEqual(textOf(rowsOf(goal, ['4', '9'])), textOf(rowsOf(goal, [])))
})

test('a long title is cut to leave room for the gutter and the count, with 1 space before the count', () => {
  let goal = newGoal('Ship', [{ title: 'Deploy the whole thing to staging and then to production' }, { title: 'Docs' }], NOW)
  goal = addSteps(goal, '1', 'planned', ['Add the secrets for every service', 'Run'], NOW).goal
  goal = addSteps(goal, '1.1', 'planned', ['Vault', 'Env', 'Rotate'], NOW).goal
  goal = focusStep(goal, '2', NOW).goal
  for (const room of [20, 24, 30, 40]) {
    const rows = textOf(rowsOf(goal, ['1'], room))
    assert.ok(rows.every(row => width(row) <= room), `${room}: ${rows.join(' | ')}`)
    assert.match(rows[1]!, /^› ⏸\uFE0E 1 Deploy.*… \(2\)$/)
  }
  assert.deepEqual(textOf(rowsOf(goal, ['1'], 24))[1], '› ⏸\uFE0E 1 Deploy the wh… (2)')
  // A nested collapsed row keeps its count too.
  const nested = textOf(rowsOf(goal, ['1.1'], 26))
  assert.deepEqual(nested[2], '  › ○ 1.1 Add the sec… (3)')
  assert.equal(width(nested[2]!), 26)
  // A wide title is cut between its characters, and the count stays.
  const wide = addSteps(newGoal('Ship', [{ title: '日本語のタイトルを長く書く' }], NOW), '1', 'planned', ['A'], NOW).goal
  const row = textOf(rowsOf(focusStep(wide, '1', NOW).goal, ['1'], 20))[1]!
  assert.equal(row, '› ▶ 1 日本語の… (1)')
  assert.ok(width(row) <= 20)
  // With no room for any title, the count still follows the ID after 1 space.
  assert.deepEqual(textOf(rowsOf(goal, ['1'], 10))[1], '› ⏸\uFE0E 1 (2)')
})

test('a title that fits is not cut, and an expanded row has no count', () => {
  let goal = newGoal('Ship', [{ title: 'Deploy' }], NOW)
  goal = addSteps(goal, '1', 'planned', ['Add'], NOW).goal
  assert.deepEqual(textOf(rowsOf(goal, ['1'], 16))[1], '› ▶ 1 Deploy (1)')
  assert.deepEqual(textOf(rowsOf(goal, [], 16))[1], '⌄ ▶ 1 Deploy')
})
