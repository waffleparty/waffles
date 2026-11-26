// Tests for merge-queue.ts, with a stub gh. Run: node --test "scripts/*.spec.ts"

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { main } from './merge-queue.ts'

// `gh pr view` answers pull request 12 of o/r on base "main", with the state's "review" as its review decision; `gh api repos/…/rules/branches/main` the state's
// "rules" (or the free plan's 403 with "no_rulesets"); `gh api graphql` the state's "pr".
const GH = `#!/usr/bin/env node
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(process.env.GH_STUB_STATE, 'utf8'))
const args = process.argv.slice(2)
fs.appendFileSync(process.env.GH_STUB_STATE + '.calls', JSON.stringify(args) + '\\n')
if (args[0] === 'pr' && args[1] === 'view') {
  console.log(JSON.stringify({ number: 12, url: 'https://github.com/o/r/pull/12', baseRefName: state.base ?? 'main', reviewDecision: state.review ?? '' }))
} else if (args[0] === 'api' && args[1] === 'graphql') {
  console.log(JSON.stringify({ data: { repository: { pullRequest: state.pr } } }))
} else if (args[0] === 'api' && args[1].includes('/rules/branches/')) {
  if (state.no_rulesets) {
    console.log('{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.","status":"403"}')
    console.error('gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)')
    process.exit(1)
  }
  if (state.down) {
    console.error('gh: HTTP 502')
    process.exit(1)
  }
  console.log(JSON.stringify(state.rules))
} else {
  process.exit(2)
}
`

type Pr = { merged?: boolean; queued?: object | null; auto?: boolean; last?: object | null; closed?: boolean }

function pr({ merged = false, queued = null, auto = false, last = null, closed = false }: Pr = {}) {
  return {
    state: merged ? 'MERGED' : closed ? 'CLOSED' : 'OPEN',
    merged,
    isInMergeQueue: queued !== null,
    mergeQueueEntry: queued,
    autoMergeRequest: auto ? { enabledAt: '2026-11-23T04:00:00Z' } : null,
    timelineItems: { nodes: last ? [last] : [] },
  }
}

