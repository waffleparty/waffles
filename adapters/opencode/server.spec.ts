import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { MODES_TEXT } from '../../core/modes.ts'
import { SUBAGENT } from '../../core/plan.ts'
import plugin, { NAMES, pluginRoot, readSkills, sessionState, skillHeader } from './server.ts'

type Json = Record<string, unknown>

type Tool = { name: string; description?: string; input?: unknown; execute: (input: unknown, context: Json) => Promise<{ content: string }> }

// A stand-in for OpenCode's plugin context: it keeps what the plugin registers, and a session record per ID.
// `emit` sends an event to the plugin's subscription; `question` is OpenCode's built-in question tool,
// which answers `answer` unless its signal aborts first.
async function fakeContext(sessionInfo: Record<string, { parentID?: string }> = { s1: {} }) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'waffles-opencode-')))
  const sessions = new Map<string, { id: string; parentID?: string; metadata?: Json; location: { directory: string } }>()
  for (const [id, info] of Object.entries(sessionInfo)) sessions.set(id, { id, ...info, location: { directory: root } })
  const entries = new Map<string, Map<string, unknown>>()
  const registered = {
    tools: [] as Tool[],
    commands: [] as { name: string; description?: string; execute: (input: Json) => Promise<void> }[],
    skills: [] as { id: string }[],
    hooks: {} as Record<string, (event: never) => unknown>,
    prompts: [] as Json[],
    storage: new Map<string, unknown>(),
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
  assert.deepEqual(registered.tools.map(t => t.name), [NAMES.planTool])
  assert.deepEqual(registered.commands.map(c => c.name).sort(), ['backlog-entry', 'prod', 'rapid'])
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
  assert.match(await fs.readFile(join(root, '.tmp', 'plan', 'ship-it.md'), 'utf8'), /Build/)
  // A refusal is thrown, so the model reads it as the call's error.
  await assert.rejects(tool.execute({ op: 'focus', id: '9' }, { sessionID: 's1' }), /No step 9/)
  await assert.rejects(tool.execute({ op: 'show' }, { sessionID: 'child' }), new RegExp(SUBAGENT))
  // The first event of the session told the model its mode.
  assert.equal(entries.get('s1')?.get('waffles-mode'), 'waffles mode: production')
  await cleanup()
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
