import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chosenModules, MODULES } from './modules.ts'
import { registryOf, seenAsOf, userText, type Module } from './registry.ts'
import { createServer } from './server.ts'
import { CURRENT, folders, inbox, META, PREVIOUS, type Message } from './testing.ts'

// A module only this spec registers: a new tool, prompt, and resource reach a client through the
// protocol code as it is, with no change to it.
const echo: Module = {
  name: 'echo',
  tools: [
    {
      name: 'echo',
      description: 'Returns its input as a structured value.',
      inputSchema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
      outputSchema: { type: 'object', properties: { word: { type: 'string' }, session: { type: 'string' } } },
      annotations: { readOnlyHint: true },
      call: async (session, input) => ({ value: { word: input.word, session: session.id } }),
    },
    { name: 'words', description: 'Returns a list.', inputSchema: { type: 'object' }, call: async () => ({ value: ['a', 'b'] }) },
    {
      name: 'boom',
      description: 'Throws.',
      inputSchema: { type: 'object' },
      call: async () => {
        throw new Error('the disk is gone\nand more lines')
      },
    },
    { name: 'no', description: 'Refuses.', inputSchema: { type: 'object' }, call: async () => ({ refusal: 'Not today.' }) },
  ],
  prompts: [
    {
      name: 'greet',
      arguments: [{ name: 'who', required: true }],
      get: async (_session, args) => ({ messages: [userText(`Hello, ${args.who}.`)] }),
    },
    {
      name: 'broken',
      get: async () => {
        throw new Error('no prompt here')
      },
    },
  ],
  instructions: ({ seenAs }) => `Call ${seenAs('echo')} to echo.`,
}

/** A server in this process with the modules given, and a client that writes lines to it. */
async function inProcess(modules: readonly Module[], extra: Record<string, string> = {}) {
  const { work, state } = await folders()
  const box = inbox()
  const logs: string[] = []
  const server = createServer({
    modules,
    env: { WAFFLES_STATE_DIR: state, WAFFLES_CWD: work, WAFFLES_SESSION_ID: 'in-process', ...extra },
    send: message => box.put(message),
    log: message => logs.push(message),
  })
  let nextId = 1
  const request = async (method: string, params: Message = {}) => {
    const id = nextId++
    await server.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return box.take(m => m.id === id)
  }
  return { server, request, logs, kept: box.kept }
}

test('a module registered alone is served on both revisions, with capabilities for what it has', async () => {
  const s = await inProcess([echo], { WAFFLES_TOOL_PREFIX: 'x_' })
  const init = await s.request('initialize', { protocolVersion: PREVIOUS, capabilities: {} })
  assert.deepEqual(init.result.capabilities, { tools: {}, prompts: {} })
  assert.equal(init.result.instructions, 'Call x_echo to echo.')
  assert.equal((await s.request('resources/list')).error.code, -32601)

  const tools = (await s.request('tools/list')).result.tools
  assert.deepEqual(tools[0], {
    name: 'echo',
    description: 'Returns its input as a structured value.',
    inputSchema: echo.tools![0]!.inputSchema,
    outputSchema: echo.tools![0]!.outputSchema,
    annotations: { readOnlyHint: true },
  })

  // A structured value goes as structuredContent, with its JSON as the text.
  const echoed = await s.request('tools/call', { name: 'echo', arguments: { word: 'hi' } })
  assert.deepEqual(echoed.result, {
    content: [{ type: 'text', text: '{"word":"hi","session":"in-process"}' }],
    structuredContent: { word: 'hi', session: 'in-process' },
    isError: false,
  })
  // 2025-11-25 allows only an object there; 2026-07-28 any JSON value.
  assert.deepEqual((await s.request('tools/call', { name: 'words' })).result, { content: [{ type: 'text', text: '["a","b"]' }], isError: false })
  const modern = await s.request('tools/call', { _meta: META, name: 'words' })
  assert.deepEqual(modern.result.structuredContent, ['a', 'b'])
  assert.deepEqual((await s.request('tools/call', { name: 'no' })).result, { content: [{ type: 'text', text: 'Not today.' }], isError: true })

  const greeted = await s.request('prompts/get', { name: 'greet', arguments: { who: 'Ada' } })
  assert.deepEqual(greeted.result, { messages: [{ role: 'user', content: { type: 'text', text: 'Hello, Ada.' } }] })
  assert.equal((await s.request('prompts/get', { name: 'greet' })).error.code, -32602)
  assert.deepEqual((await s.request('prompts/list', { _meta: META })).result.prompts, [{ name: 'greet', arguments: [{ name: 'who', required: true }] }, { name: 'broken' }])
  await s.server.end('test')
})

