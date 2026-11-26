import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

import type { Entry } from '../../core/backlog-queue.ts'
import { MERGE_QUEUE_TOOL } from '../../core/merge-queue.ts'
import { MODES_TEXT } from '../../core/modes.ts'
import { SUBAGENT } from '../../core/plan.ts'
import { TOOLS } from '../../core/tools.ts'
import plugin, { NAMES, pluginRoot, readSkills, sessionState, skillHeader } from './server.ts'

type Json = Record<string, unknown>

type Tool = {
  name: string
  description?: string
  input?: unknown
  output?: unknown
  execute: (input: unknown, context: Json) => Promise<{ content: string; output?: unknown }>
}

// A stand-in for OpenCode's plugin context: it keeps what the plugin registers, and a session record per ID.
// `emit` sends an event to the plugin's subscription; `question` is OpenCode's built-in question tool,
// which answers `answer` unless its signal aborts first.
async function fakeContext(sessionInfo: Record<string, { parentID?: string; time?: { busy?: number; idle?: number } }> = { s1: {} }) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'waffles-opencode-')))
  const sessions = new Map<string, { id: string; parentID?: string; metadata?: Json; time: { busy?: number; idle?: number }; location: { directory: string } }>()
  for (const [id, info] of Object.entries(sessionInfo)) sessions.set(id, { id, time: {}, ...info, location: { directory: root } })
  const entries = new Map<string, Map<string, unknown>>()
  const registered = {
    tools: [] as Tool[],
    commands: [] as { name: string; description?: string; execute: (input: Json) => Promise<void> }[],
    skills: [] as { id: string }[],
    hooks: {} as Record<string, (event: never) => unknown>,
    prompts: [] as Json[],
    storage: new Map<string, unknown>(),
    // What the small model is asked, and what it answers.
    generated: [] as Json[],
    answer: '{"level": "low", "why": "a lookup"}',
    // The session's messages, as session.context gives them.
    messages: [] as Json[],
  }
  const question: Tool & { answer: Promise<{ content: string }> | null } = {
    name: 'question',
    answer: null,
    execute: (_input, context) =>
      question.answer ??
      new Promise((_, reject) => (context.signal as AbortSignal).addEventListener('abort', () => reject(new Error('The user dismissed this question')))),
  }
  const builtins: Tool[] = [question]
  const queue: Json[] = []
  let wake: (() => void) | null = null
  const emit = async (event: Json) => {
    queue.push(event)
    wake?.()
    // The plugin's loop handles the event before the test goes on.
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const hook = (domain: string) => async (name: string, callback: (event: never) => unknown) => {
    registered.hooks[`${domain}.${name}`] = callback
    return { dispose: async () => undefined }
  }
  const ctx = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const found = sessions.get(sessionID)
        if (!found) throw new Error(`No session ${sessionID}`)
        return found
      },
      update: async ({ sessionID, metadata }: { sessionID: string; metadata?: Json }) => {
        sessions.get(sessionID)!.metadata = metadata
      },
      prompt: async (input: Json) => void registered.prompts.push(input),
      context: async () => registered.messages,
      list: async ({ parentID }: { parentID?: string }) => ({ data: [...sessions.values()].filter(info => info.parentID === parentID) }),
      hook: hook('session'),
      instructions: {
        entry: {
          put: async ({ sessionID, key, value }: { sessionID: string; key: string; value: unknown }) => {
            if (!entries.has(sessionID)) entries.set(sessionID, new Map())
            entries.get(sessionID)!.set(key, value)
          },
          remove: async ({ sessionID, key }: { sessionID: string; key: string }) => void entries.get(sessionID)?.delete(key),
        },
      },
    },
    model: {
      list: async () => ({ data: [{ providerID: 'anthropic', id: 'claude-sonnet-5-5', variants: ['none', 'low', 'high'].map(id => ({ id, settings: { effort: id } })) }] }),
      default: async () => ({ data: { providerID: 'anthropic', id: 'claude-sonnet-5-5' } }),
    },
    experimental: {
      generate: { text: async (input: Json) => (registered.generated.push(input), { text: registered.answer }) },
    },
    storage: {
      get: async (key: string) => registered.storage.get(key),
      set: async (key: string, value: unknown) => void registered.storage.set(key, value),
    },
    skill: { transform: async (edit: (editor: Json) => void) => edit({ add: (skill: { id: string }) => registered.skills.push(skill) }) },
    tool: {
      transform: async (edit: (editor: Json) => void) =>
        edit({
          add: (tool: Tool) => registered.tools.push(tool),
          update: (id: string, change: (tool: Tool) => void) => {
            const tool = [...registered.tools, ...builtins].find(t => t.name === id)
            if (tool) change(tool)
          },
        }),
      hook: hook('tool'),
    },
    command: { transform: async (edit: (editor: Json) => void) => edit({ add: (command: never) => registered.commands.push(command) }) },
    permission: { hook: hook('permission') },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            const next = queue.shift()
            if (next) yield next
            else
              await new Promise<void>(resolve => {
                wake = resolve
                signal.addEventListener('abort', () => resolve())
              })
          }
        },
      }),
    },
  }
  const cleanup = await plugin.setup(ctx as never)
  return { root, sessions, entries, registered, question, emit, cleanup: cleanup as () => Promise<void> }
}

