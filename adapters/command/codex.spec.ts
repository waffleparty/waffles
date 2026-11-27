import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { isFailed } from './codex.ts'

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts')
const STUCK = /5 permission requests in a row have been denied/

type Json = Record<string, any>

async function temp(): Promise<{ state: string; cwd: string }> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'waffles-codex-')))
  const cwd = join(root, 'work')
  await fs.mkdir(cwd)
  return { state: join(root, 'state'), cwd }
}

// The fields Codex sends with every event, as its hooks reference and its input schemas list them.
const common = (cwd: string, hookEventName: string) => ({
  session_id: 'thr_123',
  transcript_path: '/workspace/.codex/rollout.jsonl',
  cwd,
  hook_event_name: hookEventName,
  model: 'gpt-5.5-codex',
  permission_mode: 'default',
})

// Recorded inputs, one per event, shaped as Codex's hooks reference and input schemas give them.
const INPUTS = {
  SessionStart: (cwd: string, source = 'startup') => ({ ...common(cwd, 'SessionStart'), source }),
  UserPromptSubmit: (cwd: string, prompt: string) => ({ ...common(cwd, 'UserPromptSubmit'), turn_id: 'turn_1', prompt }),
  PreToolUse: (cwd: string, tool: string, input: Json) => ({ ...common(cwd, 'PreToolUse'), turn_id: 'turn_1', tool_name: tool, tool_use_id: 'call_1', tool_input: input }),
  PermissionRequest: (cwd: string, command: string) => ({
    ...common(cwd, 'PermissionRequest'),
    turn_id: 'turn_1',
    tool_name: 'Bash',
    tool_input: { command, description: null },
  }),
  PostToolUse: (cwd: string, command: string, response: unknown) => ({
    ...common(cwd, 'PostToolUse'),
    turn_id: 'turn_1',
    tool_name: 'Bash',
    tool_use_id: 'call_2',
    tool_input: { command },
    tool_response: response,
  }),
  Stop: (cwd: string) => ({ ...common(cwd, 'Stop'), turn_id: 'turn_1', stop_hook_active: false, last_assistant_message: 'Done.' }),
  SessionEnd: (cwd: string) => ({ session_id: 'thr_123', transcript_path: '/workspace/.codex/rollout.jsonl', cwd, hook_event_name: 'SessionEnd', reason: 'other' }),
}

/** Runs the hook command as Codex does: the event's JSON on stdin, the answer on stdout. */
function hook(state: string, event: string, stdin: unknown) {
  const r = spawnSync(process.execPath, [CLI, 'codex', event], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    env: { ...process.env, WAFFLES_STATE_DIR: state, WAFFLES_DEBUG: '' },
  })
  const json = r.stdout.trim() ? (JSON.parse(r.stdout) as Json) : null
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

