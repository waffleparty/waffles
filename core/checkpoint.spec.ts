import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'

import { nodeHost } from '../adapters/node/host.ts'
import { checkpoint, END, parseArgs, place, render, START } from './checkpoint.ts'
import type { Host } from './host.ts'

// Answers `gh pr view` from the state file's "pr" (null: no pull request), and stores the body
// `gh pr edit --body-file -` reads from stdin. Every call is recorded.
const GH = `#!/usr/bin/env node
const fs = require('node:fs')
const path = process.env.GH_STUB_STATE
const state = JSON.parse(fs.readFileSync(path, 'utf8'))
const args = process.argv.slice(2)
state.calls.push(args)
let code = 0
if (args[0] === 'pr' && args[1] === 'view') {
  if (state.pr === null) {
    process.stderr.write('no pull requests found for branch\\n')
    code = 1
  } else {
    process.stdout.write(JSON.stringify(state.pr) + '\\n')
  }
} else if (args[0] === 'pr' && args[1] === 'edit' && JSON.stringify(args.slice(3)) === '["--body-file","-"]') {
  state.pr.body = fs.readFileSync(0, 'utf8')
} else {
  process.stderr.write('unexpected: ' + args.join(' ') + '\\n')
  code = 2
}
fs.writeFileSync(path, JSON.stringify(state))
process.exitCode = code
`

const GOAL = `---
goal: Show the order total
status: open
current: 2
created: 2026-11-23T10:00:00.000Z
updated: 2026-11-23T10:00:00.000Z
---
- [x] 1 Add the order total to the order detail query
- [ ] 2 Show the order total on the order detail screen
  - [x] 2.1 ? Check the empty state <!-- aliases=3.1 -->
- [ ] 3 Remove the working files
`

const BODY = `## Summary
Display the order total (ITEM-42).

## Prerequisites
None`

// The record of decisions made for the person.
const ASSUMED_FILE = `# Assumed for you

- **Spec, approved** for you: every part of the request has a section.
- **Design question**: "Should a new member vote mid-round?" Answered: no, from the next round on.
  Why: the request says nothing; this keeps the tally fixed once a round starts.
`

const ASSUMED_LIST = [
  '- **Spec, approved** for you: every part of the request has a section.',
  '- **Design question**: "Should a new member vote mid-round?" Answered: no, from the next round on.',
  '  Why: the request says nothing; this keeps the tally fixed once a round starts.',
]

const CHECKLIST = [
  '- [x] 1. Add the order total to the order detail query',
  '- [ ] 2. Show the order total on the order detail screen',
  '  - [x] 2.1. Check the empty state',
  '- [ ] 3. Remove the working files',
]

type Pr = { number: number; url: string; body: string; headRefName: string; baseRefName?: string; state: string }
type GhState = { pr: Pr | null; calls: string[][] }

/** A clone of a bare remote, on branch feat with the outline committed and pushed, and a stub gh. */
class Checkout {
  readonly root: string
  readonly work: string
  readonly statePath: string
  readonly env: Record<string, string>

  constructor(root: string) {
    this.root = root
    this.work = join(root, 'work')
    this.statePath = join(root, 'gh.json')
    const bin = join(root, 'bin')
    const config = join(root, 'gitconfig')
    this.env = {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      GH_STUB_STATE: this.statePath,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: '1',
    }
  }

  async setUp(): Promise<this> {
    await fs.mkdir(join(this.root, 'bin'))
    await fs.writeFile(join(this.root, 'bin', 'gh'), GH, { mode: 0o755 })
    await fs.writeFile(this.env.GIT_CONFIG_GLOBAL!, '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n')
    this.gitAt(this.root, 'init', '-q', '--bare', 'remote.git')
    this.gitAt(this.root, 'clone', '-q', 'remote.git', 'work')
    await this.write('README.md', 'readme\n')
    this.git('add', 'README.md')
    this.git('commit', '-q', '-m', 'Start')
    this.git('push', '-q', 'origin', 'main')
    this.git('switch', '-q', '-c', 'feat')
    await this.write('.tmp/plan/show-the-parent-id.md', GOAL)
    this.git('add', '.tmp')
    this.git('commit', '-q', '-m', 'Add the plan outline')
    this.git('push', '-q', '-u', 'origin', 'feat')
    await this.setPr({ number: 7, url: 'https://github.com/o/r/pull/7', body: BODY, headRefName: 'feat', baseRefName: 'main', state: 'OPEN' })
    return this
  }

