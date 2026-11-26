import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'

import { nodeHost } from '../adapters/node/host.ts'
import { afterShell } from './checkpoint.ts'
import type { Host } from './host.ts'
import { startPlan } from './plan.ts'
import { mirrorPlan, planRef, restorePlan } from './plan-mirror.ts'

const GOAL = `---
goal: Show the order total
status: open
current: 1
created: 2026-11-23T10:00:00.000Z
updated: 2026-11-23T10:00:00.000Z
---
- [ ] 1 Add the order total to the order detail query
`
const ASSUMED = '# Assumed for you\n\n- **Spec, approved** for you.\n'

// Answers `gh pr view` from the state file's "pr" (null: no pull request); records every call.
const GH = `#!/usr/bin/env node
const fs = require('node:fs')
const path = process.env.GH_STUB_STATE
const state = JSON.parse(fs.readFileSync(path, 'utf8'))
const args = process.argv.slice(2)
state.calls.push(args)
let code = 0
if (args[0] === 'pr' && args[1] === 'view' && state.pr !== null) process.stdout.write(JSON.stringify(state.pr) + '\\n')
else code = 1
fs.writeFileSync(path, JSON.stringify(state))
process.exitCode = code
`

const NAMES = { assistant: 'Agent', product: 'Test', planTool: 'plan', ask: 'question', planMode: null }

/** A bare remote and a clone of it on a branch, with a stub gh, and git that may neither sign nor guess an identity. */
class World {
  readonly root: string
  readonly remote: string
  readonly env: Record<string, string>

  constructor(root: string) {
    this.root = root
    this.remote = join(root, 'remote.git')
    this.env = {
      PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      GH_STUB_STATE: join(root, 'gh.json'),
      GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    }
  }

  async setUp(): Promise<this> {
    await fs.mkdir(join(this.root, 'bin'))
    await fs.writeFile(join(this.root, 'bin', 'gh'), GH, { mode: 0o755 })
    await this.setPr(null)
    // A commit that git makes for the person needs their identity and their key; one the copy makes needs neither.
    await fs.writeFile(this.env.GIT_CONFIG_GLOBAL!, '[user]\n\tuseConfigOnly = true\n[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = false\n[init]\n\tdefaultBranch = main\n')
    this.git(this.root, 'init', '-q', '--bare', 'remote.git')
    return this
  }

  git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, env: { ...process.env, ...this.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }

  /** A clone of the remote at `name`, on `branch`: made and pushed when the remote doesn't have it yet. */
  async clone(name: string, branch = 'feat'): Promise<string> {
    this.git(this.root, 'clone', '-q', 'remote.git', name)
    const work = join(this.root, name)
    const me = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgSign=false']
    if (!this.git(this.root, '--git-dir', 'remote.git', 'branch', '--list', 'main').trim()) {
      this.git(work, ...me, 'commit', '-q', '--allow-empty', '-m', 'Start')
      this.git(work, 'push', '-q', 'origin', 'HEAD:main')
    }
    if (this.git(this.root, '--git-dir', 'remote.git', 'branch', '--list', branch).trim()) {
      this.git(work, 'switch', '-q', branch)
    } else {
      this.git(work, 'switch', '-q', '-c', branch)
      this.git(work, ...me, 'commit', '-q', '--allow-empty', '-m', 'Work')
      this.git(work, 'push', '-q', '-u', 'origin', branch)
    }
    return work
  }

  /** The plan folder of a checkout. */
  plan(work: string): string {
    return join(work, '.git', 'waffles', 'plan')
  }

  async write(path: string, text: string): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, text)
  }

  /** The ref's commit on the remote, or '' when the remote has none. */
  remoteRef(branch: string): string {
    return this.git(this.root, '--git-dir', 'remote.git', 'for-each-ref', '--format=%(objectname)', planRef(branch)).trim()
  }

  /** The file names in the remote ref's tree. */
  remoteFiles(branch: string): string[] {
    return this.git(this.root, '--git-dir', 'remote.git', 'ls-tree', '--name-only', planRef(branch)).trim().split('\n')
  }

  async setPr(pr: object | null): Promise<void> {
    await fs.writeFile(this.env.GH_STUB_STATE!, JSON.stringify({ pr, calls: [] }))
  }

  /** The Node.js host in a checkout; every argv it runs goes to `ran`. */
  host(cwd: string, ran: string[][] = []): Host {
    const host = nodeHost({ sessionId: `s-${Math.random().toString(36).slice(2)}`, cwd, names: NAMES, stateFolder: join(this.root, 'state') })
    return { ...host, process: { run: (argv, init) => (ran.push([...argv]), host.process.run(argv, init)) } }
  }

  /** What `fn` gives, run with the stub gh and the test's git config in the environment the host's commands get. */
  async withEnv<T>(fn: () => Promise<T>): Promise<T> {
    const saved = { ...process.env }
    Object.assign(process.env, this.env)
    try {
      return await fn()
    } finally {
      for (const key of Object.keys(this.env)) {
        if (key in saved) process.env[key] = saved[key]
        else delete process.env[key]
      }
    }
  }
}

