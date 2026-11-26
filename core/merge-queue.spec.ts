import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mergeQueue } from './merge-queue.ts'
import { fakeHost, type Answer } from './testing.ts'

// What gh answers for pull request 12 of o/r: `pr view` with the base and review decision, the base branch's
// rules (or a failure), and the GraphQL query's pull request.
type Gh = { base?: string; review?: string; rules?: object[] | Answer; pr?: object }

function gh({ base = 'main', review = '', rules = [], pr = {} }: Gh = {}) {
  return fakeHost({
    cwd: '/repo',
    run: argv => {
      const [command, ...args] = argv
      if (command !== 'gh') return undefined
      if (args[0] === 'pr' && args[1] === 'view') {
        return { stdout: `${JSON.stringify({ number: 12, url: 'https://github.com/o/r/pull/12', baseRefName: base, reviewDecision: review })}\n` }
      }
      if (args[0] === 'api' && args[1] === 'graphql') return { stdout: JSON.stringify({ data: { repository: { pullRequest: pr } } }) }
      if (args[0] === 'api' && args[1]?.includes('/rules/branches/')) return Array.isArray(rules) ? { stdout: JSON.stringify(rules) } : rules
      return undefined
    },
  })
}

const QUEUE = { type: 'merge_queue', parameters: { merge_method: 'SQUASH' } }
const OPEN = { state: 'OPEN', merged: false, isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null, timelineItems: { nodes: [] } }

test('mode: an approved pull request on a branch with a queue is added to the queue', async () => {
  const $ = gh({ base: 'release/1.0', review: 'APPROVED', rules: [{ type: 'pull_request' }, QUEUE] })
  const answer = await mergeQueue($, { op: 'mode', pr: '12' })
  assert.ok('value' in answer)
  assert.deepEqual(answer.value, {
    queue: true,
    base: 'release/1.0',
    approved: true,
    review: 'APPROVED',
    command: 'gh pr merge 12',
    why: 'release/1.0 has a merge queue, and the pull request has a valid approval or needs none: the command adds it to the queue once its checks pass, and the queue merges it later or removes it',
  })
  // gh runs in the session's folder, and the branch is one escaped path segment.
  assert.deepEqual(
    $.ran.map(r => [r.argv.slice(0, 3), r.cwd]),
    [
      [['gh', 'pr', 'view'], '/repo'],
      [['gh', 'api', 'repos/o/r/rules/branches/release%2F1.0'], '/repo'],
    ],
  )
})

test('mode: without an approval the command is the admin bypass, and without a queue a squash', async () => {
  const bypass = await mergeQueue(gh({ review: 'REVIEW_REQUIRED', rules: [{ type: 'merge_queue', parameters: { merge_method: 'REBASE' } }] }), { op: 'mode', pr: '12' })
  assert.ok('value' in bypass)
  assert.equal((bypass.value as { command: string }).command, 'gh pr merge 12 --rebase --admin')
  const squash = await mergeQueue(gh({ rules: [{ type: 'pull_request' }] }), { op: 'mode', pr: '12' })
  assert.ok('value' in squash)
  assert.deepEqual((squash.value as { queue: boolean; command: string }).command, 'gh pr merge 12 --squash --subject <subject> --body <digest>')
})

test("mode: a plan with no rulesets has no queue, and any other failure of gh is a refusal with gh's message", async () => {
  const free = await mergeQueue(gh({ rules: { exitCode: 1, stderr: 'gh: Upgrade to GitHub Pro or make this repository public (HTTP 403)' } }), { op: 'mode', pr: '12' })
  assert.ok('value' in free)
  assert.match((free.value as { why: string }).why, /no rulesets/)
  const down = await mergeQueue(gh({ rules: { exitCode: 1, stderr: 'gh: HTTP 502\n' } }), { op: 'mode', pr: '12' })
  assert.deepEqual(down, { refusal: 'gh api rules/branches/main failed: gh: HTTP 502' })
})

test('a gh that cannot start is a refusal, not a failure of the tool', async () => {
  const $ = fakeHost({ run: () => new Error('spawn gh ENOENT') })
  assert.deepEqual(await mergeQueue($, { op: 'state', pr: '12' }), { refusal: 'gh could not run: spawn gh ENOENT' })
})

test('state: removed with GitHub’s reason, and the query sends owner and name as strings', async () => {
  const removed = { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-23T05:00:00Z', reason: 'The merge commit failed the required check test' }
  const $ = gh({ pr: { ...OPEN, timelineItems: { nodes: [removed] } } })
  assert.deepEqual(await mergeQueue($, { op: 'state', pr: '12', repo: 'o/r' }), {
    value: { state: 'removed', number: 12, reason: 'The merge commit failed the required check test', at: '2026-11-23T05:00:00Z' },
  })
  assert.deepEqual($.ran[0]?.argv.slice(0, 6), ['gh', 'pr', 'view', '12', '-R', 'o/r'])
  assert.deepEqual($.ran[1]?.argv.slice(3, 9), ['-f', 'owner=o', '-f', 'name=r', '-F', 'number=12'])
})

test('state: queued, with its place in the queue', async () => {
  const $ = gh({ pr: { ...OPEN, isInMergeQueue: true, mergeQueueEntry: { state: 'QUEUED', position: 3 } } })
  assert.deepEqual(await mergeQueue($, { op: 'state', pr: '12' }), { value: { state: 'queued', number: 12, position: 3, entry: 'QUEUED' } })
})