  gitAt(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, env: { ...process.env, ...this.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }

  git(...args: string[]): string {
    return this.gitAt(this.work, ...args)
  }

  async write(rel: string, text: string): Promise<void> {
    const path = join(this.work, rel)
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, text)
  }

  async setPr(pr: Pr | null): Promise<void> {
    await fs.writeFile(this.statePath, JSON.stringify({ pr, calls: [] }))
  }

  async gh(): Promise<GhState> {
    return JSON.parse(await fs.readFile(this.statePath, 'utf8')) as GhState
  }

  /** The Node.js host in the clone. */
  host(): Host {
    return nodeHost({ sessionId: 'checkpoint', cwd: this.work, names: NAMES, stateFolder: join(this.root, 'state') })
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

  /** The exit code and stdout of a checkpoint in the clone. */
  async checkpoint(...args: string[]): Promise<[number, string]> {
    const options = parseArgs(args)
    assert.ok(options, `bad arguments: ${args.join(' ')}`)
    const done = await this.withEnv(() => checkpoint(this.host(), this.work, options))
    return [done.exitCode, done.stdout]
  }

  async edits(): Promise<string[][]> {
    return (await this.gh()).calls.filter(call => call[0] === 'pr' && call[1] === 'edit')
  }
}

const NAMES = { assistant: 'Agent', product: 'Test', planTool: 'plan', ask: 'question', planMode: null }

function section(items: string[], note: string | null = null): string {
  return [START, '## Plan outline', '', ...(note ? [note, ''] : []), ...items, END].join('\n')
}

// A test with a new checkout, removed after it.
function checkoutTest(name: string, fn: (co: Checkout) => Promise<void>) {
  test(name, async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'waffles-checkpoint-')))
    try {
      await fn(await new Checkout(root).setUp())
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}

checkoutTest('the outline goes after the sections and a second run changes nothing', async co => {
  const [code, out] = await co.checkpoint()
  const body = (await co.gh()).pr!.body
  const [again, outAgain] = await co.checkpoint()

  assert.equal(code, 0, out)
  assert.equal(out.trim(), 'Updated the plan outline in #7: https://github.com/o/r/pull/7')
  assert.equal(body, `${BODY}\n\n${section(CHECKLIST)}`)
  assert.equal(again, 0)
  assert.equal(outAgain.trim(), 'The plan outline in #7 is up to date.')
  assert.equal((await co.edits()).length, 1)
  assert.equal((await co.gh()).pr!.body, body)
})

checkoutTest('a changed outline replaces only the marked section', async co => {
  await co.checkpoint()
  const pr = (await co.gh()).pr!
  pr.body = `Intro text\n\n${pr.body}\n\n## Notes\nKept as written.`
  await co.setPr(pr)
  await co.write('.tmp/plan/show-the-parent-id.md', GOAL.replace('- [ ] 2 Show', '- [x] 2 Show'))
  co.git('commit', '-q', '-am', 'Show the order total')
  co.git('push', '-q')

  const [code] = await co.checkpoint()

  const ticked = [CHECKLIST[0]!, CHECKLIST[1]!.replace('[ ]', '[x]'), ...CHECKLIST.slice(2)]
  assert.equal(code, 0)
  assert.equal((await co.gh()).pr!.body, `Intro text\n\n${BODY}\n\n${section(ticked)}\n\n## Notes\nKept as written.`)
})

checkoutTest('a plan outline section written by hand is taken over and the attribution stays last', async co => {
  const footer = 'Written by Claude during an unattended run for someone.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'
  const pr = (await co.gh()).pr!
  pr.body = `${BODY}\n\n## Plan outline\n\n- [ ] 1. Old step\n- [ ] 2. Other\n\n${footer}`
  await co.setPr(pr)

  await co.checkpoint()

  assert.equal((await co.gh()).pr!.body, `${BODY}\n\n${section(CHECKLIST)}\n\n${footer}`)
})