test('a skill file names itself in its front matter', () => {
  assert.deepEqual(skillHeader('---\nname: ask\ndescription: "Collect the open items"\n---\n\nBody'), { name: 'ask', description: 'Collect the open items', autoinvoke: true })
  // A skill kept for the person to call is not offered to the model.
  assert.equal(skillHeader('---\nname: run\ndescription: Run it\ndisable-model-invocation: true\n---\n')?.autoinvoke, false)
  assert.equal(skillHeader('No front matter'), null)
  assert.equal(skillHeader('---\nname: only\n---\n'), null)
})

test("the plugin's own skills are read from its skills folder", async () => {
  const skills = await readSkills(pluginRoot())
  const ids = skills.map(s => s.id)
  for (const id of ['ask', 'backlog', 'work-loop']) assert.ok(ids.includes(id), `${id} is among ${ids.join(', ')}`)
  // The pane skill needs Claude Code's hook: here its text would tell the model the plugin is broken.
  assert.ok(!ids.includes('plan'))
  assert.equal(skills.find(s => s.id === 'work-loop')?.autoinvoke, false)
  assert.equal(skills.find(s => s.id === 'ask')?.autoinvoke, true)
  assert.ok(skills.every(s => s.content.startsWith('---') && s.path.endsWith('SKILL.md')))
})

test('the session keeps its mode on its record, and the values a view draws from in memory only', async () => {
  const record: { metadata?: Json } = { metadata: { other: 1 } }
  const ctx = { session: { get: async () => record, update: async ({ metadata }: { metadata: Json }) => void (record.metadata = metadata) } }
  const state = sessionState(ctx as never, 's1')
  assert.equal(await state.get('mode'), 'production')
  await state.set('mode', 'rapid')
  await state.set('planChanged', ['1'])
  // Another plugin's metadata stays, and only the kept values are written.
  assert.deepEqual(record.metadata, { other: 1, waffles: { mode: 'rapid' } })
  // The plan outline's tree is written for the terminal UI part, and not read back.
  await state.set('planTree', null)
  assert.deepEqual(record.metadata, { other: 1, waffles: { mode: 'rapid', planTree: null } })
  assert.equal(await sessionState(ctx as never, 's1').get('planTree'), null)
  assert.deepEqual(await state.get('planChanged'), ['1'])
  // A reopened session reads its mode back from the record.
  assert.equal(await sessionState(ctx as never, 's1').get('mode'), 'rapid')
})

test('setup registers the plan outline tool, the mode commands, the skills, and the hooks', async () => {
  const { registered, cleanup } = await fakeContext()
  assert.deepEqual(registered.tools.map(t => t.name), [NAMES.planTool, ...TOOLS.map(t => `waffles_${t.name}`)])
  assert.deepEqual(registered.commands.map(c => c.name).sort(), ['auto-effort', 'backlog-entry', 'prod', 'rapid'])
  assert.ok(registered.skills.length >= 10)
  assert.deepEqual(Object.keys(registered.hooks).sort(), ['permission.evaluate', 'session.context', 'session.prompt', 'tool.execute.after'])
  await cleanup()
})

