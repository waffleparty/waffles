import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { isFailed, LATE } from './cursor.ts'

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

type Json = Record<string, any>

async function temp(): Promise<{ state: string; cwd: string }> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'waffles-cursor-')))
  const cwd = join(root, 'work')
  await fs.mkdir(cwd)
  return { state: join(root, 'state'), cwd }
}

// The fields Cursor sends with every agent event, as its hooks reference's common schema lists them.
const common = (cwd: string, hookEventName: string) => ({
  conversation_id: 'conv-456',
  generation_id: 'gen-1',
  model: 'claude-opus-4-7-thinking-max',
  model_id: 'claude-opus-4-7',
  hook_event_name: hookEventName,
  cursor_version: '3.32.4',
  workspace_roots: [cwd],
  user_email: null,
  transcript_path: null,
})

// Recorded inputs, one per event, shaped as Cursor's hooks reference gives them.
const INPUTS = {
  sessionStart: (cwd: string) => ({ ...common(cwd, 'sessionStart'), session_id: 'conv-456', is_background_agent: false, composer_mode: 'agent' }),
  beforeSubmitPrompt: (cwd: string, prompt: string) => ({ ...common(cwd, 'beforeSubmitPrompt'), prompt, attachments: [] }),
  preToolUse: (cwd: string, tool: string, input: Json) => ({ ...common(cwd, 'preToolUse'), tool_name: tool, tool_input: input, tool_use_id: 'abc123', cwd, agent_message: 'Working...' }),
  postToolUse: (cwd: string, tool: string, input: Json, output: string) => ({
    ...common(cwd, 'postToolUse'),
    tool_name: tool,
    tool_input: input,
    tool_output: output,
    tool_use_id: 'abc123',
    cwd,
    duration: 5432,
  }),
  stop: (cwd: string) => ({ ...common(cwd, 'stop'), status: 'completed', loop_count: 0 }),
  sessionEnd: (cwd: string) => ({ ...common(cwd, 'sessionEnd'), session_id: 'conv-456', reason: 'user_close', duration_ms: 45000, is_background_agent: false, final_status: 'completed' }),
}

const read = (cwd: string) => INPUTS.postToolUse(cwd, 'Read', { path: 'README.md' }, '{"content":"# Readme"}')

/** Runs the hook command as Cursor does: the event's JSON on stdin, the answer on stdout. */
function hook(state: string, event: string, stdin: unknown) {
  const r = spawnSync(process.execPath, [CLI, 'cursor', event], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    env: { ...process.env, WAFFLES_STATE_DIR: state, WAFFLES_DEBUG: '' },
  })
  const json = r.stdout.trim() ? (JSON.parse(r.stdout) as Json) : null
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

