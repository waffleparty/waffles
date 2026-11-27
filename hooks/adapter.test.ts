import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeDisk } from './plan-testing'

// A checkout at /repo with these files; git answers its top level to every query.
function repo(on: On, files: Record<string, string>) {
  const disk = fakeDisk(on)
  disk.git = { exitCode: 0, stdout: '/repo\n' }
  for (const [name, text] of Object.entries(files)) disk.files.set(`/repo/${name}`, text)
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  return disk
}

const adapterBlock = async ($: Engine) =>
  (await $.prompt.context({ blocks: [] })).blocks.find(b => b.name === 'backlogAdapter')

test('a repo that names its backlog adapter in AGENTS.md asks for the initialization check in the first message', async ($, on) => {
  repo(on, { 'AGENTS.md': '# Agents\n\nBacklog adapter: `tracker-adapter`\n\nMore rules.\n' })

  expect(await adapterBlock($)).toEqual({
    name: 'backlogAdapter',
    text: 'backlog adapter: this repo names `tracker-adapter` in AGENTS.md. Before the first task in this conversation, run the waffles:init-check skill, unless it already ran in this conversation. Its failures never stop the work.',
  })
})

test('CLAUDE.md names the adapter only when the repo has no AGENTS.md', async ($, on) => {
  const disk = repo(on, { 'CLAUDE.md': 'Backlog adapter: example:tracker-adapter\n' })

  expect((await adapterBlock($))?.text).toMatch(/^backlog adapter: this repo names `example:tracker-adapter` in CLAUDE\.md\./)

  disk.files.set('/repo/AGENTS.md', '# Agents\n')
  expect(await adapterBlock($)).toBeUndefined()
})

test('a repo with no adapter named, or a line that only mentions one, gets no block', async ($, on) => {
  const disk = repo(on, {})

  expect(await adapterBlock($)).toBeUndefined()

  disk.files.set('/repo/AGENTS.md', 'See the Backlog adapter: section below.\n  Backlog adapter: indented\nBacklog adapter:\nnext-line\n')
  expect(await adapterBlock($)).toBeUndefined()
})

test('a file that cannot be read leaves the block out, not the first message', async ($, on) => {
  const disk = repo(on, { 'AGENTS.md': 'Backlog adapter: tracker-adapter\n' })
  disk.isReadBroken = true

  const { blocks } = await $.prompt.context({ blocks: [] })

  expect(blocks.find(b => b.name === 'backlogAdapter')).toBeUndefined()
  expect(blocks.find(b => b.name === 'wafflesMode')).toBeDefined()
})