test('every model request gets the modes and the plan outline rules, with the names OpenCode uses', async () => {
  const { registered, cleanup } = await fakeContext()
  const event = { system: [] as { type: string; text: string }[] }
  await registered.hooks['session.context']!(event as never)
  assert.equal(event.system.length, 2)
  assert.equal(event.system[0]?.text, MODES_TEXT)
  assert.match(event.system[1]?.text ?? '', /Change it only with the waffles_plan tool/)
  assert.match(event.system[1]?.text ?? '', /ask the person with question before you add it/)
  await cleanup()
})

test('the plan outline tool works for the main session and refuses a subagent', async () => {
  const { root, registered, entries, cleanup } = await fakeContext({ s1: {}, child: { parentID: 's1' } })
  const tool = registered.tools[0]!
  const made = await tool.execute({ op: 'goal', title: 'Ship it', steps: [{ title: 'Build' }] }, { sessionID: 's1' })
  assert.match(made.content, /new goal: Ship it/)
  assert.match(await fs.readFile(join(root, '.waffles', 'plan', 'ship-it.md'), 'utf8'), /Build/)
  // A refusal is thrown, so the model reads it as the call's error.
  await assert.rejects(tool.execute({ op: 'focus', id: '9' }, { sessionID: 's1' }), /No step 9/)
  await assert.rejects(tool.execute({ op: 'show' }, { sessionID: 'child' }), new RegExp(SUBAGENT))
  // The first event of the session told the model its mode.
  assert.equal(entries.get('s1')?.get('waffles-mode'), 'waffles mode: production')
  await cleanup()
})

test('a core tool answers the main session and a subagent alike, and a refusal is thrown', async () => {
  const { root, registered, cleanup } = await fakeContext({ s1: {}, child: { parentID: 's1' } })
  // A gh on the PATH that answers pull request 12 of o/r as merged, and fails every other call.
  const bin = join(root, 'bin')
  await fs.mkdir(bin)
  const gh = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify({ number: 12, url: 'https://github.com/o/r/pull/12', baseRefName: 'main', reviewDecision: '' }))
else if (args[0] === 'api' && args[1] === 'graphql') console.log(JSON.stringify({ data: { repository: { pullRequest: { state: 'MERGED', merged: true, isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null, timelineItems: { nodes: [] } } } } }))
else { console.error('gh: HTTP 502'); process.exit(1) }
`
  await fs.writeFile(join(bin, 'gh'), gh, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${path}`
  try {
    const tool = registered.tools.find(t => t.name === 'waffles_merge_queue')!
    assert.equal(tool.description, MERGE_QUEUE_TOOL.description)
    assert.deepEqual([tool.input, tool.output], [MERGE_QUEUE_TOOL.inputSchema, MERGE_QUEUE_TOOL.outputSchema])
    for (const sessionID of ['s1', 'child']) {
      const merged = await tool.execute({ op: 'state', pr: '12' }, { sessionID })
      assert.deepEqual(merged, { output: { state: 'merged', number: 12 }, content: '{"state":"merged","number":12}' }, sessionID)
    }
    await assert.rejects(tool.execute({ op: 'mode', pr: '12' }, { sessionID: 's1' }), /gh api rules\/branches\/main failed: gh: HTTP 502/)
  } finally {
    process.env.PATH = path
    await cleanup()
  }
})

