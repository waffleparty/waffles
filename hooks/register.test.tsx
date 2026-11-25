import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionCompactInput, SessionMessage } from 'claude-code'

const MODES = { plugin: 'waffles', component: 'SessionMode' } as const

const MARK = ['●', ' production', ' · ']

test('the right end of the footer shows the run marker, the engine modes, then the effort', async ($, on) => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...MODES, surface, props: { modes: ['focus', 'memory paused'] } })

    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual([...MARK, 'focus & memory paused', ' · ', 'effort: auto'])
    await ui.unmount()
  }
})

// Stands in for the engine: the pick's answer, and the effort each request goes out at.
function engine(on: On, pick: string) {
  const efforts: unknown[] = []
  on('model.complete', () => ({
    value: { isAnswered: true, text: pick, usage: { input_tokens: 0, output_tokens: 0 } },
  }) as never)
  on('session.messages', () => ({ value: [] }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.step', async function* ($, e) {
    efforts.push(e.effort)

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  return efforts
}

async function step($: Engine, index: number, effort: string) {
  const s = $.turn.step({ turnId: 't1', index, model: 'opus', effort: effort as 'medium', messageCount: 1 })
  for await (const _ of s);
  return s.result
}

const typed = { origin: { kind: 'composer' }, wait: false } as const
const run = { ...typed, text: 'finish it', command: { name: 'waffles:non-interactive', args: 'finish it' } } as const

async function drawFooter($: Engine) {
  const ui = await $.ui.mount({ ...MODES, surface: 'terminal', props: { modes: [] } })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.map(t => t.text)
}

test('the footer shows auto effort waiting for a prompt', async ($, on) => {
  expect(await drawFooter($)).toEqual(expect.arrayContaining(['effort: auto']))
})

test('an active run shows in the footer with the level its turn runs at', async ($, on) => {
  engine(on, '{"level": "low", "why": "x"}')

  await $.prompt.submit(run)
  await step($, 0, 'medium')

  expect(await drawFooter($)).toEqual(['▶', ' non-interactive', ' · ', 'effort: auto (extra high)'])
})

test('while the level is picked the footer says so', async ($, on) => {
  on('session.messages', () => ({ value: [] }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
  })
  let seen: string[] = []
  on('model.complete', async () => {
    seen = await drawFooter($)
    return { value: { isAnswered: true, text: '{"level": "low", "why": "x"}', usage: { input_tokens: 0, output_tokens: 0 } } } as never
  })

  await $.prompt.submit({ ...typed, text: 'rename foo' })
  await step($, 0, 'medium')

  expect(seen).toEqual(expect.arrayContaining(['effort: auto (picking…)']))
  expect(await drawFooter($)).toEqual(expect.arrayContaining(['effort: auto (low)']))
})

test('with auto effort off the footer shows the setting', async ($, on) => {
  const seeded: Record<string, unknown> = { effortMode: 'off', effortSetting: 'high' }
  on('state.get', ($, e, next) => (e.key in seeded ? { value: { value: seeded[e.key], version: 1 } } : next(e)) as never)

  expect(await drawFooter($)).toEqual(expect.arrayContaining(['effort: high']))
})

test('a typed prompt runs its turn at the picked level', async ($, on) => {
  const efforts = engine(on, '{"level": "high", "why": "multi-file bug hunt"}')

  await $.prompt.submit({ ...typed, text: 'Why do the payment webhooks double-charge?' })
  await step($, 0, 'medium')
  await step($, 1, 'medium')

  expect(efforts).toEqual(['high', 'high'])
})

test('/auto-effort off runs turns at the setting, and on picks again', async ($, on) => {
  const efforts = engine(on, '{"level": "high", "why": "x"}')

  expect((await $.command.run({ command: 'auto-effort', args: 'off' })).text).toContain('Auto effort: off.')
  await $.prompt.submit({ ...typed, text: 'Why do the payment webhooks double-charge?' })
  await step($, 0, 'medium')

  expect((await $.command.run({ command: 'auto-effort', args: 'on' })).text).toContain('Auto effort: on.')
  await $.prompt.submit({ ...typed, text: 'Why do the payment webhooks double-charge?' })
  await step($, 0, 'medium')

  expect(efforts).toEqual(['medium', 'high'])
})

test('/auto-effort takes only on or off', async ($, on) => {
  const r = await $.command.run({ command: 'auto-effort', args: 'suggest' })

  expect(r.text).toBe('Unknown argument: suggest. Use on or off.')
})

test('/effort with a level turns auto effort off', async ($, on) => {
  const efforts = engine(on, '{"level": "low", "why": "x"}')
  on('command.run', () => ({ text: 'Set effort level to high' }))

  await $.command.run({ command: 'effort', args: 'high' })
  await $.prompt.submit({ ...typed, text: 'rename foo' })
  await step($, 0, 'high')

  expect(efforts).toEqual(['high'])
  expect(await drawFooter($)).toEqual(expect.arrayContaining(['effort: high']))
  await $.command.run({ command: 'auto-effort', args: 'on' })
})

test('/effort max turns auto effort off too', async ($, on) => {
  const efforts = engine(on, '{"level": "low", "why": "x"}')
  on('settings.read', () => ({ value: { effortLevel: 'max' } }) as never)
  on('command.run', () => ({ text: 'Set effort level to max' }))

  await $.command.run({ command: 'effort', args: 'max' })
  await $.prompt.submit({ ...typed, text: 'rename foo' })
  await step($, 0, 'max')

  expect(efforts).toEqual(['max'])
  expect(await drawFooter($)).toEqual(expect.arrayContaining(['effort: max']))
  await $.command.run({ command: 'auto-effort', args: 'on' })
})

test('a slash command keeps the setting', async ($, on) => {
  const efforts = engine(on, '{"level": "high", "why": "x"}')

  await $.prompt.submit({ ...typed, text: '/waffles:non-interactive fix it' })
  await step($, 0, 'medium')

  expect(efforts).toEqual(['medium'])
})

test('a pick outside the levels is ignored', async ($, on) => {
  const efforts = engine(on, '{"level": "max", "why": "critical"}')

  await $.prompt.submit({ ...typed, text: 'Rewrite the whole billing system' })
  await step($, 0, 'medium')

  expect(efforts).toEqual(['medium'])
})

test('moving the setting mid-turn wins', async ($, on) => {
  const efforts = engine(on, '{"level": "low", "why": "a rename"}')

  await $.prompt.submit({ ...typed, text: 'Rename foo to bar' })
  await step($, 0, 'medium')
  await step($, 1, 'high')

  expect(efforts).toEqual(['low', 'high'])
})

test('a non-interactive run holds every turn at Extra high until a prompt is typed', async ($, on) => {
  const efforts = engine(on, '{"level": "low", "why": "a quick question"}')

  await $.prompt.submit({ ...typed, text: 'finish it', command: { name: 'waffles:non-interactive', args: 'finish it' } })
  await step($, 0, 'medium')
  await step($, 1, 'medium')
  // A background agent finishing starts a turn nobody typed.
  await step($, 0, 'medium')
  await $.prompt.submit({ ...typed, text: 'What changed?' })
  await step($, 0, 'medium')

  expect(efforts).toEqual(['xhigh', 'xhigh', 'xhigh', 'low'])
})

const ask = { tool_name: 'Bash', tool_input: { command: 'git push' } }

test('outside a run a permission request goes to the person', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  // Stands in for the dialog: no answer.
  on('classic.PermissionRequest', () => ({}))

  await $.prompt.submit({ ...typed, text: 'Push it' })

  expect((await $.classic.PermissionRequest(ask)).decision).toBe(undefined)
})

test('during a run a permission request is denied, and a typed prompt ends the run', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  // Stands in for the dialog: no answer.
  on('classic.PermissionRequest', () => ({}))

  await $.prompt.submit(run)
  const main = await $.classic.PermissionRequest(ask)
  const agent = await $.classic.PermissionRequest({ ...ask, agent_id: 'a1' })
  await $.prompt.submit({ ...typed, text: 'What changed?' })
  const after = await $.classic.PermissionRequest(ask)

  expect(main.decision).toEqual({ behavior: 'deny', message: expect.stringMatching(/The user is away.*leave the step to the user in the plan outline/) })
  expect(agent.decision).toEqual({ behavior: 'deny', message: expect.stringMatching(/report it in your result/) })
  expect(after.decision).toBe(undefined)
})

