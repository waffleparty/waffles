import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { chosenModules } from './modules.ts'
import { registryOf, SERVER_NAME, type Json, type ListKind, type Module, type Registry, type Tool, type ToolAnswer } from './registry.ts'
import { sessionsOf, type Change } from './sessions.ts'

/**
 * The waffles plugin's MCP server, for a platform whose plugins can't register a tool or a command in
 * code (Cursor, Codex, Antigravity) and take them only from MCP servers. Run it as
 * `node <plugin>/adapters/mcp/server.ts`; it speaks MCP over stdio, one JSON-RPC message per line.
 *
 * This file is the transport and the protocol only. What the server offers comes from the modules
 * (`modules.ts`) through the registry (`registry.ts`); the sessions and their Hosts are in `sessions.ts`.
 *
 * Built against MCP revision 2026-07-28 (modelcontextprotocol.io/specification/2026-07-28) and its
 * predecessor 2025-11-25. The two differ in kind: 2026-07-28 has no handshake, and every request names
 * its version in `_meta`; 2025-11-25 opens with `initialize`. The server is what the spec calls
 * dual-era: a request with the per-request `_meta` is served as 2026-07-28, and an `initialize` starts
 * 2025-11-25 for the rest of the process. So a client of either revision works, and a client that
 * supports both finds the newer one by its `server/discover` probe.
 *
 * What each revision has, and how this server serves it:
 * - Both: `tools/list`, `tools/call`, `prompts/list`, `prompts/get`, `resources/list`, `resources/read`,
 *   and `resources/templates/list`; the capabilities `tools`, `prompts`, and `resources`, with the flags
 *   `listChanged` and `resources.subscribe`; and the notifications `notifications/tools/list_changed`,
 *   `notifications/prompts/list_changed`, `notifications/resources/list_changed`, and
 *   `notifications/resources/updated`.
 * - 2025-11-25: a client subscribes to a resource with `resources/subscribe` and stops with
 *   `resources/unsubscribe`. A list change is sent to any client that has initialized, with no params.
 *   A resource that isn't there is error -32002. `ping` is served.
 * - 2026-07-28: no `resources/subscribe` and no `ping`. A client opens a stream with
 *   `subscriptions/listen`, naming what it wants (`toolsListChanged`, `promptsListChanged`,
 *   `resourcesListChanged`, `resourceSubscriptions`); the server acknowledges with
 *   `notifications/subscriptions/acknowledged`, which names the part it honors, and every notification
 *   on the stream carries the request's ID as `io.modelcontextprotocol/subscriptionId` in `_meta`. The
 *   client ends a stream with `notifications/cancelled`; at shutdown the server answers each open
 *   `subscriptions/listen` request, which ends it. Results carry `resultType`, and lists and reads carry
 *   `ttlMs` and `cacheScope`. A resource that isn't there is error -32602.
 *
 * Nothing but protocol messages goes to stdout; logs go to stderr.
 */

/** The revisions served per request, by `_meta`. */
const MODERN: readonly string[] = ['2026-07-28']
/** The revisions served after an `initialize`, newest first: the first is the answer to an `initialize` that names another. */
const LEGACY: readonly string[] = ['2025-11-25']
const SUPPORTED = [...MODERN, ...LEGACY]

const META = 'io.modelcontextprotocol/'
const SUBSCRIPTION = `${META}subscriptionId`

// JSON-RPC's codes, and the ones of MCP's own that this server sends.
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603
const UNSUPPORTED_VERSION = -32022
const RESOURCE_NOT_FOUND = -32002

// How long a list may be reused: the modules' lists never change while the process lives, unless a
// module says its list does. A resource's text can change at any time.
const TTL_MS = 60 * 60 * 1000
// How long the end waits for calls under way to answer before it ends the sessions.
const END_WAIT_MS = 5_000

const LISTS: readonly ListKind[] = ['tools', 'prompts', 'resources']

