import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { defer, takeDeferred } from './cli.ts'

test('events that end at the same time deliver waiting context once', async () => {
  const state = await fs.mkdtemp(join(tmpdir(), 'waffles-cli-'))
  await defer(state, 'conv-456', ['waffles mode: rapid.', 'waffles checkpoint: pushed'])
  // A block added twice is taken once.
  await defer(state, 'conv-456', ['waffles checkpoint: pushed'])
  const taken = await Promise.all(Array.from({ length: 8 }, () => takeDeferred(state, 'conv-456')))
  assert.deepEqual(
    taken.filter(blocks => blocks.length > 0),
    [['waffles mode: rapid.', 'waffles checkpoint: pushed']],
  )
  assert.deepEqual(await takeDeferred(state, 'conv-456'), [])
})

test('events that defer at the same time lose no block', async () => {
  const state = await fs.mkdtemp(join(tmpdir(), 'waffles-cli-'))
  const blocks = Array.from({ length: 40 }, (_, i) => `block ${i}`)
  await Promise.all(blocks.map(block => defer(state, 'conv-456', [block])))
  assert.deepEqual((await takeDeferred(state, 'conv-456')).sort(), [...blocks].sort())
})

test('a take during defers delivers each block once', async () => {
  const state = await fs.mkdtemp(join(tmpdir(), 'waffles-cli-'))
  const blocks = Array.from({ length: 40 }, (_, i) => `block ${i}`)
  const taken: string[][] = []
  await Promise.all(
    blocks.map(async (block, i) => {
      await defer(state, 'conv-456', [block])
      if (i % 5 === 0) taken.push(await takeDeferred(state, 'conv-456'))
    }),
  )
  taken.push(await takeDeferred(state, 'conv-456'))
  assert.deepEqual(taken.flat().sort(), [...blocks].sort())
  assert.ok(taken.filter(blocks => blocks.length > 0).length > 1)
})
