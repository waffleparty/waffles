import assert from 'node:assert/strict'
import { test } from 'node:test'

import { addSteps, closeSteps, newGoal } from '../../core/plan-tree.ts'
import { footerParts, noticeOf, outlineRows, PIECE_COLORS, pressOf, toggleOf } from './view.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const goal = () => newGoal('Ship it', [{ title: 'Build', kind: 'planned' }, { title: 'Test', kind: 'planned' }], NOW)
const textOf = (rows: { text: string }[][]) => rows.map(row => row.map(piece => piece.text).join(''))

test('with nothing kept, the footer shows production mode and the panel has no rows', () => {
  for (const metadata of [undefined, null, {}, { waffles: 'x' }, { other: 1 }]) {
    assert.deepEqual(footerParts(metadata), { mark: '●', color: '#6495ed', mode: 'production', step: null })
    assert.deepEqual(outlineRows(metadata, 40), [])
  }
})

test('the footer shows the mode with its color, and a run over it', () => {
  assert.deepEqual(footerParts({ waffles: { mode: 'rapid' } }), { mark: '●', color: '#7fff00', mode: 'rapid', step: null })
  assert.deepEqual(footerParts({ waffles: { mode: 'backlog' } }).color, '#a855f7')
  assert.deepEqual(footerParts({ waffles: { mode: 'rapid', run: true } }), { mark: '▶', color: '#f97316', mode: 'non-interactive', step: null })
})

test('the footer names the current step, cut so the whole item fits its row', () => {
  const planTree = newGoal('Ship it', [{ title: 'Build the whole thing from the ground up, twice', kind: 'planned' }], NOW)
  // `● production · ` takes 15 of the 26 columns.
  assert.equal(footerParts({ waffles: { planTree } }).step, '1 Build th…')
  assert.equal(footerParts({ waffles: { mode: 'rapid', planTree } }).step, '1 Build the who…')
  // A run's longer name leaves too little: the step's ID alone.
  assert.equal(footerParts({ waffles: { run: true, planTree } }).step, '1')
  assert.equal(footerParts({ waffles: { planTree } }, 40).step, '1 Build the whole thing…')
  assert.equal(footerParts({ waffles: { planTree: goal() } }).step, '1 Build')
})

test('the panel lists the goal and its steps, with the marks and colors Claude Code uses', () => {
  const planTree = goal()
  const next = closeSteps(addSteps(planTree, '2', 'work', ['Fix'], NOW, { focus: false }).goal, ['1'], 'done', false, NOW).goal
  const rows = outlineRows({ waffles: { planTree: next } }, 40)
  assert.deepEqual(textOf(rows), ['Ship it', '  ✔ 1 Build', '⌄ ▶ 2 Test', '    ○ 2.1 ⤷ Fix'])
  // The done mark is green, the current step cyan, an open step's mark amber; a parent's glyph is dim.
  assert.equal(rows[1]?.[1]?.color, 'success')
  assert.equal(rows[2]?.[0]?.isDim, true)
  assert.equal(rows[2]?.[1]?.color, 'cyan')
  assert.equal(rows[3]?.[1]?.color, 'warning')
  for (const row of rows) for (const piece of row) if (piece.color) assert.ok(PIECE_COLORS[piece.color], piece.color)
})

test('a row is cut to the panel\'s width', () => {
  const planTree = newGoal('Ship it', [{ title: 'Build the whole thing from the ground up, twice', kind: 'planned' }], NOW)
  assert.deepEqual(textOf(outlineRows({ waffles: { planTree } }, 20)), ['Ship it', '  ▶ 1 Build the who…'])
})

test("a command's line shows once, by the time it was left", () => {
  const metadata = { waffles: {}, 'waffles.notice': { text: 'Auto effort: off.', at: 5 } }
  assert.deepEqual(noticeOf(metadata, null), { text: 'Auto effort: off.', at: 5 })
  assert.equal(noticeOf(metadata, 5), null)
  assert.deepEqual(noticeOf(metadata, 4), { text: 'Auto effort: off.', at: 5 })
  for (const other of [undefined, {}, { 'waffles.notice': { text: 1, at: 5 } }, { 'waffles.notice': { text: 'x' } }]) assert.equal(noticeOf(other, null), null)
})

test('a tree that is not a goal draws nothing', () => {
  assert.deepEqual(outlineRows({ waffles: { planTree: { title: 'x' } } }, 40), [])
})

test('the panel draws the collapsed steps the server part keeps, and a parent row names the step a click toggles', () => {
  const planTree = addSteps(addSteps(goal(), '2', 'work', ['Fix', 'Lint'], NOW).goal, '1', 'planned', ['Parse'], NOW).goal
  const rows = outlineRows({ waffles: { planTree, planCollapsed: { goal: 'ship-it', ids: ['2'] } } }, 40)
  assert.deepEqual(textOf(rows), ['Ship it', '⌄ ▶ 1 Build', '    ○ 1.1 Parse', '› ○ 2 Test (2)'])
  assert.deepEqual(rows.map(toggleOf), [undefined, '1', undefined, '2'])
  // The current step's row stays cyan, for the panel's scroll to find.
  assert.ok(rows.some(row => row.some(piece => piece.color === 'cyan')))
  // Collapsed steps that are not a list of IDs are none.
  for (const planCollapsed of [null, {}, { ids: 'x' }, { ids: [2] }]) {
    assert.deepEqual(textOf(outlineRows({ waffles: { planTree, planCollapsed } }, 40)).at(-1), '    ○ 2.2 ⤷ Lint')
  }
})

test('a press names its session and its step, or is no press', () => {
  assert.deepEqual(pressOf({ sessionID: 's1', id: '2' }), { sessionID: 's1', id: '2' })
  for (const input of [undefined, null, {}, { sessionID: 's1' }, { sessionID: 1, id: '2' }]) assert.equal(pressOf(input), null)
})
