import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { ASSESS_PROMPT } from '../../core/modes.ts'
import { modesModule } from './modes.ts'
import { registryOf } from './registry.ts'
import { folders, LIMIT, META, server, stopAll, text } from './testing.ts'

after(stopAll)

// A repository with one commit, so rapid mode records a base and /prod hands the rapid work over.
async function repository(work: string) {
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: work, stdio: 'pipe' })
  git('init', '-q')
  await fs.writeFile(join(work, 'a.txt'), 'a\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'first')
}

test('a mode prompt changes the mode, and a second process with the same session ID reads it back', LIMIT, async () => {
  const { work, state } = await folders()
  const first = server(work, state, { WAFFLES_SESSION_ID: 'shared-mode' })
  await first.initialize()
  const rapid = await first.request('prompts/get', { name: 'rapid' })
  assert.match(rapid.result.description, /^Rapid mode: on\. .* No git commit was found here, so no base is recorded\.$/)
  assert.match(text(rapid), /^waffles mode: rapid\. Changes are made quickly/)
  assert.deepEqual(await first.close(), { code: 0, signal: null })

  const second = server(work, state, { WAFFLES_SESSION_ID: 'shared-mode' })
  const read = await second.request('tools/call', { _meta: META, name: 'mode', arguments: {} })
  assert.equal(read.result.isError, false)
  assert.equal(text(read), 'waffles mode: rapid')
  assert.equal((await second.request('prompts/get', { _meta: META, name: 'rapid' })).result.description, 'Already in rapid mode.')
  await second.close()

  // A process with a session of its own starts in production mode.
  const other = server(work, state)
  assert.equal(text(await other.request('tools/call', { _meta: META, name: 'mode' })), 'waffles mode: production')
  await other.close()
})

test('/prod after rapid work hands it over: the statement names it and the assessment prompt follows', LIMIT, async () => {
  const { work, state } = await folders()
  await repository(work)
  const s = server(work, state)
  await s.initialize()
  assert.match(text(await s.request('prompts/get', { name: 'rapid' })), /recorded as the base of the rapid work/)
  await fs.writeFile(join(work, 'b.txt'), 'b\n')
  const prod = await s.request('prompts/get', { name: 'prod' })
  assert.match(prod.result.description, /^Rapid mode: off\. Back in production mode\. The agent reviews the rapid work/)
  const said = text(prod)
  assert.match(said, /^waffles mode: production\. Rapid mode has ended[^]*Rapid work since commit [0-9a-f]{40} has not been brought up to standards/)
  assert.match(said, /asked, with a multiple-choice question, which of three to do/)
  assert.ok(said.endsWith(`\n\n${ASSESS_PROMPT}`), said)
  // The work was handed over once: the mode now states nothing pending.
  assert.equal(text(await s.request('tools/call', { name: 'mode', arguments: {} })), 'waffles mode: production')
  await s.close()
})

test('the mode tool reads and sets the mode, and refuses a mode it lacks', LIMIT, async () => {
  const { work, state } = await folders()
  const s = server(work, state)
  await s.initialize()
  const tools = (await s.request('tools/list')).result.tools
  const mode = tools.find((tool: { name: string }) => tool.name === 'mode')
  assert.deepEqual(mode.inputSchema.properties.set.enum, ['production', 'rapid', 'backlog'])
  // Setting changes the mode, so the tool is not marked read-only.
  assert.deepEqual(mode.annotations, { idempotentHint: true, openWorldHint: false })

  assert.equal(text(await s.request('tools/call', { name: 'mode', arguments: {} })), 'waffles mode: production')
  const set = await s.request('tools/call', { name: 'mode', arguments: { set: 'backlog' } })
  assert.equal(set.result.isError, false)
  assert.match(text(set), /^waffles mode: backlog\. Each typed prompt goes verbatim to the backlog skill/)
  assert.equal(text(await s.request('tools/call', { name: 'mode', arguments: {} })), 'waffles mode: backlog')
  // Setting the mode in force changes nothing and states it.
  assert.equal(text(await s.request('tools/call', { name: 'mode', arguments: { set: 'backlog' } })), 'waffles mode: backlog')

  const refused = await s.request('tools/call', { name: 'mode', arguments: { set: 'non-interactive' } })
  assert.equal(refused.result.isError, true)
  assert.match(text(refused), /set must be one of production, rapid, backlog/)
  const back = await s.request('tools/call', { _meta: META, name: 'mode', arguments: { set: 'production' } })
  assert.equal(back.result.resultType, 'complete')
  assert.match(text(back), /^waffles mode: production\. Backlog mode has ended/)
  await s.close()
})

test("the instructions say no mode statement comes with the first message, unless the platform's hooks send one", () => {
  const without = registryOf([modesModule], {}).instructions
  assert.match(without, /prompts of the waffles MCP server, and no mode statement comes with the first message: the mcp__waffles__mode tool returns the current one when called with no input\.$/)
  const withHooks = registryOf([modesModule], { WAFFLES_HOOKS: '1' }).instructions
  assert.doesNotMatch(withHooks, /no mode statement/)
  assert.match(withHooks, /prompts of the waffles MCP server, and the mcp__waffles__mode tool returns the current mode statement when called with no input\.$/)
})
