import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { nodeHost } from '../adapters/node/host.ts'
import { REVIEW_BRANCH_TOOL } from './review-branch.ts'
import { fakeHost, type Answer } from './testing.ts'
import { TOOLS } from './tools.ts'

// A main checkout at /main on feat with nothing changed, and no review branch yet; gh lists `waiting`.
function checkout(gh: Answer = { stdout: '[]' }, step: (argv: readonly string[]) => number = () => 0) {
  const $ = fakeHost({
    cwd: '/session',
    files: { '/main/README.md': 'readme\n' },
    run: argv => {
      $.advance(step(argv))
      const [command, ...args] = argv
      if (command === 'gh') return gh
      const line = args.join(' ')
      if (line === 'rev-parse --show-toplevel') return { stdout: '/main\n' }
      if (line === 'rev-parse --absolute-git-dir') return { stdout: '/main/.git\n' }
      if (line === 'branch --show-current') return { stdout: 'feat\n' }
      if (line.startsWith('rev-parse --verify')) return { exitCode: 1 }
      if (line.startsWith('symbolic-ref')) return { stdout: 'origin/main\n' }
      return {}
    },
  })
  return $
}

test('the review branch is one of the core tools', () => {
  assert.ok(TOOLS.includes(REVIEW_BRANCH_TOOL))
  assert.deepEqual(REVIEW_BRANCH_TOOL.inputSchema.required, ['op', 'repo'])
})

test('an input the tool cannot use is refused, and nothing runs', async () => {
  const $ = checkout()
  for (const [input, refusal] of [
    [{ op: 'merge', repo: '/main' }, 'op must be one of build, done.'],
    [{ op: 'build' }, 'repo must be the path of the main checkout.'],
    [{ op: 'build', repo: '/main' }, 'build takes either prs or waiting: true.'],
    [{ op: 'build', repo: '/main', prs: [1], waiting: true }, 'build takes either prs or waiting: true.'],
    [{ op: 'build', repo: '/main', prs: [] }, 'prs must be a list of pull request numbers.'],
    [{ op: 'build', repo: '/main', prs: ['1'] }, 'prs must be a list of pull request numbers.'],
    [{ op: 'done', repo: '/main', waiting: true }, 'done takes only repo.'],
    [{ op: 'done', repo: '/main', branch: 'x' }, 'The review_branch tool takes op, repo, prs, and waiting, not branch.'],
  ] as const) {
    assert.deepEqual(await REVIEW_BRANCH_TOOL.call($, input), { refusal }, JSON.stringify(input))
  }
  assert.deepEqual($.ran, [])
})

test('a build runs every command in the main checkout, each within its limit, and records the branch to go back to', async () => {
  const $ = checkout()
  const answer = await REVIEW_BRANCH_TOOL.call($, { op: 'build', repo: '../main', prs: [2, 1] })

  assert.deepEqual(answer, { value: { branch: 'waffles-review', from: 'feat', base: 'origin/main', merged: [2, 1], conflicts: [] } })
  assert.ok($.ran.every(r => r.cwd === '/main'))
  const limits = $.ran.map(r => [r.argv[1] === '-c' ? r.argv[3] : r.argv[1], r.timeoutMs])
  assert.deepEqual(limits.filter(([command]) => command === 'fetch' || command === 'merge'), [['fetch', 120_000], ['fetch', 120_000], ['merge', 60_000], ['merge', 60_000]])
  assert.ok(limits.every(([command, ms]) => command === 'fetch' || command === 'merge' || ms === 30_000), JSON.stringify(limits))
  assert.deepEqual(JSON.parse($.files.get('/main/.git/waffles/review.json')!), { branch: 'waffles-review', from: 'feat', base: 'origin/main', merged: [2, 1], conflicts: [] })
})

test('a build that runs out of its 4 minutes stops, and says so', async () => {
  // Each fetch takes 2.5 minutes by the clock.
  const $ = checkout(undefined, argv => (argv[1] === 'fetch' ? 150_000 : 0))
  const answer = await REVIEW_BRANCH_TOOL.call($, { op: 'build', repo: '/main', prs: [1] })

  assert.deepEqual(answer, { refusal: 'git switch did not run: the tool call ran out of time' })
  // The second fetch was given only what was left.
  assert.deepEqual($.ran.filter(r => r.argv[1] === 'fetch').map(r => r.timeoutMs), [120_000, 90_000])
  assert.ok(!$.ran.some(r => r.argv[1] === 'switch'))
})