checkoutTest('a new section goes ahead of the attribution lines', async co => {
  const footer = '🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_x'
  const pr = (await co.gh()).pr!
  pr.body = `${BODY}\n\n${footer}\n`
  await co.setPr(pr)

  await co.checkpoint()

  assert.equal((await co.gh()).pr!.body, `${BODY}\n\n${section(CHECKLIST)}\n\n${footer}\n`)
})

checkoutTest('uncommitted and unpushed work marks the checklist ahead of the branch', async co => {
  await co.write('a.txt', 'a\n')
  co.git('add', 'a.txt')
  co.git('commit', '-q', '-m', 'A')
  await co.write('README.md', 'changed\n')
  const head = co.git('rev-parse', 'HEAD')

  const [code, out] = await co.checkpoint()

  const note = '> **Ahead of the branch:** this checklist includes work that is not on the branch yet (1 commit not pushed; changes not committed).'
  assert.equal(code, 0)
  assert.ok(out.includes('(ahead of the branch)'), out)
  assert.equal((await co.gh()).pr!.body, `${BODY}\n\n${section(CHECKLIST, note)}`)
  // It never commits.
  assert.equal(co.git('rev-parse', 'HEAD'), head)
  assert.equal(co.git('status', '--porcelain'), ' M README.md\n')

  co.git('commit', '-q', '-am', 'B')
  co.git('push', '-q')
  await co.checkpoint()
  assert.equal((await co.gh()).pr!.body, `${BODY}\n\n${section(CHECKLIST)}`)
})

checkoutTest('after the working files are removed the checklist ends with that step ticked', async co => {
  co.git('rm', '-q', '-r', '.tmp')
  co.git('commit', '-q', '-m', 'Remove the working files')
  co.git('push', '-q')

  await co.checkpoint()
  const body = (await co.gh()).pr!.body
  await co.checkpoint()

  assert.equal(body, `${BODY}\n\n${section([...CHECKLIST.slice(0, 3), '- [x] 3. Remove the working files'])}`)
  assert.equal((await co.edits()).length, 1)
})

checkoutTest('the record of decisions is the assumed for you list and stays after the working files go', async co => {
  await co.write('.tmp/plan/assumed-for-you.md', ASSUMED_FILE)
  co.git('add', '.tmp')
  co.git('commit', '-q', '-m', 'Approve the spec')
  co.git('push', '-q')

  await co.checkpoint()
  const body = (await co.gh()).pr!.body
  co.git('rm', '-q', '-r', '.tmp')
  co.git('commit', '-q', '-m', 'Remove the working files')
  co.git('push', '-q')
  await co.checkpoint()

  assert.equal(body, `${BODY}\n\n${section([...CHECKLIST, '', '### Assumed for you', '', ...ASSUMED_LIST])}`)
  assert.equal(
    (await co.gh()).pr!.body,
    `${BODY}\n\n${section([...CHECKLIST.slice(0, 3), '- [x] 3. Remove the working files', '', '### Assumed for you', '', ...ASSUMED_LIST])}`,
  )
})

checkoutTest('an outline removed before the branch started is not rendered', async co => {
  // The working files went in a commit on main; a new branch from there has none of its own.
  co.git('rm', '-q', '-r', '.tmp')
  co.git('commit', '-q', '-m', 'Remove the working files')
  co.git('switch', '-q', 'main')
  co.git('merge', '-q', '--ff-only', 'feat')
  co.git('push', '-q', 'origin', 'main')
  co.git('switch', '-q', '-c', 'next')
  await co.write('b.txt', 'b\n')
  co.git('add', 'b.txt')
  co.git('commit', '-q', '-m', 'B')
  co.git('push', '-q', '-u', 'origin', 'next')
  await co.setPr({ number: 9, url: 'u', body: BODY, headRefName: 'next', baseRefName: 'main', state: 'OPEN' })

  const [code, out] = await co.checkpoint()

  assert.equal(code, 0)
  assert.equal(out.trim(), 'No plan outline in .tmp/plan/: #9 stays as it is.')
  assert.deepEqual(await co.edits(), [])
})

