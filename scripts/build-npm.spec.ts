import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renameScripts } from './build-npm.ts'

const COMPILED = new Set(['builders', 'merge-queue', 'watch'])

test('renameScripts names the compiled file of each script that tsc compiled', () => {
  assert.equal(
    renameScripts('Run `node <skill-dir>/../../scripts/builders.ts clone`, then `node <skill-dir>/watch.ts <map> --once`.', COMPILED),
    'Run `node <skill-dir>/../../scripts/builders.js clone`, then `node <skill-dir>/watch.js <map> --once`.',
  )
  assert.equal(renameScripts('merge-queue.ts state, until it ends', COMPILED), 'merge-queue.js state, until it ends')
})

test('renameScripts leaves a .ts name that tsc did not compile', () => {
  assert.equal(renameScripts('Test it in a `core/*.spec.ts` and in plan-store.test.ts.', COMPILED), 'Test it in a `core/*.spec.ts` and in plan-store.test.ts.')
  assert.equal(renameScripts('See tsconfig.ts and builders.tsx.', COMPILED), 'See tsconfig.ts and builders.tsx.')
})