test('5 denials in a row wrap the run up', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.prompt.submit(run)
  const messages: unknown[] = []
  for (let i = 0; i < 5; i += 1) {
    const r = await $.classic.PermissionRequest(ask)
    messages.push(r.decision?.behavior === 'deny' ? r.decision.message : undefined)
  }

  expect(messages[3]).toEqual(expect.stringMatching(/The user is away/))
  expect(messages[4]).toEqual(expect.stringMatching(/5 permission requests in a row.*plan outline, and finish as the skill's Finishing section says/))
})

const question = {
  tool: 'AskUserQuestion',
  questions: [
    {
      question: 'The checkout of widget holds 3 commits that are not on the remote. Do they belong to this run?',
      header: 'Run start',
      multiSelect: false,
      options: [
        { label: 'Include them (Recommended)', description: 'They go into the run\'s branch.' },
        { label: 'Leave them out', description: 'The run does not merge its pull request.' },
      ],
    },
  ],
} as never

const ANSWERED = { result: { answered: 'Include them (Recommended)' } }

// Stands in for the engine's question dialog: answered at once, or never.
function dialog(on: On, isAnswered: boolean) {
  const shown: unknown[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    shown.push(e)
    return (isAnswered ? ANSWERED : new Promise(() => {})) as never
  })
  return shown
}

