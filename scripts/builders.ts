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
// Exit codes: 0 when done; 3 when refused, with the reason; 1 when git or gh failed, with its message; 2 for wrong
// arguments. test-slot exits with its command's code.
//
// The output, the argument errors, and the help are byte for byte what builders.py prints with Python 3.12's argparse
// (./pycompat.ts keeps Python's JSON, repr, and error texts).

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { constants, tmpdir, userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'

import { tryLock } from './lock.ts'
import {
  PyException,
  ValueError,
  basename,
  commonpath,
  decodeUtf8,
  dirname,
  dumps,
  exists,
  expanduser,
  isErrno,
  isdir,
  join,
  loads,
  makedirs,
  osException,
  pyInt,
  readText,
  realpath,
  repr,
  str,
  strip,
  truthy,
  universalNewlines,
  type PyDict,
  type PyValue,
} from './pycompat.ts'

// At most this many open pull requests per repo that wait for human review (the owner's cap).
export const REVIEW_CAP = 10
// Builders running tests at once on this machine. A test suite already spreads over several cores, so on a
// many-core workstation the runs finished per minute stop rising at about 3 at once: past that, another run at once
// only slows the others. --slots sets another count for another machine.
export const TEST_SLOTS = 3
const WAIT_MS = 1000

// git@github.com:owner/repo.git, ssh://git@host/owner/repo.git, https://github.com/owner/repo, or a local path.
const REMOTE = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/

class Refused extends Error {}

class GitFailed extends Error {}

/** Where the output goes: stdout, or a test's capture. done runs once what was written before it is out. */
export type Out = { write(text: string, done?: () => void): unknown }

/** subprocess.run(args, capture_output=True, text=True): stdin passed on, the output read as Python's text mode. */
function run(args: string[], cwd?: string): { returncode: number; stdout: string; stderr: string } {
  const done = spawnSync(args[0]!, args.slice(1), { cwd, stdio: ['inherit', 'pipe', 'pipe'] })
  if (done.error) throw osException(done.error, args[0])
  const text = (bytes: Buffer) => universalNewlines(decodeUtf8(bytes))
  return { returncode: returncode(done), stdout: text(done.stdout), stderr: text(done.stderr) }
}

/** Python's returncode: the exit status, or minus the signal that ended the process. */
function returncode(done: SpawnSyncReturns<unknown>): number {
  if (done.status !== null) return done.status
  return -((constants.signals as Record<string, number>)[done.signal ?? ''] ?? 0)
}

function git(cwd: string, ...args: string[]): string {
  const done = run(['git', '-C', cwd, ...args])
  if (done.returncode !== 0) throw new GitFailed(`git ${args.join(' ')} failed in ${cwd}: ${strip(done.stderr)}`)
  return strip(done.stdout)
}

function gitStatus(cwd: string, ...args: string[]): number {
  return run(['git', '-C', cwd, ...args]).returncode
}

let ROOT: string | null = null

function root(): string {
  const chosen = process.env['WAFFLES_BUILDERS_ROOT'] || ROOT
  if (!chosen) throw new Refused('no folder for the clones: pass --root (the skills pass <session scratchpad>/builders) or set WAFFLES_BUILDERS_ROOT.')
  return realpath(expanduser(chosen))
}

export function ownerRepo(url: string): [string, string] {
  const match = REMOTE.exec(url)
  if (!match) throw new Refused(`origin's URL ${url} names no owner and repo.`)
  return [match[1]!, match[2]!]
}

function slug(text: string): string {
  const clean = text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  if (!clean) throw new Refused(`the item ID ${repr(text)} makes no folder name.`)
  return clean
}

function inside(path: string, folder: string): boolean {
  return commonpath(path, folder) === folder
}

type Result = PyDict

function clone(repo: string, item: string, branch: string, base: string | null): Result {
  const main = realpath(git(repo, 'rev-parse', '--show-toplevel'))
  const url = git(main, 'remote', 'get-url', 'origin')
  const [owner, name] = ownerRepo(url)
  const path = join(root(), owner, name, slug(item))
  if (inside(path, main) || inside(main, path)) throw new Refused(`the clone ${path} would be inside the main checkout ${main}, or hold it.`)

  if (exists(path)) {
    if (!isdir(join(path, '.git'))) throw new Refused(`${path} exists and is not a clone.`)
    if (git(path, 'remote', 'get-url', 'origin') !== url) throw new Refused(`${path} is a clone of another remote.`)
    const current = git(path, 'branch', '--show-current')
    if (current !== branch) throw new Refused(`${path} is the clone of item ${item} on branch ${current}, not ${branch}.`)
    return new Map<string, PyValue>([['path', path], ['branch', branch], ['base', recordedBase(path)], ['reused', true]])
  }

  makedirs(dirname(path))
  const common = realpath(join(main, git(main, 'rev-parse', '--git-common-dir')))
  const done = run(['git', 'clone', '--quiet', '--reference-if-able', common, '--dissociate', url, path])
  if (done.returncode !== 0) throw new GitFailed(`git clone ${url} failed: ${strip(done.stderr)}`)
  try {
    if (!base) {
      const head = git(path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
      // Python's split("/", 1)[1]: a name with no slash ends the run, and leaves the clone.
      if (!head.includes('/')) throw new PyException('IndexError', 'list index out of range')
      base = head.slice(head.indexOf('/') + 1)
    }
    const onOrigin = gitStatus(path, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`) === 0
    if (onOrigin) {
      git(path, 'switch', '--quiet', '--track', `origin/${branch}`)
    } else {
      if (gitStatus(path, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`) !== 0) {
        throw new Refused(`origin has no branch ${base} to start ${branch} from. Push the item it depends on first.`)
      }
      git(path, 'switch', '--quiet', '--no-track', '-c', branch, `origin/${base}`)
    }
  } catch (error) {
    if (error instanceof Refused || error instanceof GitFailed) rmSync(path, { recursive: true })
    throw error
  }
  const record = join(path, '.git', 'waffles', 'builder.json')
  makedirs(dirname(record))
  writeFileSync(record, `${dumps(new Map([['item', item], ['branch', branch], ['base', base], ['main', main]]), 2)}\n`)
  return new Map<string, PyValue>([['path', path], ['branch', branch], ['base', base], ['reused', false]])
}

