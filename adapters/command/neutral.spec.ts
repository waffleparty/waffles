import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ASSESS_PROMPT, MODES_TEXT } from '../../core/modes.ts'
import { planRules } from '../../core/plan-prompt.ts'
import { nodeHost, sessionPath } from '../node/host.ts'
import { handle, modeCommandOf, promptOf, type NeutralEvent } from './neutral.ts'

const NAMES = { assistant: 'Agent', product: 'Test', planTool: 'plan', ask: 'question', planMode: null }
const STUCK = /5 permission requests in a row have been denied/

async function temp(): Promise<{ state: string; cwd: string }> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'waffles-command-')))
  const cwd = join(root, 'work')
  await fs.mkdir(cwd)
  return { state: join(root, 'state'), cwd }
}

/**
 * One event in its own process, as a platform's hook runs it: a new host with an empty memory, on the
 * same state folder. Notes come back as the event's context, as the command line does it.
 */
async function event(where: { state: string; cwd: string }, e: NeutralEvent, sessionId = 's1') {
  const notes: string[] = []
  const $ = nodeHost({
    sessionId,
    cwd: where.cwd,
    names: NAMES,
    stateFolder: where.state,
    parts: { conversation: { lastReply: async () => '', note: async text => notes.push(text) > 0 } },
  })
  return handle({ $, sessionId, stateFolder: where.state }, e, notes)
}

const reader = (where: { state: string; cwd: string }, sessionId = 's1') => nodeHost({ sessionId, cwd: where.cwd, names: NAMES, stateFolder: where.state })

test('the session start adds the rules, the mode, and no plan outline block outside a plan outline', async () => {
  const where = await temp()
  const { context } = await event(where, { kind: 'start', source: 'startup' })
  assert.deepEqual(context, [MODES_TEXT, planRules(NAMES), 'waffles mode: production'])
})