test('outside a run a question goes to the person', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  const shown = dialog(on, true)

  await $.prompt.submit({ ...typed, text: 'Ask me' })
  const r = await $.tool.call(question)

  expect(shown.length).toBe(1)
  expect(r).toEqual(ANSWERED)
})

test('the first question of a run is shown, and its answer returned', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  mock.clock(on)
  const shown = dialog(on, true)

  await $.prompt.submit(run)
  const r = await $.tool.call(question)

  expect(shown.length).toBe(1)
  expect(r).toEqual(ANSWERED)
})

test('a start question nobody answers ends after 60 seconds', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  const clock = mock.clock(on)
  const shown = dialog(on, false)

  await $.prompt.submit(run)
  let settled = false
  const pending = $.tool.call(question).then(r => {
    settled = true
    return r
  })
  await clock.advance(59_999)
  const before = settled
  await clock.advance(1)
  const r = await pending

  expect(shown.length).toBe(1)
  expect(before).toBe(false)
  expect(r.deny).toEqual(expect.stringMatching(/^No answer in 60 seconds\./))
})

test('a second question in a run is refused at once', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  mock.clock(on)
  const shown = dialog(on, true)

  await $.prompt.submit(run)
  await $.tool.call(question)
  const second = await $.tool.call(question)

  expect(shown.length).toBe(1)
  expect(second.deny).toEqual(expect.stringMatching(/^Denied: The user is away.*Make the decision yourself/))
})

test('a question from a sub-agent in a run is refused at once, and the start question stays open', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  mock.clock(on)
  const shown = dialog(on, true)

  await $.prompt.submit(run)
  const agent = await $.tool.call({ ...(question as object), agentId: 'a1' } as never)
  const main = await $.tool.call(question)

  expect(agent.deny).toEqual(expect.stringMatching(/^Denied: The user is away.*Report the question in your result/))
  expect(shown.length).toBe(1)
  expect(main).toEqual(ANSWERED)
})

test('a question later than 5 minutes into a run is refused at once', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  const clock = mock.clock(on)
  const shown = dialog(on, true)

  await $.prompt.submit(run)
  await clock.advance(300_001)
  const r = await $.tool.call(question)

  expect(shown.length).toBe(0)
  expect(r.deny).toEqual(expect.stringMatching(/^Denied: The user is away/))
})

test('while the start question is open its permission request goes to the person, and others are denied', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  // Stands in for the dialog: no answer.
  on('classic.PermissionRequest', () => ({}))
  const clock = mock.clock(on)
  dialog(on, false)

  await $.prompt.submit(run)
  const pending = $.tool.call(question)
  await clock.advance(1)
  const own = await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: {} })
  const other = await $.classic.PermissionRequest(ask)
  await clock.advance(60_000)
  await pending
  const after = await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: {} })

  expect(own.decision).toBe(undefined)
  expect(other.decision?.behavior).toBe('deny')
  expect(after.decision?.behavior).toBe('deny')
})