checkoutTest('no pull request or a merged one is left alone', async co => {
  await co.setPr(null)
  let [code, out] = await co.checkpoint()
  assert.equal(code, 0)
  assert.equal(out.trim(), 'No pull request for the branch feat: nothing to update.')

  await co.setPr({ number: 7, url: 'u', body: BODY, headRefName: 'feat', state: 'MERGED' })
  ;[code, out] = await co.checkpoint()
  assert.equal(code, 0)
  assert.ok(out.includes('is merged'), out)
  assert.deepEqual(await co.edits(), [])
})

checkoutTest('a pull request for another branch is left alone', async co => {
  let [code, out] = await co.checkpoint('--pr', '7')
  assert.ok(out.includes('Updated'), out)
  await co.setPr({ number: 8, url: 'u', body: BODY, headRefName: 'other', state: 'OPEN' })
  ;[code, out] = await co.checkpoint('--pr', '8')
  assert.equal(code, 0)
  assert.equal(out.trim(), 'Pull request #8 is for other, not feat: nothing to update.')
  assert.deepEqual((await co.gh()).calls.at(-1), ['pr', 'view', '8', '--json', 'number,url,body,headRefName,baseRefName,state'])
})

checkoutTest('dry run prints the description and writes nothing', async co => {
  const [code, out] = await co.checkpoint('--dry-run')
  assert.equal(code, 0)
  assert.equal(out, `${BODY}\n\n${section(CHECKLIST)}\n`)
  assert.deepEqual(await co.edits(), [])
})

checkoutTest('the time limit bounds all the commands together', async co => {
  // Each command takes 20 seconds by the clock, and is told how much of the limit is left.
  let now = 0
  const limits: (number | undefined)[] = []
  const host = co.host()
  const $: Host = {
    ...host,
    clock: { now: async () => now },
    process: {
      run: (argv, init) => {
        limits.push(init?.timeoutMs)
        now += 20_000
        return host.process.run(argv, init)
      },
    },
  }

  const done = await co.withEnv(() => checkpoint($, co.work, { timeoutMs: 60_000 }))

  assert.deepEqual(limits, [60_000, 40_000, 20_000])
  assert.deepEqual(done, { exitCode: 1, stdout: 'checkpoint: git could not run: the checkpoint ran out of time\n', stderr: '' })
  assert.deepEqual(await co.edits(), [])
})

test('dropped deferred parked review and subagent steps', () => {
  const goal = GOAL.replace(
    '- [ ] 3 Remove the working files',
    '- [-] 3 Try the old query\n- [>] 4 Add caching → .backlog/cache.md\n- [~] 5 ⤷ Fix the build <!-- parked=2.1 -->\n- [ ] 6 \\? Odd title\n- [r] 7 Merge the fixes\n- [ ] 8 Archive <!-- agent=a1 -->',
  )
  assert.deepEqual(render([['g.md', goal]], false)!.slice(3), [
    '- [x] 3. ~~Try the old query~~ (dropped)',
    '- [x] 4. Add caching (moved to the backlog: .backlog/cache.md)',
    '- [ ] 5. Fix the build',
    '- [ ] 6. ? Odd title',
    '- [ ] 7. Merge the fixes',
    '- [ ] 8. Archive',
  ])
})

test('a plain checklist is rendered and a plan document is not', () => {
  const plain = '# Work\n\n- [x] 1. First\n- [ ] 2 Second\n- [ ] Remove the working files\n'
  const document = '# Plan\n\nSome prose.\n\n- [ ] not a step list\n'
  assert.deepEqual(
    render(
      [
        ['outline.md', plain],
        ['plan.md', document],
      ],
      true,
    ),
    ['- [x] 1. First', '- [ ] 2. Second', '- [x] Remove the working files'],
  )
  assert.equal(render([['plan.md', document]], false), null)
  // Goal files come before a plain checklist.
  assert.deepEqual(
    render(
      [
        ['a.md', GOAL],
        ['outline.md', plain],
      ],
      false,
    ),
    CHECKLIST,
  )
})

