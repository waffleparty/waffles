import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Failed, notStarted, run } from './commands.ts'
import { fakeHost } from './testing.ts'

const absent = (program: string) => Object.assign(new Error(`spawn ${program} ENOENT`), { code: 'ENOENT' })

test('a program that is not installed is named as that, with what to install', () => {
  assert.equal(notStarted('gh pr', absent('gh')), 'gh is not installed, or not on the PATH. Install the GitHub CLI (https://cli.github.com) and sign in with `gh auth login`.')
  assert.equal(notStarted('git fetch', absent('git')), 'git is not installed, or not on the PATH. Install git.')
  assert.equal(notStarted('lsof', new Error('lsof: command not found')), 'lsof is not installed, or not on the PATH. Install lsof.')
  assert.equal(notStarted('jq .', absent('jq')), 'jq is not installed, or not on the PATH. Install jq.')
})

test('another reason a command did not start is passed on', () => {
  assert.equal(notStarted('gh pr', new Error('spawn gh EACCES')), 'gh pr could not run: spawn gh EACCES')
})

test('a run of a program that is not installed fails with that message', async () => {
  const $ = fakeHost({ run: () => absent('gh') })
  await assert.rejects(run($, ['gh', 'pr', 'list'], { cwd: '/repo', timeoutMs: 1000, deadline: Number.MAX_SAFE_INTEGER }), (error: unknown) => {
    assert.ok(error instanceof Failed)
    assert.match(error.message, /^gh is not installed, or not on the PATH\. /)
    return true
  })
})
