import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { nodeHost } from '../adapters/node/host.ts'
import { chooseLevel, lowestLevel, nearestLevel } from './effort.ts'

const NAMES = { assistant: 'The agent', product: 'Test', planTool: 'plan', ask: 'ask', planMode: null }

// A host whose small model answers `answer`, and records each question it gets.
async function hostAnswering(answer: string | null) {
  const folder = await fs.mkdtemp(join(tmpdir(), 'waffles-effort-'))
  const asked: string[] = []
  const $ = nodeHost({
    sessionId: 's1',
    cwd: folder,
    names: NAMES,
    stateFolder: folder,
    parts: { model: { ask: async prompt => (asked.push(prompt), answer) }, conversation: { lastReply: async () => 'I renamed it.', note: async () => false } },
  })
  return { $, asked }
}

test('a level falls back to the nearest level a model offers, never to none', () => {
  const all = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
  assert.equal(nearestLevel('high', all), 'high')
  // Claude Sonnet 4.6 has no xhigh: the next level up.
  assert.equal(nearestLevel('xhigh', ['none', 'low', 'medium', 'high', 'max']), 'max')
  // Claude Haiku 4.5 offers none, high and max.
  assert.equal(nearestLevel('low', ['none', 'high', 'max']), 'high')
  // GPT-5.5 Pro starts at medium; a model that stops at high takes high for xhigh.
  assert.equal(nearestLevel('low', ['medium', 'high', 'xhigh']), 'medium')
  assert.equal(nearestLevel('xhigh', ['minimal', 'low', 'high']), 'high')
  assert.equal(nearestLevel('medium', ['none']), null)
  assert.equal(nearestLevel('medium', []), null)
  assert.equal(nearestLevel('medium', ['fast', 'review']), null)
})

test('the lowest level a model offers is the quickest to answer', () => {
  assert.equal(lowestLevel(['low', 'none', 'high']), 'none')
  assert.equal(lowestLevel(['medium', 'high']), 'medium')
  assert.equal(lowestLevel(['review']), null)
  assert.equal(lowestLevel([]), null)
})

test("the model's pick sets the level, and keep repeats the last turn's", async () => {
  const pick = async (answer: string | null, setting = 'default', last = 'medium') => chooseLevel((await hostAnswering(answer)).$, 'fix it', setting, last)
  assert.equal(await pick('{"level": "high", "why": "unknown cause"}'), 'high')
  assert.equal(await pick('{"level": "keep", "why": "approval"}', 'default', 'xhigh'), 'xhigh')
  // A pick that is the setting already, or names no level, runs at the setting.
  assert.equal(await pick('{"level": "low", "why": "lookup"}', 'low'), null)
  assert.equal(await pick('{"level": "keep", "why": "approval"}', 'default', 'default'), null)
  assert.equal(await pick('{"level": "huge"}'), null)
  assert.equal(await pick(null), null)
})

test('the small model reads the prompt, the setting, and the last reply', async () => {
  const { $, asked } = await hostAnswering('{"level": "low", "why": "x"}')
  await chooseLevel($, 'rename foo to bar', 'high', 'high')
  assert.match(asked[0] ?? '', /a coding agent \(Test\)/)
  assert.match(asked[0] ?? '', /The current setting: high/)
  assert.match(asked[0] ?? '', /<reply>\nI renamed it\.\n<\/reply>/)
  assert.match(asked[0] ?? '', /<prompt>\nrename foo to bar\n<\/prompt>/)
})
