import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { isPlanCall } from './antigravity.ts'

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts')
const STUCK = /5 permission requests in a row have been denied/

type Json = Record<string, any>

async function temp(): Promise<{ state: string; cwd: string }> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'waffles-antigravity-')))
  const cwd = join(root, 'work')
  await fs.mkdir(cwd)
  return { state: join(root, 'state'), cwd }
}

// The fields Antigravity sends with every event, as its Hooks page lists them and its examples give them.
const common = (cwd: string) => ({
  conversationId: 'ec33ebf9-0cba-4100-8142-c61503f6c587',
  workspacePaths: [cwd],
  transcriptPath: '~/.gemini/antigravity/brain/ec33ebf9-0cba-4100-8142-c61503f6c587/.system_generated/logs/transcript.jsonl',
  artifactDirectoryPath: '~/.gemini/antigravity/brain/ec33ebf9-0cba-4100-8142-c61503f6c587',
  modelName: 'gemini-3.6-flash-medium',
})

// Inputs shaped as the examples on Antigravity's Hooks page give them.
const INPUTS = {
  SessionStart: (cwd: string) => common(cwd),
  PreInvocation: (cwd: string, lastUserInput: string, invocationNum = 0) => ({ invocationNum, initialNumSteps: 1 + invocationNum * 3, ...common(cwd), lastUserInput }),
  PreToolUse: (cwd: string, name: string, args: Json) => ({ toolCall: { name, args }, stepIdx: 19, ...common(cwd) }),
  PostToolUse: (cwd: string, name: string, args: Json, error = '') => ({ toolCall: { name, args }, stepIdx: 5, error, ...common(cwd) }),
  Stop: (cwd: string, fullyIdle = true) => ({ executionNum: 1, terminationReason: 'model_stop', error: '', fullyIdle, ...common(cwd) }),
}

const shell = (cwd: string, command: string) => ({ CommandLine: command, Cwd: cwd, WaitMsBeforeAsync: 5000 })

/** Runs the hook command as Antigravity does: the event's JSON on stdin, the answer on stdout. */
function hook(state: string, event: string, stdin: unknown) {
  const r = spawnSync(process.execPath, [CLI, 'antigravity', event], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    env: { ...process.env, WAFFLES_STATE_DIR: state, WAFFLES_DEBUG: '' },
  })
  const json = r.stdout.trim() ? (JSON.parse(r.stdout) as Json) : null
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

/** The text of the system message a SessionStart or PreInvocation answer injects; undefined when it injects none. */
const injected = (json: Json | null): string | undefined => {
  if (json?.injectSteps === undefined) return undefined
  assert.equal(json.injectSteps.length, 1)
  return json.injectSteps[0].systemMessage.systemMessage
}

