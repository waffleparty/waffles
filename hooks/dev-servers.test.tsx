import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const MODES = { plugin: 'waffles', component: 'SessionMode' } as const
const PANE = { plugin: 'waffles', component: 'Pane', surface: 'terminal', requestId: 'dev-servers' } as const
const paneProps = { title: 'Dev servers', isFocused: true, bodyColumns: 60, placement: 'inline' } as never

const SERVERS = ['http://localhost:4000', 'http://localhost:8080']

function seedServers(on: On) {
  on('state.get', ($, e, next) =>
    e.key === 'urls' ? { value: { value: SERVERS, version: 1 } } : next(e),
  )
}

const MARK = ['●', ' production', ' · ']

test('running dev servers show as a menu ahead of the effort', async ($, on) => {
  seedServers(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...MODES, surface, props: { modes: [] } })

    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual([...MARK, '⎔', ' 2', ' · ', 'effort: auto'])
    await ui.unmount()
  }
})

test('with no dev server the footer has no menu', async ($, on) => {
  const ui = await $.ui.mount({ ...MODES, surface: 'terminal', props: { modes: [] } })

  expect(await ui.find({ type: 'Button' })).toBeFalsy()
  await ui.unmount()
})

for (const [os, opener] of [['Darwin', 'open'], ['Linux', 'xdg-open']] as const) {
test(`the dev servers menu opens the picked URL with ${opener} on ${os} and closes`, async ($, on) => {
  seedServers(on)
  const ran: string[][] = []
  const opened: unknown[] = []
  const closed: string[] = []
  on('ui.open', ($, e) => (opened.push(e), { value: { isPlaced: true } }) as never)
  on('process.run', ($, e) => (ran.push([...e.argv]), { value: { exitCode: 0, stdout: e.argv[0] === 'uname' ? `${os}\n` : '', stderr: '' } }) as never)
  on('ui.close', ($, e) => (closed.push(e.id), { value: undefined }) as never)

  const footer = await $.ui.mount({ ...MODES, surface: 'terminal', props: { modes: [] } })
  await footer.press({ key: 'servers' })
  await footer.unmount()
  expect(opened).toEqual([expect.objectContaining({ id: 'dev-servers', focus: true, closeOnEscape: true })])

  const pane = await $.ui.mount({ ...PANE, props: paneProps })
  expect((await pane.findAll({ type: 'Button' })).map(b => b.text)).toEqual(SERVERS)
  await pane.press({ key: 'http://localhost:8080' })
  await pane.unmount()

  expect(ran).toContainEqual([opener, 'http://localhost:8080'])
  expect(closed).toEqual(['dev-servers'])
})
}

test('/waffles:dev-server lists the running servers without the skill', async ($, on) => {
  seedServers(on)
  let isSkillRun = false
  on('command.run', () => ((isSkillRun = true), { text: 'skill' }))

  const r = await $.command.run({ command: 'waffles:dev-server', args: '' })

  expect(r.text).toBe(`Dev servers running for this project:\n${SERVERS.join('\n')}`)
  expect(isSkillRun).toBe(false)
})

test('/waffles:dev-server runs the skill with no server up', async ($, on) => {
  on('command.run', () => ({ text: 'skill' }))

  expect((await $.command.run({ command: 'waffles:dev-server', args: '' })).text).toBe('skill')
})

test('/waffles:dev-server runs the skill with an app named', async ($, on) => {
  seedServers(on)
  on('command.run', () => ({ text: 'skill' }))

  expect((await $.command.run({ command: 'waffles:dev-server', args: 'web' })).text).toBe('skill')
})