test('waiting refuses a list of pull requests that the platform cut', async () => {
  const $ = checkout({ stdout: '[{"number": 1, "isDraft": false}, {"num', isTruncated: true })
  const answer = await REVIEW_BRANCH_TOOL.call($, { op: 'build', repo: '/main', waiting: true })

  assert.deepEqual(answer, { refusal: 'gh pr list printed more than the platform passes on, so nothing is answered from a part of it' })
  assert.ok(!$.ran.some(r => r.argv[1] === 'switch' || r.argv[1] === 'fetch'))
})

test('a refusal starts "Refused: ", and a folder that is not there is a failure', async () => {
  const $ = checkout()
  assert.deepEqual(await REVIEW_BRANCH_TOOL.call($, { op: 'done', repo: '/main' }), { refusal: 'Refused: no review branch was built in /main.' })
  assert.deepEqual(await REVIEW_BRANCH_TOOL.call($, { op: 'done', repo: '/gone' }), { refusal: '/gone does not exist' })
})

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1' }

test('on Node.js, the tool builds and ends the branch in the checkout it names, not the session’s folder', async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'waffles-review-')))
  const saved = { ...process.env }
  Object.assign(process.env, GIT_ENV, { GIT_CONFIG_GLOBAL: join(root, 'gitconfig') })
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    await fs.writeFile(join(root, 'gitconfig'), '[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n')
    sh(root, 'init', '-q', '--bare', 'origin.git')
    sh(root, 'clone', '-q', 'origin.git', 'app')
    const app = join(root, 'app')
    await fs.writeFile(join(app, 'a.txt'), 'a\n')
    sh(app, 'add', 'a.txt')
    sh(app, 'commit', '-q', '-m', 'Start')
    sh(app, 'push', '-q', '-u', 'origin', 'main')
    sh(app, 'remote', 'set-head', 'origin', 'main')
    sh(app, 'switch', '-q', '-c', 'feat/one')
    await fs.writeFile(join(app, 'b.txt'), 'b\n')
    sh(app, 'add', 'b.txt')
    sh(app, 'commit', '-q', '-m', 'Add b')
    sh(app, 'push', '-q', 'origin', 'HEAD:refs/pull/5/head')

    const $ = nodeHost({ sessionId: 'review', cwd: root, names: { assistant: 'A', product: 'p', planTool: 'plan', ask: 'q', planMode: null }, stateFolder: join(root, 'state') })
    const built = await REVIEW_BRANCH_TOOL.call($, { op: 'build', repo: 'app', prs: [5] })
    assert.deepEqual(built, { value: { branch: 'waffles-review', from: 'feat/one', base: 'origin/main', merged: [5], conflicts: [] } })
    assert.equal(sh(app, 'branch', '--show-current'), 'waffles-review')
    assert.deepEqual(await REVIEW_BRANCH_TOOL.call($, { op: 'done', repo: app }), { value: { branch: 'feat/one', deleted: 'waffles-review' } })
    assert.equal(sh(app, 'branch', '--show-current'), 'feat/one')
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a build fetches from the remote that WAFFLES_REMOTE names', async () => {
  const $ = fakeHost({
    cwd: '/session',
    files: { '/main/README.md': 'readme\n' },
    env: { WAFFLES_REMOTE: 'upstream' },
    run: argv => {
      const line = argv.slice(1).join(' ')
      if (line === 'rev-parse --show-toplevel') return { stdout: '/main\n' }
      if (line === 'rev-parse --absolute-git-dir') return { stdout: '/main/.git\n' }
      if (line === 'branch --show-current') return { stdout: 'feat\n' }
      if (line.startsWith('rev-parse --verify')) return { exitCode: 1 }
      if (line.startsWith('symbolic-ref')) return { stdout: 'upstream/main\n' }
      return {}
    },
  })
  const answer = await REVIEW_BRANCH_TOOL.call($, { op: 'build', repo: '/main', prs: [2] })

  assert.ok('value' in answer && (answer.value as { base: string }).base === 'upstream/main')
  const lines = $.ran.map(r => r.argv.join(' '))
  assert.ok(lines.includes('git fetch --quiet upstream'))
  assert.ok(lines.includes('git symbolic-ref --short refs/remotes/upstream/HEAD'))
  assert.equal(lines.some(line => / origin\b/.test(line)), false)
})
