import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PLAN_TOOL } from '../../core/plan.ts'

type Json = Record<string, any>

// A test that fails part way leaves its server running: each is stopped at the end, so the run ends.
const children = new Set<ReturnType<typeof spawn>>()
after(() => {
  for (const child of children) child.kill('SIGKILL')
})
// A server that never answers fails the test instead of hanging it.
const LIMIT = { timeout: 20_000 }

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.ts')
const CURRENT = '2026-07-28'
const PREVIOUS = '2025-11-25'
// The `_meta` a 2026-07-28 client puts on every request.
const META = {
  'io.modelcontextprotocol/protocolVersion': CURRENT,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
}

async function folders() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'waffles-mcp-')))
  const work = join(root, 'work')
  await fs.mkdir(work)
  return { root, work, state: join(root, 'state') }
}

/** The server as a child process, and a client that speaks to it one line at a time. */
function server(work: string, state: string, extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, WAFFLES_STATE_DIR: state, WAFFLES_CWD: work, ...extra }
  for (const key of ['WAFFLES_SESSION_ID', 'WAFFLES_PLAN_TOOL', 'WAFFLES_ASK_TOOL', 'WAFFLES_DEBUG']) if (!(key in extra)) delete env[key]
  const child = spawn(process.execPath, [SERVER], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  let out = ''
  let stderr = ''
  const messages: Json[] = []
  const waiting: ((message: Json) => void)[] = []
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk
    let end: number
    while ((end = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, end)
      out = out.slice(end + 1)
      // Every line on stdout must be one JSON-RPC message: this throws on anything else.
      const message = JSON.parse(line) as Json
      assert.equal(message.jsonrpc, '2.0', line)
      const waiter = waiting.shift()
      if (waiter) waiter(message)
      else messages.push(message)
    }
  })
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
  let nextId = 1
  const write = (line: string) => child.stdin.write(`${line}\n`)
  // The next message from the server, in the order it wrote them.
  const next = () => new Promise<Json>(resolve => (messages.length ? resolve(messages.shift()!) : waiting.push(resolve)))
  const request = async (method: string, params?: Json) => {
    const id = nextId++
    write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }))
    const reply = await next()
    assert.equal(reply.id, id, JSON.stringify(reply))
    return reply
  }
  const notify = (method: string, params?: Json) => write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }))
  const initialize = (protocolVersion = PREVIOUS) =>
    request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } })
  const close = async () => {
    child.stdin.end()
    return exited
  }
  return { child, write, next, request, notify, initialize, close, exited, stderr: () => stderr }
}

const text = (reply: Json): string => reply.result.content.map((part: Json) => part.text).join('')