/** The name of a value's Python type, as an AttributeError names it. */
function typeName(value: PyValue): string {
  if (value === null) return 'NoneType'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'bigint') return 'int'
  if (typeof value === 'number') return 'float'
  if (typeof value === 'string') return 'str'
  return Array.isArray(value) ? 'list' : 'dict'
}

/** value.get(key), which only a dict has. */
function get(value: PyValue, key: string): PyValue | undefined {
  if (!(value instanceof Map)) throw new PyException('AttributeError', `'${typeName(value)}' object has no attribute 'get'`)
  return value.get(key)
}

/** value[key]: a key that is missing ends the run, as Python's KeyError does. */
function item(value: PyValue, key: string): PyValue {
  const found = get(value, key)
  if (found === undefined) throw new PyException('KeyError', repr(key))
  return found
}

function recordedBase(path: string): PyValue {
  let data: PyValue
  try {
    data = loads(readText(join(path, '.git', 'waffles', 'builder.json')))
  } catch (error) {
    if (isErrno(error) || error instanceof ValueError) return null
    throw error
  }
  return get(data, 'base') ?? null
}

function remove(path: string): Result {
  path = realpath(path)
  if (!inside(path, root()) || path === root()) throw new Refused(`${path} is not a builder's clone under ${root()}.`)
  if (!isdir(join(path, '.git'))) throw new Refused(`${path} is not a clone.`)
  if (git(path, 'status', '--porcelain')) throw new Refused(`${path} holds changes that are not committed.`)
  if (git(path, 'stash', 'list')) throw new Refused(`${path} holds stashed changes.`)
  git(path, 'fetch', '--quiet', 'origin')
  const ahead = git(path, 'log', '--oneline', 'HEAD', '--branches', '--not', '--remotes')
  if (ahead) throw new Refused(`${path} holds commits that origin lacks:\n${ahead}`)
  rmSync(path, { recursive: true })
  let parent = dirname(path)
  while (parent !== root() && inside(parent, root()) && readdirSync(parent).length === 0) {
    rmdirSync(parent)
    parent = dirname(parent)
  }
  return new Map<string, PyValue>([['path', path], ['removed', true]])
}

