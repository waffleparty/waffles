// Tests for builders.ts, on a local origin. Run: node --test "scripts/*.spec.ts"

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { TEST_SLOTS, main, ownerRepo, type Out } from './builders.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }

function sh(cwd: string, ...args: string[]): string {
  const done = spawnSync(args[0]!, args.slice(1), { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } })
  assert.equal(done.status, 0, `${args.join(' ')}: ${done.stderr}`)
  return done.stdout.trim()
}

function commit(cwd: string, name: string, text: string): void {
  writeFileSync(join(cwd, name), text)
  sh(cwd, 'git', 'add', name)
  sh(cwd, 'git', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `Add ${name}`)
}

/** Collects what main writes. */
class Capture implements Out {
  text = ''
  write(text: string, done?: () => void) {
    this.text += text
    done?.()
  }
}

/** Sets environment variables for 1 test, and puts back what they were. */
function saveEnv(...names: string[]): () => void {
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

type Clone = { path: string; branch: string; base: string; reused: boolean }

describe('builders', () => {
  let tmp: string
  let origin: string
  let mainCheckout: string
  let root: string
  let restore: () => void

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'builders-'))
    const base = realpathSync(tmp)
    origin = join(base, 'remote', 'example', 'widget.git')
    mkdirSync(origin, { recursive: true })
    sh(origin, 'git', 'init', '-q', '--bare', '-b', 'main')
    mainCheckout = join(base, 'widget')
    sh(base, 'git', 'clone', '-q', origin, mainCheckout)
    sh(mainCheckout, 'git', 'switch', '-q', '-c', 'main')
    commit(mainCheckout, 'README.md', 'widget\n')
    sh(mainCheckout, 'git', 'push', '-q', '-u', 'origin', 'main')
    sh(mainCheckout, 'git', 'remote', 'set-head', 'origin', 'main')
    root = join(base, 'builders')
    restore = saveEnv('WAFFLES_BUILDERS_ROOT')
    process.env['WAFFLES_BUILDERS_ROOT'] = root
  })

  afterEach(() => {
    restore()
    rmSync(tmp, { recursive: true, force: true })
  })

  // The result on stdout; a refusal or a failure on stderr, with nothing on stdout.
  async function runScript(...args: string[]): Promise<[number, Clone & Record<string, unknown> | string]> {
    const [out, err] = [new Capture(), new Capture()]
    const code = await main(args, out, err)
    if (code === 0) return [code, JSON.parse(out.text)]
    assert.equal(out.text, '')
    return [code, err.text]
  }

  async function clone(item: string, branch: string, ...more: string[]): Promise<Clone> {
    const [code, result] = await runScript('clone', '--repo', mainCheckout, '--item', item, '--branch', branch, ...more)
    assert.equal(code, 0, String(result))
    return result as Clone
  }

  test('2 builders in 1 repo never touch the same checkout', async () => {
    const a = await clone('ITEM-1', 'feat/ITEM-1')
    const b = await clone('ITEM-2', 'feat/ITEM-2-other')
    assert.equal(a.path, join(root, 'example', 'widget', 'ITEM-1'))
    assert.equal(b.path, join(root, 'example', 'widget', 'ITEM-2'))
    const checkouts = new Set([mainCheckout, a.path, b.path])
    const gitDirs = new Set([...checkouts].map((p) => sh(p, 'git', 'rev-parse', '--absolute-git-dir')))
    assert.equal(checkouts.size, 3)
    assert.equal(gitDirs.size, 3)
    // Full clones, not worktrees: each has its own object store and no link to the main checkout's.
    for (const path of [a.path, b.path]) {
      assert.ok(statSync(join(path, '.git', 'objects')).isDirectory())
      assert.ok(!existsSync(join(path, '.git', 'objects', 'info', 'alternates')))
      assert.equal(sh(path, 'git', 'remote', 'get-url', 'origin'), origin)
    }
    assert.equal(sh(a.path, 'git', 'branch', '--show-current'), 'feat/ITEM-1')
    assert.equal(sh(b.path, 'git', 'branch', '--show-current'), 'feat/ITEM-2-other')
    // Work in one clone shows in neither the other clone nor the main checkout.
    commit(a.path, 'a.txt', 'a\n')
    writeFileSync(join(b.path, 'b.txt'), 'b\n')
    assert.ok(!existsSync(join(b.path, 'a.txt')))
    assert.ok(!existsSync(join(mainCheckout, 'a.txt')))
    assert.equal(sh(mainCheckout, 'git', 'status', '--porcelain'), '')
    assert.equal(sh(mainCheckout, 'git', 'branch', '--list', 'feat/*'), '')
    assert.equal(sh(a.path, 'git', 'status', '--porcelain'), '')
  })

  test('an item that depends on an unmerged one stacks on its branch', async () => {
    const a = await clone('ITEM-1', 'feat/ITEM-1')
    commit(a.path, 'a.txt', 'a\n')
    sh(a.path, 'git', 'push', '-q', '-u', 'origin', 'feat/ITEM-1')
    const b = await clone('ITEM-2', 'feat/ITEM-2', '--base', 'feat/ITEM-1')
    assert.equal(b.base, 'feat/ITEM-1')
    assert.ok(statSync(join(b.path, 'a.txt')).isFile())
    // The branch has no upstream yet: its first push sets it.
    assert.equal(spawnSync('git', ['-C', b.path, 'rev-parse', '--abbrev-ref', '@{upstream}']).status, 128)
  })

  test('a base that is not pushed is refused and leaves no clone', async () => {
    const [code, text] = await runScript('clone', '--repo', mainCheckout, '--item', 'ITEM-3', '--branch', 'feat/ITEM-3', '--base', 'feat/ITEM-9')
    assert.equal(code, 3)
    assert.ok(String(text).includes('origin has no branch feat/ITEM-9'))
    assert.ok(!existsSync(join(root, 'example', 'widget', 'ITEM-3')))
  })

  test('a branch on origin is checked out as it is', async () => {
    const a = await clone('ITEM-1', 'feat/ITEM-1')
    commit(a.path, 'a.txt', 'a\n')
    sh(a.path, 'git', 'push', '-q', '-u', 'origin', 'feat/ITEM-1')
    assert.equal((await runScript('remove', '--path', a.path))[0], 0)
    const again = await clone('ITEM-1', 'feat/ITEM-1')
    assert.equal(again.reused, false)
    assert.ok(statSync(join(again.path, 'a.txt')).isFile())
  })

  test('the clone of an item is reused on its branch, and refused on another', async () => {
    const first = await clone('ITEM-1', 'feat/ITEM-1')
    const again = await clone('ITEM-1', 'feat/ITEM-1')
    assert.deepEqual([again.path, again.reused, again.base], [first.path, true, 'main'])
    const [code, text] = await runScript('clone', '--repo', mainCheckout, '--item', 'ITEM-1', '--branch', 'feat/ITEM-1-new')
    assert.equal(code, 3)
    assert.ok(String(text).includes('on branch feat/ITEM-1, not feat/ITEM-1-new'))
  })

  test('remove keeps a clone with work that origin lacks', async () => {
    const a = await clone('ITEM-1', 'feat/ITEM-1')
    writeFileSync(join(a.path, 'a.txt'), 'a\n')
    let [code, text] = await runScript('remove', '--path', a.path)
    assert.equal(code, 3)
    assert.ok(String(text).includes('not committed'))
    commit(a.path, 'a.txt', 'a\n')
    ;[code, text] = await runScript('remove', '--path', a.path)
    assert.equal(code, 3)
    assert.ok(String(text).includes('commits that origin lacks'))
    sh(a.path, 'git', 'push', '-q', '-u', 'origin', 'feat/ITEM-1')
    writeFileSync(join(a.path, 'a.txt'), 'stashed\n')
    sh(a.path, 'git', 'stash', '-q')
    ;[code, text] = await runScript('remove', '--path', a.path)
    assert.equal(code, 3)
    assert.ok(String(text).includes('stashed changes'))
    sh(a.path, 'git', 'stash', 'drop', '-q')
    sh(a.path, 'git', 'switch', '-q', '--detach')
    commit(a.path, 'd.txt', 'detached\n')
    ;[code, text] = await runScript('remove', '--path', a.path)
    assert.equal(code, 3)
    assert.ok(String(text).includes('Add d.txt'))
    sh(a.path, 'git', 'switch', '-q', 'feat/ITEM-1')
    assert.equal((await runScript('remove', '--path', a.path))[0], 0)
    assert.ok(!existsSync(join(root, 'example')))
  })

  test('clone uses --root when no variable is set, and refuses with neither', async () => {
    delete process.env['WAFFLES_BUILDERS_ROOT']
    const other = join(dirname(root), 'scratch')
    const [code, result] = await runScript('clone', '--root', other, '--repo', mainCheckout, '--item', 'ITEM-9', '--branch', 'feat/ITEM-9')
    assert.equal(code, 0)
    assert.equal((result as Clone).path, join(realpathSync(dirname(other)), 'scratch', 'example', 'widget', 'ITEM-9'))
    const [refused, text] = await runScript('clone', '--repo', mainCheckout, '--item', 'ITEM-8', '--branch', 'feat/ITEM-8')
    assert.equal(refused, 3)
    assert.ok(String(text).startsWith('Refused: '))
    assert.ok(String(text).includes('--root'))
  })

  test('remove refuses a folder outside the builders root', async () => {
    const [code, text] = await runScript('remove', '--path', mainCheckout)
    assert.equal(code, 3)
    assert.ok(String(text).includes("is not a builder's clone"))
    assert.ok(statSync(mainCheckout).isDirectory())
  })

  test('owner and repo come from any form of URL', () => {
    for (const url of ['git@github.com:example/widget.git', 'https://github.com/example/widget', 'ssh://git@github.com/example/widget.git', '/srv/example/widget.git/']) {
      assert.deepEqual(ownerRepo(url), ['example', 'widget'], url)
    }
  })
})