test('SessionStart injects the rules and the mode as a system message', async () => {
  const { state, cwd } = await temp()
  const r = hook(state, 'SessionStart', INPUTS.SessionStart(cwd))
  assert.equal(r.status, 0)
  const added = injected(r.json)!
  assert.match(added, /^# waffles modes\n/)
  assert.match(added, /# waffles plan outline/)
  assert.match(added, /Change it only with the mcp_waffles_waffles_plan tool/)
  assert.match(added, /ask_question/)
  assert.match(added, /\n\nwaffles mode: production$/)
})

test("a mode command injects its note and its text once per prompt, and the mode holds in the next process", async () => {
  const { state, cwd } = await temp()
  const r = hook(state, 'PreInvocation', INPUTS.PreInvocation(cwd, '/waffles:backlog-entry'))
  assert.equal(r.status, 0)
  const added = injected(r.json)!
  assert.match(added, /^waffles mode: backlog\./)
  assert.match(added, /waffles command: the person's prompt \/backlog-entry is a waffles command/)
  assert.equal(r.json?.terminationBehavior, undefined)
  // The model calls after the first in the same turn carry the same prompt: they inject nothing.
  assert.deepEqual(hook(state, 'PreInvocation', INPUTS.PreInvocation(cwd, '/waffles:backlog-entry', 1)).json, {})
  const next = hook(state, 'PreInvocation', INPUTS.PreInvocation(cwd, 'the export drops the last row', 2))
  assert.equal(injected(next.json), 'waffles mode: backlog')
  assert.match(injected(hook(state, 'SessionStart', INPUTS.SessionStart(cwd)).json)!, /\n\nwaffles mode: backlog$/)
})

test('during a run, a question after the start question is refused, in another process', async () => {
  const { state, cwd } = await temp()
  const question = INPUTS.PreToolUse(cwd, 'ask_question', { questions: [{ question: 'Which database?', options: ['SQLite', 'Postgres'], is_multi_select: false }] })
  assert.deepEqual(hook(state, 'PreToolUse', question).json, { decision: 'allow' })
  hook(state, 'PreInvocation', INPUTS.PreInvocation(cwd, '/waffles:non-interactive ship the export'))
  // The run's start question goes to the person.
  assert.deepEqual(hook(state, 'PreToolUse', question).json, { decision: 'allow' })
  assert.deepEqual(hook(state, 'PostToolUse', INPUTS.PostToolUse(cwd, 'ask_question', question.toolCall.args)).json, {})
  const r = hook(state, 'PreToolUse', question)
  assert.equal(r.status, 0)
  assert.equal(r.json?.decision, 'deny')
  assert.match(r.json?.reason, /^Denied: The user is away/)
})

test('during a run, a call that would ask is refused unless granted before, and not counted', async () => {
  const { state, cwd } = await temp()
  const push = INPUTS.PreToolUse(cwd, 'run_command', shell(cwd, 'git push'))
  assert.deepEqual(hook(state, 'PreToolUse', push).json, { decision: 'allow' })
  hook(state, 'PreInvocation', INPUTS.PreInvocation(cwd, '/non-interactive'))
  for (let i = 0; i < 6; i += 1) {
    const r = hook(state, 'PreToolUse', push)
    assert.equal(r.status, 0)
    assert.equal(r.json?.decision, 'deny_unless_prior_grant')
    assert.match(r.json?.reason, /^Denied: The user is away/)
    assert.doesNotMatch(r.json?.reason, STUCK)
  }
  // The model's own request for more permissions is denied outright, and counted.
  const asks = INPUTS.PreToolUse(cwd, 'ask_permission', { Action: 'command', Target: 'git push', Reason: 'Publish the branch' })
  const reasons = Array.from({ length: 5 }, () => hook(state, 'PreToolUse', asks).json)
  assert.equal(reasons[0]?.decision, 'deny')
  assert.doesNotMatch(reasons[3]?.reason, STUCK)
  assert.match(reasons[4]?.reason, STUCK)
  // The next prompt ends the run.
  hook(state, 'PreInvocation', INPUTS.PreInvocation(cwd, 'I am back'))
  assert.deepEqual(hook(state, 'PreToolUse', push).json, { decision: 'allow' })
})

test('the plan outline tool is approved, during a run too', async () => {
  const { state, cwd } = await temp()
  const eager = INPUTS.PreToolUse(cwd, 'mcp_waffles_waffles_plan', { op: 'show' })
  const lazy = INPUTS.PreToolUse(cwd, 'call_mcp_tool', { ServerName: 'waffles_waffles', ToolName: 'plan', Arguments: { op: 'show' } })
  assert.deepEqual(hook(state, 'PreToolUse', eager).json, { decision: 'auto_approve' })
  hook(state, 'PreInvocation', INPUTS.PreInvocation(cwd, '/waffles:non-interactive'))
  assert.deepEqual(hook(state, 'PreToolUse', eager).json, { decision: 'auto_approve' })
  assert.deepEqual(hook(state, 'PreToolUse', lazy).json, { decision: 'auto_approve' })
  assert.equal(isPlanCall('call_mcp_tool', { ServerName: 'other_server', ToolName: 'plan' }), false)
})

test('a push that worked leaves the checkpoint line for the next model call; one that failed leaves nothing', async () => {
  const { state, cwd } = await temp()
  const failed = hook(state, 'PostToolUse', INPUTS.PostToolUse(cwd, 'run_command', shell(cwd, 'git push'), 'exit status 1'))
  assert.equal(failed.status, 0)
  assert.equal(failed.stdout, '')
  assert.deepEqual(hook(state, 'PostToolUse', INPUTS.PostToolUse(cwd, 'run_command', shell(cwd, 'ls'))).json, {})
  const r = hook(state, 'PostToolUse', INPUTS.PostToolUse(cwd, 'run_command', shell(cwd, 'git push -u origin feat/x')))
  assert.equal(r.status, 0)
  assert.deepEqual(r.json, {})
  const next = hook(state, 'PreInvocation', INPUTS.PreInvocation(cwd, 'push the branch', 3))
  assert.match(injected(next.json)!, /^waffles checkpoint: /)
  // Taken once.
  assert.deepEqual(hook(state, 'PreInvocation', INPUTS.PreInvocation(cwd, 'push the branch', 4)).json, {})
})

test('Stop answers with an empty object; a stop with background work going answers nothing', async () => {
  const { state, cwd } = await temp()
  const stop = hook(state, 'Stop', INPUTS.Stop(cwd))
  assert.equal(stop.status, 0)
  assert.deepEqual(stop.json, {})
  const busy = hook(state, 'Stop', INPUTS.Stop(cwd, false))
  assert.equal(busy.status, 0)
  assert.equal(busy.stdout, '')
})

test('malformed input fails open: exit 0, nothing printed', async () => {
  const { state, cwd } = await temp()
  for (const [event, stdin] of [
    ['PreInvocation', '{ not json'],
    ['PreInvocation', ''],
    ['PreToolUse', '[1, 2]'],
    ['PreToolUse', JSON.stringify({ toolCall: { name: 'run_command', args: {} } })],
    ['PreToolUse', JSON.stringify({ ...INPUTS.PreToolUse(cwd, 'run_command', {}), toolCall: { name: 42 } })],
    ['PreToolUse', JSON.stringify({ ...INPUTS.PreToolUse(cwd, 'run_command', {}), workspacePaths: [] })],
    ['PreInvocation', JSON.stringify({ ...INPUTS.PreInvocation(cwd, ''), lastUserInput: null })],
    ['PostInvocation', JSON.stringify(INPUTS.PreInvocation(cwd, 'hello'))],
  ] as const) {
    const r = hook(state, event, stdin)
    assert.equal(r.status, 0, `${event} ${stdin}`)
    assert.equal(r.stdout, '', `${event} ${stdin}`)
    assert.equal(r.stderr, '', `${event} ${stdin}`)
  }
})