/** The open pull requests that wait for human review: ready, with a review requested. */
function waitingForReview(repo: string): PyValue[] {
  const done = run(['gh', 'pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,url,isDraft,reviewRequests'], repo)
  if (done.returncode !== 0) {
    throw new GitFailed(`gh pr list failed in ${repo}, so the pull requests that wait for review are not counted: ${strip(done.stderr)}`)
  }
  let prs: PyValue
  try {
    prs = loads(done.stdout)
  } catch (error) {
    if (error instanceof ValueError) throw new GitFailed(`gh pr list answered no JSON: ${error.message}`)
    throw error
  }
  // Python iterates a list's items and a dict's keys.
  const items = Array.isArray(prs) ? prs : prs instanceof Map ? [...prs.keys()] : null
  if (items === null) throw new PyException('TypeError', `'${typeName(prs)}' object is not iterable`)
  return items.filter((pr) => !truthy(get(pr, 'isDraft')) && truthy(get(pr, 'reviewRequests')))
}

/** Python's < between 2 numbers, or 2 strs; any other pair ends the run, as its TypeError does. */
function compare(a: PyValue, b: PyValue): number {
  const number = (v: PyValue) => (typeof v === 'boolean' ? Number(v) : typeof v === 'bigint' || typeof v === 'number' ? v : null)
  const x = number(a)
  const y = number(b)
  if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : 0
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  throw new PyException('TypeError', `'<' not supported between instances of '${typeName(b)}' and '${typeName(a)}'`)
}

