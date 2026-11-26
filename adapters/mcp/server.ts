import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import type { Names } from '../../core/host.ts'
import { callPlan, endPlan, PLAN_TOOL, POLL_MS, startPlan, tickPlan } from '../../core/plan.ts'
import { planRules } from '../../core/plan-prompt.ts'
import { forgetSession, nodeHost, pruneSessions, stateFolder } from '../node/host.ts'

/**
 * The waffles plugin's MCP server: the plan outline tool, for a platform whose plugins can't register a
 * tool in code (Cursor, Codex, Antigravity) and take tools only from MCP servers. Run it as
 * `node <plugin>/adapters/mcp/server.ts`; it speaks MCP over stdio, one JSON-RPC message per line.
 *
 * Built against MCP revision 2026-07-28 (modelcontextprotocol.io/specification/2026-07-28) and its
 * predecessor 2025-11-25. The two differ in kind: 2026-07-28 has no handshake, and every request names
 * its version in `_meta`; 2025-11-25 opens with `initialize`. The server is what the spec calls
 * dual-era: a request with the per-request `_meta` is served as 2026-07-28, and an `initialize` starts
 * 2025-11-25 for the rest of the process. So a client of either revision works, and a client that
 * supports both finds the newer one by its `server/discover` probe.
 *
 * Nothing but protocol messages goes to stdout; logs go to stderr.
 */

/** The revisions served per request, by `_meta`. */
const MODERN: readonly string[] = ['2026-07-28']
/** The revisions served after an `initialize`, newest first: the first is the answer to an `initialize` that names another. */
const LEGACY: readonly string[] = ['2025-11-25']
const SUPPORTED = [...MODERN, ...LEGACY]

const META = 'io.modelcontextprotocol/'
const NAME = 'waffles'

// JSON-RPC's codes, and the one of MCP's own that this server sends.
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603
const UNSUPPORTED_VERSION = -32022

// How long a list result may be reused: the tool and the rules never change while the process lives.
const TTL_MS = 60 * 60 * 1000
// How long the end waits for calls under way to answer before it releases the goal.
const END_WAIT_MS = 5_000

type Id = string | number
type Json = Record<string, unknown>

class RpcError extends Error {
  code: number
  data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
// JSON-RPC allows a null ID; MCP doesn't.
const isId = (value: unknown): value is Id => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))