test('a question whose check fails during a run is refused, not left open', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  let reads = 0
  on('clock.now', () => {
    reads += 1
    if (reads > 1) throw new Error('no clock')
    return { value: 0 }
  })
  const shown = dialog(on, true)

  await $.prompt.submit(run)
  const r = await $.tool.call(question)

  expect(shown.length).toBe(0)
  expect(r.deny).toEqual(expect.stringMatching(/^Denied: The user is away/))
})

test('a start question whose check failed is used up: the next question is refused too', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  let reads = 0
  on('clock.now', () => {
    reads += 1
    if (reads === 2) throw new Error('no clock')
    return { value: 0 }
  })
  const shown = dialog(on, true)

  await $.prompt.submit(run)
  await $.tool.call(question)
  const second = await $.tool.call(question)

  expect(shown.length).toBe(0)
  expect(second.deny).toEqual(expect.stringMatching(/^Denied: The user is away/))
})

test('2 questions asked at once in a run show 1 dialog', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  const clock = mock.clock(on)
  const shown = dialog(on, false)

  await $.prompt.submit(run)
  const first = $.tool.call(question)
  const second = await $.tool.call(question)
  await clock.advance(60_000)
  await first

  expect(shown.length).toBe(1)
  expect(second.deny).toEqual(expect.stringMatching(/^Denied: The user is away/))
})

test('a new run may ask its own start question', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  mock.clock(on)
  const shown = dialog(on, true)

  await $.prompt.submit(run)
  await $.tool.call(question)
  await $.prompt.submit({ ...typed, text: 'What changed?' })
  await $.prompt.submit(run)
  const r = await $.tool.call(question)

  expect(shown.length).toBe(2)
  expect(r).toEqual(ANSWERED)
})

// Stands in for the engine's prompt.submit: the context each prompt entered with.
function contexts(on: On) {
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', ($, e) => (seen.push(e.context), { text: e.text }))
  return seen
}

// Stands in for the engine's end step.
function ends(on: On) {
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
}

const BACKLOG_TAG = 'waffles mode: backlog'

test('/backlog-entry shows a purple backlog mode in the footer, and /prod returns', async ($, on) => {
  const on1 = await $.command.run({ command: 'backlog-entry', args: '' })
  const backlog = await drawFooter($)
  const off = await $.command.run({ command: 'prod', args: '' })

  expect(on1.text).toContain('Backlog mode: on.')
  expect(backlog.slice(0, 2)).toEqual(['●', ' backlog'])
  expect(off.text).toContain('Backlog mode: off.')
  expect((await drawFooter($)).slice(0, 2)).toEqual(['●', ' production'])
})

test('in backlog mode a typed prompt is sent to the backlog skill', async ($, on) => {
  const seen = contexts(on)

  await $.prompt.submit({ ...typed, text: 'Add dark mode' })
  await $.command.run({ command: 'backlog-entry', args: '' })
  await $.prompt.submit({ ...typed, text: 'Add dark mode' })
  // Typed over the running turn, still the person's.
  await $.prompt.submit({ ...typed, text: 'And a settings page', turnId: 't1' })
  await $.prompt.submit({ ...typed, text: '/waffles:backlog-review', command: { name: 'waffles:backlog-review', args: '' } })
  await $.prompt.submit({ text: 'Agent finished', origin: { kind: 'task-notification' }, wait: false } as never)
  await $.command.run({ command: 'prod', args: '' })
  await $.prompt.submit({ ...typed, text: 'Add dark mode' })

  expect(seen).toEqual([undefined, [BACKLOG_TAG], [BACKLOG_TAG], undefined, undefined, undefined])
})

test('/clear returns to production mode', async ($, on) => {
  const seen = contexts(on)
  ends(on)

  await $.command.run({ command: 'backlog-entry', args: '' })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.prompt.submit({ ...typed, text: 'Add dark mode' })

  expect(seen).toEqual([undefined])
  expect((await drawFooter($)).slice(0, 2)).toEqual(['●', ' production'])
})

test('other session ends keep backlog mode', async ($, on) => {
  ends(on)
  await $.command.run({ command: 'backlog-entry', args: '' })
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })

  expect((await drawFooter($)).slice(0, 2)).toEqual(['●', ' backlog'])
  await $.command.run({ command: 'prod', args: '' })
})

