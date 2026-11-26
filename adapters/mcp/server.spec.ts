import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { COMMANDS } from '../../core/modes.ts'
import { PLAN_TOOL } from '../../core/plan.ts'
import { CURRENT, folders, LIMIT, META, PREVIOUS, server, stopAll, text, type Message } from './testing.ts'

after(stopAll)

const URI = 'waffles://plan-outline'
const ALL = { tools: {}, prompts: {}, resources: { subscribe: true } }

test('the handshake answers with the revision asked for, the content, and the rules as instructions', LIMIT, async () => {
  const { work, state } = await folders()
  const s = server(work, state)
  const init = await s.initialize(PREVIOUS)
  assert.equal(init.result.protocolVersion, PREVIOUS)
  assert.deepEqual(init.result.capabilities, ALL)
  assert.equal(init.result.serverInfo.name, 'waffles')
  assert.match(init.result.instructions, /# waffles plan outline/)
  assert.match(init.result.instructions, /only with the mcp__waffles__plan tool/)
  assert.match(init.result.instructions, /ask the person with a multiple-choice question/)
  // A notification gets no answer: the next message is the ping's.
  s.notify('notifications/initialized')
  assert.deepEqual((await s.request('ping')).result, {})

  const list = await s.request('tools/list')
  // A 2025-11-25 result has no resultType or cache fields.
  assert.deepEqual(Object.keys(list.result), ['tools'])
  assert.deepEqual(list.result.tools.map((tool: Message) => tool.name), ['mode', 'plan', 'merge_queue', 'checkpoint', 'review_branch', 'backlog_queue'])
  assert.deepEqual(list.result.tools[1], { name: 'plan', description: PLAN_TOOL.description, inputSchema: PLAN_TOOL.inputSchema })
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
  assert.match(await fs.readFile(join(work, '.waffles', 'plan', 'ship-it.md'), 'utf8'), /Build/)

  const refused = await s.request('tools/call', { name: 'plan', arguments: { op: 'done', ids: ['9'] } })
  assert.equal(refused.error, undefined)
  assert.equal(refused.result.isError, true)
  assert.match(text(refused), /No step 9/)

  assert.equal((await s.request('tools/call', { name: 'other', arguments: {} })).error.code, -32602)
  assert.equal((await s.request('tools/call', { name: 'plan', arguments: ['op'] })).error.code, -32602)
  const unknown = await s.request('completion/complete')
  assert.equal(unknown.error.code, -32601)
  assert.match(unknown.error.message, /completion\/complete/)
  // 2026-07-28's methods need their revision in _meta.
  assert.equal((await s.request('subscriptions/listen', { notifications: {} })).error.code, -32602)

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
  assert.deepEqual(discover.result.capabilities, ALL)
  assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].name, 'waffles')
  assert.equal(typeof discover.result.ttlMs, 'number')
  assert.match(discover.result.instructions, /only with the waffles_plan tool/)
  assert.match(discover.result.instructions, /ask the person with AskQuestion/)
  // Only the plan tool has a variable of its own; the others keep the prefix.
  assert.match(discover.result.instructions, /the mcp__waffles__mode tool returns the current one/)

  const list = await s.request('tools/list', { _meta: META })
  assert.equal(list.result.resultType, 'complete')
  assert.equal(list.result.cacheScope, 'private')
  assert.deepEqual(list.result.tools.map((tool: Message) => tool.name), ['mode', 'plan', 'merge_queue', 'checkpoint', 'review_branch', 'backlog_queue'])

  const made = await s.request('tools/call', { _meta: META, name: 'plan', arguments: { op: 'goal', title: 'Ship it' } })
  assert.equal(made.result.resultType, 'complete')
  assert.equal(made.result.isError, false)

  const old = await s.request('tools/list', { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } })
  assert.deepEqual(old.error, { code: -32022, message: 'Unsupported protocol version', data: { supported: [CURRENT, PREVIOUS], requested: '1900-01-01' } })
  const { 'io.modelcontextprotocol/clientCapabilities': _, ...bare } = META
  assert.equal((await s.request('tools/list', { _meta: bare })).error.code, -32602)
  // 2026-07-28 has no ping, and no resources/subscribe: a listen stream replaces it.
  assert.equal((await s.request('ping', { _meta: META })).error.code, -32601)
  assert.equal((await s.request('resources/subscribe', { _meta: META, uri: URI })).error.code, -32601)
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
  assert.match(await fs.readFile(join(work, '.waffles', 'plan', 'ship-it.md'), 'utf8'), /\[x\] 1 Build/)
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