const log = (message: string) => {
  process.stderr.write(`waffles mcp: ${message}\n`)
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The names the rules use. A client shows the model an MCP tool under a name of its own, most often
 * `mcp__<server>__<tool>`, so the person can name it; the same for the tool the model asks a question with.
 * Where the client has no such tool, the default ask reads as plain words and the model asks in the chat.
 */
function namesOf(env: NodeJS.ProcessEnv): Names {
  return {
    assistant: 'The agent',
    product: 'the MCP client',
    planTool: env.WAFFLES_PLAN_TOOL || `mcp__${NAME}__${PLAN_TOOL.name}`,
    ask: env.WAFFLES_ASK_TOOL || 'a multiple-choice question',
    planMode: null,
  }
}

// The plugin's version, from its Claude Code manifest: the same in every manifest.
function versionOf(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'))
    return isObject(manifest) && typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const env = process.env
const names = namesOf(env)
const instructions = planRules(names)
const serverInfo = { name: NAME, title: 'waffles', version: versionOf() }
// The protocol gives no session ID. One the platform's hooks share comes from the environment, so the
// mode and the goal agree between them and this server; else the session is this process.
const isOwnSession = !env.WAFFLES_SESSION_ID
const sessionId = env.WAFFLES_SESSION_ID || `mcp-${randomUUID()}`
const folder = stateFolder(env)
const $ = nodeHost({ sessionId, cwd: env.WAFFLES_CWD || process.cwd(), names, stateFolder: folder })

const TOOL = { name: PLAN_TOOL.name, description: PLAN_TOOL.description, inputSchema: PLAN_TOOL.inputSchema }

// The revision an `initialize` chose; null until one came.
let legacy: string | null = null
let timer: ReturnType<typeof setInterval> | undefined
let started: Promise<void> | null = null

// The plan outline starts at the first `initialize`, or at a 2026-07-28 client's first request, which has
// no handshake before it. The heartbeat keeps the session's lock on its goal live while the process lives.
const start = () =>
  (started ??= (async () => {
    await pruneSessions(folder, sessionId).catch(error => log(`old sessions were not pruned: ${messageOf(error)}`))
    await startPlan($).catch(error => log(`the plan outline did not start: ${messageOf(error)}`))
    timer = setInterval(() => void tickPlan($), POLL_MS)
    timer.unref()
  })())

async function callTool(params: Json): Promise<Json> {
  if (params.name !== TOOL.name) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(params.name)}`)
  const input = params.arguments ?? {}
  if (!isObject(input)) throw new RpcError(INVALID_PARAMS, 'The tool arguments must be an object.')
  await start()
  const answer = await callPlan($, input)
  // A refusal is the tool's answer, which the model reads and acts on, not a failure of the protocol.
  return 'deny' in answer ? { content: [{ type: 'text', text: answer.deny }], isError: true } : { content: [{ type: 'text', text: answer.result }], isError: false }
}

// A request that names its revision in `_meta`, served as that revision: on its own, with nothing
// taken from earlier requests.
async function modern(method: string, params: Json, meta: Json): Promise<Json> {
  const version = meta[`${META}protocolVersion`]
  if (typeof version !== 'string' || !MODERN.includes(version)) {
    throw new RpcError(UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED, requested: version })
  }
  if (!isObject(meta[`${META}clientCapabilities`])) throw new RpcError(INVALID_PARAMS, `_meta has no ${META}clientCapabilities.`)
  const done = (result: Json) => ({ resultType: 'complete', ...result, _meta: { [`${META}serverInfo`]: serverInfo } })
  const cached = { ttlMs: TTL_MS, cacheScope: 'private' }
  switch (method) {
    case 'server/discover':
      await start()
      return done({ supportedVersions: SUPPORTED, capabilities: { tools: {} }, instructions, ...cached })
    case 'tools/list':
      await start()
      return done({ tools: [TOOL], ...cached })
    case 'tools/call':
      return done(await callTool(params))
    default:
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
  }
}

// A request with no revision in `_meta`: the handshake, or a request after it.
async function handshake(method: string, params: Json): Promise<Json> {
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion
      if (typeof asked !== 'string') throw new RpcError(INVALID_PARAMS, 'initialize needs a protocolVersion.')
      // A revision this server doesn't serve gets its newest handshake revision; the client decides whether to go on.
      legacy = LEGACY.includes(asked) ? asked : LEGACY[0]!
      await start()
      return { protocolVersion: legacy, capabilities: { tools: {} }, serverInfo, instructions }
    }
    // Allowed before the handshake too.
    case 'ping':
      return {}
    case 'tools/list':
    case 'tools/call':
    case 'server/discover':
      // Before a handshake, a request must name its revision; `server/discover` always must.
      if (legacy === null || method === 'server/discover') {
        const before = legacy === null ? ', and no initialize came before it' : ''
        throw new RpcError(INVALID_PARAMS, `The request names no protocol version in _meta (${META}protocolVersion)${before}.`, { supported: SUPPORTED })
      }
      return method === 'tools/list' ? { tools: [TOOL] } : callTool(params)
    default:
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
  }
}

async function request(method: string, params: Json): Promise<Json> {
  const meta = params._meta
  // An `initialize` always opens the handshake: a 2026-07-28 client never sends one.
  if (method !== 'initialize' && isObject(meta) && `${META}protocolVersion` in meta) return modern(method, params, meta)
  return handshake(method, params)
}

const error = (id: Id | null, code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0',
  id,
  error: data === undefined ? { code, message } : { code, message, data },
})

/** The answer to one line from the client, or null where none is due: a notification, or a response. */
async function answer(line: string): Promise<Json | null> {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return error(null, PARSE_ERROR, 'Parse error: the line is not JSON.')
  }
  if (Array.isArray(message)) return error(null, INVALID_REQUEST, 'Batches are not supported.')
  if (!isObject(message)) return error(null, INVALID_REQUEST, 'A message must be a JSON object.')
  const id = message.id
  const hasId = 'id' in message
  // A response to a request: this server sends none, so it has nothing to match.
  if (!('method' in message) && ('result' in message || 'error' in message)) return null
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (hasId && !isId(id))) {
    return error(isId(id) ? id : null, INVALID_REQUEST, 'Invalid request: it needs jsonrpc "2.0", a string method, and a string or number id.')
  }
  const params = message.params ?? {}
  // A notification gets no answer, whatever it is: notifications/initialized and notifications/cancelled
  // ask nothing of this server, and a call under way can't be stopped part way.
  if (!hasId || !isId(id)) return null
  if (!isObject(params)) return error(id, INVALID_PARAMS, 'params must be an object.')
  try {
    return { jsonrpc: '2.0', id, result: await request(message.method, params) }
  } catch (failure) {
    if (failure instanceof RpcError) return error(id, failure.code, failure.message, failure.data)
    log(`${message.method} failed: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`)
    return error(id, INTERNAL_ERROR, `Internal error: ${messageOf(failure)}`)
  }
}

let isOutClosed = false
// JSON.stringify escapes every newline inside a string, so a message is always one line.
const send = (message: Json) => {
  if (!isOutClosed) process.stdout.write(`${JSON.stringify(message)}\n`)
}
// The client stopped reading: nothing more can reach it.
process.stdout.on('error', () => {
  isOutClosed = true
  void end('stdout closed')
})

const pending = new Set<Promise<void>>()
let ending: Promise<void> | null = null

/**
 * The client closed stdin or stopped the process. Calls under way answer first; then the lock on the
 * goal is released. The session's record stays, so a later process with the same session ID continues
 * the goal; the values of a session this process made up are removed, since nothing can name it again.
 */
function end(why: string): Promise<void> {
  return (ending ??= (async () => {
    clearInterval(timer)
    let wait: ReturnType<typeof setTimeout> | undefined
    await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => (wait = setTimeout(resolve, END_WAIT_MS)))])
    clearTimeout(wait)
    if (started !== null) {
      await started
      await endPlan($, sessionId, false).catch(error => log(`the plan outline did not end: ${messageOf(error)}`))
      if (isOwnSession) await forgetSession(folder, sessionId).catch(() => undefined)
    }
    if (env.WAFFLES_DEBUG) log(`ended: ${why}`)
    // An empty write calls back once the writes before it are out, so no answer is cut off by the exit.
    if (!isOutClosed) await new Promise<void>(resolve => process.stdout.write('', () => resolve()))
    process.exit(0)
  })())
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
  if (!line.trim() || ending !== null) return
  const work = answer(line).then(
    reply => {
      if (reply !== null) send(reply)
    },
    failure => log(`a message was not answered: ${messageOf(failure)}`),
  )
  pending.add(work)
  void work.finally(() => pending.delete(work))
})
lines.on('close', () => void end('stdin ended'))
process.on('SIGTERM', () => void end('SIGTERM'))
process.on('SIGINT', () => void end('SIGINT'))