test('sessionStart adds the rules, the mode, and where late statements come, as additional context', async () => {
  const { state, cwd } = await temp()
  const r = hook(state, 'sessionStart', INPUTS.sessionStart(cwd))
  assert.equal(r.status, 0)
  const added: string = r.json?.additional_context
  assert.match(added, /^# waffles modes\n/)
  assert.match(added, /# waffles plan outline/)
  assert.match(added, /Change it only with the waffles MCP server's plan tool/)
  assert.match(added, /The plan outline is not Cursor's Plan mode\./)
  assert.match(added, /\n\nwaffles mode: production\n\n/)
  assert.ok(added.endsWith(LATE))
})

test("a mode command stops its prompt with the command's text, and the change reaches the model at the next tool call", async () => {
  const { state, cwd } = await temp()
  const r = hook(state, 'beforeSubmitPrompt', INPUTS.beforeSubmitPrompt(cwd, '/waffles:backlog-entry'))
  assert.equal(r.status, 0)
  assert.equal(r.json?.continue, false)
  assert.match(r.json?.user_message, /^Backlog mode: on\./)
  const next = hook(state, 'postToolUse', read(cwd))
  assert.equal(next.status, 0)
  const added: string = next.json?.additional_context
  assert.match(added, /^waffles mode: backlog\./)
  assert.match(added, /waffles command: the person's prompt \/backlog-entry is a waffles command, and the waffles plugin has run it\. It printed: Backlog mode: on\./)
  // Taken once: the tool call after gets nothing.
  assert.equal(hook(state, 'postToolUse', read(cwd)).stdout, '')
  // A prompt in backlog mode goes on; its statement of the mode comes with the next tool call.
  const typed = hook(state, 'beforeSubmitPrompt', INPUTS.beforeSubmitPrompt(cwd, 'the export drops the last row'))
  assert.equal(typed.status, 0)
  assert.equal(typed.stdout, '')
  assert.deepEqual(hook(state, 'postToolUse', read(cwd)).json, { additional_context: 'waffles mode: backlog' })
  // The mode holds in a new conversation's start too.
  assert.match(hook(state, 'sessionStart', INPUTS.sessionStart(cwd)).json?.additional_context, /\n\nwaffles mode: backlog\n\n/)
})

test('/prod after rapid work names it at the next tool call, and keeps it pending, since the model had not read it: the next start names it too', async () => {
  const { state, cwd } = await temp()
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'base')
  hook(state, 'beforeSubmitPrompt', INPUTS.beforeSubmitPrompt(cwd, '/rapid'))
  const r = hook(state, 'beforeSubmitPrompt', INPUTS.beforeSubmitPrompt(cwd, '/prod'))
  assert.equal(r.json?.continue, false)
  assert.equal(r.json?.user_message, 'Rapid mode: off. Back in production mode.')
  const added: string = hook(state, 'postToolUse', read(cwd)).json?.additional_context
  assert.match(added, /^waffles mode: rapid\./)
  assert.match(added, /\n\nwaffles mode: production\. Rapid mode has ended[^\n]* Rapid work since commit [0-9a-f]{40} has not been brought up to standards\./)
  assert.match(hook(state, 'sessionStart', INPUTS.sessionStart(cwd)).json?.additional_context, /waffles mode: production\. Rapid work since commit [0-9a-f]{40} has not been brought up to standards\./)
})

test('a prompt that is no waffles command goes on with nothing printed', async () => {
  const { state, cwd } = await temp()
  assert.equal(hook(state, 'beforeSubmitPrompt', INPUTS.beforeSubmitPrompt(cwd, '/other:prod')).stdout, '')
  assert.equal(hook(state, 'beforeSubmitPrompt', INPUTS.beforeSubmitPrompt(cwd, 'add a test for the export')).stdout, '')
  assert.equal(hook(state, 'postToolUse', read(cwd)).stdout, '')
})

test('a push that worked gets the checkpoint line; one that failed gets nothing', async () => {
  const { state, cwd } = await temp()
  const push = (command: string, output: string) => INPUTS.postToolUse(cwd, 'Shell', { command, working_directory: cwd }, output)
  const r = hook(state, 'postToolUse', push('git push -u origin feat/x', '{"exitCode":0,"stdout":"Everything up-to-date"}'))
  assert.equal(r.status, 0)
  assert.match(r.json?.additional_context, /^waffles checkpoint: /)
  assert.equal(hook(state, 'postToolUse', push('git push', '{"exitCode":1,"stdout":"","stderr":"rejected"}')).stdout, '')
  assert.equal(hook(state, 'postToolUse', push('ls', '{"exitCode":0,"stdout":"README.md"}')).stdout, '')
})

test('Cursor has no event to refuse a question or a permission at: during a run, preToolUse prints nothing', async () => {
  const { state, cwd } = await temp()
  hook(state, 'beforeSubmitPrompt', INPUTS.beforeSubmitPrompt(cwd, '/waffles:non-interactive ship the export'))
  for (let i = 0; i < 3; i += 1) {
    const r = hook(state, 'preToolUse', INPUTS.preToolUse(cwd, 'Shell', { command: 'rm -rf build' }))
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
})

test('stop and sessionEnd answer with nothing', async () => {
  const { state, cwd } = await temp()
  for (const [event, stdin] of [
    ['stop', INPUTS.stop(cwd)],
    ['sessionEnd', INPUTS.sessionEnd(cwd)],
  ] as const) {
    const r = hook(state, event, stdin)
    assert.equal(r.status, 0, event)
    assert.equal(r.stdout, '', event)
  }
})

test('malformed input fails open: exit 0, nothing printed', async () => {
  const { state, cwd } = await temp()
  for (const [event, stdin] of [
    ['beforeSubmitPrompt', '{ not json'],
    ['beforeSubmitPrompt', ''],
    ['beforeSubmitPrompt', JSON.stringify({ ...INPUTS.beforeSubmitPrompt(cwd, '/rapid'), conversation_id: 42, session_id: undefined })],
    ['beforeSubmitPrompt', JSON.stringify({ ...INPUTS.beforeSubmitPrompt(cwd, '/rapid'), workspace_roots: 'nope' })],
    ['postToolUse', '[1, 2]'],
    ['postToolUse', JSON.stringify({ ...read(cwd), tool_name: 42 })],
    ['sessionStart', JSON.stringify({ hook_event_name: 'sessionStart' })],
    ['afterShellExecution', JSON.stringify({ ...common(cwd, 'afterShellExecution'), command: 'git push', output: '', duration: 1, sandbox: false })],
  ] as const) {
    const r = hook(state, event, stdin)
    assert.equal(r.status, 0, `${event} ${stdin}`)
    assert.equal(r.stdout, '', `${event} ${stdin}`)
    assert.equal(r.stderr, '', `${event} ${stdin}`)
  }
})

test('the hooks file names only events the table reads, each through the plugin root', async () => {
  const file = JSON.parse(await fs.readFile(join(ROOT, 'adapters/command/cursor-hooks.json'), 'utf8')) as { version: number; hooks: Record<string, { command: string; timeout: number }[]> }
  assert.equal(file.version, 1)
  for (const [event, hooks] of Object.entries(file.hooks)) {
    for (const { command } of hooks) assert.equal(command, `node "\${CURSOR_PLUGIN_ROOT}/adapters/command/cli.ts" cursor ${event}`)
  }
  assert.deepEqual(Object.keys(file.hooks).sort(), ['beforeSubmitPrompt', 'postToolUse', 'sessionEnd', 'sessionStart', 'stop'])
  const manifest = JSON.parse(await fs.readFile(join(ROOT, '.cursor-plugin/plugin.json'), 'utf8')) as Json
  assert.equal(manifest.hooks, './adapters/command/cursor-hooks.json')
  assert.equal(manifest.mcpServers, './adapters/command/cursor-mcp.json')
})

test('a shell result names its failure by its exit code', () => {
  assert.equal(isFailed('{"exitCode":0,"stdout":"All tests passed"}'), false)
  assert.equal(isFailed('{"exitCode":128,"stderr":"fatal"}'), true)
  assert.equal(isFailed({ exitCode: 2 }), true)
  assert.equal(isFailed('{"redacted":true}'), false)
  assert.equal(isFailed('plain output'), false)
  assert.equal(isFailed(null), false)
})