test('a non-interactive run ends backlog mode', async ($, on) => {
  const seen = contexts(on)

  await $.command.run({ command: 'backlog-entry', args: '' })
  await $.prompt.submit(run)
  expect((await drawFooter($)).slice(0, 2)).toEqual(['▶', ' non-interactive'])
  await $.prompt.submit({ ...typed, text: 'What changed?' })

  expect(seen).toEqual([undefined, undefined])
  expect((await drawFooter($)).slice(0, 2)).toEqual(['●', ' production'])
})

test('backlog mode keeps auto effort picking from the prompt', async ($, on) => {
  const efforts = engine(on, '{"level": "high", "why": "abstract idea to break down"}')

  await $.command.run({ command: 'backlog-entry', args: '' })
  await $.prompt.submit({ ...typed, text: 'Make onboarding feel less overwhelming' })
  await step($, 0, 'medium')
  await $.command.run({ command: 'prod', args: '' })

  expect(efforts).toEqual(['high'])
})

const production = { command: 'prod', args: '' } as const
const backlog = { command: 'backlog-entry', args: '' } as const

// Stands in for the engine's prompt.submit and the session's store: the notes and prompts in the order they land.
function landed(on: On, origins: unknown[] = []) {
  const log: string[] = []
  on('prompt.submit', ($, e) => (log.push(`prompt: ${e.text}`), origins.push(e.origin), { text: e.text }))
  on('session.append', { door: 'note' }, ($, e, next) => {
    log.push(e.message.content.map(b => (b.type === 'text' ? b.text : '')).join(''))
    return next(e)
  })
  return log
}

// Starts from production mode with no run, whatever an earlier test left, and an empty log.
async function fresh($: Engine, log: string[]) {
  await $.command.run(production)
  log.length = 0
}

const rapid = { command: 'rapid', args: '' } as const

const HEAD = '0123456789abcdef0123456789abcdef01234567'

// Stands in for git: HEAD, and `git status` listing a change, a rename and an untracked folder;
// with no head, a directory outside any repository.
function git(on: On, head: string | null = HEAD) {
  const ran: string[][] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    if (head === null) return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } } as never
    if (e.argv[1] === 'rev-parse') return { value: { exitCode: 0, stdout: `${head}\n`, stderr: '' } } as never
    return { value: { exitCode: 0, stdout: ' M src/app.ts\0R  new.ts\0old.ts\0?? notes/\0', stderr: '' } } as never
  })
  return ran
}

const compose = { model: 'opus', promptModel: 'opus', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const

test('the system prompt defines the modes in one section that never changes', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  git(on)

  const first = await $.prompt.compose(compose)
  await $.command.run(backlog)
  const inBacklog = await $.prompt.compose(compose)
  await $.prompt.submit(run)
  const inRun = await $.prompt.compose(compose)
  await $.command.run(rapid)
  const inRapid = await $.prompt.compose(compose)
  await $.command.run(production)

  expect(first.sections.map(s => s.id)).toEqual(['intro', 'waffles:modes', 'waffles:plan-outline'])
  expect(first.sections[1]).toEqual({ id: 'waffles:modes', scope: 'session', text: expect.stringMatching(/most recent statement.*is the current mode/s) })
  expect(first.sections[1]?.text).not.toMatch(/system-reminder|SYSTEM/)
  expect(inBacklog).toEqual(first)
  expect(inRun).toEqual(first)
  expect(inRapid).toEqual(first)
})

test('the first message states the mode current when it is made', async ($, on) => {
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  git(on)
  const core = { blocks: [{ name: 'currentDate', text: "Today's date is 2026-11-12." }] }
  const stated = async () => (await $.prompt.context(core)).blocks

  await $.command.run(production)
  const fresh = await stated()
  await $.command.run(backlog)
  const inBacklog = await stated()
  await $.prompt.submit(run)
  const inRun = await stated()
  await $.command.run(rapid)
  const inRapid = await stated()
  await $.command.run(production)

  expect(fresh).toEqual([...core.blocks, { name: 'wafflesMode', text: 'waffles mode: production' }])
  expect(inBacklog.at(-1)).toEqual({ name: 'wafflesMode', text: 'waffles mode: backlog' })
  expect(inRun.at(-1)).toEqual({ name: 'wafflesMode', text: 'waffles mode: non-interactive' })
  expect(inRapid.at(-1)).toEqual({ name: 'wafflesMode', text: 'waffles mode: rapid' })
})

