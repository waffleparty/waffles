import assert from 'node:assert/strict'
import { test } from 'node:test'

import { remoteName, reviewCap } from './settings.ts'

const host = (env: Record<string, string>) => {
  const logged: string[] = []
  return { env: async (name: string) => env[name], log: (message: string) => void logged.push(message), logged }
}

test('with nothing set, the remote is origin and there is no cap', async () => {
  const $ = host({})
  assert.equal(await remoteName($), 'origin')
  assert.equal(await reviewCap($), null)
  assert.deepEqual($.logged, [])
})

test('the environment names another remote and another cap', async () => {
  const $ = host({ WAFFLES_REMOTE: ' upstream ', WAFFLES_REVIEW_CAP: '25' })
  assert.equal(await remoteName($), 'upstream')
  assert.equal(await reviewCap($), 25)
})

test('a value that cannot be used is logged, and the default holds', async () => {
  const $ = host({ WAFFLES_REMOTE: '--upload-pack=x', WAFFLES_REVIEW_CAP: '0' })
  assert.equal(await remoteName($), 'origin')
  assert.equal(await reviewCap($), null)
  assert.deepEqual($.logged, [
    'WAFFLES_REMOTE is "--upload-pack=x", which names no git remote: origin is used.',
    'WAFFLES_REVIEW_CAP is "0", which is no count from 1 up: no cap is used.',
  ])
})
