import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { callPlan, startPlan } from '../../core/plan.ts'
import { forgetSession, nodeHost, pruneSessions, sessionPath, SESSION_MS, stateFolder } from './host.ts'

const NAMES = { assistant: 'Agent', product: 'Test', planTool: 'plan', ask: 'question', planMode: null }

async function temp(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(join(tmpdir(), 'waffles-host-')))
}

async function host(sessionId = 's1') {
  const root = await temp()
  const state = join(root, 'state')
  const cwd = join(root, 'work')
  await fs.mkdir(cwd)
  return { root, state, cwd, $: nodeHost({ sessionId, cwd, names: NAMES, stateFolder: state }) }
}

test('a session value reads as its default until set, then as set, from another process too', async () => {
  const { $, state, cwd } = await host()
  assert.equal(await $.state.get('mode'), 'production')
  assert.deepEqual(await $.state.get('planChanged'), [])
  await $.state.set('mode', 'rapid')
  assert.equal(await $.state.get('mode'), 'rapid')
  // A second host stands for a second process that serves the same session.
  const other = nodeHost({ sessionId: 's1', cwd, names: NAMES, stateFolder: state })
  assert.equal(await other.state.get('mode'), 'rapid')
})

test('a session value never reaches another session', async () => {
  const { $, state, cwd } = await host()
  await $.state.set('mode', 'backlog')
  const other = nodeHost({ sessionId: 's2', cwd, names: NAMES, stateFolder: state })
  assert.equal(await other.state.get('mode'), 'production')
})

test("the person's values hold for every session", async () => {
  const { $, state, cwd } = await host()
  assert.equal(await $.store.get('effort.enabled'), undefined)
  await $.store.set('effort.enabled', false)
  const other = nodeHost({ sessionId: 's2', cwd, names: NAMES, stateFolder: state })
  assert.equal(await other.store.get('effort.enabled'), false)
})

test('writes of several keys at once all land', async () => {
  const { $ } = await host()
  await Promise.all([$.state.set('mode', 'rapid'), $.state.set('run', true), $.state.set('planGoal', 'a-goal')])
  assert.equal(await $.state.get('mode'), 'rapid')
  assert.equal(await $.state.get('run'), true)
  assert.equal(await $.state.get('planGoal'), 'a-goal')
})

test('a value file that does not parse, or has another format, reads as the defaults', async () => {
  const { $, state } = await host()
  await fs.mkdir(join(state, 'sessions'), { recursive: true })
  await fs.writeFile(sessionPath(state, 's1'), '{ not json')
  assert.equal(await $.state.get('mode'), 'production')
  await fs.writeFile(sessionPath(state, 's1'), JSON.stringify({ format: 99, values: { mode: 'rapid' } }))
  assert.equal(await $.state.get('mode'), 'production')
})

test('a session ID that could leave the folder is named by its hash', async () => {
  const state = '/state'
  assert.equal(sessionPath(state, 'abc-123_x'), join(state, 'sessions', 'abc-123_x.json'))
  const odd = sessionPath(state, '../../etc/passwd')
  assert.match(odd, /sessions[\\/][0-9a-f]{64}\.json$/)
})

test('forgetting a session removes its values, and old sessions are pruned', async () => {
  const { $, state, cwd } = await host()
  await $.state.set('mode', 'rapid')
  const old = nodeHost({ sessionId: 'old', cwd, names: NAMES, stateFolder: state })
  await old.state.set('mode', 'backlog')
  await pruneSessions(state, 's1', Date.now() + SESSION_MS + 1000)
  assert.equal(await old.state.get('mode'), 'production')
  // The session that prunes keeps its own values.
  assert.equal(await $.state.get('mode'), 'rapid')
  await forgetSession(state, 's1')
  assert.equal(await $.state.get('mode'), 'production')
})

test('files: write makes the folders, list and stat describe, remove is quiet for a missing file', async () => {
  const { $, cwd } = await host()
  const path = join(cwd, 'a', 'b', 'note.txt')
  assert.equal(await $.fs.exists(path), false)
  await $.fs.write(path, 'hello')
  assert.equal(await $.fs.read(path), 'hello')
  assert.equal(await $.fs.exists(path), true)
  assert.equal((await $.fs.stat(path)).kind, 'file')
  assert.equal((await $.fs.stat(join(cwd, 'a'))).kind, 'dir')
  const [entry] = await $.fs.list(join(cwd, 'a', 'b'))
  assert.deepEqual({ name: entry?.name, kind: entry?.kind, size: entry?.size }, { name: 'note.txt', kind: 'file', size: 5 })
  await $.fs.remove(path)
  await $.fs.remove(path)
  assert.equal(await $.fs.exists(path), false)
  await assert.rejects($.fs.read(path))
})

test('a run answers with the exit code and output, takes input, and rejects when it cannot start or runs too long', async () => {
  const { $ } = await host()
  const node = process.execPath
  const ok = await $.process.run([node, '-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'])
  assert.deepEqual(ok, { exitCode: 3, stdout: 'out', stderr: 'err' })
  const echoed = await $.process.run([node, '-e', 'process.stdin.pipe(process.stdout)'], { stdin: 'given' })
  assert.equal(echoed.stdout, 'given')
  const where = await $.process.run([node, '-e', 'process.stdout.write(process.cwd())'])
  assert.equal(await fs.realpath(where.stdout), await $.session.cwd())
  await assert.rejects($.process.run(['waffles-no-such-command']))
  await assert.rejects($.process.run([node, '-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 100 }))
})

test('the state folder follows the environment', () => {
  assert.equal(stateFolder({ WAFFLES_STATE_DIR: '/x' }), '/x')
  assert.equal(stateFolder({ XDG_STATE_HOME: '/xdg' }), join('/xdg', 'waffles'))
})

test('the plan outline tool works end to end outside git, and a second process continues the goal', async () => {
  const { $, state, cwd } = await host()
  await startPlan($)
  const made = await callPlan($, { op: 'goal', title: 'Ship it', steps: [{ title: 'Build' }, { title: 'Test' }] })
  assert.ok('result' in made, JSON.stringify(made))
  assert.match(made.result, /Ship it/)
  assert.equal(await $.state.get('planGoal'), 'ship-it')
  assert.match(await fs.readFile(join(cwd, '.waffles', 'plan', 'ship-it.md'), 'utf8'), /Build/)

  // The next event of the same session comes to a new process: the goal is still active there.
  const next = nodeHost({ sessionId: 's1', cwd, names: NAMES, stateFolder: state })
  await startPlan(next)
  const done = await callPlan(next, { op: 'done', ids: ['1'] })
  assert.ok('result' in done, JSON.stringify(done))
  assert.match(await fs.readFile(join(cwd, '.waffles', 'plan', 'ship-it.md'), 'utf8'), /\[x\] 1 Build/)
})