const SKILLS = join(dirname(HERE), 'skills')

describe('no patch recipes', () => {
  test('neither work-loop nor the run skill hands work back as a patch', () => {
    const files = [join(SKILLS, 'work-loop', 'SKILL.md')]
    const run = join(SKILLS, 'non-interactive')
    files.push(...readdirSync(run).sort().filter((name) => name.endsWith('.md')).map((name) => join(run, name)))
    for (const path of files) {
      assert.doesNotMatch(readFileSync(path, 'utf8'), /\bpatch|git apply|isolation: "worktree"/i, path)
    }
  })

  test("the limits in work-loop are the script's", () => {
    const text = readFileSync(join(SKILLS, 'work-loop', 'SKILL.md'), 'utf8').split(/\s+/).filter(Boolean).join(' ')
    assert.ok(text.includes('A cap on the open pull requests per repo that wait for human review, when the person set one in `WAFFLES_REVIEW_CAP`'))
    assert.ok(text.includes(`${TEST_SLOTS} builders running tests at once on this machine`))
    assert.ok(text.includes('builders.ts limits --repo <main>'))
  })
})

// `gh pr list` answers the pull requests in the state file, or fails when "down" is set.
const GH = `#!${process.execPath}
const state = JSON.parse(require('fs').readFileSync(process.env.GH_STUB_STATE, 'utf8'))
if (state.down) {
  process.stderr.write('gh: HTTP 502\\n')
  process.exit(1)
}
if (process.argv[2] !== 'pr' || process.argv[3] !== 'list') process.exit(2)
process.stdout.write(JSON.stringify(state.prs) + '\\n')
`

