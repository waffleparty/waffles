import assert from 'node:assert/strict'
import { test } from 'node:test'

import { addSteps, closeSteps, newGoal } from '../../core/plan-tree.ts'
import { footerParts, outlineLines } from './view.ts'

const NOW = '2026-01-01T00:00:00.000Z'
const goal = () => newGoal('Ship it', [{ title: 'Build', kind: 'planned' }, { title: 'Test', kind: 'planned' }], NOW)

test('with nothing kept, the footer shows production mode and the sidebar is empty', () => {
  for (const metadata of [undefined, null, {}, { waffles: 'x' }, { other: 1 }]) {
    assert.deepEqual(footerParts(metadata), { mark: '●', mode: 'production', step: null })
    assert.deepEqual(outlineLines(metadata), [])
  }
})

test('the footer shows the mode, and a run over it', () => {
  assert.deepEqual(footerParts({ waffles: { mode: 'rapid' } }), { mark: '●', mode: 'rapid', step: null })
  assert.deepEqual(footerParts({ waffles: { mode: 'rapid', run: true } }), { mark: '▶', mode: 'non-interactive', step: null })
})

test('with a goal drawn, the footer names its current step and the sidebar lists its tree', () => {
  const planTree = goal()
  assert.equal(footerParts({ waffles: { mode: 'production', planTree } }).step, '1 Build')
  assert.deepEqual(outlineLines({ waffles: { planTree } }), ['Ship it', '▶ 1 Build', '○ 2 Test'])
  const next = closeSteps(addSteps(planTree, '2', 'work', ['Fix'], NOW, { focus: false }).goal, ['1'], 'done', false, NOW).goal
  assert.equal(footerParts({ waffles: { planTree: next } }).step, '2 Test')
  assert.deepEqual(outlineLines({ waffles: { planTree: next } }), ['Ship it', '✔ 1 Build', '▶ 2 Test', '  ○ 2.1 ⤷ Fix'])
})

test('a tree that is not a goal draws nothing', () => {
  assert.deepEqual(outlineLines({ waffles: { planTree: { title: 'x' } } }), [])
})