test('each change of mode appends one note, ahead of the prompt that made it', async ($, on) => {
  const session = mock.session(on)
  const log = landed(on)
  await fresh($, log)
  const before = session.appended().length

  await $.command.run(backlog)
  await $.command.run(backlog)
  await $.command.run(production)
  await $.prompt.submit(run)
  // Typed over the running turn: the run goes on.
  await $.prompt.submit({ ...typed, text: 'Also the docs', turnId: 't1' })
  await $.prompt.submit({ ...typed, text: 'What changed?' })
  await $.prompt.submit({ ...typed, text: 'And the tests?' })

  expect(log).toEqual([
    expect.stringMatching(/^waffles mode: backlog\. Each typed prompt goes verbatim to the waffles:backlog skill/),
    expect.stringMatching(/^waffles mode: production\. Backlog mode has ended/),
    expect.stringMatching(/^waffles mode: non-interactive\. A \/waffles:non-interactive run has started/),
    'prompt: finish it',
    'prompt: Also the docs',
    expect.stringMatching(/^waffles mode: production\. The non-interactive run has ended; the person is present\..*the run's commit rules and pull request path no longer apply: commits and pushes follow the person's own rules\.$/),
    'prompt: What changed?',
    'prompt: And the tests?',
  ])
  expect(session.appended().slice(before).map(r => [r.door, r.message.type])).toEqual([
    ['note', 'user'],
    ['note', 'user'],
    ['note', 'user'],
    ['note', 'user'],
  ])
})

test('a run started in backlog mode, and /prod during a run, each note both ends', async ($, on) => {
  const log = landed(on)
  await fresh($, log)

  await $.command.run(backlog)
  await $.prompt.submit(run)
  const r = await $.command.run(production)

  expect(r.text).toBe('Non-interactive run: ended. Back in production mode.')
  expect(log).toEqual([
    expect.stringMatching(/^waffles mode: backlog\./),
    expect.stringMatching(/^waffles mode: non-interactive\. Backlog mode has ended.*A \/waffles:non-interactive run has started/),
    'prompt: finish it',
    expect.stringMatching(/^waffles mode: production\. The non-interactive run has ended/),
  ])
  expect((await drawFooter($)).slice(0, 2)).toEqual(['●', ' production'])
})

test('/clear ends a run, and the new conversation gets no note', async ($, on) => {
  ends(on)
  const log = landed(on)
  await fresh($, log)

  await $.prompt.submit(run)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await $.prompt.submit({ ...typed, text: 'Add dark mode' })

  expect(log).toEqual([expect.stringMatching(/^waffles mode: non-interactive\./), 'prompt: finish it', 'prompt: Add dark mode'])
  expect((await drawFooter($)).slice(0, 2)).toEqual(['●', ' production'])
})

test('compaction leaves out the notes, and only the notes', async ($, on) => {
  const log = landed(on)
  let seen: SessionCompactInput | undefined
  on('session.compact', ($, e) => ((seen = e), { messages: e.messages }))
  await fresh($, log)
  await $.command.run(backlog)
  await $.command.run(production)
  const [toBacklog, toProduction] = log
  const row = (role: 'user' | 'assistant', text: string): SessionMessage => ({ role, text, toolUses: [] })
  const messages = [
    row('user', 'Add dark mode'),
    row('user', toBacklog!),
    row('user', `Add a settings page\n\n${BACKLOG_TAG}`),
    row('assistant', 'Added 1 item.'),
    row('user', toProduction!),
    row('user', 'waffles mode: production, right?'),
    row('assistant', `It said: ${toProduction}`),
  ]

  await $.session.compact({ trigger: 'manual', instructions: 'Keep the plan.', messages })
  const manual = seen
  await $.session.compact({ trigger: 'auto', messages })
  const auto = seen
  await $.session.compact({ trigger: 'auto', agentId: 'a1', messages })
  const agent = seen

  expect(manual?.messages).toEqual([messages[0], messages[2], messages[3], messages[5], messages[6]])
  expect(manual?.instructions).toMatch(/^Keep the plan\.\n\nLeave waffles mode statements .*out of the summary/)
  expect(auto?.instructions).toMatch(/^Leave waffles mode statements/)
  expect(agent?.messages).toEqual(messages)
  expect(agent?.instructions).toBe(undefined)
})