function pr(number: number, draft = false, requested = true) {
  return {
    number,
    title: `Item ${number}`,
    url: `https://github.com/example/widget/pull/${number}`,
    isDraft: draft,
    reviewRequests: requested ? [{ login: 'octocat' }] : [],
  }
}

describe('limits', () => {
  let tmp: string
  let base: string
  let repo: string
  let state: string
  let restore: () => void

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'builders-limits-'))
    base = realpathSync(tmp)
    const bin = join(base, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'gh'), GH)
    chmodSync(join(bin, 'gh'), 0o755)
    repo = join(base, 'widget')
    mkdirSync(repo)
    sh(repo, 'git', 'init', '-q')
    state = join(base, 'gh.json')
    restore = saveEnv('PATH', 'GH_STUB_STATE', 'WAFFLES_TEST_SLOTS')
    process.env['PATH'] = bin + delimiter + process.env['PATH']
    process.env['GH_STUB_STATE'] = state
    process.env['WAFFLES_TEST_SLOTS'] = join(base, 'slots')
  })

  afterEach(() => {
    restore()
    rmSync(tmp, { recursive: true, force: true })
  })

  function prs(list: ReturnType<typeof pr>[], down = false): void {
    writeFileSync(state, JSON.stringify({ prs: list, down }))
  }

  // stdout when it counted; stderr, with nothing on stdout, when it refused or could not count.
  async function limits(...cap: string[]): Promise<[number, string]> {
    const [out, err] = [new Capture(), new Capture()]
    const code = await main(['limits', '--repo', repo, ...cap], out, err)
    if (code === 0) return [code, out.text]
    assert.equal(out.text, '')
    return [code, err.text]
  }

  test('with no cap set, 10 pull requests waiting for review are counted and nothing is refused', async () => {
    prs(Array.from({ length: 10 }, (_, i) => pr(i + 1)))
    const [code, out] = await limits()
    assert.equal(code, 0, out)
    assert.deepEqual(JSON.parse(out), { waiting: 10, cap: null, numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })
  })

  test('at a cap of 10, with 10 pull requests waiting for review no builder starts, and the reason lists them', async () => {
    prs(Array.from({ length: 10 }, (_, i) => pr(i + 1)))
    const [code, out] = await limits('--cap', '10')
    assert.equal(code, 3)
    assert.ok(out.includes('Refused: 10 open pull requests in widget wait for human review (ready, with a review requested), and the cap is 10.'))
    assert.ok(out.includes('- #10 Item 10: https://github.com/example/widget/pull/10'))
  })

  test('the reason lists what gh gave of each pull request, and leaves out what it did not', async () => {
    const list: Partial<ReturnType<typeof pr>>[] = Array.from({ length: 10 }, (_, i) => pr(i + 1))
    delete list[0]!.number
    delete list[1]!.title
    delete list[2]!.url
    for (const key of ['number', 'title', 'url'] as const) delete list[3]![key]
    prs(list as ReturnType<typeof pr>[])
    const [code, out] = await limits('--cap', '10')
    assert.equal(code, 3)
    assert.doesNotMatch(out, /undefined/)
    const lines = out.split('\n').filter((line) => line.startsWith('- '))
    assert.deepEqual(lines.slice(0, 4).sort(), [
      '- #2: https://github.com/example/widget/pull/2',
      '- #3 Item 3',
      '- Item 1: https://github.com/example/widget/pull/1',
      '- a pull request that gh gave no number, title, or URL for',
    ])
  })

  test('drafts, and pull requests with no review requested, do not count', async () => {
    prs([...Array.from({ length: 9 }, (_, i) => pr(i + 1)), pr(20, true), pr(21, false, false)])
    const [code, out] = await limits()
    assert.equal(code, 0, out)
    assert.deepEqual(JSON.parse(out), { waiting: 9, cap: null, numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9] })
  })

  test('when gh cannot count, the reason says so', async () => {
    prs([], true)
    const [code, out] = await limits()
    assert.equal(code, 1)
    assert.ok(out.includes('the pull requests that wait for review are not counted: gh: HTTP 502'))
  })

  /** 2 commands at once, each sleeping 0.6 s: their start and end times. */
  async function slotRuns(slots: number): Promise<[[number, number][], string[]]> {
    const script = join(HERE, 'builders.ts')
    const logs = [0, 1].map((n) => join(base, `log-${slots}-${n}`))
    const cmd = [process.execPath, '-e', "const s = Date.now() / 1000; setTimeout(() => require('fs').writeFileSync(process.argv[1], `${s} ${Date.now() / 1000}`), 600)"]
    const runs = logs.map((log) => {
      const child = spawn(process.execPath, [script, 'test-slot', '--slots', String(slots), '--', ...cmd, log], { stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        out += chunk
      })
      return new Promise<[number | null, string]>((resolve) => child.on('close', (code) => resolve([code, out])))
    })
    const results = await Promise.all(runs)
    assert.deepEqual(results.map(([code]) => code), [0, 0])
    const spans = logs.map((log) => readFileSync(log, 'utf8').split(' ').map(Number) as [number, number])
    return [spans.sort((x, y) => x[0] - y[0] || x[1] - y[1]), results.map(([, out]) => out)]
  }

  test('test runs beyond the slots wait for a free one', async () => {
    let [spans, outs] = await slotRuns(1)
    assert.ok(spans[1]![0] >= spans[0]![1])
    assert.ok(outs.some((o) => o.includes('Waiting for a test slot: all 1 are in use on this machine.')))
    ;[spans] = await slotRuns(2)
    assert.ok(spans[1]![0] < spans[0]![1])
  })

  test("test-slot passes on the command's exit code", async () => {
    assert.equal(await main(['test-slot', '--', process.execPath, '-e', 'process.exit(5)'], new Capture()), 5)
  })

  test('bad arguments go to stderr and exit 2, with nothing on stdout', async () => {
    for (const args of [['test-slot'], ['test-slot', '--slots', '0', '--', 'true'], ['limits'], ['frob']]) {
      const [out, err] = [new Capture(), new Capture()]
      assert.equal(await main(args, out, err), 2, args.join(' '))
      assert.equal(out.text, '', args.join(' '))
      assert.ok(err.text.startsWith('builders: '), err.text)
    }
  })
})
