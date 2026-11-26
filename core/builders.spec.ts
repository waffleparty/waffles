import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { nodeHost } from '../adapters/node/host.ts'
import { BUILDERS_TOOL } from './builders.ts'
import { fakeHost, type Answer } from './testing.ts'
import { TOOLS } from './tools.ts'

const NAMES = { assistant: 'Agent', product: 'Test', planTool: 'plan', ask: 'question', planMode: null }

const pr = (number: number, isDraft = false, requested = true) => ({ number, title: `Item ${number}`, url: `https://github.com/o/widget/pull/${number}`, isDraft, reviewRequests: requested ? [{ login: 'a' }] : [] })

// A main checkout at /widget; gh lists what it is given.
function widget(gh: Answer, init: Parameters<typeof fakeHost>[0] = {}) {
  return fakeHost({
    cwd: '/session',
    files: { '/widget/README.md': 'widget\n' },
    run: argv => (argv[0] === 'gh' ? gh : argv.join(' ') === 'git rev-parse --show-toplevel' ? { stdout: '/widget\n' } : undefined),
    ...init,
  })
}

test('builders is one of the core tools, and test-slot is not a tool', async () => {
  assert.ok(TOOLS.includes(BUILDERS_TOOL))
  assert.match(BUILDERS_TOOL.description, /builders\.ts test-slot -- <command>/)
  const $ = widget({ stdout: '[]' })
  assert.deepEqual(await BUILDERS_TOOL.call($, { op: 'test-slot' }), { refusal: 'test-slot is not a tool: run tests as `node <scripts>/builders.ts test-slot -- <command>`.' })
  for (const [input, refusal] of [
    [{ op: 'clone', repo: '/widget', item: 'ITEM-1' }, 'op clone needs branch.'],
    [{ op: 'remove', repo: '/widget', path: '/x' }, 'op remove takes op, root, path, not repo.'],
    [{ op: 'limits', repo: '/widget', cap: 2.5 }, 'cap must be a whole number.'],
    [{ op: 'limits', repo: '' }, 'repo must be text.'],
    [{ op: 'limits', repo: '/widget', slots: 3 }, 'The builders tool takes op, root, repo, item, branch, base, path, cap, not slots.'],
  ] as const) {
    assert.deepEqual(await BUILDERS_TOOL.call($, input), { refusal }, JSON.stringify(input))
  }
  assert.deepEqual($.ran, [])
})

test('limits counts the ready pull requests with a review requested, in the main checkout, within the 45 s of the call', async () => {
  const $ = widget({ stdout: JSON.stringify([pr(3), pr(1), pr(2, true), pr(4, false, false)]) })
  assert.deepEqual(await BUILDERS_TOOL.call($, { op: 'limits', repo: '../widget' }), { value: { waiting: 2, cap: 10, numbers: [1, 3] } })
  assert.deepEqual($.ran.map(r => [r.argv[0], r.cwd, r.timeoutMs]), [['git', '/widget', 30_000], ['gh', '/widget', 45_000]])
})

test('limits refuses at the cap, listing the pull requests, and refuses a list the platform cut', async () => {
  const full = widget({ stdout: JSON.stringify([pr(1), pr(2)]) })
  const refused = await BUILDERS_TOOL.call(full, { op: 'limits', repo: '/widget', cap: 2 })
  assert.ok('refusal' in refused)
  assert.match(refused.refusal, /^Refused: 2 open pull requests in widget wait for human review/)
  assert.match(refused.refusal, /- #2 Item 2: https:\/\/github.com\/o\/widget\/pull\/2$/)

  const cut = widget({ stdout: JSON.stringify([pr(1)]).slice(0, 20), isTruncated: true })
  assert.deepEqual(await BUILDERS_TOOL.call(cut, { op: 'limits', repo: '/widget' }), {
    refusal: 'gh pr list printed more than the platform passes on, so nothing is answered from a part of it',
  })
})

test('clone and remove refuse without a folder for the clones, and the environment’s folder wins over root', async () => {
  const $ = widget({ stdout: '[]' })
  const refused = await BUILDERS_TOOL.call($, { op: 'remove', path: '/x' })
  assert.deepEqual(refused, { refusal: 'Refused: no folder for the clones: pass root (the skills pass <session scratchpad>/builders) or set WAFFLES_BUILDERS_ROOT.' })
  const elsewhere = widget({ stdout: '[]' }, { env: { WAFFLES_BUILDERS_ROOT: '~/clones' } })
  assert.deepEqual(await BUILDERS_TOOL.call(elsewhere, { op: 'remove', root: '/scratch/builders', path: '/scratch/builders/o/r/ITEM-1' }), {
    refusal: "Refused: /scratch/builders/o/r/ITEM-1 is not a builder's clone under /home/clones.",
  })
})

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1' }

test('on Node.js, the tool clones from the main checkout it names, records the clone, and removes it with its empty folders', async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'waffles-builders-')))
  const saved = { ...process.env }
  Object.assign(process.env, GIT_ENV, { GIT_CONFIG_GLOBAL: join(root, 'gitconfig') })
  delete process.env.WAFFLES_BUILDERS_ROOT
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    await fs.writeFile(join(root, 'gitconfig'), '[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n')
    await fs.mkdir(join(root, 'remote', 'example'), { recursive: true })
    sh(join(root, 'remote', 'example'), 'init', '-q', '--bare', 'widget.git')
    sh(root, 'clone', '-q', join(root, 'remote', 'example', 'widget.git'), 'widget')
    const main = join(root, 'widget')
    await fs.writeFile(join(main, 'README.md'), 'widget\n')
    sh(main, 'add', 'README.md')
    sh(main, 'commit', '-q', '-m', 'Start')
    sh(main, 'push', '-q', '-u', 'origin', 'main')
    sh(main, 'remote', 'set-head', 'origin', 'main')

    // The session's folder is the root: repo and root are relative to it.
    const $ = nodeHost({ sessionId: 'builders', cwd: root, names: NAMES, stateFolder: join(root, 'state') })
    const made = await BUILDERS_TOOL.call($, { op: 'clone', root: 'scratch/builders', repo: 'widget', item: 'ITEM 7', branch: 'feat/ITEM-7' })
    const path = join(root, 'scratch', 'builders', 'example', 'widget', 'ITEM-7')
    assert.deepEqual(made, { value: { path, branch: 'feat/ITEM-7', base: 'main', reused: false } })
    assert.equal(sh(path, 'branch', '--show-current'), 'feat/ITEM-7')
    assert.deepEqual(JSON.parse(await fs.readFile(join(path, '.git', 'waffles', 'builder.json'), 'utf8')), { item: 'ITEM 7', branch: 'feat/ITEM-7', base: 'main', main })
    assert.deepEqual(await BUILDERS_TOOL.call($, { op: 'clone', root: 'scratch/builders', repo: main, item: 'ITEM 7', branch: 'feat/ITEM-7' }), { value: { path, branch: 'feat/ITEM-7', base: 'main', reused: true } })

    await fs.writeFile(join(path, 'work.txt'), 'w\n')
    assert.deepEqual(await BUILDERS_TOOL.call($, { op: 'remove', root: 'scratch/builders', path }), { refusal: `Refused: ${path} holds changes that are not committed.` })
    await fs.rm(join(path, 'work.txt'))
    assert.deepEqual(await BUILDERS_TOOL.call($, { op: 'remove', root: 'scratch/builders', path }), { value: { path, removed: true } })
    assert.deepEqual(await fs.readdir(join(root, 'scratch', 'builders')), [])
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    await fs.rm(root, { recursive: true, force: true })
  }
})