test('the instructions hold the modules’ blocks in module order, with every tool named by the prefix', LIMIT, async () => {
  const { work, state } = await folders()
  const s = server(work, state, { WAFFLES_TOOL_PREFIX: 'waffles_' })
  const { instructions } = (await s.initialize()).result
  const modes = instructions.indexOf('# waffles modes')
  const plan = instructions.indexOf('# waffles plan outline')
  assert.ok(modes === 0 && plan > modes, instructions)
  assert.match(instructions, /the waffles_mode tool returns the current one/)
  assert.match(instructions, /only with the waffles_plan tool/)
  await s.close()

  // The same names give the same bytes, in another process.
  const again = server(work, state, { WAFFLES_TOOL_PREFIX: 'waffles_' })
  assert.equal((await again.initialize()).result.instructions, instructions)
  await again.close()
})

test('WAFFLES_MCP_MODULES limits the content, and the capabilities follow it', LIMIT, async () => {
  const { work, state } = await folders()
  const s = server(work, state, { WAFFLES_MCP_MODULES: 'plan' })
  const init = await s.initialize()
  assert.deepEqual(init.result.capabilities, { tools: {}, resources: { subscribe: true } })
  assert.match(init.result.instructions, /^# waffles plan outline/)
  assert.doesNotMatch(init.result.instructions, /# waffles modes/)
  assert.deepEqual((await s.request('tools/list')).result.tools.map((tool: Message) => tool.name), ['plan'])
  assert.equal((await s.request('prompts/list')).error.code, -32601)
  assert.equal((await s.request('prompts/get', { name: 'rapid' })).error.code, -32601)
  await s.close()

  const modern = server(work, state, { WAFFLES_MCP_MODULES: 'plan' })
  assert.deepEqual((await modern.request('server/discover', { _meta: META })).result.capabilities, { tools: {}, resources: { subscribe: true } })
  await modern.close()

  // A name no module has is reported; the others are served.
  const odd = server(work, state, { WAFFLES_MCP_MODULES: 'modes, nothing' })
  assert.deepEqual((await odd.initialize()).result.capabilities, { tools: {}, prompts: {} })
  await odd.close()
  assert.match(odd.stderr(), /names no module nothing/)
})

test('the mode commands are prompts on both revisions', LIMIT, async () => {
  const { work, state } = await folders()
  const s = server(work, state)
  await s.initialize()
  const legacy = await s.request('prompts/list')
  assert.deepEqual(legacy.result, { prompts: COMMANDS.map(({ name, description }) => ({ name, description })) })
  const got = await s.request('prompts/get', { name: 'backlog-entry' })
  assert.match(got.result.description, /^Backlog mode: on\./)
  assert.equal(got.result.messages.length, 1)
  assert.equal(got.result.messages[0].role, 'user')
  assert.match(text(got), /^waffles mode: backlog\. /)
  assert.equal((await s.request('prompts/get', { name: 'nothing' })).error.code, -32602)
  assert.equal((await s.request('prompts/get', { name: 'prod', arguments: { a: 1 } })).error.code, -32602)

  const modern = await s.request('prompts/list', { _meta: META })
  assert.equal(modern.result.resultType, 'complete')
  assert.equal(typeof modern.result.ttlMs, 'number')
  assert.deepEqual(modern.result.prompts, legacy.result.prompts)
  const back = await s.request('prompts/get', { _meta: META, name: 'prod' })
  assert.equal(back.result.resultType, 'complete')
  assert.equal(back.result.description, 'Backlog mode: off. Back in production mode.')
  assert.match(text(back), /^waffles mode: production\. Backlog mode has ended/)
  // Nothing changes on a second /prod: the message states the current mode.
  const same = await s.request('prompts/get', { _meta: META, name: 'prod' })
  assert.equal(same.result.description, 'Already in production mode.')
  assert.equal(text(same), 'waffles mode: production')
  await s.close()
})

test('the plan outline is a resource, and a 2025-11-25 subscriber hears when a tool call changes it', LIMIT, async () => {
  const { work, state } = await folders()
  const s = server(work, state)
  await s.initialize()
  const list = await s.request('resources/list')
  assert.deepEqual(list.result.resources.map((r: Message) => [r.uri, r.mimeType]), [[URI, 'text/plain']])
  assert.deepEqual((await s.request('resources/templates/list')).result, { resourceTemplates: [] })
  const before = await s.request('resources/read', { uri: URI })
  assert.deepEqual(before.result, { contents: [{ uri: URI, mimeType: 'text/plain', text: 'No active goal and no open goals.' }] })
  assert.deepEqual((await s.request('resources/read', { uri: 'waffles://nothing' })).error, { code: -32002, message: 'Resource not found', data: { uri: 'waffles://nothing' } })
  assert.equal((await s.request('resources/subscribe', { uri: 'waffles://nothing' })).error.code, -32002)

  assert.deepEqual((await s.request('resources/subscribe', { uri: URI })).result, {})
  await s.request('tools/call', { name: 'plan', arguments: { op: 'goal', title: 'Ship it', steps: [{ title: 'Build' }] } })
  assert.deepEqual((await s.notification('notifications/resources/updated')).params, { uri: URI })
  assert.match((await s.request('resources/read', { uri: URI })).result.contents[0].text, /Build/)

  // A call that changes nothing, and any call after the unsubscribe, is not told.
  await s.request('tools/call', { name: 'plan', arguments: { op: 'show' } })
  assert.deepEqual((await s.request('resources/unsubscribe', { uri: URI })).result, {})
  await s.request('tools/call', { name: 'plan', arguments: { op: 'add', parent: null, titles: ['Test'] } })
  await s.request('ping')
  assert.deepEqual(s.kept(), [])
  await s.close()
})

test('a 2026-07-28 client hears of a change to the plan outline on its listen stream', LIMIT, async () => {
  const { work, state } = await folders()
  const s = server(work, state)
  const read = await s.request('resources/read', { _meta: META, uri: URI })
  assert.equal(read.result.resultType, 'complete')
  assert.equal(read.result.ttlMs, 0)
  assert.equal(read.result.contents[0].text, 'No active goal and no open goals.')
  assert.deepEqual((await s.request('resources/read', { _meta: META, uri: 'waffles://nothing' })).error, {
    code: -32602,
    message: 'Resource not found',
    data: { uri: 'waffles://nothing' },
  })

  const listen = (id: string, notifications: Message) =>
    s.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'subscriptions/listen', params: { _meta: META, notifications } }))
  // No list changes: the lists never change, so the acknowledgement leaves that out; an unknown URI too.
  listen('watch', { toolsListChanged: true, promptsListChanged: true, resourceSubscriptions: [URI, 'waffles://nothing'] })
  const ack = await s.notification('notifications/subscriptions/acknowledged')
  assert.deepEqual(ack.params, { _meta: { 'io.modelcontextprotocol/subscriptionId': 'watch' }, notifications: { resourceSubscriptions: [URI] } })
  listen('other', { resourceSubscriptions: [URI] })
  await s.notification('notifications/subscriptions/acknowledged')

  await s.request('tools/call', { _meta: META, name: 'plan', arguments: { op: 'goal', title: 'Ship it' } })
  const told = [await s.notification('notifications/resources/updated'), await s.notification('notifications/resources/updated')]
  assert.deepEqual(told.map(n => n.params['_meta']['io.modelcontextprotocol/subscriptionId']).sort(), ['other', 'watch'])
  assert.ok(told.every(n => n.params.uri === URI))

  // A stream the client cancels hears nothing more; the other is answered when the server ends.
  s.notify('notifications/cancelled', { requestId: 'other' })
  await s.request('tools/call', { _meta: META, name: 'plan', arguments: { op: 'add', parent: null, titles: ['Test'] } })
  const once = await s.notification('notifications/resources/updated')
  assert.equal(once.params._meta['io.modelcontextprotocol/subscriptionId'], 'watch')
  const ended = s.close()
  const closing = await s.next()
  assert.equal(closing.id, 'watch')
  assert.deepEqual(closing.result.resultType, 'complete')
  assert.equal(closing.result._meta['io.modelcontextprotocol/subscriptionId'], 'watch')
  assert.deepEqual(await ended, { code: 0, signal: null })
  assert.deepEqual(s.kept(), [])
})
