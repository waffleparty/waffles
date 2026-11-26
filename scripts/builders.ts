// Give each builder its own full clone of the repo, on its own branch, within the waffles limits; remove the clone
// once merged.
//
// Usage:
//   node builders.ts clone --root DIR --repo DIR --item ID --branch NAME [--base BRANCH]
//   node builders.ts remove --root DIR --path DIR
//   node builders.ts limits --repo DIR [--cap 10]
//   node builders.ts test-slot [--slots 3] -- COMMAND...
//
// A builder is an agent that builds one item: one clone, one branch, one draft pull request. Builders never share a
// checkout, and nothing is copied back from a clone: the work reaches the repo as a pull request.
//
// clone makes `<root>/<owner>/<repo>/<item>` from the main checkout's `origin`. The root is $WAFFLES_BUILDERS_ROOT when
// it is set, so a person can keep clones where they like; otherwise --root, which the skills set to `<session
// scratchpad>/builders`: the session can write there without a permission prompt, and the plugin names no folder of
// its own. A clone that a later session can't find is made again from its pushed branch. It borrows the main
// checkout's objects while it clones (--reference-if-able, then --dissociate), so the clone is fast and needs nothing
// of the main checkout afterwards. The branch starts from origin's BASE: the default branch, or for an item that
// depends on one not merged yet, that item's branch (a stacked pull request). A branch that origin already has is
// checked out as it is. A clone that already exists for the item is used again when it is on the same branch. It
// prints 1 line of JSON: path, branch, base, and whether it was reused.
//
// remove deletes a clone under the root once it holds no change, no stash, and no commit that origin lacks (on a
// branch or a detached HEAD).
//
// limits counts, from GitHub, the open pull requests of the repo that wait for human review: marked ready (not a
// draft), with a review requested from a person or a team. It counts every developer's. At the cap (10) it refuses:
// waffles starts no builder in that repo until one is reviewed, and the reason lists them. A pull request that an
// agent will merge itself has no review requested, so it is not counted.
//
// test-slot runs COMMAND (a test run, a linter, a type check) once one of the machine's test slots is free, and holds
// the slot until COMMAND ends. The slots are lock files in $WAFFLES_TEST_SLOTS or /tmp/waffles-test-slots-<uid>,
// shared by every session of the user; a lock goes with its process, also when it is killed (./lock.ts). It exits
// with COMMAND's code.
//
// Exit codes: 0 when done; 3 when refused, with the reason on stderr; 1 when git or gh failed, with its message on
// stderr; 2 for wrong arguments, with the reason on stderr. test-slot exits with its command's code.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { constants, homedir, tmpdir, userInfo } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { tryLock } from './lock.ts'

// At most this many open pull requests per repo that wait for human review (the owner's cap).
export const REVIEW_CAP = 10
// Builders running tests at once on this machine. A test suite already spreads over several cores, so on a
// many-core workstation the runs finished per minute stop rising at about 3 at once: past that, another run at once
// only slows the others. --slots sets another count for another machine.
export const TEST_SLOTS = 3
const WAIT_MS = 1000

// git@github.com:owner/repo.git, ssh://git@host/owner/repo.git, https://github.com/owner/repo, or a local path.
const REMOTE = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/

const USAGE = `Usage:
  node builders.ts clone --root DIR --repo DIR --item ID --branch NAME [--base BRANCH]
  node builders.ts remove --root DIR --path DIR
  node builders.ts limits --repo DIR [--cap 10]
  node builders.ts test-slot [--slots 3] -- COMMAND...`

class Refused extends Error {}

class GitFailed extends Error {}

/** Bad arguments: exit code 2. */
class Usage extends Error {}

/** Where the output goes: stdout, or a test's capture. done runs once what was written before it is out. */
export type Out = { write(text: string, done?: () => void): unknown }

/** The exit status, or minus the signal that ended the process. */
function exitCode(done: SpawnSyncReturns<unknown>): number {
  if (done.status !== null) return done.status
  return -((constants.signals as Record<string, number>)[done.signal ?? ''] ?? 0)
}