// A test with a new world, removed after it.
function worldTest(name: string, fn: (w: World) => Promise<void>) {
  test(name, async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'waffles-mirror-')))
    try {
      await fn(await new World(root).setUp())
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}

worldTest('after a push the ref on the remote holds the plan folder, and a second push with nothing changed pushes nothing', async w => {
  const work = await w.clone('work')
  await w.write(join(w.plan(work), 'show-the-order-total.md'), GOAL)
  await w.write(join(w.plan(work), 'assumed-for-you.md'), ASSUMED)
  const head = w.git(work, 'rev-parse', 'HEAD')
  const ran: string[][] = []

  const line = await w.withEnv(() => mirrorPlan(w.host(work, ran), work))

  assert.equal(line, null)
  assert.deepEqual(w.remoteFiles('feat'), ['assumed-for-you.md', 'show-the-order-total.md'])
  assert.equal(w.git(w.root, '--git-dir', 'remote.git', 'show', `${planRef('feat')}:show-the-order-total.md`), GOAL)
  // The local ref is the copy pushed; the branch, the index and the working tree are as they were.
  assert.equal(w.git(work, 'rev-parse', planRef('feat')).trim(), w.remoteRef('feat'))
  assert.equal(w.git(work, 'rev-parse', 'HEAD'), head)
  assert.equal(w.git(work, 'status', '--porcelain'), '')
  // Unsigned, by waffles, though the person's config signs every commit and names no one.
  assert.equal(w.git(work, 'log', '-1', '--format=%an <%ae>|%G?', planRef('feat')).trim(), 'waffles <waffles@localhost>|N')
  // The remote lists it beside its branches; a clone of the branches doesn't fetch it.
  assert.match(w.git(work, 'ls-remote', 'origin'), /\trefs\/waffles\/plan\/feat\n/)
  assert.equal(ran.filter(argv => argv[1] === 'push').length, 1)

  const first = w.remoteRef('feat')
  const again = await w.withEnv(() => mirrorPlan(w.host(work, ran), work))

  assert.equal(again, null)
  assert.equal(w.remoteRef('feat'), first)
  assert.equal(ran.filter(argv => argv[1] === 'push').length, 1)

  // A change is pushed on top of the last copy.
  await w.write(join(w.plan(work), 'show-the-order-total.md'), GOAL.replace('- [ ] 1', '- [x] 1'))
  await w.withEnv(() => mirrorPlan(w.host(work, ran), work))
  assert.notEqual(w.remoteRef('feat'), first)
  assert.equal(w.git(w.root, '--git-dir', 'remote.git', 'rev-parse', `${planRef('feat')}^`).trim(), first)
})

worldTest('a fresh clone restores the branch’s copy at its first poll, and the goal is open there', async w => {
  const work = await w.clone('work')
  await w.write(join(w.plan(work), 'show-the-order-total.md'), GOAL)
  await w.write(join(w.plan(work), 'assumed-for-you.md'), ASSUMED)
  await w.withEnv(() => mirrorPlan(w.host(work), work))
  const other = await w.clone('other')
  const $ = w.host(other)

  await w.withEnv(() => startPlan($))

  assert.equal(await fs.readFile(join(w.plan(other), 'show-the-order-total.md'), 'utf8'), GOAL)
  assert.equal(await fs.readFile(join(w.plan(other), 'assumed-for-you.md'), 'utf8'), ASSUMED)
  assert.deepEqual(await $.state.get('planOthers'), [{ slug: 'show-the-order-total', title: 'Show the order total', current: '1 Add the order total to the order detail query', inUse: false }])
  assert.equal(await $.state.get('planFetched'), true)
  assert.equal(w.git(other, 'rev-parse', planRef('feat')).trim(), w.remoteRef('feat'))
  // Nothing is in the working tree.
  assert.equal(w.git(other, 'status', '--porcelain'), '')
})

