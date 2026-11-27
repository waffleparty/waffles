import assert from 'node:assert/strict'
import { test } from 'node:test'

import { collapsedFor, collapsedOf, currentIds, endTurn, isCollapsed, newIds, reveal, toggle } from './plan-collapse.ts'
import { addSteps, closeSteps, endAgent, findStep, focusStep, markRunning, moveStep, newGoal, type Goal } from './plan-tree.ts'

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

// The 4 turns of the mockups' walkthrough (.backlog/plan-outline-collapse-mockups.html, section 3), each tree
// as the turn leaves it.
function turns() {
  // Turn 1: the prompt starts the goal; 1, 2, 3 and their children are added, and 1.1 started.
  let one = newGoal('Add SSO login', [{ title: 'Research the SSO providers' }, { title: 'Build the callback route' }, { title: 'Deploy to staging' }], NOW)
  one = addSteps(one, '1', 'planned', ['Compare Okta and Auth0', 'Pick a provider'], NOW, { focus: true }).goal
  one = addSteps(one, '2', 'planned', ['Parse the token', 'Validate the state param'], NOW).goal
  one = addSteps(one, '3', 'planned', ['Add the secrets', 'Run the migration'], NOW).goal
  // Turn 2: 1.1 done, 1.2 started.
  let two = closeSteps(one, ['1.1'], 'done', false, NOW).goal
  two = focusStep(two, '1.2', NOW).goal
  // Turn 3: 1.2 done and 1 done; 2.1 started, and a detour 2.1.1 added under it and made current.
  let three = closeSteps(two, ['1.2', '1'], 'done', false, NOW).goal
  three = focusStep(three, '2.1', NOW).goal
  three = addSteps(three, '2.1', 'work', ['Fix CORS on dev proxy'], NOW, { focus: true }).goal
  // Turn 4: 2.1.1 and 2.1 done, 2.2 started, and a background subagent takes 3.1.
  let four = closeSteps(three, ['2.1.1', '2.1'], 'done', false, NOW).goal
  four = focusStep(four, '2.2', NOW).goal
  four = markRunning(four, '3.1', 'agent-1', NOW)!.goal
  return { one, two, three, four }
}

test('the end-of-turn rules give the 4 turns of the mockups', () => {
  const { one, two, three, four } = turns()
  assert.equal(one.current, '1.1')
  assert.equal(three.current, '2.1.1')
  assert.equal(four.current, '2.2')

  // Turn 1: every step is new, so every parent is expanded.
  const after1 = endTurn(null, one, [], newIds(null, one))
  assert.deepEqual(after1, [])
  // Turn 2: 1 has the started step; 2 and 3 are idle, and their steps existed when the turn began.
  const after2 = endTurn(one, two, after1, newIds(one, two))
  assert.deepEqual(after2, ['2', '3'])
  // Turn 3: 1's steps are all done; 2.1 was started under 2, and 2.1.1 is new under 2.1; 3 stays idle.
  assert.deepEqual(newIds(two, three), ['2.1.1'])
  const after3 = endTurn(two, three, after2, newIds(two, three))
  assert.deepEqual(after3, ['1', '3'])
  // Turn 4: 2.1's steps are all done; 2.2 was started under 2, and the subagent's 3.1 under 3.
  const after4 = endTurn(three, four, after3, newIds(three, four))
  assert.deepEqual(after4, ['1', '2.1'])
})

test('steps added and all closed in the same turn: all closed wins, and the parent collapses', () => {
  const before = newGoal('Ship', [{ title: 'Build' }, { title: 'Test' }], NOW)
  let after = addSteps(before, '2', 'planned', ['Unit', 'Lint'], NOW).goal
  after = closeSteps(after, ['2.1', '2.2'], 'done', false, NOW).goal
  assert.deepEqual(newIds(before, after), ['2.1', '2.2'])
  assert.deepEqual(endTurn(before, after, [], newIds(before, after)), ['2'])
})

test('a parent with an active step that was not started this turn keeps its state', () => {
  let goal = newGoal('Ship', [{ title: 'Build' }, { title: 'Test' }], NOW)
  goal = addSteps(goal, '1', 'planned', ['Parse', 'Lint'], NOW, { focus: true }).goal
  goal = addSteps(goal, '2', 'planned', ['Unit'], NOW).goal
  // 1.1 was current when the turn began and still is: 1 stays as it was. 2 is idle and old.
  assert.deepEqual(endTurn(goal, goal, [], []), ['2'])
})

