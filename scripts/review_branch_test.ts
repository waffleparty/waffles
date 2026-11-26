// Tests for review_branch.ts, on a local origin and a stub gh. Run: node --test "scripts/*_test.ts"

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { main } from './review_branch.ts'

const GIT_ENV: Record<string, string> = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }

// `gh pr list` answers the pull requests in GH_STUB_PRS.
const GH = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] !== 'pr' || args[1] !== 'list' || !args.includes('review-requested:@me')) process.exit(2)
console.log(process.env.GH_STUB_PRS)
`

function sh(cwd: string, ...args: string[]): string {
  const done = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8' })
  if (done.status !== 0) throw new Error(`${args.join(' ')} failed: ${done.stderr}`)
  return done.stdout.trim()
}

describe('review_branch', () => {
  let tmp: string
  let origin: string
  let app: string
  let saved: Record<string, string | undefined>

  const commit = (name: string, text: string) => {
    writeFileSync(join(app, name), text)
    sh(app, 'git', 'add', name)
    sh(app, 'git', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `Change ${name}`)
  }

  // The parsed JSON when the script printed it, else its text.
  const runScript = (...args: string[]): [number, any] => {
    let text = ''
    const code = main(args, { write: (s: string) => (text += s) })
    return [code, code === 0 ? JSON.parse(text) : text]
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'review-branch-'))
    const base = realpathSync(tmp)
    saved = Object.fromEntries([...Object.keys(GIT_ENV), 'PATH', 'GH_STUB_PRS'].map((k) => [k, process.env[k]]))
    Object.assign(process.env, GIT_ENV)
    const bin = join(base, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'gh'), GH)
    chmodSync(join(bin, 'gh'), 0o755)
    process.env.PATH = bin + delimiter + process.env.PATH
    origin = join(base, 'origin.git')
    sh(base, 'git', 'init', '-q', '--bare', '-b', 'main', origin)
    app = join(base, 'app')
    sh(base, 'git', 'clone', '-q', origin, app)
    sh(app, 'git', 'switch', '-q', '-c', 'main')
    commit('app.txt', 'header\nbody\n')
    sh(app, 'git', 'push', '-q', '-u', 'origin', 'main')
    sh(app, 'git', 'remote', 'set-head', 'origin', 'main')
    // 3 UI pull requests that touch separate files, and 1 that conflicts with #1.
    const prs: [number, string, string][] = [[1, 'app.txt', 'header\nbody, version 1\n'], [2, 'page2.txt', '2\n'], [3, 'page3.txt', '3\n'], [4, 'app.txt', 'header\nbody, version 4\n']]
    for (const [n, name, text] of prs) {
      sh(app, 'git', 'switch', '-q', '-c', `feat/ITEM-${n}`, 'main')
      commit(name, text)
      sh(app, 'git', 'push', '-q', 'origin', `HEAD:refs/pull/${n}/head`)
    }
    sh(app, 'git', 'switch', '-q', 'main')
    sh(app, 'git', 'switch', '-q', '-c', 'feat/mine')
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(tmp, { recursive: true, force: true })
  })

  test('3 UI pull requests are merged into one local branch that has no upstream', () => {
    const [code, result] = runScript('build', '--repo', app, '--pr', '1', '2', '3')
    assert.equal(code, 0, result)
    assert.deepEqual([result.merged, result.conflicts, result.from], [[1, 2, 3], [], 'feat/mine'])
    assert.equal(sh(app, 'git', 'branch', '--show-current'), 'waffles-review')
    for (const [name, text] of [['app.txt', 'header\nbody, version 1\n'], ['page2.txt', '2\n'], ['page3.txt', '3\n']]) {
      assert.equal(readFileSync(join(app, name), 'utf8'), text)
    }
    assert.equal(spawnSync('git', ['-C', app, 'rev-parse', '--abbrev-ref', 'waffles-review@{upstream}']).status, 128)
    assert.ok(!sh(app, 'git', 'ls-remote', 'origin').includes('waffles-review'))
  })

  test('a pull request that conflicts is left out and named', () => {
    const [code, result] = runScript('build', '--repo', app, '--pr', '1', '4', '2')
    assert.equal(code, 0, result)
    assert.deepEqual([result.merged, result.conflicts], [[1, 2], [4]])
    assert.equal(sh(app, 'git', 'status', '--porcelain'), '')
  })

  test('a rebuild starts over, and done switches back and deletes the branch', () => {
    runScript('build', '--repo', app, '--pr', '1')
    let [code, result] = runScript('build', '--repo', app, '--pr', '2', '3')
    assert.deepEqual([code, result.merged, result.from], [0, [2, 3], 'feat/mine'])
    assert.equal(readFileSync(join(app, 'app.txt'), 'utf8'), 'header\nbody\n')
    ;[code, result] = runScript('done', '--repo', app)
    assert.equal(code, 0, result)
    assert.equal(sh(app, 'git', 'branch', '--show-current'), 'feat/mine')
    assert.equal(sh(app, 'git', 'branch', '--list', 'waffles-review'), '')
    assert.equal(sh(app, 'git', 'for-each-ref', 'refs/waffles-review'), '')
  })

  test('waiting takes the ready pull requests that ask for a review', () => {
    process.env.GH_STUB_PRS = JSON.stringify([{ number: 3, isDraft: false }, { number: 2, isDraft: false }, { number: 9, isDraft: true }])
    const [code, result] = runScript('build', '--repo', app, '--waiting')
    assert.deepEqual([code, result.merged], [0, [2, 3]])
  })

  test('changes to tracked files are refused', () => {
    appendFileSync(join(app, 'app.txt'), 'work in progress\n')
    const [code, text] = runScript('build', '--repo', app, '--pr', '1')
    assert.equal(code, 3)
    assert.ok(text.includes('has changes to tracked files'))
    assert.equal(sh(app, 'git', 'branch', '--show-current'), 'feat/mine')
  })

  test('own commits on waffles-review are never lost', () => {
    runScript('build', '--repo', app, '--pr', '1')
    commit('mine.txt', 'my own work\n')
    for (const args of [['build', '--repo', app, '--pr', '2'], ['done', '--repo', app]]) {
      const [code, text] = runScript(...args)
      assert.equal(code, 3, args.join(' '))
      assert.ok(text.includes('holds commits that are not merges of the pull requests'))
      assert.ok(text.includes('Change mine.txt'))
    }
    assert.ok(existsSync(join(app, 'mine.txt')))
    // A branch named waffles-review that the script did not make is refused the same way.
    sh(app, 'git', 'switch', '-q', 'feat/mine')
    sh(app, 'git', 'branch', '-q', '-D', 'waffles-review')
    sh(app, 'git', 'switch', '-q', '-c', 'waffles-review')
    commit('other.txt', 'other\n')
    sh(app, 'git', 'switch', '-q', 'feat/mine')
    const [code, text] = runScript('build', '--repo', app, '--pr', '1')
    assert.equal(code, 3)
    assert.ok(text.includes('Change other.txt'))
  })
})