worldTest('local files are never written over: a folder with a file takes nothing, and the next push writes over the copy', async w => {
  const work = await w.clone('work')
  await w.write(join(w.plan(work), 'show-the-order-total.md'), GOAL)
  await w.withEnv(() => mirrorPlan(w.host(work), work))
  const other = await w.clone('other')
  const mine = GOAL.replace('Show the order total', 'Mine')
  await w.write(join(w.plan(other), 'show-the-order-total.md'), mine)
  const ran: string[][] = []

  assert.deepEqual(await w.withEnv(() => restorePlan(w.host(other, ran), w.plan(other))), [])
  assert.equal(await fs.readFile(join(w.plan(other), 'show-the-order-total.md'), 'utf8'), mine)
  assert.deepEqual(ran, [])

  // Local wins: its push replaces the copy.
  await w.withEnv(() => mirrorPlan(w.host(other), other))
  assert.equal(w.git(w.root, '--git-dir', 'remote.git', 'show', `${planRef('feat')}:show-the-order-total.md`), mine)
})

worldTest('a branch name with a slash keeps its slash in the ref, and a detached HEAD copies nothing', async w => {
  const work = await w.clone('work', 'feat/x')
  await w.write(join(w.plan(work), 'show-the-order-total.md'), GOAL)

  assert.equal(await w.withEnv(() => mirrorPlan(w.host(work), work)), null)
  assert.deepEqual(w.remoteFiles('feat/x'), ['show-the-order-total.md'])
  const other = await w.clone('other', 'feat/x')
  assert.deepEqual(await w.withEnv(() => restorePlan(w.host(other), w.plan(other))), ['show-the-order-total.md'])

  w.git(work, 'switch', '-q', '--detach')
  await w.write(join(w.plan(work), 'show-the-order-total.md'), GOAL.replace('- [ ] 1', '- [x] 1'))
  const ran: string[][] = []
  assert.equal(await w.withEnv(() => mirrorPlan(w.host(work, ran), work)), null)
  assert.deepEqual(ran.map(argv => argv[1]), ['rev-parse', 'symbolic-ref'])
})

worldTest('with no remote nothing is copied; an unreachable remote costs one line, not the command', async w => {
  const work = await w.clone('work')
  await w.write(join(w.plan(work), 'show-the-order-total.md'), GOAL)
  w.git(work, 'remote', 'rename', 'origin', 'upstream')
  w.git(work, 'config', '--unset', 'branch.feat.remote')

  assert.equal(await w.withEnv(() => mirrorPlan(w.host(work), work)), null)
  assert.throws(() => w.git(work, 'rev-parse', '--verify', '-q', planRef('feat')))

  w.git(work, 'config', 'branch.feat.remote', 'upstream')
  w.git(work, 'remote', 'set-url', 'upstream', join(w.root, 'gone.git'))
  const line = await w.withEnv(() => mirrorPlan(w.host(work), work))

  assert.match(line ?? '', /^waffles plan outline: the copy on upstream was not updated: git push failed: /)
  assert.equal(line?.includes('\n'), false)
  // Not pushed, so the next push tries again.
  assert.throws(() => w.git(work, 'rev-parse', '--verify', '-q', planRef('feat')))
})

worldTest('after a push the model reads the checkpoint’s line alone; after a merge gh reports done, the copy is removed', async w => {
  const work = await w.clone('work')
  await w.write(join(w.plan(work), 'show-the-order-total.md'), GOAL)
  const $ = w.host(work)

  const pushed = await w.withEnv(() => afterShell($, 'git push', work))

  assert.equal(pushed, 'waffles checkpoint: No pull request for the branch feat: nothing to update.')
  assert.notEqual(w.remoteRef('feat'), '')

  // A merge queue leaves it open: the copy stays.
  await w.setPr({ state: 'OPEN', headRefName: 'feat', isCrossRepository: false })
  assert.equal(await w.withEnv(() => afterShell($, 'gh pr merge 7 --squash', work)), null)
  assert.notEqual(w.remoteRef('feat'), '')
  // A pull request from a fork names a branch of another repository.
  await w.setPr({ state: 'MERGED', headRefName: 'feat', isCrossRepository: true })
  await w.withEnv(() => afterShell($, 'gh pr merge 7 --squash', work))
  assert.notEqual(w.remoteRef('feat'), '')

  await w.setPr({ state: 'MERGED', headRefName: 'feat', isCrossRepository: false })
  const merged = await w.withEnv(() => afterShell($, 'gh pr merge 7 --squash', work))

  assert.equal(merged, null)
  assert.equal(w.remoteRef('feat'), '')
  assert.throws(() => w.git(work, 'rev-parse', '--verify', '-q', planRef('feat')))
  assert.deepEqual(JSON.parse(await fs.readFile(w.env.GH_STUB_STATE!, 'utf8')).calls, [['pr', 'view', '7', '--json', 'state,headRefName,isCrossRepository']])
  // The plan folder stays: only the copy goes.
  assert.equal(await fs.readFile(join(w.plan(work), 'show-the-order-total.md'), 'utf8'), GOAL)
})