const RAPID_NOTE = /^waffles mode: rapid\. .*Changes are made quickly and stay uncommitted in the working tree.*recorded as the base of the rapid work\.$/
const ASSESS = 'prompt: Production mode has started with rapid work pending. The latest waffles mode statement describes the rapid work and what comes before other work.'

// The note that hands rapid work over in production mode, after what the mode before it ended.
const handover = (ended: string) =>
  new RegExp(
    `^waffles mode: production\\. ${ended}.* Rapid work since commit ${HEAD} has not been brought up to standards\\. ` +
      'It excludes these paths \\(relative to the repository root\\), already changed when rapid mode started: src/app\\.ts, new\\.ts, old\\.ts, notes/\\. ' +
      `Before other work comes an assessment of it: the diff against ${HEAD}, untracked files included, .*\\(tests to write, checks to run, cleanup, docs\\)\\. ` +
      'Then the person is asked, with AskUserQuestion, which of three to do: bring it up to standards now; defer \\(stash\\).*; or defer \\(unstaged\\).* No option discards the rapid work: the person does that themselves\\. Once the person picks, commits follow the new mode\'s usual rules\\.$',
  )

async function drawMark($: Engine) {
  const ui = await $.ui.mount({ ...MODES, surface: 'terminal', props: { modes: [] } })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return [texts[0]?.props.color, texts[0]?.text, texts[1]?.text]
}

test('/rapid shows a chartreuse rapid mode in the footer and records the git base once', async ($, on) => {
  const ran = git(on)
  const log = landed(on)
  await fresh($, log)
  const inProduction = await drawMark($)

  const r = await $.command.run(rapid)
  const inRapid = await drawMark($)
  const again = await $.command.run(rapid)

  expect(inProduction).toEqual(['#6495ed', '●', ' production'])
  expect(inRapid).toEqual(['#7fff00', '●', ' rapid'])
  expect(r.text).toBe('Rapid mode: on. Changes are made quickly, without tests, checks or commits. /prod offers to bring them up to standards or defer them.')
  expect(again.text).toBe('Already in rapid mode.')
  expect(ran).toEqual([
    ['git', 'rev-parse', 'HEAD'],
    ['git', 'status', '--porcelain', '-z'],
  ])
  expect(log).toEqual([expect.stringMatching(RAPID_NOTE)])
  await $.command.run(production)
})

test('/prod after rapid work names its base and the paths changed before it, then starts the assessment', async ($, on) => {
  git(on)
  const clock = mock.clock(on)
  const origins: unknown[] = []
  const log = landed(on, origins)
  await fresh($, log)
  origins.length = 0

  await $.command.run(rapid)
  const r = await $.command.run(production)
  await clock.advance(1)
  const again = await $.command.run(production)

  expect(r.text).toBe('Rapid mode: off. Back in production mode. Claude reviews the rapid work, then asks whether to bring it up to standards now or defer it.')
  expect(log).toEqual([expect.stringMatching(RAPID_NOTE), expect.stringMatching(handover('Rapid mode has ended')), ASSESS])
  expect(origins).toEqual([{ kind: 'plugin', name: 'waffles' }])
  // Handed over once: the model owns it now.
  expect(again.text).toBe('Already in production mode.')
  expect(log).toHaveLength(3)
})

test('outside a git repository /rapid records no base, and /prod hands nothing over', async ($, on) => {
  git(on, null)
  const log = landed(on)
  await fresh($, log)

  const r = await $.command.run(rapid)
  const off = await $.command.run(production)

  expect(r.text).toContain('No git commit was found here, so no base is recorded.')
  expect(off.text).toBe('Rapid mode: off. Back in production mode.')
  expect(log).toEqual([
    expect.stringMatching(/^waffles mode: rapid\. .*No git commit was found in the working directory, so no base is recorded for the rapid work\.$/),
    'waffles mode: production. Rapid mode has ended: changes are no longer made without tests, checks and reviews.',
  ])
})