test('the backlog queue answers a subagent with a structured value, in the folder it is given', async () => {
  const { root, registered, cleanup } = await fakeContext({ s1: {}, child: { parentID: 's1' } })
  try {
    const tool = registered.tools.find(t => t.name === 'waffles_backlog_queue')!
    const backlog = join(root, '.backlog')
    const added = await tool.execute({ op: 'add', step: 'claim', item: 'ITEM-4', why: 'no network', backlog }, { sessionID: 'child' })
    assert.equal((added.output as Entry).item, 'ITEM-4')
    const listed = await tool.execute({ op: 'list', backlog }, { sessionID: 's1' })
    assert.deepEqual((listed.output as { entries: Entry[] }).entries.map(e => e.item), ['ITEM-4'])
    await assert.rejects(tool.execute({ op: 'done', seq: 1, backlog }, { sessionID: 's1' }), /Refused: no queued call 1/)
  } finally {
    await cleanup()
  }
})

test('/rapid then /prod keeps the mode on the session and hands the rapid work to the model', async () => {
  const { registered, sessions, entries, cleanup } = await fakeContext()
  const command = (name: string) => registered.commands.find(c => c.name === name)!.execute({ sessionID: 's1' })
  await command('rapid')
  assert.equal((sessions.get('s1')?.metadata?.waffles as Json).mode, 'rapid')
  assert.match(String(entries.get('s1')?.get('waffles-mode')), /^waffles mode: rapid\./)
  await command('prod')
  assert.equal((sessions.get('s1')?.metadata?.waffles as Json).mode, 'production')
  assert.match(String(entries.get('s1')?.get('waffles-mode')), /^waffles mode: production\. Rapid mode has ended/)
  // Outside git no base is recorded, so there is no rapid work to assess and no prompt is sent.
  assert.deepEqual(registered.prompts, [])
  await cleanup()
})

test('a permission request is left alone outside an unattended run', async () => {
  const { registered, cleanup } = await fakeContext()
  const event = { sessionID: 's1', action: 'edit', resources: ['a.ts'], effect: 'ask' as string, message: undefined as string | undefined }
  await registered.hooks['permission.evaluate']!(event as never)
  assert.equal(event.effect, 'ask')
  await cleanup()
})

const prompt = (sessionID: string, text: string, skills: string[] = []) => ({ sessionID, prompt: { text, skills: skills.map(id => ({ id })) }, delivery: 'steer' })
const signal = () => new AbortController().signal

test('a prompt that names the non-interactive skill starts a run, and the next prompt typed between turns ends it', async () => {
  const { registered, sessions, emit, cleanup } = await fakeContext()
  const runOf = () => (sessions.get('s1')?.metadata?.waffles as Json | undefined)?.run
  await registered.hooks['session.prompt']!(prompt('s1', '@non-interactive finish the work', ['non-interactive']) as never)
  assert.equal(runOf(), true)
  // A prompt delivered into the running turn leaves the run on.
  await emit({ type: 'session.execution.started', data: { sessionID: 's1' } })
  await registered.hooks['session.prompt']!(prompt('s1', 'also this') as never)
  assert.equal(runOf(), true)
  // Another skill named between turns is a command, not a run.
  await emit({ type: 'session.execution.succeeded', data: { sessionID: 's1' } })
  await registered.hooks['session.prompt']!(prompt('s1', '@ask', ['ask']) as never)
  assert.equal(runOf(), false)
  await cleanup()
})