/** Runs a command with stdin passed on and its output captured. */
function run(args: string[], cwd?: string): { status: number; stdout: string; stderr: string } {
  const done = spawnSync(args[0]!, args.slice(1), { cwd, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] })
  if (done.error) throw new Error(`cannot run ${args[0]}: ${done.error.message}`)
  return { status: exitCode(done), stdout: done.stdout, stderr: done.stderr }
}

function git(cwd: string, ...args: string[]): string {
  const done = run(['git', '-C', cwd, ...args])
  if (done.status !== 0) throw new GitFailed(`git ${args.join(' ')} failed in ${cwd}: ${done.stderr.trim()}`)
  return done.stdout.trim()
}

function gitOk(cwd: string, ...args: string[]): boolean {
  return run(['git', '-C', cwd, ...args]).status === 0
}

function isDir(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
}

/** The path with its symlinks resolved, also when its last parts do not exist yet. */
function realpath(path: string): string {
  const full = resolve(path)
  try {
    return realpathSync(full)
  } catch {
    const parent = dirname(full)
    return parent === full ? full : join(realpath(parent), basename(full))
  }
}

function inside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep)
}

function root(option: string | undefined): string {
  const chosen = process.env['WAFFLES_BUILDERS_ROOT'] || option
  if (!chosen) throw new Refused('no folder for the clones: pass --root (the skills pass <session scratchpad>/builders) or set WAFFLES_BUILDERS_ROOT.')
  return realpath(chosen === '~' || chosen.startsWith('~/') ? homedir() + chosen.slice(1) : chosen)
}

export function ownerRepo(url: string): [string, string] {
  const match = REMOTE.exec(url)
  if (!match) throw new Refused(`origin's URL ${url} names no owner and repo.`)
  return [match[1]!, match[2]!]
}

function slug(text: string): string {
  const clean = text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  if (!clean) throw new Refused(`the item ID ${JSON.stringify(text)} makes no folder name.`)
  return clean
}

type Clone = { path: string; branch: string; base: unknown; reused: boolean }

function clone(rootFolder: string, repo: string, item: string, branch: string, base: string | undefined): Clone {
  const main = realpath(git(repo, 'rev-parse', '--show-toplevel'))
  const url = git(main, 'remote', 'get-url', 'origin')
  const [owner, name] = ownerRepo(url)
  const path = join(rootFolder, owner, name, slug(item))
  if (inside(path, main) || inside(main, path)) throw new Refused(`the clone ${path} would be inside the main checkout ${main}, or hold it.`)

  if (existsSync(path)) {
    if (!isDir(join(path, '.git'))) throw new Refused(`${path} exists and is not a clone.`)
    if (git(path, 'remote', 'get-url', 'origin') !== url) throw new Refused(`${path} is a clone of another remote.`)
    const current = git(path, 'branch', '--show-current')
    if (current !== branch) throw new Refused(`${path} is the clone of item ${item} on branch ${current}, not ${branch}.`)
    return { path, branch, base: recordedBase(path), reused: true }
  }

  mkdirSync(dirname(path), { recursive: true })
  const common = realpath(join(main, git(main, 'rev-parse', '--git-common-dir')))
  const done = run(['git', 'clone', '--quiet', '--reference-if-able', common, '--dissociate', url, path])
  if (done.status !== 0) throw new GitFailed(`git clone ${url} failed: ${done.stderr.trim()}`)
  try {
    if (!base) {
      const head = git(path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
      base = head.slice(head.indexOf('/') + 1)
    }
    if (gitOk(path, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`)) {
      git(path, 'switch', '--quiet', '--track', `origin/${branch}`)
    } else {
      if (!gitOk(path, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`)) {
        throw new Refused(`origin has no branch ${base} to start ${branch} from. Push the item it depends on first.`)
      }
      git(path, 'switch', '--quiet', '--no-track', '-c', branch, `origin/${base}`)
    }
  } catch (error) {
    if (error instanceof Refused || error instanceof GitFailed) rmSync(path, { recursive: true })
    throw error
  }
  const record = join(path, '.git', 'waffles', 'builder.json')
  mkdirSync(dirname(record), { recursive: true })
  writeFileSync(record, `${JSON.stringify({ item, branch, base, main }, null, 2)}\n`)
  return { path, branch, base, reused: false }
}

