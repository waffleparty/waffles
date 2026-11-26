import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHost } from '../core/testing.ts'
import { textOf, TOOLS } from '../core/tools.ts'

const MERGED = { state: 'MERGED', merged: true, isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null, timelineItems: { nodes: [] } }

// What gh answers in a checkout at /repo for pull request 12 of o/r, merged; any other command finds nothing.
// Every command is recorded as `[argv, cwd]`.
function world(on: On) {
  const runs: [string[], string | undefined][] = []
  const done = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.cwd', () => ({ value: '/repo' }))
  on('clock.now', () => ({ value: 1000 }))
  on('process.run', ($, e) => {
    runs.push([[...e.argv], e.init?.cwd])
    const [command, ...args] = e.argv
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') return done(JSON.stringify({ number: 12, url: 'https://github.com/o/r/pull/12', baseRefName: 'main', reviewDecision: '' }))
    if (command === 'gh' && args[1] === 'graphql') return done(JSON.stringify({ data: { repository: { pullRequest: MERGED } } }))
    return { value: { exitCode: 1, stdout: '', stderr: 'not here', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { runs }
}

// Starts the session as the engine does, answering what the plugin's other modules ask of it at start.
async function start($: Engine, on: On) {
  const tools: { name: string; description: string; inputSchema?: unknown }[] = []
  on('tool.register', ($, e) => (tools.push(e as never), { value: { tool: `mcp__waffles__${e.name}` } }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  mock.store(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  return tools
}

test('every core tool is registered with its description and input schema', async ($, on) => {
  world(on)
  const tools = await start($, on)

  for (const tool of TOOLS) {
    expect(tools.find(t => t.name === tool.name)).toEqual(expect.objectContaining({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
  }
})

// The hooks module writes each tool's hook out by name: a core tool with no hook here fails this test. Every
// tool refuses an input it does not take before it runs a command, so the answer is the same on both hosts.
test("every core tool's calls are answered by the core tool itself", async ($, on) => {
  world(on)
  for (const tool of TOOLS) {
    const said = textOf(await tool.call(fakeHost(), { notAnInput: 1 }))
    const expected = 'refusal' in said ? { deny: said.refusal } : { result: said.text }
    expect(await $.tool.call({ tool: `mcp__waffles__${tool.name}`, notAnInput: 1 } as never)).toEqual(expected)
  }
})

test('the merge queue answers the main thread and a subagent alike, running gh in the session’s folder', async ($, on) => {
  const { runs } = world(on)
  const call = (extra: object) => $.tool.call({ tool: 'mcp__waffles__merge_queue', op: 'state', pr: '12', ...extra } as never)

  expect(await call({})).toEqual({ result: '{"state":"merged","number":12}' })
  expect(await call({ agentId: 'a1' })).toEqual({ result: '{"state":"merged","number":12}' })
  expect(runs.map(([argv, cwd]) => [argv.slice(0, 3), cwd])).toEqual([
    [['gh', 'pr', 'view'], '/repo'],
    [['gh', 'api', 'graphql'], '/repo'],
    [['gh', 'pr', 'view'], '/repo'],
    [['gh', 'api', 'graphql'], '/repo'],
  ])
})

test('a tool that fails is a deny with a short reason', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'not json', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.log', () => ({ value: undefined }))

  const r = await $.tool.call({ tool: 'mcp__waffles__merge_queue', op: 'mode', pr: '12' } as never)
  expect(r.deny).toMatch(/^The merge_queue tool failed: /)
})

test("a failure of gh is a deny with gh's message", async ($, on) => {
  world(on)

  expect(await $.tool.call({ tool: 'mcp__waffles__merge_queue', op: 'mode', pr: '12' } as never)).toEqual({ deny: 'gh api rules/branches/main failed: not here' })
})

test('the checkpoint runs in the folder it is given, from the session’s folder, and a failure of git is a deny', async ($, on) => {
  const { runs } = world(on)

  const r = await $.tool.call({ tool: 'mcp__waffles__checkpoint', folder: 'app', agentId: 'a1' } as never)

  expect(r).toEqual({ deny: 'checkpoint: git rev-parse --path-format=absolute failed: not here' })
  expect(runs).toEqual([[['git', 'rev-parse', '--path-format=absolute', '--git-dir'], '/repo/app']])
})

test('a stdout that Claude Code cut is refused, not read in part', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('clock.now', () => ({ value: 1000 }))
  on('process.run', ($, e) => {
    const [command, ...args] = e.argv
    const stdout = command === 'git' ? (args.includes('--git-dir') ? '/repo/.git\n' : 'feat\n') : '{"number": 7, "body": "'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: command === 'gh', isStderrTruncated: false } }
  })

  const r = await $.tool.call({ tool: 'mcp__waffles__checkpoint' } as never)

  expect(r).toEqual({ deny: 'checkpoint: gh pr view printed more than the platform passes on, so the checkpoint does not go on from a part of it' })
})