test('during a run, the start question reaches the person and every later question is refused', async () => {
  const { registered, question, cleanup } = await fakeContext()
  const ask = () => question.execute({ questions: [] }, { sessionID: 's1', signal: signal() })
  question.answer = Promise.resolve({ content: 'A' })
  // Outside a run a question goes through.
  assert.deepEqual(await ask(), { content: 'A' })
  await registered.hooks['session.prompt']!(prompt('s1', 'go', ['non-interactive']) as never)
  assert.deepEqual(await ask(), { content: 'A' })
  await assert.rejects(ask(), /^Error: Denied: The user is away .* can't answer\. A run asks 1 question/)
  // A permission request during a run is denied rather than left waiting.
  const event = { sessionID: 's1', action: 'edit', resources: ['a.ts'], effect: 'ask' as string, message: undefined as string | undefined }
  await registered.hooks['permission.evaluate']!(event as never)
  assert.equal(event.effect, 'deny')
  assert.match(event.message ?? '', /^Denied: The user is away/)
  await cleanup()
})

test("a subagent asks under its main session's run", async () => {
  const { registered, question, cleanup } = await fakeContext({ s1: {}, child: { parentID: 's1' } })
  question.answer = Promise.resolve({ content: 'A' })
  const ask = () => question.execute({ questions: [] }, { sessionID: 'child', signal: signal() })
  assert.deepEqual(await ask(), { content: 'A' })
  await registered.hooks['session.prompt']!(prompt('s1', 'go', ['non-interactive']) as never)
  // Even the run's first question: a subagent reports its question in its result.
  await assert.rejects(ask(), /Report the question in your result/)
  const event = { sessionID: 'child', action: 'shell', resources: ['rm'], effect: 'ask' as string, message: undefined as string | undefined }
  await registered.hooks['permission.evaluate']!(event as never)
  assert.equal(event.effect, 'deny')
  assert.match(event.message ?? '', /report it in your result/)
  await cleanup()
})

test("a typed prompt's turn runs at the level the session's own model picks, asked at its lowest variant", async () => {
  const { registered, cleanup } = await fakeContext()
  registered.messages = [
    { type: 'user', text: 'hi' },
    { type: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'Renamed foo.' }] },
    { type: 'assistant', content: [{ type: 'tool', name: 'read' }] },
  ]
  await registered.hooks['session.prompt']!(prompt('s1', 'what does this do?') as never)
  const request = { sessionID: 's1', model: { providerID: 'anthropic', id: 'claude-sonnet-5-5' }, system: [] as Json[], options: { maxTokens: 100 } as Json }
  await registered.hooks['session.context']!(request as never)
  assert.deepEqual(request.options, { maxTokens: 100, effort: 'low' })
  assert.deepEqual(registered.generated[0]?.model, { providerID: 'anthropic', id: 'claude-sonnet-5-5', variant: 'none' })
  // The pick reads the last reply that holds text.
  assert.match(String(registered.generated[0]?.prompt), /<reply>\nRenamed foo\.\n<\/reply>/)
  await cleanup()
})

test("/auto-effort off is kept in the person's values, and its line is left for the terminal UI part", async () => {
  const { registered, sessions, cleanup } = await fakeContext()
  await registered.commands.find(c => c.name === 'auto-effort')!.execute({ sessionID: 's1', prompt: { text: 'off' } })
  assert.equal(registered.storage.get('store/effort.enabled'), false)
  const notice = sessions.get('s1')?.metadata?.['waffles.notice'] as Json
  assert.match(String(notice.text), /^Auto effort: off\./)
  assert.equal(typeof notice.at, 'number')
  // With it off, a typed prompt's turn runs at the model's variant, and nothing is asked.
  await registered.hooks['session.prompt']!(prompt('s1', 'what does this do?') as never)
  const request = { sessionID: 's1', model: { providerID: 'anthropic', id: 'claude-sonnet-5-5' }, system: [] as Json[], options: {} as Json }
  await registered.hooks['session.context']!(request as never)
  assert.deepEqual(request.options, {})
  assert.equal(registered.generated.length, 0)
  await cleanup()
})

test("a subagent's requests run at its own variant", async () => {
  const { registered, cleanup } = await fakeContext({ s1: {}, child: { parentID: 's1' } })
  const request = { sessionID: 'child', model: { providerID: 'anthropic', id: 'claude-sonnet-5-5' }, system: [] as Json[], options: {} as Json }
  await registered.hooks['session.context']!(request as never)
  assert.deepEqual(request.options, {})
  await cleanup()
})

