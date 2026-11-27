import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { submitUnattended } from '../../core/unattended.ts'
import { nodeHost } from '../node/host.ts'
import { autoEffort, type Variant } from './effort.ts'
import { NAMES } from './server.ts'

// OpenCode's variants for an Anthropic model and an OpenAI one, as its model list gives them.
const anthropic = (level: string): Variant => ({ id: level, settings: { thinking: { type: 'adaptive', display: 'summarized' }, effort: level } })
const openai = (level: string): Variant => ({ id: level, settings: { reasoningEffort: level, reasoningSummary: 'auto' } })
const VARIANTS: Record<string, Variant[]> = {
  'anthropic/claude-sonnet-5-5': ['low', 'medium', 'high', 'xhigh', 'max'].map(anthropic),
  'openai/gpt-5.5': ['none', 'low', 'medium', 'high', 'xhigh'].map(openai),
  'acme/raw': [{ id: 'high', body: { thinking: true } }],
}
const SONNET = { providerID: 'anthropic', id: 'claude-sonnet-5-5' }

// A host whose small model picks `level`, and an auto effort over the variants above.
async function setup(level: string | null) {
  const folder = await fs.mkdtemp(join(tmpdir(), 'waffles-auto-effort-'))
  const picks: string[] = []
  const answer = level === null ? null : JSON.stringify({ level, why: 'test' })
  const $ = nodeHost({ sessionId: 's1', cwd: folder, names: NAMES, stateFolder: folder, parts: { model: { ask: async prompt => (picks.push(prompt), answer) } } })
  const effort = autoEffort(async model => VARIANTS[`${model.providerID}/${model.id}`] ?? [])
  const typed = (text: string, command?: string) => effort.submit('s1', { isTyped: true, command, text })
  return { $, effort, picks, typed }
}

test("a typed prompt's pick reaches each of its turn's requests as the variant's options", async () => {
  const { $, effort, picks, typed } = await setup('low')
  typed('what does this function do?')
  assert.deepEqual(await effort.request($, 's1', SONNET), anthropic('low').settings)
  // The turn's later requests keep the level without asking again.
  assert.deepEqual(await effort.request($, 's1', SONNET), anthropic('low').settings)
  assert.equal(picks.length, 1)
  // OpenAI's variant carries the level under its own key.
  effort.complete('s1')
  typed('and this one?')
  assert.deepEqual(await effort.request($, 's1', { providerID: 'openai', id: 'gpt-5.5' }), openai('low').settings)
})

test('a turn with no typed prompt, or a pick that is the variant already, runs at the variant', async () => {
  const { $, effort, picks, typed } = await setup('high')
  // A subagent's result wakes the session: nothing was typed.
  assert.equal(await effort.request($, 's1', SONNET), null)
  assert.equal(picks.length, 0)
  effort.complete('s1')
  typed('debug the flaky test')
  assert.equal(await effort.request($, 's1', { ...SONNET, variant: 'high' }), null)
  // A slash command and a named skill are not picked for.
  effort.complete('s1')
  typed('/review')
  typed('go', 'ask')
  assert.equal(await effort.request($, 's1', SONNET), null)
  assert.equal(picks.length, 1)
})

test('a prompt delivered into a running turn leaves its level alone', async () => {
  const { $, effort, typed } = await setup('low')
  typed('look this up')
  await effort.request($, 's1', SONNET)
  effort.submit('s1', { isTyped: false, command: undefined, text: 'also check that' })
  assert.deepEqual(await effort.request($, 's1', SONNET), anthropic('low').settings)
})

test('a variant the person picks during the turn wins', async () => {
  const { $, effort, typed } = await setup('low')
  typed('look this up')
  assert.deepEqual(await effort.request($, 's1', SONNET), anthropic('low').settings)
  assert.equal(await effort.request($, 's1', { ...SONNET, variant: 'max' }), null)
})

test('a run holds every turn at extra high, without asking', async () => {
  const { $, effort, picks, typed } = await setup('low')
  await submitUnattended($, { isPerson: true, isTyped: true, command: 'non-interactive', isMeta: false, text: '' })
  typed('finish the work', 'non-interactive')
  assert.deepEqual(await effort.request($, 's1', SONNET), anthropic('xhigh').settings)
  effort.complete('s1')
  // A model with no xhigh takes the nearest level it has.
  assert.deepEqual(await effort.request($, 's1', { providerID: 'openai', id: 'gpt-5.5', variant: 'low' }), openai('xhigh').settings)
  assert.equal(picks.length, 0)
})

test('a model whose variant needs raw request fields, or has no variants, runs as it is', async () => {
  const { $, effort, typed } = await setup('high')
  typed('debug this')
  assert.equal(await effort.request($, 's1', { providerID: 'acme', id: 'raw' }), null)
  effort.complete('s1')
  typed('debug this')
  assert.equal(await effort.request($, 's1', { providerID: 'acme', id: 'other' }), null)
})

test('/auto-effort off keeps every turn at the variant, and the choice lasts', async () => {
  const { $, effort, picks, typed } = await setup('low')
  assert.match(await effort.command($, 'off'), /^Auto effort: off\.\nEvery turn runs at the model's variant\.$/)
  assert.equal(await $.store.get('effort.enabled'), false)
  typed('look this up')
  assert.equal(await effort.request($, 's1', SONNET), null)
  assert.equal(picks.length, 0)
  assert.match(await effort.command($, ''), /^Auto effort: off\./)
  assert.match(await effort.command($, 'sideways'), /^Unknown argument: sideways\. Use on or off\.$/)
  await submitUnattended($, { isPerson: true, isTyped: true, command: 'non-interactive', isMeta: false, text: '' })
  assert.match(await effort.command($, 'ON'), /^Auto effort: on\.\nA non-interactive run holds every turn at Extra high/)
})