function recordedBase(path: string): unknown {
  try {
    return JSON.parse(readFileSync(join(path, '.git', 'waffles', 'builder.json'), 'utf8'))?.base ?? null
  } catch {
    return null
  }
}

function remove(rootFolder: string, path: string): { path: string; removed: true } {
  path = realpath(path)
  if (!inside(path, rootFolder) || path === rootFolder) throw new Refused(`${path} is not a builder's clone under ${rootFolder}.`)
  if (!isDir(join(path, '.git'))) throw new Refused(`${path} is not a clone.`)
  if (git(path, 'status', '--porcelain')) throw new Refused(`${path} holds changes that are not committed.`)
  if (git(path, 'stash', 'list')) throw new Refused(`${path} holds stashed changes.`)
  git(path, 'fetch', '--quiet', 'origin')
  const ahead = git(path, 'log', '--oneline', 'HEAD', '--branches', '--not', '--remotes')
  if (ahead) throw new Refused(`${path} holds commits that origin lacks:\n${ahead}`)
  rmSync(path, { recursive: true })
  let parent = dirname(path)
  while (parent !== rootFolder && inside(parent, rootFolder) && readdirSync(parent).length === 0) {
    rmdirSync(parent)
    parent = dirname(parent)
  }
  return { path, removed: true }
}

type PullRequest = { number: number; title: string; url: string; isDraft?: boolean; reviewRequests?: unknown[] }

/** The open pull requests that wait for human review: ready, with a review requested. */
function waitingForReview(repo: string): PullRequest[] {
  const done = run(['gh', 'pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,url,isDraft,reviewRequests'], repo)
  if (done.status !== 0) {
    throw new GitFailed(`gh pr list failed in ${repo}, so the pull requests that wait for review are not counted: ${done.stderr.trim()}`)
  }
  let prs: unknown
  try {
    prs = JSON.parse(done.stdout)
  } catch (error) {
    throw new GitFailed(`gh pr list answered no JSON: ${(error as Error).message}`)
  }
  if (!Array.isArray(prs)) throw new GitFailed('gh pr list answered no list of pull requests')
  return (prs as PullRequest[]).filter((pr) => !pr.isDraft && (pr.reviewRequests?.length ?? 0) > 0)
}

function limits(repo: string, cap: number): { waiting: number; cap: number; numbers: number[] } {
  const main = realpath(git(repo, 'rev-parse', '--show-toplevel'))
  const waiting = waitingForReview(main).sort((a, b) => a.number - b.number)
  if (waiting.length >= cap) {
    const listed = waiting.map((pr) => `- #${pr.number} ${pr.title}: ${pr.url}`).join('\n')
    throw new Refused(
      `${waiting.length} open pull requests in ${basename(main)} wait for human review (ready, with a review ` +
        `requested), and the cap is ${cap}. Start no builder in this repo until one of them is reviewed:\n${listed}`,
    )
  }
  return { waiting: waiting.length, cap, numbers: waiting.map((pr) => pr.number) }
}

function slotsDir(): string {
  if (process.env['WAFFLES_TEST_SLOTS']) return process.env['WAFFLES_TEST_SLOTS']
  // Windows has no uid, and no /tmp: there the folder is in the user's temp folder, named for the user.
  if (process.getuid === undefined) return join(tmpdir(), `waffles-test-slots-${userInfo().username}`)
  return `/tmp/waffles-test-slots-${process.getuid()}`
}

function flush(out: Out): Promise<void> {
  return new Promise((resolve) => out.write('', () => resolve()))
}

/** Runs command holding 1 of the machine's test slots; waits for one while all are held. */
async function testSlot(slots: number, command: string[], out: Out): Promise<number> {
  const folder = slotsDir()
  mkdirSync(folder, { recursive: true })
  let said = false
  for (;;) {
    for (let n = 0; n < slots; n++) {
      // This process holds the slot: it waits for the command, and the lock file names its pid. Killed, it leaves a
      // lock that the next process to look finds stale.
      const held = tryLock(join(folder, `slot-${n}.lock`))
      if (held === null) continue
      try {
        await flush(out)
        const done = spawnSync(command[0]!, command.slice(1), { stdio: 'inherit', env: { ...process.env, WAFFLES_TEST_SLOT: String(n) } })
        if (done.error) throw new Error(`cannot run ${command[0]}: ${done.error.message}`)
        return exitCode(done)
      } finally {
        held.release()
      }
    }
    if (!said) {
      out.write(`Waiting for a test slot: all ${slots} are in use on this machine.\n`)
      said = true
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS))
  }
}

