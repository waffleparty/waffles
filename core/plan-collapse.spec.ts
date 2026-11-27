import assert from 'node:assert/strict'
import { test } from 'node:test'

import { collapsedFor, collapsedOf, currentIds, isCollapsed } from './plan-collapse.ts'
import { addSteps, findStep, moveStep, newGoal, type Goal } from './plan-tree.ts'

const NOW = '2026-11-15T12:00:00.000Z'

// 1 with 1.1 and 1.2, 2 with 2.1, and 3 with no children.
function sample(): Goal {
  let goal = newGoal('Ship', [{ title: 'Research' }, { title: 'Build' }, { title: 'Deploy' }], NOW)
  goal = addSteps(goal, '1', 'planned', ['Compare', 'Pick'], NOW).goal
  return addSteps(goal, '2', 'planned', ['Parse'], NOW).goal
}

test('a step is collapsed when its ID is listed; an ID not listed is expanded', () => {
  const goal = sample()
  assert.equal(isCollapsed(findStep(goal, '1')!, ['1']), true)
  assert.equal(isCollapsed(findStep(goal, '2')!, ['1']), false)
  assert.equal(isCollapsed(findStep(goal, '2')!, []), false)
})

test('a moved step keeps its state under its new ID: its old ID is its alias', () => {
  const moved = moveStep(sample(), '2', '1', NOW).goal
  const step = findStep(moved, '1.3')!
  assert.deepEqual(step.aliases, ['2'])
  assert.equal(isCollapsed(step, ['2']), true)
  assert.deepEqual(currentIds(moved, ['2']), ['1.3'])
})

test('the kept IDs are the steps’ IDs now, without IDs of no step or of a step with no children', () => {
  const goal = sample()
  assert.deepEqual(currentIds(goal, ['1', '9', '3', '1.1', '1']), ['1'])
  assert.deepEqual(currentIds(goal, []), [])
})

test('the collapsed steps kept for another goal are none for this one', () => {
  assert.deepEqual(collapsedFor({ goal: 'ship', ids: ['1'] }, 'ship'), ['1'])
  assert.deepEqual(collapsedFor({ goal: 'other', ids: ['1'] }, 'ship'), [])
  assert.deepEqual(collapsedFor(null, 'ship'), [])
  assert.deepEqual(collapsedFor({ goal: 'ship', ids: ['1'] }, null), [])
  assert.deepEqual(collapsedOf('ship', ['1']), { goal: 'ship', ids: ['1'] })
  assert.equal(collapsedOf('ship', []), null)
})
