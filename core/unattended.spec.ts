import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { nodeHost } from '../adapters/node/host.ts'
import { permissionAsked, questionAsked, questionDone, submitUnattended, writeChecked, writeEnded } from './unattended.ts'

const NAMES = { assistant: 'Agent', product: 'Test', planTool: 'plan', ask: 'question', planMode: null }
const RUN = { isPerson: true, isTyped: true, command: 'waffles:non-interactive', isMeta: false, text: '' }

// A host on a state folder of its own; `another` stands for a second process that serves the same session.
async function hosts() {
  const folder = await fs.mkdtemp(join(tmpdir(), 'waffles-unattended-'))
  const another = () => nodeHost({ sessionId: 's1', cwd: folder, names: NAMES, stateFolder: folder })
  return { $: another(), another }
}

test("the run's changes are in the session's values at once, for every process", async () => {
  const { $, another } = await hosts()
  await submitUnattended($, RUN)
  await permissionAsked($, { isQuestion: false, isAgent: false })
  await permissionAsked($, { isQuestion: false, isAgent: true })
  assert.equal(await another().state.get('runDenials'), 2)
  assert.deepEqual(await questionAsked(another(), false), { ask: true })
  assert.equal(await $.state.get('runAsking'), true)
  assert.equal(await $.state.get('runStartedAt'), null)
  await questionDone(another())
  assert.equal(await $.state.get('runAsking'), false)
})

test('a denial that is not counted leaves the count as it was, and says what the next one would', async () => {
  const { $ } = await hosts()
  await submitUnattended($, RUN)
  for (let i = 0; i < 4; i += 1) await permissionAsked($, { isQuestion: false, isAgent: false })
  const uncounted = await permissionAsked($, { isQuestion: false, isAgent: false, isCounted: false })
  assert.match(uncounted ?? '', /5 permission requests in a row/)
  assert.equal(await $.state.get('runDenials'), 4)
})

test('2 questions at once in one process: 1 is the start question, and the other is refused', async () => {
  const { $ } = await hosts()
  await submitUnattended($, RUN)
  const answers = await Promise.all([questionAsked($, false), questionAsked($, false)])
  assert.equal(answers.filter(answer => 'ask' in answer).length, 1)
  assert.equal(answers.filter(answer => 'deny' in answer).length, 1)
})

test('a write that ran during the run starts the count of denials over', async () => {
  const { $ } = await hosts()
  await submitUnattended($, RUN)
  await permissionAsked($, { isQuestion: false, isAgent: false })
  await writeChecked($, 'call-1')
  await writeEnded($, 'call-1', false)
  assert.equal(await $.state.get('runDenials'), 1)
  await writeChecked($, 'call-2')
  await writeEnded($, 'call-2', true)
  assert.equal(await $.state.get('runDenials'), 0)
})