test('a handler that throws is a tool error with a short message, and the server goes on', async () => {
  const s = await inProcess([echo])
  await s.request('initialize', { protocolVersion: PREVIOUS, capabilities: {} })
  const thrown = await s.request('tools/call', { name: 'boom', arguments: {} })
  assert.equal(thrown.error, undefined)
  assert.deepEqual(thrown.result, { content: [{ type: 'text', text: 'The boom tool failed: the disk is gone' }], isError: true })
  // The stack goes to the log, not to the model.
  assert.match(s.logs.join('\n'), /the boom tool failed: Error: the disk is gone/)
  // A prompt has no error result: its failure is the protocol's internal error.
  assert.deepEqual((await s.request('prompts/get', { name: 'broken' })).error, { code: -32603, message: 'Internal error: no prompt here' })
  assert.equal((await s.request('tools/call', { name: 'echo', arguments: { word: 'still' } })).result.isError, false)
  await s.server.end('test')
})

test('a module told of a change to its list sends it on, and its list is not cached', async () => {
  let told: (() => void) | undefined
  const changing: Module = {
    name: 'changing',
    tools: [
      {
        name: 'later',
        description: 'Changes the list.',
        inputSchema: { type: 'object' },
        call: async session => {
          told = () => session.listChanged('tools')
          return { text: 'ok' }
        },
      },
    ],
    listChanges: ['tools'],
  }
  const s = await inProcess([changing])
  const discover = await s.request('server/discover', { _meta: META })
  assert.deepEqual(discover.result.capabilities, { tools: { listChanged: true } })
  assert.equal((await s.request('tools/list', { _meta: META })).result.ttlMs, 0)
  await s.server.receive(JSON.stringify({ jsonrpc: '2.0', id: 'l', method: 'subscriptions/listen', params: { _meta: META, notifications: { toolsListChanged: true } } }))
  assert.deepEqual(s.kept()[0]!.params.notifications, { toolsListChanged: true })
  await s.request('tools/call', { _meta: META, name: 'later' })
  told!()
  assert.deepEqual(s.kept()[1], { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { 'io.modelcontextprotocol/subscriptionId': 'l' } } })
  await s.server.end('test')
  assert.equal(s.kept()[2]!.id, 'l')
})

test('a tool is seen under the prefix, or under its own variable, and the module list keeps its order', () => {
  const tools = [{ ...echo.tools![0]!, nameVariable: 'ECHO_TOOL' }]
  assert.equal(seenAsOf({}, tools)('echo'), 'mcp__waffles__echo')
  assert.equal(seenAsOf({ WAFFLES_TOOL_PREFIX: '' }, tools)('echo'), 'echo')
  assert.equal(seenAsOf({ ECHO_TOOL: 'my_echo', WAFFLES_TOOL_PREFIX: 'p_' }, tools)('echo'), 'my_echo')
  assert.equal(seenAsOf({ WAFFLES_TOOL_PREFIX: 'p_' }, tools)('other'), 'p_other')

  const log: string[] = []
  assert.deepEqual(chosenModules({ WAFFLES_MCP_MODULES: 'plan,modes' }, m => log.push(m)).map(m => m.name), ['modes', 'plan'])
  assert.deepEqual(chosenModules({}, m => log.push(m)), [...MODULES])
  assert.deepEqual(log, [])
  assert.throws(() => registryOf([echo, { name: 'again', tools: echo.tools }], {}), /Two MCP tools are named echo/)
  assert.throws(() => registryOf([echo, { name: 'again', prompts: echo.prompts }], {}), /Two MCP prompts are named greet/)
})

test('a server with no modules announces nothing', async () => {
  const s = await inProcess([])
  const discover = await s.request('server/discover', { _meta: META })
  assert.deepEqual(discover.result.supportedVersions, [CURRENT, PREVIOUS])
  // No modules: nothing is announced, and no instructions are sent.
  assert.deepEqual(discover.result.capabilities, {})
  assert.equal('instructions' in discover.result, false)
  await s.server.end('test')
})