test('the assumed for you list follows the checklist and is never a checklist itself', () => {
  const taskLike = '# Assumed for you\n\n- [ ] 1. A line that looks like a task\n'
  assert.deepEqual(
    render(
      [
        ['a.md', GOAL],
        ['assumed-for-you.md', ASSUMED_FILE],
      ],
      false,
    ),
    [...CHECKLIST, '', '### Assumed for you', '', ...ASSUMED_LIST],
  )
  // With no outline beside it, there is nothing to render.
  assert.equal(render([['assumed-for-you.md', taskLike]], false), null)
  // An empty record adds nothing.
  assert.deepEqual(
    render(
      [
        ['a.md', GOAL],
        ['assumed-for-you.md', '# Assumed for you\n\n'],
      ],
      false,
    ),
    CHECKLIST,
  )
})

test('several goals each get a heading', () => {
  const other = GOAL.replace('goal: Show the order total', 'goal: Fix the date').replace('\n  - [x] 2.1 ? Check the empty state <!-- aliases=3.1 -->', '')
  const lines = render(
    [
      ['a.md', GOAL],
      ['b.md', other],
    ],
    false,
  )!
  assert.deepEqual(lines.slice(0, 2), ['### Show the order total', ''])
  assert.deepEqual(lines.slice(6, 9), ['', '### Fix the date', ''])
})

test('a body with crlf line ends keeps them', () => {
  const body = '## Summary\r\nText\r\n'
  const block = [START, 'A', END]
  const placed = place(body, block)
  assert.equal(placed, `## Summary\r\nText\r\n\r\n${START}\r\nA\r\n${END}\r\n`)
  assert.equal(place(placed, block), placed)
})

checkoutTest('the working files removed in an earlier commit of the branch still give the checklist', async co => {
  co.git('rm', '-q', '-r', '.tmp')
  co.git('commit', '-q', '-m', 'Remove the working files')
  await co.write('b.txt', 'b\n')
  co.git('add', 'b.txt')
  co.git('commit', '-q', '-m', 'B')
  // main moves on, and the branch takes it in with a merge after the removal.
  co.git('switch', '-q', 'main')
  await co.write('c.txt', 'c\n')
  co.git('add', 'c.txt')
  co.git('commit', '-q', '-m', 'C')
  co.git('push', '-q', 'origin', 'main')
  co.git('switch', '-q', 'feat')
  co.git('merge', '-q', '--no-edit', 'main')
  co.git('push', '-q')

  const [code, out] = await co.checkpoint()

  assert.equal(code, 0, out)
  assert.equal((await co.gh()).pr!.body, `${BODY}\n\n${section([...CHECKLIST.slice(0, 3), '- [x] 3. Remove the working files'])}`)
})

checkoutTest('a pull request with no url is still updated, and the run ends well', async co => {
  const pr: Partial<Pr> = (await co.gh()).pr!
  delete pr.url
  await co.setPr(pr as Pr)

  const [code, out] = await co.checkpoint()

  assert.equal(code, 0, out)
  assert.equal(out, 'Updated the plan outline in #7.\n')
  assert.equal((await co.gh()).pr!.body, `${BODY}\n\n${section(CHECKLIST)}`)
})

checkoutTest('a pull request with no state or no head branch says which, and is left alone', async co => {
  for (const [key, line] of [
    ['state', 'gh gave no state for pull request #7: nothing to update.'],
    ['headRefName', 'gh gave no head branch for pull request #7: nothing to update.'],
  ] as const) {
    const pr: Partial<Pr> = { number: 7, url: 'u', body: BODY, headRefName: 'feat', baseRefName: 'main', state: 'OPEN' }
    delete pr[key]
    await co.setPr(pr as Pr)

    const [code, out] = await co.checkpoint()

    assert.equal(code, 0, out)
    assert.equal(out, `${line}\n`)
    assert.deepEqual(await co.edits(), [])
  }
})

test('--pr takes ASCII digits only', () => {
  assert.deepEqual(parseArgs(['--pr', '12']), { pr: '12' })
  for (const number of ['²', '①', '٣', '１２', '1²']) assert.equal(parseArgs(['--pr', number]), null, number)
})