test('active work is always visible: the rules and a press never hide it', () => {
  let goal = newGoal('Ship', [{ title: 'Build' }, { title: 'Test' }], NOW)
  goal = addSteps(goal, '1', 'planned', ['Parse'], NOW).goal
  goal = addSteps(goal, '1.1', 'planned', ['Token'], NOW, { focus: true }).goal
  goal = addSteps(goal, '2', 'planned', ['Unit', 'Lint'], NOW).goal
  // 1 and 1.1 collapsed by hand, the current step 1.1.1 under them: a turn that changes nothing keeps
  // them by the last rule, and the reveal expands them.
  assert.deepEqual(endTurn(goal, goal, ['1', '1.1'], []), ['2'])
  assert.deepEqual(reveal(goal, ['1', '1.1', '2']), ['2'])
  // A press that would hide the current step changes nothing; one on an idle parent toggles it.
  assert.deepEqual(toggle(goal, [], '1'), [])
  assert.deepEqual(toggle(goal, [], '2'), ['2'])
  assert.deepEqual(toggle(goal, ['2'], '2'), [])
  // A step with no children, or no step, has no state to toggle.
  assert.deepEqual(toggle(goal, ['2'], '2.1'), ['2'])
  assert.deepEqual(toggle(goal, ['2'], '9'), ['2'])
  // A subagent's step, and a step whose report waits for review, are shown too.
  const running = markRunning(goal, '2.1', 'agent-1', NOW)!.goal
  assert.deepEqual(reveal(running, ['2']), [])
  const review = endAgent(running, 'agent-1', 'review', NOW)!.goal
  assert.deepEqual(reveal(review, ['2']), [])
  // A parked step is not active work: it may be hidden.
  const parked = endAgent(running, 'agent-1', 'parked', NOW)!.goal
  assert.deepEqual(reveal(parked, ['2']), ['2'])
})

test('a moved step is no new step, and keeps its collapsed state under its new ID', () => {
  let before = newGoal('Ship', [{ title: 'Build' }, { title: 'Test' }, { title: 'Docs' }], NOW)
  before = addSteps(before, '2', 'planned', ['Unit', 'Lint'], NOW).goal
  const after = moveStep(before, '2', '3', NOW).goal
  assert.deepEqual(newIds(before, after), [])
  // 3.1 (was 2) collapsed by hand stays collapsed: its steps are idle and old. So is 3.1 under 3: a
  // moved step was there when the turn began, so 3 collapses as idle and old.
  assert.deepEqual(endTurn(before, after, ['2'], []), ['3', '3.1'])
})

test('at a stop with no turn of the person’s open, only the rules that expand run', () => {
  let before = newGoal('Ship', [{ title: 'Build' }, { title: 'Test' }, { title: 'Docs' }], NOW)
  before = addSteps(before, '2', 'planned', ['Unit'], NOW).goal
  before = addSteps(before, '3', 'planned', ['Guide'], NOW).goal
  // 2 collapsed by the last turn's end; a notification's turn adds 2.2 and closes 3.1, and 1 has none.
  let after = addSteps(before, '2', 'planned', ['Lint'], NOW).goal
  after = closeSteps(after, ['3.1'], 'done', false, NOW).goal
  assert.deepEqual(endTurn(before, after, ['2'], newIds(before, after), { isExpandOnly: true }), [])
  // 3 is all closed and 2 idle: neither collapses at such a stop, and a collapsed one stays so.
  assert.deepEqual(endTurn(after, after, [], [], { isExpandOnly: true }), [])
  assert.deepEqual(endTurn(after, after, ['3'], [], { isExpandOnly: true }), ['3'])
  // At the person's turn's end they do.
  assert.deepEqual(endTurn(after, after, [], []), ['2', '3'])
})

test('a step pressed during the turn keeps the state the press gave it at that turn’s end', () => {
  let before = newGoal('Ship', [{ title: 'Build' }, { title: 'Test' }, { title: 'Docs' }], NOW)
  before = addSteps(before, '2', 'planned', ['Unit'], NOW).goal
  before = addSteps(before, '3', 'planned', ['Guide'], NOW).goal
  const after = addSteps(before, '2', 'planned', ['Lint'], NOW).goal
  // 2 gets a new step and 3 is idle: the rules expand 2 and collapse 3.
  assert.deepEqual(endTurn(before, after, ['2'], ['2.2']), ['3'])
  // Pressed during the turn, 2 stays collapsed and 3 expanded.
  assert.deepEqual(endTurn(before, after, ['2'], ['2.2'], { held: ['2', '3'] }), ['2'])
})