test('rapid work stays pending through backlog mode and rapid mode again, keeping its first base', async ($, on) => {
  const ran = git(on)
  const clock = mock.clock(on)
  const log = landed(on)
  await fresh($, log)

  await $.command.run(rapid)
  await $.command.run(backlog)
  await $.command.run(rapid)
  await $.command.run(backlog)
  const r = await $.command.run(production)
  await clock.advance(1)

  expect(r.text).toBe('Backlog mode: off. Back in production mode. Claude reviews the rapid work, then asks whether to bring it up to standards now or defer it.')
  expect(ran.filter(argv => argv[1] === 'rev-parse')).toHaveLength(1)
  expect(log).toEqual([
    expect.stringMatching(RAPID_NOTE),
    'waffles mode: backlog. Rapid mode has ended: changes are no longer made without tests, checks and reviews. ' +
      "Each typed prompt goes verbatim to the waffles:backlog skill, and the reply is only that skill's report.",
    expect.stringMatching(/^waffles mode: rapid\. Backlog mode has ended.*recorded as the base of the rapid work\.$/),
    expect.stringMatching(/^waffles mode: backlog\. Rapid mode has ended/),
    expect.stringMatching(handover('Backlog mode has ended')),
    ASSESS,
  ])
})

test('a run started in rapid mode ends in production mode, and the first prompt after it gets the handover', async ($, on) => {
  git(on)
  const log = landed(on)
  await fresh($, log)

  await $.command.run(rapid)
  await $.prompt.submit(run)
  const inRun = await drawMark($)
  await $.prompt.submit({ ...typed, text: 'What changed?' })

  expect(inRun.slice(1)).toEqual(['▶', ' non-interactive'])
  expect(await drawMark($)).toEqual(['#6495ed', '●', ' production'])
  // The typed prompt starts the turn, so the plugin submits none.
  expect(log).toEqual([
    expect.stringMatching(RAPID_NOTE),
    expect.stringMatching(/^waffles mode: non-interactive\. Rapid mode has ended.*A \/waffles:non-interactive run has started/),
    'prompt: finish it',
    expect.stringMatching(handover('The non-interactive run has ended; the person is present\\.')),
    'prompt: What changed?',
  ])
})

test('/rapid during a run ends the run', async ($, on) => {
  git(on)
  const log = landed(on)
  await fresh($, log)

  await $.prompt.submit(run)
  await $.command.run(rapid)

  expect(await drawMark($)).toEqual(['#7fff00', '●', ' rapid'])
  expect(log.at(-1)).toMatch(/^waffles mode: rapid\. The non-interactive run has ended.*Changes are made quickly/)
  await $.command.run(production)
})

test('/clear with rapid work pending states it in the first message until a main-chat turn has run', async ($, on) => {
  git(on)
  ends(on)
  const log = landed(on)
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const stated = async () => (await $.prompt.context({ blocks: [] })).blocks.at(-1)?.text
  const done = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
  await fresh($, log)

  await $.command.run(rapid)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  const first = await stated()
  const asked = await stated()
  await $.turn.complete({ ...done, agentId: 'a1' })
  const afterAgent = await stated()
  await $.turn.complete(done)

  expect(await drawMark($)).toEqual(['#6495ed', '●', ' production'])
  expect(log).toEqual([expect.stringMatching(RAPID_NOTE)])
  expect(first).toMatch(new RegExp(`^waffles mode: production\\. Rapid work since commit ${HEAD} has not been brought up to standards\\. .*AskUserQuestion`))
  expect(asked).toBe(first)
  expect(afterAgent).toBe(first)
  expect(await stated()).toBe('waffles mode: production')
})

test('compaction leaves out the rapid notes, and no prompt that only looks like one', async ($, on) => {
  git(on)
  const log = landed(on)
  let seen: SessionCompactInput | undefined
  on('session.compact', ($, e) => ((seen = e), { messages: e.messages }))
  await fresh($, log)
  await $.command.run(rapid)
  await $.command.run(production)
  const [toRapid, toProduction] = log
  const row = (role: 'user' | 'assistant', text: string): SessionMessage => ({ role, text, toolUses: [] })
  const messages = [
    row('user', toRapid!),
    row('user', 'Make the header sticky'),
    row('user', toProduction!),
    row('user', `${toProduction} Also, why?`),
    row('user', `waffles mode: production. Rapid mode has ended: changes are no longer made without tests, checks and reviews. Rapid work since commit ${HEAD} is fine.`),
    row('assistant', 'The rapid work lacks tests.'),
  ]

  await $.session.compact({ trigger: 'auto', messages })

  expect(seen?.messages).toEqual([messages[1], messages[3], messages[4], messages[5]])
})