test('the handshake answers with the revision asked for, the tool, and the rules as instructions', LIMIT, async () => {
  const { work, state } = await folders()
  const s = server(work, state)
  const init = await s.initialize(PREVIOUS)
  assert.equal(init.result.protocolVersion, PREVIOUS)
  assert.deepEqual(init.result.capabilities, { tools: {} })
  assert.equal(init.result.serverInfo.name, 'waffles')
  assert.match(init.result.instructions, /# waffles plan outline/)
  assert.match(init.result.instructions, /only with the mcp__waffles__plan tool/)
  assert.match(init.result.instructions, /ask the person with a multiple-choice question/)
  // A notification gets no answer: the next message is the ping's.
  s.notify('notifications/initialized')
  assert.deepEqual((await s.request('ping')).result, {})

  const list = await s.request('tools/list')
  // A 2025-11-25 result has no resultType or cache fields.
  assert.deepEqual(list.result, { tools: [{ name: 'plan', description: PLAN_TOOL.description, inputSchema: PLAN_TOOL.inputSchema }] })
  assert.deepEqual(await s.close(), { code: 0, signal: null })
})

test('a handshake that asks for a revision the server lacks gets its newest handshake revision', LIMIT, async () => {
  const { work, state } = await folders()
  const s = server(work, state)
  assert.equal((await s.initialize('2024-11-05')).result.protocolVersion, PREVIOUS)
  assert.equal((await s.request('initialize', { capabilities: {} })).error.code, -32602)
  await s.close()
})

test('a goal call changes the outline, a refused call is a tool error, and other mistakes are protocol errors', LIMIT, async () => {
  const { work, state } = await folders()
  const s = server(work, state)
  // Before the handshake, a request with no revision in _meta is malformed.
  const early = await s.request('tools/list')
  assert.equal(early.error.code, -32602)
  assert.deepEqual(early.error.data.supported, [CURRENT, PREVIOUS])
  await s.initialize()
  s.notify('notifications/initialized')

  const made = await s.request('tools/call', { name: 'plan', arguments: { op: 'goal', title: 'Ship it', steps: [{ title: 'Build' }, { title: 'Test' }] } })
  assert.equal(made.result.isError, false)
  assert.match(text(made), /Ship it/)
  assert.match(await fs.readFile(join(work, '.tmp', 'plan', 'ship-it.md'), 'utf8'), /Build/)

  const refused = await s.request('tools/call', { name: 'plan', arguments: { op: 'done', ids: ['9'] } })
  assert.equal(refused.error, undefined)
  assert.equal(refused.result.isError, true)
  assert.match(text(refused), /No step 9/)

  assert.equal((await s.request('tools/call', { name: 'other', arguments: {} })).error.code, -32602)
  assert.equal((await s.request('tools/call', { name: 'plan', arguments: ['op'] })).error.code, -32602)
  const unknown = await s.request('resources/list')
  assert.equal(unknown.error.code, -32601)
  assert.match(unknown.error.message, /resources\/list/)

  // A line that isn't JSON, and JSON that isn't a request, answer with id null; the server goes on.
  s.write('{"jsonrpc": "2.0", "id": 7, "method": ')
  assert.deepEqual(await s.next(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the line is not JSON.' } })
  s.write('[1, 2]')
  assert.equal((await s.next()).error.code, -32600)
  s.write('{"jsonrpc": "2.0", "id": null, "method": "ping"}')
  assert.deepEqual([(await s.next()).error.code], [-32600])
  s.write('{"jsonrpc": "1.0", "id": 8, "method": "ping"}')
  assert.deepEqual(await s.next().then(m => [m.id, m.error.code]), [8, -32600])
  // A response from the client and a blank line get no answer.
  s.write('{"jsonrpc": "2.0", "id": 5, "result": {}}')
  s.write('')
  assert.deepEqual((await s.request('ping')).result, {})

  assert.deepEqual(await s.close(), { code: 0, signal: null })
  assert.equal(s.stderr().includes('failed'), false, s.stderr())
})

test('a 2026-07-28 request is served on its own, by the _meta it carries', LIMIT, async () => {
  const { work, state } = await folders()
  const s = server(work, state, { WAFFLES_PLAN_TOOL: 'waffles_plan', WAFFLES_ASK_TOOL: 'AskQuestion' })
  const discover = await s.request('server/discover', { _meta: META })
  assert.equal(discover.result.resultType, 'complete')
  assert.deepEqual(discover.result.supportedVersions, [CURRENT, PREVIOUS])
  assert.deepEqual(discover.result.capabilities, { tools: {} })
  assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].name, 'waffles')
  assert.equal(typeof discover.result.ttlMs, 'number')
  assert.match(discover.result.instructions, /only with the waffles_plan tool/)
  assert.match(discover.result.instructions, /ask the person with AskQuestion/)

  const list = await s.request('tools/list', { _meta: META })
  assert.equal(list.result.resultType, 'complete')
  assert.deepEqual(list.result.tools.map((tool: Json) => tool.name), ['plan'])

  const made = await s.request('tools/call', { _meta: META, name: 'plan', arguments: { op: 'goal', title: 'Ship it' } })
  assert.equal(made.result.resultType, 'complete')
  assert.equal(made.result.isError, false)

  const old = await s.request('tools/list', { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } })
  assert.deepEqual(old.error, { code: -32022, message: 'Unsupported protocol version', data: { supported: [CURRENT, PREVIOUS], requested: '1900-01-01' } })
  const { 'io.modelcontextprotocol/clientCapabilities': _, ...bare } = META
  assert.equal((await s.request('tools/list', { _meta: bare })).error.code, -32602)
  // 2026-07-28 has no ping.
  assert.equal((await s.request('ping', { _meta: META })).error.code, -32601)
  // An answer to a call under way still goes out when stdin ends right after it.
  s.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { _meta: META, name: 'plan', arguments: { op: 'show' } } }))
  const ended = s.close()
  assert.equal((await s.next()).id, 99)
  assert.deepEqual(await ended, { code: 0, signal: null })
})

test('a second process with the same session ID continues the goal; one with none starts with no goal', LIMIT, async () => {
  const { work, state } = await folders()
  const first = server(work, state, { WAFFLES_SESSION_ID: 'shared-1' })
  await first.initialize()
  await first.request('tools/call', { name: 'plan', arguments: { op: 'goal', title: 'Ship it', steps: [{ title: 'Build' }, { title: 'Test' }] } })
  assert.deepEqual(await first.close(), { code: 0, signal: null })

  const second = server(work, state, { WAFFLES_SESSION_ID: 'shared-1' })
  await second.initialize()
  const done = await second.request('tools/call', { name: 'plan', arguments: { op: 'done', ids: ['1'] } })
  assert.equal(done.result.isError, false, text(done))
  assert.match(await fs.readFile(join(work, '.tmp', 'plan', 'ship-it.md'), 'utf8'), /\[x\] 1 Build/)
  // SIGTERM ends it as cleanly as the end of stdin.
  second.child.kill('SIGTERM')
  assert.deepEqual(await second.exited, { code: 0, signal: null })

  const other = server(work, state)
  await other.initialize()
  const refused = await other.request('tools/call', { name: 'plan', arguments: { op: 'done', ids: ['2'] } })
  assert.equal(refused.result.isError, true)
  assert.match(text(refused), /No active goal/)
  // The ended process released its lock, so another session can continue the goal at once.
  const taken = await other.request('tools/call', { name: 'plan', arguments: { op: 'goal', switch: 'ship-it' } })
  assert.equal(taken.result.isError, false, text(taken))
  await other.close()
  // A session the process made up leaves no values behind; a shared one keeps its own.
  assert.deepEqual(await fs.readdir(join(state, 'sessions')), ['shared-1.json'])
})