function limits(repo: string, cap: bigint): Result {
  const main = realpath(git(repo, 'rev-parse', '--show-toplevel'))
  const waiting = waitingForReview(main)
  if (BigInt(waiting.length) >= cap) {
    const listed = [...waiting]
      .sort((a, b) => compare(item(a, 'number'), item(b, 'number')))
      .map((pr) => `- #${str(item(pr, 'number'))} ${str(item(pr, 'title'))}: ${str(item(pr, 'url'))}`)
      .join('\n')
    throw new Refused(
      `${waiting.length} open pull requests in ${basename(main)} wait for human review (ready, with a review ` +
        `requested), and the cap is ${cap}. Start no builder in this repo until one of them is reviewed:\n${listed}`,
    )
  }
  const numbers = waiting.map((pr) => item(pr, 'number')).sort(compare)
  return new Map<string, PyValue>([['waiting', BigInt(waiting.length)], ['cap', cap], ['numbers', numbers]])
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
async function testSlot(slots: bigint, command: string[], out: Out): Promise<number> {
  const folder = slotsDir()
  makedirs(folder)
  let said = false
  for (;;) {
    for (let n = 0n; n < slots; n++) {
      // This process holds the slot: it waits for the command, and the lock file names its pid. Killed, it leaves a
      // lock that the next process to look finds stale, as flock's lock went with the process that held it.
      const path = join(folder, `slot-${n}.lock`)
      let held
      try {
        held = tryLock(path)
      } catch (error) {
        throw osException(error, path)
      }
      if (held === null) continue
      try {
        await flush(out)
        const done = spawnSync(command[0]!, command.slice(1), { stdio: 'inherit', env: { ...process.env, WAFFLES_TEST_SLOT: String(n) } })
        if (done.error) throw osException(done.error, command[0])
        return returncode(done)
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

// --- Arguments: Python 3.12's argparse, for this parser -----------------------------------------------------------

type Action = {
  flags: string[]
  dest: string
  help?: string
  required?: boolean
  int?: boolean
  takesValue: boolean
}
type Positional = { dest: string; help?: string; nargs: 'remainder' } | { dest: string; help?: string; nargs: 'parser'; choices: Parser[] }
type Parser = { prog: string; name: string; help?: string; actions: Action[]; positional?: Positional }

const HELP: Action = { flags: ['-h', '--help'], dest: 'help', help: 'show this help message and exit', takesValue: false }
const ROOT_OPTION: Action = { flags: ['--root'], dest: 'root', help: 'the folder for the clones; $WAFFLES_BUILDERS_ROOT wins when set', takesValue: true }
const REPO: Action = { flags: ['--repo'], dest: 'repo', help: 'the main checkout', required: true, takesValue: true }

const SUBCOMMANDS: Parser[] = [
  {
    prog: 'builders.py clone',
    name: 'clone',
    help: "make a builder's clone and branch",
    actions: [
      HELP,
      ROOT_OPTION,
      REPO,
      { flags: ['--item'], dest: 'item', help: "the item's ID, or its .backlog/ file's stem", required: true, takesValue: true },
      { flags: ['--branch'], dest: 'branch', help: "the item's branch", required: true, takesValue: true },
      { flags: ['--base'], dest: 'base', help: "the branch to start from; default: origin's default branch", takesValue: true },
    ],
  },
  {
    prog: 'builders.py remove',
    name: 'remove',
    help: "delete a builder's clone whose work is on origin",
    actions: [HELP, ROOT_OPTION, { flags: ['--path'], dest: 'path', required: true, takesValue: true }],
  },
  {
    prog: 'builders.py limits',
    name: 'limits',
    help: 'refuse at 10 open pull requests that wait for human review',
    actions: [HELP, REPO, { flags: ['--cap'], dest: 'cap', int: true, takesValue: true }],
  },
  {
    prog: 'builders.py test-slot',
    name: 'test-slot',
    help: "run a test command in 1 of the machine's test slots",
    actions: [HELP, { flags: ['--slots'], dest: 'slots', int: true, takesValue: true }],
    positional: { dest: 'cmd', help: '-- then the command', nargs: 'remainder' },
  },
]
const PARSER: Parser = { prog: 'builders.py', name: '', actions: [HELP], positional: { dest: 'command', nargs: 'parser', choices: SUBCOMMANDS } }

/** The end of a parse: SystemExit's code, after argparse printed the help or the error. */
class ParserExit {
  readonly code: number
  constructor(code: number) {
    this.code = code
  }
}

/** HelpFormatter's width: $COLUMNS, else the terminal's, else 80; less 2. */
function width(): number {
  let columns = Number(pyInt(process.env['COLUMNS'] ?? '') ?? 0n)
  if (columns <= 0) columns = (process.stdout.isTTY ? process.stdout.columns : 0) || 80
  return columns - 2
}

function metavar(action: Action): string {
  return action.dest.toUpperCase()
}

function positionalUsage(positional: Positional): string {
  if (positional.nargs === 'remainder') return '...'
  return `{${positional.choices.map((p) => p.name).join(',')}} ...`
}

function invocation(action: Action): string {
  return action.flags.map((flag) => (action.takesValue ? `${flag} ${metavar(action)}` : flag)).join(', ')
}

function formatUsage(parser: Parser, textWidth: number): string {
  const prefix = 'usage: '
  const optUsage = parser.actions
    .map((a) => {
      const part = a.takesValue ? `${a.flags[0]} ${metavar(a)}` : a.flags[0]!
      return a.required ? part : `[${part}]`
    })
    .join(' ')
  const posUsage = parser.positional ? positionalUsage(parser.positional) : ''
  let usage = [parser.prog, [optUsage, posUsage].filter(Boolean).join(' ')].filter(Boolean).join(' ')
  if (prefix.length + usage.length > textWidth) {
    const partsOf = (text: string) => text.match(/\(.*?\)+(?=\s|$)|\[.*?\]+(?=\s|$)|\S+/g) ?? []
    const optParts = partsOf(optUsage)
    const posParts = partsOf(posUsage)
    const getLines = (parts: string[], indent: string, first?: string): string[] => {
      const lines: string[] = []
      let line: string[] = []
      let lineLen = first !== undefined ? first.length - 1 : indent.length - 1
      for (const part of parts) {
        if (lineLen + 1 + part.length > textWidth && line.length > 0) {
          lines.push(indent + line.join(' '))
          line = []
          lineLen = indent.length - 1
        }
        line.push(part)
        lineLen += part.length + 1
      }
      if (line.length > 0) lines.push(indent + line.join(' '))
      if (first !== undefined) lines[0] = lines[0]!.slice(indent.length)
      return lines
    }
    let lines: string[]
    if (prefix.length + parser.prog.length <= 0.75 * textWidth) {
      const indent = ' '.repeat(prefix.length + parser.prog.length + 1)
      if (optParts.length > 0) lines = [...getLines([parser.prog, ...optParts], indent, prefix), ...getLines(posParts, indent)]
      else if (posParts.length > 0) lines = getLines([parser.prog, ...posParts], indent, prefix)
      else lines = [parser.prog]
    } else {
      const indent = ' '.repeat(prefix.length)
      lines = getLines([...optParts, ...posParts], indent)
      if (lines.length > 1) lines = [...getLines(optParts, indent), ...getLines(posParts, indent)]
      lines = [parser.prog, ...lines]
    }
    usage = lines.join('\n')
  }
  return `${prefix}${usage}\n\n`
}

/** textwrap.wrap on text that holds single spaces only. */
function wrap(text: string, width: number): string[] {
  const chunks = text.split(/( +)/).filter(Boolean).reverse()
  const lines: string[] = []
  while (chunks.length > 0) {
    const line: string[] = []
    let length = 0
    if (strip(chunks[chunks.length - 1]!) === '' && lines.length > 0) chunks.pop()
    while (chunks.length > 0 && length + chunks[chunks.length - 1]!.length <= width) {
      length += chunks[chunks.length - 1]!.length
      line.push(chunks.pop()!)
    }
    if (chunks.length > 0 && chunks[chunks.length - 1]!.length > width) {
      const chunk = chunks[chunks.length - 1]!
      const spaceLeft = width < 1 ? 1 : width - length
      let end = spaceLeft
      const hyphen = chunk.lastIndexOf('-', spaceLeft - 1)
      if (chunk.length > spaceLeft && hyphen > 0 && /[^-]/.test(chunk.slice(0, hyphen))) end = hyphen + 1
      line.push(chunk.slice(0, end))
      chunks[chunks.length - 1] = chunk.slice(end)
    }
    if (line.length > 0 && strip(line[line.length - 1]!) === '') line.pop()
    if (line.length > 0) lines.push(line.join(''))
  }
  return lines
}

function formatHelp(parser: Parser, fullWidth: number): string {
  const maxHelpPosition = Math.min(24, Math.max(fullWidth - 20, 4))
  type Row = { header: string; help?: string; subrows?: Row[] }
  const positionals: Row[] = []
  if (parser.positional?.nargs === 'remainder') positionals.push({ header: parser.positional.dest, help: parser.positional.help })
  if (parser.positional?.nargs === 'parser') {
    positionals.push({
      header: `{${parser.positional.choices.map((p) => p.name).join(',')}}`,
      subrows: parser.positional.choices.map((p) => ({ header: p.name, help: p.help })),
    })
  }
  const options: Row[] = parser.actions.map((a) => ({ header: invocation(a), help: a.help }))
  const rows = [...positionals, ...options]
  const maxLength = Math.max(0, ...rows.map((r) => Math.max(r.header.length, ...(r.subrows ?? []).map((s) => s.header.length)) + 2))
  const helpPosition = Math.min(maxLength + 2, maxHelpPosition)
  const helpWidth = Math.max(fullWidth - helpPosition, 11)
  const formatRow = (row: Row, indent: number): string => {
    const actionWidth = helpPosition - indent - 2
    let text: string
    let indentFirst = 0
    if (!row.help) text = `${' '.repeat(indent)}${row.header}\n`
    else if (row.header.length <= actionWidth) text = `${' '.repeat(indent)}${row.header.padEnd(actionWidth)}  `
    else {
      text = `${' '.repeat(indent)}${row.header}\n`
      indentFirst = helpPosition
    }
    if (row.help && strip(row.help)) {
      const lines = wrap(strip(row.help.replace(/\s+/g, ' ')), helpWidth)
      text += `${' '.repeat(indentFirst)}${lines[0]}\n`
      for (const line of lines.slice(1)) text += `${' '.repeat(helpPosition)}${line}\n`
    } else if (!text.endsWith('\n')) text += '\n'
    for (const sub of row.subrows ?? []) text += formatRow(sub, indent + 2)
    return text
  }
  const section = (heading: string, items: Row[]) => (items.length > 0 ? `\n${heading}:\n${items.map((r) => formatRow(r, 2)).join('')}\n` : '')
  const help = formatUsage(parser, fullWidth) + section('positional arguments', positionals) + section('options', options)
  return `${help.replace(/\n\n\n+/g, '\n\n').replace(/^\n+|\n+$/g, '')}\n`
}

function fail(parser: Parser, message: string): never {
  process.stderr.write(`${formatUsage(parser, width()).replace(/\n+$/, '')}\n`)
  process.stderr.write(`${parser.prog}: error: ${message}\n`)
  throw new ParserExit(2)
}

type Classified = { action: Action | null; flag: string; explicit: string | null } | null

/** ArgumentParser._parse_optional: null for an argument, else the option it names, if any. */
function classify(parser: Parser, arg: string): Classified {
  const byFlag = new Map(parser.actions.flatMap((a) => a.flags.map((f) => [f, a] as const)))
  if (!arg || arg[0] !== '-') return null
  if (byFlag.has(arg)) return { action: byFlag.get(arg)!, flag: arg, explicit: null }
  if (arg.length === 1) return null
  if (arg.includes('=')) {
    const flag = arg.slice(0, arg.indexOf('='))
    if (byFlag.has(flag)) return { action: byFlag.get(flag)!, flag, explicit: arg.slice(arg.indexOf('=') + 1) }
  }
  const matches: { action: Action; flag: string; explicit: string | null }[] = []
  if (arg[1] === '-') {
    const [prefix, explicit] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null]
    for (const [flag, action] of byFlag) if (flag.startsWith(prefix)) matches.push({ action, flag, explicit })
  } else {
    for (const [flag, action] of byFlag) {
      if (flag === arg.slice(0, 2)) matches.push({ action, flag, explicit: arg.slice(2) })
      else if (flag.startsWith(arg)) matches.push({ action, flag, explicit: null })
    }
  }
  if (matches.length > 1) fail(parser, `ambiguous option: ${arg} could match ${matches.map((m) => m.flag).join(', ')}`)
  if (matches.length === 1) return matches[0]!
  // Python's $ also matches before a final newline.
  if (/^-\p{Nd}+\n?$|^-\p{Nd}*\.\p{Nd}+\n?$/u.test(arg)) return null
  if (arg.includes(' ')) return null
  return { action: null, flag: arg, explicit: null }
}

type Values = Record<string, string | bigint | string[] | null>

/** ArgumentParser.parse_known_args, for a parser whose options take 0 or 1 value and whose positional comes last. */
function parseKnown(parser: Parser, args: string[], values: Values): string[] {
  const pattern: string[] = []
  const options = new Map<number, NonNullable<Classified>>()
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      pattern.push('-', ...args.slice(i + 1).map(() => 'A'))
      break
    }
    const found = classify(parser, args[i]!)
    pattern.push(found === null ? 'A' : 'O')
    if (found !== null) options.set(i, found)
  }
  const extras: string[] = []
  const seen = new Set<Action>()
  let positional = parser.positional
  const error = (action: Action, message: string): never => fail(parser, `argument ${action.flags.join('/')}: ${message}`)

  const take = (action: Action, value: string | null) => {
    seen.add(action)
    if (action === HELP) {
      process.stdout.write(formatHelp(parser, width()))
      throw new ParserExit(0)
    }
    if (action.int) {
      const n = pyInt(value!)
      if (n === null) error(action, `invalid int value: ${repr(value!)}`)
      values[action.dest] = n
    } else values[action.dest] = value
  }

  const consumePositionals = (start: number): number => {
    if (positional === undefined) return start
    const rest = pattern.slice(start).join('')
    if (positional.nargs === 'remainder') {
      values[positional.dest] = args.slice(start)
      positional = undefined
      return args.length
    }
    const match = /^(-*A[-AO]*)/.exec(rest)
    if (match === null) return start
    const taken = args.slice(start)
    positional = undefined
    const name = taken[0]!
    const sub = SUBCOMMANDS.find((p) => p.name === name)
    if (sub === undefined) {
      const choices = SUBCOMMANDS.map((p) => repr(p.name)).join(', ')
      fail(parser, `argument command: invalid choice: ${repr(name)} (choose from ${choices})`)
    }
    values['command'] = name
    extras.push(...parseKnown(sub!, taken.slice(1), values))
    return args.length
  }

  const consumeOptional = (start: number): number => {
    let { action, flag, explicit } = options.get(start)!
    const pending: [Action, string | null][] = []
    let stop: number
    for (;;) {
      if (action === null) {
        extras.push(args[start]!)
        return start + 1
      }
      if (explicit !== null) {
        // A single-dash option that takes no value reads what follows it as more single-dash options: -hh.
        if (!action.takesValue && flag[1] !== '-' && explicit !== '') {
          pending.push([action, null])
          flag = flag.charAt(0) + explicit.charAt(0)
          const next = parser.actions.find((a) => a.flags.includes(flag))
          if (next === undefined) error(action, `ignored explicit argument ${repr(explicit)}`)
          action = next!
          explicit = explicit.slice(1) || null
          continue
        }
        if (!action.takesValue) error(action, `ignored explicit argument ${repr(explicit)}`)
        pending.push([action, explicit])
        stop = start + 1
        break
      }
      if (action.takesValue && pattern[start + 1] !== 'A') error(action, 'expected one argument')
      pending.push([action, action.takesValue ? args[start + 1]! : null])
      stop = start + 1 + (action.takesValue ? 1 : 0)
      break
    }
    for (const [a, value] of pending) take(a, value)
    return stop
  }

  const indices = [...options.keys()]
  const last = indices.length > 0 ? Math.max(...indices) : -1
  let start = 0
  while (start <= last) {
    const next = Math.min(...indices.filter((i) => i >= start))
    if (start !== next) {
      const end = consumePositionals(start)
      if (end > start) {
        start = end
        continue
      }
      start = end
    }
    if (!options.has(start)) {
      extras.push(...args.slice(start, next))
      start = next
    }
    start = consumeOptional(start)
  }
  start = consumePositionals(start)
  extras.push(...args.slice(start))

  const required = parser.actions.filter((a) => a.required && !seen.has(a)).map((a) => a.flags.join('/'))
  if (parser.positional?.nargs === 'parser' && values['command'] === undefined) required.push('command')
  if (required.length > 0) fail(parser, `the following arguments are required: ${required.join(', ')}`)
  return extras
}

/** ArgumentParser.parse_args. Throws ParserExit after it printed the help or an error. */
function parseArgs(argv: string[]): Values {
  const values: Values = { root: null, base: null, cap: BigInt(REVIEW_CAP), slots: BigInt(TEST_SLOTS), cmd: [] }
  const extras = parseKnown(PARSER, argv, values)
  if (extras.length > 0) fail(PARSER, `unrecognized arguments: ${extras.join(' ')}`)
  return values
}

export async function main(argv: string[], out: Out = process.stdout): Promise<number> {
  let args: Values
  try {
    args = parseArgs(argv)
  } catch (error) {
    if (error instanceof ParserExit) return error.code ? 2 : 0
    throw error
  }
  if (args['command'] === 'test-slot') {
    const cmd = args['cmd'] as string[]
    const command = cmd[0] === '--' ? cmd.slice(1) : cmd
    if (command.length === 0 || (args['slots'] as bigint) < 1n) {
      out.write('test-slot needs a command after --, and 1 slot or more.\n')
      return 2
    }
    return testSlot(args['slots'] as bigint, command, out)
  }
  ROOT = (args['root'] as string | null) ?? null
  let result: Result
  try {
    if (args['command'] === 'clone') {
      result = clone(args['repo'] as string, args['item'] as string, args['branch'] as string, args['base'] as string | null)
    } else if (args['command'] === 'limits') {
      result = limits(args['repo'] as string, args['cap'] as bigint)
    } else {
      result = remove(args['path'] as string)
    }
  } catch (error) {
    if (error instanceof Refused) {
      out.write(`Refused: ${error.message}\n`)
      return 3
    }
    if (error instanceof GitFailed) {
      out.write(`${error.message}\n`)
      return 1
    }
    throw error
  }
  out.write(`${dumps(result)}\n`)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      // Where Python ends with a traceback, the port ends with its last line and the same exit code.
      const python = error instanceof PyException ? error : isErrno(error) ? osException(error) : null
      if (python === null) throw error
      process.stderr.write(`${python}\n`)
      process.exitCode = 1
    },
  )
}
