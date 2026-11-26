import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { CLOSED, NO_ANSWER, permissionAsked, submitUnattended } from '../../core/unattended.ts'
import { nodeHost } from '../node/host.ts'
import { NAMES } from './server.ts'
import { guardQuestion } from './unattended.ts'

// A host whose values live in a folder of their own, in a run when `isRun`.
async function hostIn(isRun: boolean) {
  const folder = await fs.mkdtemp(join(tmpdir(), 'waffles-unattended-'))
  const $ = nodeHost({ sessionId: 's1', cwd: folder, names: NAMES, stateFolder: folder })
  if (isRun) await submitUnattended($, { isPerson: true, isTyped: true, command: 'non-interactive', isMeta: false, text: '' })
  return $
}

// The question tool as OpenCode runs it: it answers when told to, or rejects when its signal aborts.
function questionTool() {
  const calls: AbortSignal[] = []
  let answer: (value: string) => void = () => undefined
  let dismiss: () => void = () => undefined
  const execute = (_input: unknown, context: { sessionID: string; signal: AbortSignal }) =>
    new Promise<string>((resolve, reject) => {
      calls.push(context.signal)
      answer = resolve
      dismiss = () => reject(new Error('The user dismissed this question'))
      context.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  return { calls, execute, answer: (value: string) => answer(value), dismiss: () => dismiss() }
}

const context = () => ({ sessionID: 's1', signal: new AbortController().signal })
// Waits until the question is on the screen: the run's checks read the session's values from disk first.
async function shown(tool: { calls: readonly unknown[] }) {
  while (tool.calls.length === 0) await new Promise(resolve => setTimeout(resolve, 1))
}

test('outside a run the question goes to the person and waits for them', async () => {
  const $ = await hostIn(false)
  const tool = questionTool()
  const asked = guardQuestion(tool.execute, async () => ({ $, isChild: false }), 10)(null, context())
  await shown(tool)
  await new Promise(resolve => setTimeout(resolve, 30))
  tool.answer('B')
  assert.equal(await asked, 'B')
})

test("the run's start question takes the answer given in time", async () => {
  const $ = await hostIn(true)
  const tool = questionTool()
  const asked = guardQuestion(tool.execute, async () => ({ $, isChild: false }), 1000)(null, context())
  await shown(tool)
  tool.answer('A')
  assert.equal(await asked, 'A')
})

test("the run's start question ends unanswered after its wait, and leaves the screen", async () => {
  const $ = await hostIn(true)
  const tool = questionTool()
  await assert.rejects(guardQuestion(tool.execute, async () => ({ $, isChild: false }), 20)(null, context()), new RegExp(`^Error: ${NO_ANSWER.slice(0, 30)}`))
  // The question's own signal aborted, which is what takes OpenCode's question off the screen.
  assert.equal(tool.calls[0]?.aborted, true)
  // The start question is no longer on the screen: a permission request is denied again.
  assert.match((await permissionAsked($, { isQuestion: true, isAgent: false })) ?? '', /^Denied/)
})

test("a dismissed start question tells the model what to do, rather than ending the run's turn", async () => {
  const $ = await hostIn(true)
  const tool = questionTool()
  const asked = guardQuestion(tool.execute, async () => ({ $, isChild: false }), 1000)(null, context())
  await shown(tool)
  tool.dismiss()
  await assert.rejects(asked, new RegExp(`^Error: ${CLOSED.slice(0, 30)}`))
})

test('a session the plugin cannot read leaves the question alone', async () => {
  const tool = questionTool()
  const asked = guardQuestion(tool.execute, async () => null, 10)(null, context())
  await shown(tool)
  tool.answer('C')
  assert.equal(await asked, 'C')
})