const REMOVED = { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-23T05:00:00Z', reason: 'The merge commit failed the required check test' }

describe('merge_queue', () => {
  let tmp: string
  let statePath: string
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'merge-queue-'))
    const bin = join(tmp, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'gh'), GH)
    chmodSync(join(bin, 'gh'), 0o755)
    statePath = join(tmp, 'gh.json')
    saved = { PATH: process.env.PATH, GH_STUB_STATE: process.env.GH_STUB_STATE }
    process.env.PATH = bin + delimiter + process.env.PATH
    process.env.GH_STUB_STATE = statePath
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(tmp, { recursive: true, force: true })
  })

  const write = (state: object) => writeFileSync(statePath, JSON.stringify(state))

  // The parsed JSON when the script printed it, else its text.
  const runScript = (...args: string[]): [number, any] => {
    let text = ''
    const code = main(args, { write: (s: string) => (text += s) })
    return [code, code === 0 ? JSON.parse(text) : text]
  }

  const calls = (): string[][] => readFileSync(`${statePath}.calls`, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))

  test('with a merge queue, an approved pull request is added to the queue', () => {
    write({ rules: [{ type: 'pull_request' }, { type: 'merge_queue', parameters: { merge_method: 'SQUASH' } }], base: 'release/1.0', review: 'APPROVED' })
    const [code, result] = runScript('mode', '12')
    assert.equal(code, 0)
    // No merge method and no --auto: the queue's own method applies, and the repo may not allow auto-merge.
    assert.deepEqual([result.queue, result.approved, result.command], [true, true, 'gh pr merge 12'])
    const [view, rules] = calls()
    assert.ok(view[view.indexOf('--json') + 1].includes('reviewDecision'))
    assert.deepEqual(rules, ['api', 'repos/o/r/rules/branches/release%2F1.0'])
    // No review required: GitHub adds it too.
    write({ rules: [{ type: 'merge_queue', parameters: { merge_method: 'SQUASH' } }], review: '' })
    assert.equal(runScript('mode', '12')[1].command, 'gh pr merge 12')
  })

  test('with a merge queue, a pull request without an approval gets the admin bypass', () => {
    const cases: [string, string | null, string][] = [
      ['REVIEW_REQUIRED', 'SQUASH', 'gh pr merge 12 --squash --admin --subject <subject> --body <digest>'],
      ['CHANGES_REQUESTED', 'MERGE', 'gh pr merge 12 --merge --admin --subject <subject> --body <digest>'],
      ['REVIEW_REQUIRED', 'REBASE', 'gh pr merge 12 --rebase --admin'],
      ['REVIEW_REQUIRED', null, 'gh pr merge 12 --squash --admin --subject <subject> --body <digest>'],
    ]
    for (const [review, method, command] of cases) {
      write({ rules: [{ type: 'merge_queue', parameters: method ? { merge_method: method } : {} }], review })
      const [code, result] = runScript('mode', '12')
      assert.equal(code, 0)
      assert.deepEqual([result.queue, result.approved, result.review, result.command], [true, false, review, command])
      assert.ok(result.why.includes('leave it for a reviewer'))
    }
  })

  test('without a queue, merge is a squash now', () => {
    write({ rules: [{ type: 'pull_request' }] })
    let [code, result] = runScript('mode', 'https://github.com/o/r/pull/12')
    assert.deepEqual([code, result.queue], [0, false])
    assert.equal(result.command, 'gh pr merge 12 --squash --subject <subject> --body <digest>')
    write({ no_rulesets: true })
    ;[code, result] = runScript('mode', '12')
    assert.deepEqual([code, result.queue], [0, false])
    assert.ok(result.why.includes('no rulesets'))
  })

  test('when gh cannot read the rules, the reason says so', () => {
    write({ down: true })
    const [code, text] = runScript('mode', '12')
    assert.equal(code, 1)
    assert.ok(text.includes('HTTP 502'))
  })

  test("a pull request the queue removed is removed, with GitHub's reason", () => {
    write({ pr: pr({ last: REMOVED }) })
    const [code, result] = runScript('state', '12')
    assert.equal(code, 0)
    assert.deepEqual(result, { state: 'removed', number: 12, reason: 'The merge commit failed the required check test', at: '2026-11-23T05:00:00Z' })
  })

  test('merged, queued, waiting, closed, and open', () => {
    const cases: [object, string][] = [
      [pr({ merged: true, last: { __typename: 'AddedToMergeQueueEvent', createdAt: 'x' } }), 'merged'],
      [pr({ queued: { state: 'AWAITING_CHECKS', position: 2 } }), 'queued'],
      [pr({ auto: true }), 'waiting'],
      // Added again after a removal: auto-merge is on, so it waits again.
      [pr({ auto: true, last: REMOVED }), 'waiting'],
      [pr({ closed: true, last: REMOVED }), 'closed'],
      [pr(), 'open'],
    ]
    for (const [data, expected] of cases) {
      write({ pr: data })
      const [code, result] = runScript('state', '12')
      assert.deepEqual([code, result.state], [0, expected], JSON.stringify(data))
    }
    write({ pr: pr({ queued: { state: 'QUEUED', position: 3 } }) })
    assert.deepEqual(runScript('state', '12')[1], { state: 'queued', number: 12, position: 3, entry: 'QUEUED' })
    const graphql = calls().filter((call) => call.includes('graphql')).at(-1) as string[]
    // Owner and name go as strings (-f), so an all-digit name is not sent as a number; the number as -F.
    assert.deepEqual(graphql.slice(2, 8), ['-f', 'owner=o', '-f', 'name=r', '-F', 'number=12'])
  })
})