type Id = string | number
type Era = 'modern' | 'legacy'

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

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// An object with the fields that hold a value: the spec's optional fields are left out, not null.
const defined = (fields: Json): Json => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))

// The plugin's version, from its Claude Code manifest: the same in every manifest.
function versionOf(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'))
    return isObject(manifest) && typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** A tool as `tools/list` lists it. */
const listed = ({ name, title, description, inputSchema, outputSchema, annotations }: Tool): Json =>
  defined({ name, title, description, inputSchema, outputSchema, annotations })

/**
 * A tool's answer as a `tools/call` result. A structured value goes with its JSON as the text, for a
 * client that reads only text. 2025-11-25 allows only an object as `structuredContent`; any other value
 * goes as the text alone.
 */
function resultOf(answer: ToolAnswer, era: Era): Json {
  if ('refusal' in answer) return { content: [{ type: 'text', text: answer.refusal }], isError: true }
  if ('text' in answer) return { content: [{ type: 'text', text: answer.text }], isError: false }
  const text = JSON.stringify(answer.value) ?? 'null'
  const isCarried = era === 'modern' || isObject(answer.value)
  return { content: [{ type: 'text', text }], ...(isCarried ? { structuredContent: answer.value } : {}), isError: false }
}

export type ServerInit = {
  modules: readonly Module[]
  env: NodeJS.ProcessEnv
  /** Writes one message to the client. */
  send(message: Json): void
  log(message: string): void
}

export type Server = {
  registry: Registry
  /** Answers one line from the client, if an answer is due; resolves once it is sent. */
  receive(line: string): Promise<void>
  /** Answers the calls under way, closes the listen streams, and ends the sessions. */
  end(why: string): Promise<void>
}

/** A server over any line transport: stdio below, or a test's. */
export function createServer({ modules, env, send, log }: ServerInit): Server {
  const registry = registryOf(modules, env)
  const serverInfo = { name: SERVER_NAME, title: 'waffles', version: versionOf() }
  const capabilities = registry.capabilities
  const instructions = registry.instructions ? { instructions: registry.instructions } : {}

  // The revision an `initialize` chose; null until one came.
  let legacy: string | null = null
  // The resources a 2025-11-25 client subscribed to.
  const subscribed = new Set<string>()
  // The open 2026-07-28 listen streams, by the ID of the request that opened each, with what each honors.
  const streams = new Map<Id, Json>()
  let isEnding = false

  const notify = (method: string, params?: Json) => send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })

  // Each change goes to the clients that asked for it, in the form of the revision each speaks.
  const emit = (change: Change) => {
    if (isEnding) return
    if (change.type === 'resource') {
      if (legacy !== null && subscribed.has(change.uri)) notify('notifications/resources/updated', { uri: change.uri })
      for (const [id, filter] of streams) {
        const uris = filter.resourceSubscriptions
        if (Array.isArray(uris) && uris.includes(change.uri)) notify('notifications/resources/updated', { _meta: { [SUBSCRIPTION]: id }, uri: change.uri })
      }
      return
    }
    if (!registry.isListChanging(change.kind)) return
    const method = `notifications/${change.kind}/list_changed`
    if (legacy !== null) notify(method)
    for (const [id, filter] of streams) if (filter[`${change.kind}ListChanged`] === true) notify(method, { _meta: { [SUBSCRIPTION]: id } })
  }

  const sessions = sessionsOf({ registry, env, emit, log })

  // Whether this server serves a method in some revision.
  const offers = (method: string): boolean => {
    switch (method) {
      case 'server/discover':
      case 'subscriptions/listen':
        return true
      case 'tools/list':
      case 'tools/call':
        return 'tools' in capabilities
      case 'prompts/list':
      case 'prompts/get':
        return 'prompts' in capabilities
      case 'resources/list':
      case 'resources/read':
      case 'resources/templates/list':
        return 'resources' in capabilities
      case 'resources/subscribe':
      case 'resources/unsubscribe':
        return isObject(capabilities.resources) && capabilities.resources.subscribe === true
      default:
        return false
    }
  }

  const notFound = (uri: string, era: Era) =>
    new RpcError(era === 'modern' ? INVALID_PARAMS : RESOURCE_NOT_FOUND, 'Resource not found', { uri })

  async function callTool(params: Json, era: Era): Promise<Json> {
    const tool = typeof params.name === 'string' ? registry.tool(params.name) : undefined
    if (tool === undefined) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(params.name)}`)
    const input = params.arguments ?? {}
    if (!isObject(input)) throw new RpcError(INVALID_PARAMS, 'The tool arguments must be an object.')
    const session = await sessions.of(params)
    let answer: ToolAnswer
    try {
      answer = await tool.call(session, input)
    } catch (failure) {
      // The model reads a short reason and can go on; the stack goes to the log.
      log(`the ${tool.name} tool failed: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`)
      answer = { refusal: `The ${tool.name} tool failed: ${messageOf(failure).split('\n')[0]}` }
    }
    return resultOf(answer, era)
  }

  async function getPrompt(params: Json): Promise<Json> {
    const prompt = typeof params.name === 'string' ? registry.prompt(params.name) : undefined
    if (prompt === undefined) throw new RpcError(INVALID_PARAMS, `Unknown prompt: ${String(params.name)}`)
    const args = params.arguments ?? {}
    if (!isObject(args) || !Object.values(args).every(value => typeof value === 'string')) {
      throw new RpcError(INVALID_PARAMS, 'The prompt arguments must be an object of strings.')
    }
    const missing = (prompt.arguments ?? []).filter(arg => arg.required && !(arg.name in args)).map(arg => arg.name)
    if (missing.length) throw new RpcError(INVALID_PARAMS, `The ${prompt.name} prompt needs the arguments: ${missing.join(', ')}.`)
    const got = await prompt.get(await sessions.of(params), args as Record<string, string>)
    return defined({ description: got.description, messages: got.messages })
  }

  async function readResource(params: Json, era: Era): Promise<Json> {
    if (typeof params.uri !== 'string') throw new RpcError(INVALID_PARAMS, 'resources/read needs a uri.')
    const resource = registry.resource(params.uri)
    if (resource === undefined) throw notFound(params.uri, era)
    const text = await resource.read(await sessions.of(params))
    return { contents: [defined({ uri: resource.uri, mimeType: resource.mimeType, text })] }
  }

  // The methods both revisions serve the same way, but for the fields each revision adds to a result.
  async function content(method: string, params: Json, era: Era): Promise<Json> {
    switch (method) {
      case 'tools/list':
        await sessions.of(params)
        return { tools: registry.tools().map(listed) }
      case 'tools/call':
        return callTool(params, era)
      case 'prompts/list':
        await sessions.of(params)
        return { prompts: registry.prompts().map(({ name, title, description, arguments: args }) => defined({ name, title, description, arguments: args })) }
      case 'prompts/get':
        return getPrompt(params)
      case 'resources/list':
        await sessions.of(params)
        return { resources: registry.resources().map(({ uri, name, title, description, mimeType }) => defined({ uri, name, title, description, mimeType })) }
      case 'resources/read':
        return readResource(params, era)
      // No module has a template yet.
      case 'resources/templates/list':
        return { resourceTemplates: [] }
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
  }

  // How long a 2026-07-28 client may reuse a result: lists for the life of the process, unless a module
  // changes one; a resource's text not at all. A call's result is not cacheable.
  const cacheOf = (method: string): Json => {
    const kind = LISTS.find(k => method === `${k}/list`)
    if (kind !== undefined) return { ttlMs: registry.isListChanging(kind) ? 0 : TTL_MS, cacheScope: 'private' }
    if (method === 'resources/templates/list') return { ttlMs: TTL_MS, cacheScope: 'private' }
    if (method === 'resources/read') return { ttlMs: 0, cacheScope: 'private' }
    return {}
  }

  /**
   * A `subscriptions/listen` request opens a stream that lasts until the client cancels it or the server
   * ends. It is acknowledged at once with what the server honors: the list changes a module tells of, and
   * the resources it watches. Its answer comes only when the server ends the stream.
   */
  async function listen(id: Id, params: Json): Promise<null> {
    const asked = params.notifications
    if (!isObject(asked)) throw new RpcError(INVALID_PARAMS, 'subscriptions/listen needs a notifications filter.')
    await sessions.of(params)
    const honored: Json = {}
    for (const kind of LISTS) if (asked[`${kind}ListChanged`] === true && registry.isListChanging(kind)) honored[`${kind}ListChanged`] = true
    if (Array.isArray(asked.resourceSubscriptions)) {
      const uris = asked.resourceSubscriptions.filter((uri): uri is string => typeof uri === 'string' && registry.resource(uri)?.isWatched === true)
      if (uris.length) honored.resourceSubscriptions = uris
    }
    streams.set(id, honored)
    notify('notifications/subscriptions/acknowledged', { _meta: { [SUBSCRIPTION]: id }, notifications: honored })
    return null
  }

  // A request that names its revision in `_meta`, served as that revision: on its own, with nothing
  // taken from earlier requests. Null where the answer comes later.
  async function modern(id: Id, method: string, params: Json, meta: Json): Promise<Json | null> {
    const version = meta[`${META}protocolVersion`]
    if (typeof version !== 'string' || !MODERN.includes(version)) {
      throw new RpcError(UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED, requested: version })
    }
    if (!isObject(meta[`${META}clientCapabilities`])) throw new RpcError(INVALID_PARAMS, `_meta has no ${META}clientCapabilities.`)
    // 2026-07-28 has no ping, and subscribes to a resource on a listen stream.
    if (!offers(method) || method === 'resources/subscribe' || method === 'resources/unsubscribe') {
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
    if (method === 'subscriptions/listen') return listen(id, params)
    const done = (result: Json) => ({ resultType: 'complete', ...result, _meta: { [`${META}serverInfo`]: serverInfo } })
    if (method === 'server/discover') {
      await sessions.of(params)
      return done({ supportedVersions: SUPPORTED, capabilities, ...instructions, ttlMs: TTL_MS, cacheScope: 'private' })
    }
    return done({ ...(await content(method, params, 'modern')), ...cacheOf(method) })
  }

  // A request with no revision in `_meta`: the handshake, or a request after it.
  async function handshake(method: string, params: Json): Promise<Json> {
    if (method === 'initialize') {
      const asked = params.protocolVersion
      if (typeof asked !== 'string') throw new RpcError(INVALID_PARAMS, 'initialize needs a protocolVersion.')
      // A revision this server doesn't serve gets its newest handshake revision; the client decides whether to go on.
      legacy = LEGACY.includes(asked) ? asked : LEGACY[0]!
      await sessions.of(params)
      return { protocolVersion: legacy, capabilities, serverInfo, ...instructions }
    }
    // Allowed before the handshake too.
    if (method === 'ping') return {}
    if (!offers(method)) throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
    // Before a handshake, a request must name its revision; one only 2026-07-28 has always must.
    if (legacy === null || method === 'server/discover' || method === 'subscriptions/listen') {
      const before = legacy === null ? ', and no initialize came before it' : ''
      throw new RpcError(INVALID_PARAMS, `The request names no protocol version in _meta (${META}protocolVersion)${before}.`, { supported: SUPPORTED })
    }
    if (method === 'resources/subscribe' || method === 'resources/unsubscribe') {
      if (typeof params.uri !== 'string') throw new RpcError(INVALID_PARAMS, `${method} needs a uri.`)
      if (registry.resource(params.uri) === undefined) throw notFound(params.uri, 'legacy')
      if (method === 'resources/subscribe') subscribed.add(params.uri)
      else subscribed.delete(params.uri)
      return {}
    }
    return content(method, params, 'legacy')
  }

  async function request(id: Id, method: string, params: Json): Promise<Json | null> {
    const meta = params._meta
    // An `initialize` always opens the handshake: a 2026-07-28 client never sends one.
    if (method !== 'initialize' && isObject(meta) && `${META}protocolVersion` in meta) return modern(id, method, params, meta)
    return handshake(method, params)
  }

  const error = (id: Id | null, code: number, message: string, data?: unknown) => ({
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  })

  /** The answer to one line from the client, or null where none is due: a notification, a response, or a stream's request. */
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
    // A notification gets no answer. Of those a client sends, only the cancel of a listen stream asks
    // anything of this server: a call under way can't be stopped part way.
    if (!hasId || !isId(id)) {
      if (message.method === 'notifications/cancelled' && isObject(params) && isId(params.requestId)) streams.delete(params.requestId)
      return null
    }
    if (!isObject(params)) return error(id, INVALID_PARAMS, 'params must be an object.')
    try {
      const result = await request(id, message.method, params)
      return result === null ? null : { jsonrpc: '2.0', id, result }
    } catch (failure) {
      if (failure instanceof RpcError) return error(id, failure.code, failure.message, failure.data)
      log(`${message.method} failed: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`)
      return error(id, INTERNAL_ERROR, `Internal error: ${messageOf(failure)}`)
    }
  }

  const pending = new Set<Promise<void>>()
  let ending: Promise<void> | null = null

  return {
    registry,

    receive(line) {
      if (!line.trim() || ending !== null) return Promise.resolve()
      const work = answer(line).then(
        reply => {
          if (reply !== null) send(reply)
        },
        failure => log(`a message was not answered: ${messageOf(failure)}`),
      )
      pending.add(work)
      void work.finally(() => pending.delete(work))
      return work
    },

    end(why) {
      return (ending ??= (async () => {
        let wait: ReturnType<typeof setTimeout> | undefined
        await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => (wait = setTimeout(resolve, END_WAIT_MS)))])
        clearTimeout(wait)
        isEnding = true
        // The answer to a listen request tells its client the stream ended on purpose.
        for (const id of streams.keys()) {
          send({ jsonrpc: '2.0', id, result: { resultType: 'complete', _meta: { [SUBSCRIPTION]: id, [`${META}serverInfo`]: serverInfo } } })
        }
        streams.clear()
        await sessions.end()
        if (env.WAFFLES_DEBUG) log(`ended: ${why}`)
      })())
    },
  }
}

/**
 * The server on this process's stdio. The client closes stdin or stops the process: calls under way
 * answer first, then the sessions end and the process exits with code 0.
 */
function main() {
  const log = (message: string) => {
    process.stderr.write(`waffles mcp: ${message}\n`)
  }
  let isOutClosed = false
  // JSON.stringify escapes every newline inside a string, so a message is always one line.
  const send = (message: Json) => {
    if (!isOutClosed) process.stdout.write(`${JSON.stringify(message)}\n`)
  }
  const server = createServer({ modules: chosenModules(process.env, log), env: process.env, send, log })
  const stop = (why: string) =>
    void server.end(why).then(async () => {
      // An empty write calls back once the writes before it are out, so no answer is cut off by the exit.
      if (!isOutClosed) await new Promise<void>(resolve => process.stdout.write('', () => resolve()))
      process.exit(0)
    })
  // The client stopped reading: nothing more can reach it.
  process.stdout.on('error', () => {
    isOutClosed = true
    stop('stdout closed')
  })
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', line => void server.receive(line))
  lines.on('close', () => stop('stdin ended'))
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

// Run as a program, not imported by a test.
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) main()