function count(name: string, text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback
  if (!/^-?[0-9]+$/.test(text.trim())) throw new Usage(`--${name} takes a whole number, not ${JSON.stringify(text)}`)
  return Number(text)
}

/** test-slot's arguments: --slots, then the command, after `--` or from its first word that is not an option. */
function slotArgs(argv: string[]): { help: boolean; slots: string | undefined; command: string[] } {
  let slots: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-h' || arg === '--help') return { help: true, slots, command: [] }
    if (arg === '--') return { help: false, slots, command: argv.slice(i + 1) }
    if (arg.startsWith('--slots=')) slots = arg.slice('--slots='.length)
    else if (arg === '--slots') {
      if (i + 1 >= argv.length) throw new Usage('--slots needs a value')
      slots = argv[++i]
    } else if (arg.startsWith('-')) throw new Usage(`unknown option ${arg}`)
    else return { help: false, slots, command: argv.slice(i) }
  }
  return { help: false, slots, command: [] }
}

const OPTIONS = {
  clone: ['root', 'repo', 'item', 'branch', 'base'],
  remove: ['root', 'path'],
  limits: ['repo', 'cap'],
} as const
const REQUIRED: Record<string, string[]> = { clone: ['repo', 'item', 'branch'], remove: ['path'], limits: ['repo'] }

function parse(command: keyof typeof OPTIONS, argv: string[]): Record<string, string | undefined> | null {
  const options = Object.fromEntries(OPTIONS[command].map((name) => [name, { type: 'string' as const }]))
  let values: Record<string, string | boolean | undefined>
  try {
    values = parseArgs({ args: argv, options: { ...options, help: { type: 'boolean', short: 'h' } } }).values
  } catch (error) {
    throw new Usage((error as Error).message)
  }
  if (values['help']) return null
  const missing = REQUIRED[command]!.filter((name) => values[name] === undefined)
  if (missing.length > 0) throw new Usage(`${command} needs ${missing.map((name) => `--${name}`).join(', ')}`)
  return values as Record<string, string | undefined>
}

export async function main(argv: string[], out: Out = process.stdout, err: Out = process.stderr): Promise<number> {
  const [command, ...rest] = argv
  try {
    if (command === '-h' || command === '--help') {
      out.write(`${USAGE}\n`)
      return 0
    }
    if (command === 'test-slot') {
      const args = slotArgs(rest)
      if (args.help) {
        out.write(`${USAGE}\n`)
        return 0
      }
      const slots = count('slots', args.slots, TEST_SLOTS)
      if (args.command.length === 0 || slots < 1) throw new Usage('test-slot needs a command after --, and 1 slot or more.')
      return await testSlot(slots, args.command, out)
    }
    if (command !== 'clone' && command !== 'remove' && command !== 'limits') {
      throw new Usage(command === undefined ? 'name a command: clone, remove, limits, or test-slot' : `unknown command ${JSON.stringify(command)}`)
    }
    const args = parse(command, rest)
    if (args === null) {
      out.write(`${USAGE}\n`)
      return 0
    }
    let result: object
    try {
      if (command === 'clone') result = clone(root(args['root']), args['repo']!, args['item']!, args['branch']!, args['base'])
      else if (command === 'limits') result = limits(args['repo']!, count('cap', args['cap'], REVIEW_CAP))
      else result = remove(root(args['root']), args['path']!)
    } catch (error) {
      if (error instanceof Refused) {
        err.write(`Refused: ${error.message}\n`)
        return 3
      }
      if (error instanceof GitFailed) {
        err.write(`${error.message}\n`)
        return 1
      }
      throw error
    }
    out.write(`${JSON.stringify(result)}\n`)
    return 0
  } catch (error) {
    err.write(`builders: ${(error as Error).message}\n`)
    return error instanceof Usage ? 2 : 1
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