test('SessionStart adds the rules and the mode as additional context', async () => {
  const { state, cwd } = await temp()
  const r = hook(state, 'SessionStart', INPUTS.SessionStart(cwd))
  assert.equal(r.status, 0)
  assert.equal(r.json?.hookSpecificOutput.hookEventName, 'SessionStart')
  const added: string = r.json?.hookSpecificOutput.additionalContext
  assert.match(added, /^# waffles modes\n/)
  assert.match(added, /# waffles plan outline/)
  assert.match(added, /Change it only with the mcp__waffles__plan tool/)
  assert.match(added, /request_user_input/)
  assert.match(added, /\n\nwaffles mode: production$/)
})

test('a mode command answers with its note and its text, and the mode holds in the next process', async () => {
  const { state, cwd } = await temp()
  const r = hook(state, 'UserPromptSubmit', INPUTS.UserPromptSubmit(cwd, '/waffles:backlog-entry'))
  assert.equal(r.status, 0)
  assert.match(r.json?.systemMessage, /^Backlog mode: on\./)
  assert.equal(r.json?.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(r.json?.hookSpecificOutput.additionalContext, /^waffles mode: backlog\./)
  assert.equal(r.json?.decision, undefined)
  const next = hook(state, 'UserPromptSubmit', INPUTS.UserPromptSubmit(cwd, 'the export drops the last row'))
  assert.deepEqual(next.json, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'waffles mode: backlog' } })
  const resumed = hook(state, 'SessionStart', INPUTS.SessionStart(cwd, 'resume'))
  assert.match(resumed.json?.hookSpecificOutput.additionalContext, /\n\nwaffles mode: backlog$/)
})

test('during a run, a question after the start question is refused, in another process', async () => {
  const { state, cwd } = await temp()
  const question = INPUTS.PreToolUse(cwd, 'request_user_input', { questions: [{ question: 'Which database?' }] })
  assert.equal(hook(state, 'PreToolUse', question).stdout, '')
  hook(state, 'UserPromptSubmit', INPUTS.UserPromptSubmit(cwd, '/waffles:non-interactive ship the export'))
  assert.equal(hook(state, 'PreToolUse', question).stdout, '')
  const r = hook(state, 'PreToolUse', question)
  assert.equal(r.status, 0)
  assert.equal(r.json?.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(r.json?.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(r.json?.hookSpecificOutput.permissionDecisionReason, /^Denied: The user is away/)
  // A shell call is no question: it goes through.
  assert.equal(hook(state, 'PreToolUse', INPUTS.PreToolUse(cwd, 'Bash', { command: 'ls' })).stdout, '')
})

test('permission requests during a run are denied, counted across processes', async () => {
  const { state, cwd } = await temp()
  assert.equal(hook(state, 'PermissionRequest', INPUTS.PermissionRequest(cwd, 'rm -rf build')).stdout, '')
  hook(state, 'UserPromptSubmit', INPUTS.UserPromptSubmit(cwd, '/non-interactive'))
  const messages: string[] = []
  for (let i = 0; i < 5; i += 1) {
    const r = hook(state, 'PermissionRequest', INPUTS.PermissionRequest(cwd, 'rm -rf build'))
    assert.equal(r.status, 0)
    assert.equal(r.json?.hookSpecificOutput.hookEventName, 'PermissionRequest')
    assert.equal(r.json?.hookSpecificOutput.decision.behavior, 'deny')
    messages.push(r.json?.hookSpecificOutput.decision.message)
  }
  assert.match(messages[0]!, /^Denied: The user is away/)
  assert.doesNotMatch(messages[3]!, STUCK)
  assert.match(messages[4]!, STUCK)
})

test('a push that worked gets the checkpoint line; one that failed gets nothing', async () => {
  const { state, cwd } = await temp()
  const r = hook(state, 'PostToolUse', INPUTS.PostToolUse(cwd, 'git push -u origin feat/x', 'Exit code: 0\nWall time: 1.2 seconds\nOutput:\nEverything up-to-date\n'))
  assert.equal(r.status, 0)
  assert.equal(r.json?.hookSpecificOutput.hookEventName, 'PostToolUse')
  assert.match(r.json?.hookSpecificOutput.additionalContext, /^waffles checkpoint: /)
  const failed = hook(state, 'PostToolUse', INPUTS.PostToolUse(cwd, 'git push', 'Exit code: 1\nOutput:\nrejected\n'))
  assert.equal(failed.stdout, '')
  assert.equal(hook(state, 'PostToolUse', INPUTS.PostToolUse(cwd, 'ls', 'Exit code: 0\n')).stdout, '')
})

test('Stop answers with an empty object, and SessionEnd with nothing', async () => {
  const { state, cwd } = await temp()
  const stop = hook(state, 'Stop', INPUTS.Stop(cwd))
  assert.equal(stop.status, 0)
  assert.deepEqual(stop.json, {})
  const end = hook(state, 'SessionEnd', INPUTS.SessionEnd(cwd))
  assert.equal(end.status, 0)
  assert.equal(end.stdout, '')
})

test('malformed input fails open: exit 0, nothing printed', async () => {
  const { state, cwd } = await temp()
  for (const [event, stdin] of [
    ['UserPromptSubmit', '{ not json'],
    ['UserPromptSubmit', ''],
    ['PermissionRequest', '[1, 2]'],
    ['PermissionRequest', JSON.stringify({ tool_name: 'Bash' })],
    ['PreToolUse', JSON.stringify({ ...INPUTS.PreToolUse(cwd, 'request_user_input', {}), tool_name: 42 })],
    ['NoSuchEvent', JSON.stringify(INPUTS.Stop(cwd))],
  ] as const) {
    const r = hook(state, event, stdin)
    assert.equal(r.status, 0, `${event} ${stdin}`)
    assert.equal(r.stdout, '', `${event} ${stdin}`)
    assert.equal(r.stderr, '', `${event} ${stdin}`)
  }
  // An unknown platform too.
  const r = spawnSync(process.execPath, [CLI, 'nowhere', 'Stop'], { input: '{}', encoding: 'utf8', env: { ...process.env, WAFFLES_STATE_DIR: state } })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('a failure goes to stderr only with WAFFLES_DEBUG set', async () => {
  const { state } = await temp()
  const r = spawnSync(process.execPath, [CLI, 'codex', 'UserPromptSubmit'], {
    input: '{ not json',
    encoding: 'utf8',
    env: { ...process.env, WAFFLES_STATE_DIR: state, WAFFLES_DEBUG: '1' },
  })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /^waffles: codex UserPromptSubmit failed: SyntaxError/)
})

test('a shell result names its failure by its exit code', () => {
  assert.equal(isFailed('Exit code: 0\nOutput:\n'), false)
  assert.equal(isFailed('Exit code: 128\nOutput:\nfatal'), true)
  assert.equal(isFailed('Process exited with code 1'), true)
  assert.equal(isFailed({ exit_code: 2 }), true)
  assert.equal(isFailed({ metadata: { exit_code: 0 } }), false)
  assert.equal(isFailed('plain output'), false)
  assert.equal(isFailed(null), false)
})
