import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { defer, takeDeferred } from './cli.ts'

test('events that end at the same time deliver waiting context once', async () => {
  const state = await fs.mkdtemp(join(tmpdir(), 'waffles-cli-'))
  await defer(state, 'conv-456', ['waffles mode: rapid.', 'waffles checkpoint: pushed'])
  // A block already waiting isn't added twice.
  await defer(state, 'conv-456', ['waffles checkpoint: pushed'])
  const taken = await Promise.all(Array.from({ length: 8 }, () => takeDeferred(state, 'conv-456')))
  assert.deepEqual(
    taken.filter(blocks => blocks.length > 0),
    [['waffles mode: rapid.', 'waffles checkpoint: pushed']],
  )
  assert.deepEqual(await takeDeferred(state, 'conv-456'), [])
})