test('a mode command changes the mode, and the next process starts in it', async () => {
  const where = await temp()
  const answer = await event(where, { kind: 'prompt', text: '/rapid', isAgent: false })
  assert.match(answer.notice ?? '', /^Rapid mode: on\./)
  assert.match(answer.context[0]!, /^waffles mode: rapid\./)
  assert.match(answer.context[1]!, /^waffles command: the person's prompt \/rapid is a waffles command/)
  const next = await event(where, { kind: 'start', source: 'resume' })
  assert.equal(next.context[2], 'waffles mode: rapid')
  // A prompt in another process leaves the mode as it is.
  const plain = await event(where, { kind: 'prompt', text: 'make the button blue', isAgent: false })
  assert.deepEqual(plain, { context: [] })
  assert.equal(await reader(where).state.get('mode'), 'rapid')
})

test('/prod with rapid work pending hands it over in the same answer, once', async () => {
  const where = await temp()
  const $ = reader(where)
  await $.state.set('mode', 'rapid')
  await $.state.set('rapidBase', { head: 'abc1234', dirty: [] })
  const answer = await event(where, { kind: 'prompt', text: '/waffles:prod', isAgent: false })
  assert.match(answer.context[0]!, /^waffles mode: production\. Rapid mode has ended/)
  assert.match(answer.context[0]!, /Rapid work since commit abc1234/)
  assert.equal(answer.context.at(-1), ASSESS_PROMPT)
  assert.equal(await $.state.get('rapidBase'), null)
})

test('a session start that names pending rapid work clears it at the end of the turn, in another process', async () => {
  const where = await temp()
  const $ = reader(where)
  await $.state.set('rapidBase', { head: 'abc1234', dirty: ['a.txt'] })
  const start = await event(where, { kind: 'start', source: 'startup' })
  assert.match(start.context[2]!, /^waffles mode: production\. Rapid work since commit abc1234/)
  await event(where, { kind: 'turnEnd', isAgent: true })
  assert.notEqual(await $.state.get('rapidBase'), null)
  await event(where, { kind: 'turnEnd', isAgent: false })
  assert.equal(await $.state.get('rapidBase'), null)
  assert.equal(await $.state.get('rapidStated'), false)
})

test('a prompt in backlog mode carries the mode beside it', async () => {
  const where = await temp()
  await event(where, { kind: 'prompt', text: '/backlog-entry', isAgent: false })
  const answer = await event(where, { kind: 'prompt', text: 'the export drops the last row', isAgent: false })
  assert.deepEqual(answer.context, ['waffles mode: backlog'])
})

test('a run asks its start question once; every later question is refused, each in its own process', async () => {
  const where = await temp()
  assert.deepEqual(await event(where, { kind: 'tool', isQuestion: true, isAgent: false }), { context: [] })
  const started = await event(where, { kind: 'prompt', text: '/waffles:non-interactive build the export', isAgent: false })
  assert.match(started.context[0]!, /^waffles mode: non-interactive\./)
  // The start question goes to the person, and is off the screen once its call ends.
  assert.deepEqual(await event(where, { kind: 'tool', isQuestion: true, isAgent: false }), { context: [] })
  assert.equal(await reader(where).state.get('runAsking'), true)
  await event(where, { kind: 'toolDone', isQuestion: true, shell: null })
  assert.equal(await reader(where).state.get('runAsking'), false)
  const second = await event(where, { kind: 'tool', isQuestion: true, isAgent: false })
  assert.match(second.deny ?? '', /^Denied: The user is away/)
  const agent = await event(where, { kind: 'tool', isQuestion: true, isAgent: true })
  assert.match(agent.deny ?? '', /Report the question in your result/)
  // Any other tool goes through.
  assert.deepEqual(await event(where, { kind: 'tool', isQuestion: false, isAgent: false }), { context: [] })
})

test('denials count across processes, and the fifth says the run is stuck', async () => {
  const where = await temp()
  assert.deepEqual(await event(where, { kind: 'permission', isQuestion: false, isAgent: false }), { context: [] })
  await event(where, { kind: 'prompt', text: '/non-interactive', isAgent: false })
  const denied: string[] = []
  for (let i = 0; i < 5; i += 1) denied.push((await event(where, { kind: 'permission', isQuestion: false, isAgent: false })).deny ?? '')
  assert.ok(denied.slice(0, 4).every(d => d.startsWith('Denied: The user is away')))
  assert.match(denied[4]!, STUCK)
  assert.equal(await reader(where).state.get('runDenials'), 5)
  // A prompt the person types ends the run, and the count with it.
  await event(where, { kind: 'prompt', text: 'I am back', isAgent: false })
  assert.equal(await reader(where).state.get('runDenials'), 0)
  assert.deepEqual(await event(where, { kind: 'permission', isQuestion: false, isAgent: false }), { context: [] })
})

test('a push outside a git repository still gets a checkpoint line; other commands get none', async () => {
  const where = await temp()
  const pushed = await event(where, { kind: 'toolDone', isQuestion: false, shell: { command: 'git push -u origin feat/x' } })
  assert.equal(pushed.context.length, 1)
  assert.match(pushed.context[0]!, /^waffles checkpoint: /)
  assert.deepEqual(await event(where, { kind: 'toolDone', isQuestion: false, shell: { command: 'ls -la' } }), { context: [] })
})

test('a clear returns to production mode; a session gone for good loses its values', async () => {
  const where = await temp()
  await event(where, { kind: 'prompt', text: '/rapid', isAgent: false })
  await event(where, { kind: 'end', isClear: true, isGone: false })
  assert.equal(await reader(where).state.get('mode'), 'production')
  await event(where, { kind: 'prompt', text: '/backlog-entry', isAgent: false })
  const start = await event(where, { kind: 'start', source: 'clear' })
  assert.equal(start.context[2], 'waffles mode: production')
  await event(where, { kind: 'end', isClear: false, isGone: true })
  await assert.rejects(fs.access(sessionPath(where.state, 's1')))
})

test('a subagent prompt changes nothing', async () => {
  const where = await temp()
  assert.deepEqual(await event(where, { kind: 'prompt', text: '/rapid', isAgent: true }), { context: [] })
  assert.equal(await reader(where).state.get('mode'), 'production')
})

test('a prompt is a mode command only when it is the command alone', () => {
  assert.equal(modeCommandOf('/prod'), 'prod')
  assert.equal(modeCommandOf('  /waffles:backlog-entry\n'), 'backlog-entry')
  assert.equal(modeCommandOf('/rapid please'), null)
  assert.equal(modeCommandOf('/other:prod'), null)
  assert.equal(modeCommandOf('/review'), null)
  assert.equal(promptOf('/waffles:non-interactive do it').command, 'waffles:non-interactive')
  assert.equal(promptOf('/usr/bin/env is missing').command, undefined)
  assert.equal(promptOf('plain text').command, undefined)
})
