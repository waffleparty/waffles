import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The MCP server's specs' client: the server as a child process, spoken to one line at a time. */

export type Message = Record<string, any>

export const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.ts')
export const CURRENT = '2026-07-28'
export const PREVIOUS = '2025-11-25'
/** The `_meta` a 2026-07-28 client puts on every request. */
export const META = {
  'io.modelcontextprotocol/protocolVersion': CURRENT,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
}
/** A server that never answers fails the test instead of hanging it. */
export const LIMIT = { timeout: 20_000 }

// The variables a test may set; any other test's value is never inherited from the shell.
const OURS = ['WAFFLES_SESSION_ID', 'WAFFLES_PLAN_TOOL', 'WAFFLES_ASK_TOOL', 'WAFFLES_SKILL_PREFIX', 'WAFFLES_RUN_COMMAND', 'WAFFLES_TOOL_PREFIX', 'WAFFLES_MCP_MODULES', 'WAFFLES_DEBUG']

// A test that fails part way leaves its server running: `stopAll` stops each, so the run ends.
const children = new Set<ReturnType<typeof spawn>>()
export const stopAll = () => {
  for (const child of children) child.kill('SIGKILL')
}

export async function folders() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'waffles-mcp-')))
  const work = join(root, 'work')
  await fs.mkdir(work)
  return { root, work, state: join(root, 'state') }
}

/** Takes messages in the order they came, or the first that matches, waiting for one that hasn't come yet. */
export function inbox() {
  const kept: Message[] = []
  const waiting: { match: (message: Message) => boolean; resolve: (message: Message) => void }[] = []
  return {
    put(message: Message) {
      const at = waiting.findIndex(w => w.match(message))
      if (at >= 0) waiting.splice(at, 1)[0]!.resolve(message)
      else kept.push(message)
    },
    take(match: (message: Message) => boolean = () => true): Promise<Message> {
      const at = kept.findIndex(match)
      if (at >= 0) return Promise.resolve(kept.splice(at, 1)[0]!)
      return new Promise(resolve => waiting.push({ match, resolve }))
    },
    /** The messages come and not yet taken. */
    kept: () => [...kept],
  }
}

export function server(work: string, state: string, extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, WAFFLES_STATE_DIR: state, WAFFLES_CWD: work, ...extra }
  for (const key of OURS) if (!(key in extra)) delete env[key]
  const child = spawn(process.execPath, [SERVER], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  let out = ''
  let stderr = ''
  const box = inbox()
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk
    let end: number
    while ((end = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, end)
      out = out.slice(end + 1)
      // Every line on stdout must be one JSON-RPC message: this throws on anything else.
      const message = JSON.parse(line) as Message
      assert.equal(message.jsonrpc, '2.0', line)
      box.put(message)
    }
  })
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
  let nextId = 1
  const write = (line: string) => child.stdin.write(`${line}\n`)
  /** The next message from the server, in the order it wrote them. */
  const next = () => box.take()
  /** The answer to a request, whatever notifications came before it. */
  const request = async (method: string, params?: Message) => {
    const id = nextId++
    write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }))
    return box.take(m => m.id === id && !('method' in m))
  }
  /** The next notification with this method. */
  const notification = (method: string) => box.take(m => m.method === method && !('id' in m))
  const notify = (method: string, params?: Message) => write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }))
  const initialize = (protocolVersion = PREVIOUS) =>
    request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } })
  const close = async () => {
    child.stdin.end()
    return exited
  }
  return { child, write, next, request, notification, notify, initialize, close, exited, kept: box.kept, stderr: () => stderr }
}

/** The text of a tool result or a prompt's first message. */
export const text = (reply: Message): string =>
  reply.result.content ? reply.result.content.map((part: Message) => part.text).join('') : reply.result.messages[0].content.text