// The plan outline's tree as the session's record holds it for the terminal UI part, once `ready` holds.
async function treeWhen(sessions: Map<string, { metadata?: Json }>, ready: (steps: Json[]) => boolean): Promise<Json[]> {
  for (let i = 0; i < 100; i++) {
    const steps = ((sessions.get('s1')?.metadata?.waffles as Json | undefined)?.planTree as { steps?: Json[] } | null | undefined)?.steps ?? []
    if (ready(steps)) return steps
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('The plan outline never got there.')
}

const subagent = (sessionID: string, input: Json, child: string) => ({
  tool: 'subagent',
  status: 'completed',
  sessionID,
  input,
  result: { content: 'started', metadata: { sessionID: child, status: 'running' } },
})

test("a subagent whose description names a step marks it, and its turn's end sets the step to review", async () => {
  const { registered, sessions, emit, cleanup } = await fakeContext({ s1: {}, child: { parentID: 's1' } })
  await registered.tools[0]!.execute({ op: 'goal', title: 'Ship it', steps: [{ title: 'Build' }, { title: 'Test' }] }, { sessionID: 's1' })
  await registered.hooks['tool.execute.after']!(subagent('s1', { agent: 'general', description: '2: Test it', prompt: 'p' }, 'child') as never)
  let steps = await treeWhen(sessions, all => all[1]?.agent === 'child')
  assert.equal(steps[0]?.agent, undefined)
  await emit({ type: 'session.execution.succeeded', data: { sessionID: 'child' } })
  steps = await treeWhen(sessions, all => all[1]?.agent === undefined)
  assert.equal(steps[1]?.state, 'review')
  await cleanup()
})

test('a subagent that names no step, a follow-up, or a subagent of a subagent marks nothing', async () => {
  const { registered, sessions, cleanup } = await fakeContext({ s1: {}, child: { parentID: 's1' } })
  await registered.tools[0]!.execute({ op: 'goal', title: 'Ship it', steps: [{ title: 'Build' }] }, { sessionID: 's1' })
  const after = (sessionID: string, input: Json) => registered.hooks['tool.execute.after']!(subagent(sessionID, input, 'other') as never)
  await after('s1', { description: '2 parallel searches', prompt: 'p' })
  await after('s1', { description: '1: Build', prompt: 'p', sessionID: 'other' })
  await after('child', { description: '1: Build', prompt: 'p' })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal((await treeWhen(sessions, () => true))[0]?.agent, undefined)
  await cleanup()
})

test("the core's sweep sees each child session, running while its last turn has not ended", async () => {
  const { registered, sessions, cleanup } = await fakeContext({
    s1: {},
    done: { parentID: 's1', time: { busy: 1, idle: 2 } },
    working: { parentID: 's1', time: { busy: 3, idle: 2 } },
    other: { parentID: 'elsewhere', time: { busy: 1 } },
  })
  await registered.tools[0]!.execute({ op: 'goal', title: 'Ship it', steps: [{ title: 'Build' }, { title: 'Test' }] }, { sessionID: 's1' })
  for (const [description, child] of [['1: Build', 'done'], ['2: Test', 'working']] as const) {
    await registered.hooks['tool.execute.after']!(subagent('s1', { description }, child) as never)
  }
  await treeWhen(sessions, all => all[0]?.agent === 'done' && all[1]?.agent === 'working')
  // Switching to the goal again sweeps its subagents: the one that ended goes to review.
  await registered.tools[0]!.execute({ op: 'goal', switch: 'ship-it' }, { sessionID: 's1' })
  const steps = await treeWhen(sessions, all => all[0]?.agent === undefined)
  assert.equal(steps[0]?.state, 'review')
  assert.equal(steps[1]?.agent, 'working')
  await cleanup()
})

test('a shell command that is no push leaves its result alone', async () => {
  const { registered, cleanup } = await fakeContext()
  const event = { tool: 'shell', status: 'completed', sessionID: 's1', input: { command: 'ls -la' }, result: { content: 'files' } }
  await registered.hooks['tool.execute.after']!(event as never)
  assert.equal(event.result.content, 'files')
  await cleanup()
})

test('after a push, the model reads what the checkpoint did', async () => {
  const { registered, cleanup } = await fakeContext()
  // Outside a git repository the checkpoint reports why it did nothing, which is still a line to read.
  const event = { tool: 'shell', status: 'completed', sessionID: 's1', input: { command: 'git push' }, result: { content: 'pushed' } }
  await registered.hooks['tool.execute.after']!(event as never)
  assert.match(event.result.content, /^pushed\n\nwaffles checkpoint: /)
  await cleanup()
})
