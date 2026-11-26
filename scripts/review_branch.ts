// Build a throwaway local branch in the main checkout that merges every pull request waiting for the person.
//
// Usage:
//   node review_branch.ts build --repo DIR (--pr N... | --waiting)
//   node review_branch.ts done --repo DIR
//
// The person reviews several finished UI items at once: one branch, `waffles-review`, holds the default branch with each
// pull request merged into it, and one dev server serves it. The branch is never pushed: it has no upstream, and done
// deletes it.
//
// build fetches each pull request's head from origin (refs/pull/<n>/head, kept under refs/waffles-review/), starts
// `waffles-review` from origin's default branch, and merges them in the order given, unsigned, since the merges never leave
// this machine. A pull request that conflicts with the ones before it is left out, and the output names it. --waiting
// takes the open pull requests that are ready and ask the person for a review (`gh pr list --search
// review-requested:@me`). Run build again to rebuild the branch after a waiting pull request changed. It refuses a
// checkout with changes to tracked files, since it switches branches. It records the branch the checkout was on in
// `<git dir>/waffles/review.json`.
//
// done switches back to that branch and deletes `waffles-review` and its fetched refs. Both build and done refuse when
// `waffles-review` holds a commit that is not a merge of the pull requests (someone's own work, or their own branch of that
// name), since they would lose it.
//
// Prints 1 line of JSON. Exit codes: 0 when done; 3 when refused, with the reason; 1 when git or gh failed, with its
// message; 2 for wrong arguments.
//
// This is a port of review_branch.py. Its output, help, and argument errors match the Python's byte for byte, so the
// file also carries a small copy of Python's argparse and json.dumps; it stays self-contained, as the Python did.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const BRANCH = 'waffles-review'
const REFS = 'refs/waffles-review'

type Json = null | boolean | number | bigint | string | Json[] | { [key: string]: Json }
type Dict = { [key: string]: Json }
type Out = { write(text: string): unknown }

class Refused extends Error {}
class Failed extends Error {}

type Done = { status: number | null; stdout: string; stderr: string }

// Like Python's subprocess.run with capture_output and text: stdin stays the caller's, there is no output limit, and
// text mode turns \r\n and \r into \n. A program that cannot start throws, as Python's FileNotFoundError does, and so
// does an argument that is not a string, as Python's TypeError does.
function run(argv: string[], cwd?: string): Done {
  const bad = argv.find((arg) => typeof arg !== 'string')
  if (bad !== undefined) throw new TypeError(`expected str, bytes or os.PathLike object, not ${Array.isArray(bad) ? 'list' : typeof bad}`)
  const done = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: Infinity })
  if (done.error) throw done.error
  const text = (s: string) => s.replace(/\r\n?/g, '\n')
  return { status: done.status, stdout: text(done.stdout), stderr: text(done.stderr) }
}

function git(cwd: string, args: string[], check = true): Done {
  const done = run(['git', '-C', cwd, ...args])
  if (check && done.status !== 0) throw new Failed(`git ${args.join(' ')} failed: ${strip(done.stderr)}`)
  return done
}

function outOf(cwd: string, ...args: string[]): string {
  return strip(git(cwd, args).stdout)
}

function statePath(main: string): string {
  return join(outOf(main, 'rev-parse', '--absolute-git-dir'), 'waffles', 'review.json')
}

function readState(main: string): Json {
  try {
    return JSON.parse(readFileSync(statePath(main), 'utf8')) as Json
  } catch (error) {
    if (error instanceof Failed) throw error
    return null
  }
}

// Commits on waffles-review that are not the merges this script made: someone's own work, which a rebuild or done would lose.
function ownCommits(main: string): string {
  if (git(main, ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`], false).status !== 0) return ''
  const fallback = strip(git(main, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], false).stdout)
  return outOf(main, 'log', '--oneline', '--no-merges', BRANCH, '--not', fallback || 'HEAD', `--glob=${REFS}/*`)
}

function refuseOwnCommits(main: string): void {
  const own = ownCommits(main)
  if (own) {
    throw new Refused(
      `the branch ${BRANCH} holds commits that are not merges of the pull requests, and rebuilding or deleting it ` +
        `would lose them. Move them to another branch first:\n${own}`,
    )
  }
}

function waiting(main: string): bigint[] {
  const done = run(['gh', 'pr', 'list', '--state', 'open', '--search', 'review-requested:@me', '--json', 'number,isDraft'], main)
  if (done.status !== 0) throw new Failed(`gh pr list failed: ${strip(done.stderr)}`)
  return (JSON.parse(done.stdout) as Dict[])
    .filter((pr) => !truthy(pr.isDraft))
    .map((pr) => BigInt(pr.number as number))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export function build(repo: string, prs: bigint[] | null, fromGh: boolean): Dict {
  const main = outOf(repo, 'rev-parse', '--show-toplevel')
  if (outOf(main, 'status', '--porcelain', '--untracked-files=no')) {
    throw new Refused(`${main} has changes to tracked files. Commit or stash them, then build the review branch.`)
  }
  const numbers = fromGh ? waiting(main) : (prs ?? [])
  if (!numbers.length) throw new Refused('no pull request waits for review.')
  const current = outOf(main, 'branch', '--show-current')
  const state = readState(main)
  const back = truthy(state) && current === BRANCH ? (state as Dict).from : current
  if (!truthy(back)) throw new Refused(`${main} is not on a branch (a detached HEAD), so done could not switch back.`)

  refuseOwnCommits(main)
  git(main, ['fetch', '--quiet', 'origin'])
  const base = outOf(main, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  const specs = numbers.map((n) => `+refs/pull/${n}/head:${REFS}/pr-${n}`)
  git(main, ['fetch', '--quiet', 'origin', ...specs])
  git(main, ['switch', '--quiet', '--no-track', '-C', BRANCH, base])
  const merged: bigint[] = []
  const leftOut: bigint[] = []
  for (const n of numbers) {
    const done = git(main, ['-c', 'commit.gpgsign=false', 'merge', '--quiet', '--no-ff', '--no-edit', '-m', `Review: pull request #${n}`, `${REFS}/pr-${n}`], false)
    if (done.status === 0) merged.push(n)
    else {
      git(main, ['merge', '--abort'], false)
      leftOut.push(n)
    }
  }
  const path = statePath(main)
  mkdirSync(dirname(path), { recursive: true })
  const result: Dict = { branch: BRANCH, from: back, base, merged, conflicts: leftOut }
  writeFileSync(path, `${dumps(result, 2)}\n`, 'utf8')
  return result
}

export function done(repo: string): Dict {
  const main = outOf(repo, 'rev-parse', '--show-toplevel')
  const state = readState(main)
  if (!truthy(state)) throw new Refused(`no review branch was built in ${main}.`)
  const from = (state as Dict).from as string
  refuseOwnCommits(main)
  if (outOf(main, 'branch', '--show-current') === BRANCH) {
    if (outOf(main, 'status', '--porcelain', '--untracked-files=no')) {
      throw new Refused(`${BRANCH} has changes to tracked files. Discard or keep them elsewhere first.`)
    }
    git(main, ['switch', '--quiet', from])
  }
  git(main, ['branch', '-D', BRANCH], false)
  for (const ref of splitlines(outOf(main, 'for-each-ref', '--format=%(refname)', REFS))) git(main, ['update-ref', '-d', ref])
  rmSync(statePath(main))
  return { branch: from, deleted: BRANCH }
}

export function main(argv: string[], out: Out = process.stdout): number {
  let args: Record<string, unknown>
  try {
    args = parseArgs(TOP, argv)
  } catch (error) {
    if (error instanceof Exit) return error.code ? 2 : 0
    throw error
  }
  let result: Dict
  try {
    result = args.command === 'build' ? build(args.repo as string, args.pr as bigint[] | null, args.waiting as boolean) : done(args.repo as string)
  } catch (error) {
    if (error instanceof Refused) {
      out.write(`Refused: ${error.message}\n`)
      return 3
    }
    if (error instanceof Failed) {
      out.write(`${error.message}\n`)
      return 1
    }
    throw error
  }
  out.write(`${dumps(result)}\n`)
  return 0
}

// Python's truth test: an empty string, list, or object is false.
function truthy(value: Json | undefined): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0
  return Boolean(value)
}

// str.strip(): Python's whitespace, which differs from String.prototype.trim's at \x1c-\x1f, \x85, and \ufeff.
const SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const EDGES = new RegExp(`^${SPACE}+|${SPACE}+$`, 'g')
function strip(text: string): string {
  return text.replace(EDGES, '')
}

// str.splitlines(), which also breaks at \v, \f, \x1c-\x1e, \x85, \u2028, and \u2029.
function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

// json.dumps: ", " and ": " between items, or with an indent ",\n" and ": ", and every character outside printable
// ASCII escaped.
function dumps(value: Json, indent?: number, depth = 0): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value).toString() : String(value)
  if (typeof value === 'string') return encode(value)
  const items = Array.isArray(value)
    ? value.map((item) => dumps(item, indent, depth + 1))
    : Object.entries(value).map(([key, item]) => `${encode(key)}: ${dumps(item, indent, depth + 1)}`)
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
  if (!items.length) return open + close
  if (indent === undefined) return open + items.join(', ') + close
  const inner = `\n${' '.repeat(indent * (depth + 1))}`
  return `${open}${inner}${items.join(`,${inner}`)}\n${' '.repeat(indent * depth)}${close}`
}

const ESCAPES: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' }
function encode(text: string): string {
  return `"${text.replace(/["\\]|[^\x20-\x7e]/g, (c) => ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`
}

// The argument parser: a port of the parts of Python 3.12's argparse that these parsers use, so that help, usage, and
// every error read and exit as they did. Help and usage wrap to the terminal's width (COLUMNS, else stdout's, else 80).

type Action = {
  dest: string
  flags: string[]
  // 1 is argparse's default (one value), '+' one or more, 'parser' a subcommand and all that follows it.
  nargs: 0 | 1 | '+' | 'parser'
  kind: 'help' | 'store' | 'true' | 'parsers'
  required?: boolean
  choices?: string[]
  int?: boolean
}
// An invocation as help shows it, its help text, and its depth under its section.
type Row = [string, string, number]
type Parser = {
  prog: string
  // The usage's optional parts, then its positional parts: the words argparse wraps between, where only a bracketed
  // group stays whole.
  usage: [string[], string[]]
  sections: [string, Row[]][]
  actions: Action[]
  flags: Map<string, Action>
  // A required group of mutually exclusive options.
  exclusive?: Action[]
  parsers?: Record<string, Parser>
}
// An argument that looks like an option: its action (null when the parser has none), the option, and its =value.
type Found = [Action | null, string, string | null]

class Exit {
  code: number
  constructor(code: number) {
    this.code = code
  }
}

class ArgumentError extends Error {
  action: Action
  constructor(action: Action, message: string) {
    super(message)
    this.action = action
  }
}

function parser(prog: string, usage: [string[], string[]], sections: [string, Row[]][], actions: Action[], more: Partial<Parser> = {}): Parser {
  const flags = new Map<string, Action>()
  for (const action of actions) for (const flag of action.flags) flags.set(flag, action)
  return { prog, usage, sections, actions, flags, ...more }
}

const HELP: Action = { dest: 'help', flags: ['-h', '--help'], nargs: 0, kind: 'help' }
const HELP_ROW: Row = ['-h, --help', 'show this help message and exit', 0]
const PR: Action = { dest: 'pr', flags: ['--pr'], nargs: '+', kind: 'store', int: true }
const WAITING: Action = { dest: 'waiting', flags: ['--waiting'], nargs: 0, kind: 'true' }
const BUILD_HELP = 'merge the waiting pull requests into the local branch waffles-review'
const DONE_HELP = 'switch back and delete waffles-review'
const BUILD = parser(
  'review_branch.ts build',
  [['[-h]', '--repo', 'REPO', '(--pr PR [PR ...] | --waiting)'], []],
  [
    ['options', [HELP_ROW, ['--repo REPO', 'the main checkout', 0], ['--pr PR [PR ...]', 'the pull requests, in merge order', 0], ['--waiting', 'every ready pull request that asks you for a review', 0]]],
  ],
  [HELP, { dest: 'repo', flags: ['--repo'], nargs: 1, kind: 'store', required: true }, PR, WAITING],
  { exclusive: [PR, WAITING] },
)
const DONE = parser(
  'review_branch.ts done',
  [['[-h]', '--repo', 'REPO'], []],
  [['options', [HELP_ROW, ['--repo REPO', '', 0]]]],
  [HELP, { dest: 'repo', flags: ['--repo'], nargs: 1, kind: 'store', required: true }],
)
const TOP = parser(
  'review_branch.ts',
  [['[-h]'], ['{build,done}', '...']],
  [
    ['positional arguments', [['{build,done}', '', 0], ['build', BUILD_HELP, 1], ['done', DONE_HELP, 1]]],
    ['options', [HELP_ROW]],
  ],
  [HELP, { dest: 'command', flags: [], nargs: 'parser', kind: 'parsers', required: true, choices: ['build', 'done'] }],
  { parsers: { build: BUILD, done: DONE } },
)

function actionName(action: Action): string {
  return action.flags.length ? action.flags.join('/') : action.dest
}

function columns(): number {
  const env = pyInt(process.env.COLUMNS ?? '')
  if (env !== null && env > 0) return Number(env)
  return (process.stdout.isTTY && process.stdout.columns) || 80
}

// int(text): Python takes surrounding whitespace, a sign, leading zeros, and _ between digits.
function pyInt(text: string): bigint | null {
  const digits = strip(text)
  return /^[+-]?\d+(?:_\d+)*$/.test(digits) ? BigInt(digits.replace(/_/g, '')) : null
}

function usageText(p: Parser, width: number): string {
  const prefix = 'usage: '
  const [optional, positional] = p.usage
  const usage = [p.prog, ...optional, ...positional].join(' ')
  if (prefix.length + usage.length <= width) return prefix + usage
  const lines = (parts: string[], indent: string, first?: string): string[] => {
    const result: string[] = []
    let line: string[] = []
    let length = (first ?? indent).length - 1
    for (const part of parts) {
      if (length + 1 + part.length > width && line.length) {
        result.push(indent + line.join(' '))
        line = []
        length = indent.length - 1
      }
      line.push(part)
      length += part.length + 1
    }
    if (line.length) result.push(indent + line.join(' '))
    if (first !== undefined) result[0] = result[0].slice(indent.length)
    return result
  }
  let result: string[]
  if (prefix.length + p.prog.length <= 0.75 * width) {
    const indent = ' '.repeat(prefix.length + p.prog.length + 1)
    if (optional.length) result = [...lines([p.prog, ...optional], indent, prefix), ...lines(positional, indent)]
    else if (positional.length) result = lines([p.prog, ...positional], indent, prefix)
    else result = [p.prog]
  } else {
    const indent = ' '.repeat(prefix.length)
    result = lines([...optional, ...positional], indent)
    if (result.length > 1) result = [...lines(optional, indent), ...lines(positional, indent)]
    result = [p.prog, ...result]
  }
  return prefix + result.join('\n')
}

function helpText(p: Parser, width: number): string {
  const most = Math.min(24, Math.max(width - 20, 4))
  // argparse measures every invocation at the section's indent, also the subcommands it shows deeper.
  const longest = Math.max(...p.sections.flatMap(([, rows]) => rows.map(([invocation]) => invocation.length + 2)))
  const position = Math.min(longest + 2, most)
  let text = `${usageText(p, width)}\n\n`
  for (const [heading, rows] of p.sections) {
    text += `\n${heading}:\n`
    for (const [invocation, help, depth] of rows) {
      const indent = 2 + 2 * depth
      const room = position - indent - 2
      text += ' '.repeat(indent)
      if (!help) {
        text += `${invocation}\n`
        continue
      }
      let first = 0
      if (invocation.length <= room) text += `${invocation.padEnd(room)}  `
      else {
        text += `${invocation}\n`
        first = position
      }
      const lines = wrap(help, Math.max(width - position, 11))
      text += `${' '.repeat(first)}${lines[0]}\n`
      for (const line of lines.slice(1)) text += `${' '.repeat(position)}${line}\n`
    }
    text += '\n'
  }
  return `${text.replace(/\n\n\n+/g, '\n\n').replace(/^\n+|\n+$/g, '')}\n`
}

// textwrap.wrap, for help texts of plain words: a word breaks after a hyphen between letters, as textwrap breaks it.
const HYPHEN = /(?<=[\p{L}_]{2}-|[\p{L}_]-[\p{L}_]-)(?=[\p{L}_]-?[\p{L}_])/u
function wrap(text: string, width: number): string[] {
  const chunks = text.split(/( )/).flatMap((word) => (word === ' ' ? [word] : word.split(HYPHEN))).filter(Boolean).reverse()
  const lines: string[] = []
  while (chunks.length) {
    const line: string[] = []
    let length = 0
    if (chunks[chunks.length - 1] === ' ' && lines.length) chunks.pop()
    while (chunks.length && length + chunks[chunks.length - 1].length <= width) {
      length += chunks[chunks.length - 1].length
      line.push(chunks.pop() as string)
    }
    if (chunks.length && chunks[chunks.length - 1].length > width) {
      const chunk = chunks[chunks.length - 1]
      const room = width < 1 ? 1 : width - length
      let end = room
      const hyphen = chunk.lastIndexOf('-', room - 1)
      if (hyphen > 0 && /[^-]/.test(chunk.slice(0, hyphen))) end = hyphen + 1
      line.push(chunk.slice(0, end))
      chunks[chunks.length - 1] = chunk.slice(end)
    }
    if (line.length && line[line.length - 1] === ' ') line.pop()
    if (line.length) lines.push(line.join(''))
  }
  return lines
}

function fail(p: Parser, message: string): never {
  process.stderr.write(`${usageText(p, columns() - 2)}\n${p.prog}: error: ${message}\n`)
  throw new Exit(2)
}

function parseArgs(p: Parser, args: string[]): Record<string, unknown> {
  const [namespace, extras] = parseKnownArgs(p, args)
  if (extras.length) fail(p, `unrecognized arguments: ${extras.join(' ')}`)
  return namespace
}

function parseKnownArgs(p: Parser, args: string[]): [Record<string, unknown>, string[]] {
  const namespace: Record<string, unknown> = {}
  for (const action of p.actions) if (action.kind !== 'help') namespace[action.dest] = action.kind === 'true' ? false : null
  // A subcommand's parser leaves the arguments it does not know to its parent, which reports them.
  const unknown: string[] = []
  let extras: string[]
  try {
    extras = parseKnown(p, args, namespace, unknown)
  } catch (error) {
    if (error instanceof ArgumentError) fail(p, `argument ${actionName(error.action)}: ${error.message}`)
    throw error
  }
  return [namespace, [...extras, ...unknown]]
}

function parseOptional(p: Parser, arg: string): Found | null {
  if (!arg || arg[0] !== '-') return null
  const exact = p.flags.get(arg)
  if (exact) return [exact, arg, null]
  if (arg.length === 1) return null
  const equals = arg.indexOf('=')
  if (equals >= 0) {
    const known = p.flags.get(arg.slice(0, equals))
    if (known) return [known, arg.slice(0, equals), arg.slice(equals + 1)]
  }
  // An abbreviation of an option, or a short option with its value attached.
  const found: Found[] = []
  if (arg[1] === '-') {
    const prefix = equals >= 0 ? arg.slice(0, equals) : arg
    for (const [flag, action] of p.flags) if (flag.startsWith(prefix)) found.push([action, flag, equals >= 0 ? arg.slice(equals + 1) : null])
  } else {
    for (const [flag, action] of p.flags) {
      if (flag === arg.slice(0, 2)) found.push([action, flag, arg.slice(2)])
      else if (flag.startsWith(arg)) found.push([action, flag, null])
    }
  }
  if (found.length > 1) fail(p, `ambiguous option: ${arg} could match ${found.map(([, flag]) => flag).join(', ')}`)
  if (found.length === 1) return found[0]
  // Python's $ also matches before a final newline, and its \d takes any decimal digit.
  if (/^-\p{Nd}+\n?$|^-\p{Nd}*\.\p{Nd}+\n?$/u.test(arg) || arg.includes(' ')) return null
  return [null, arg, null]
}

function nargsPattern(action: Action): string {
  if (action.flags.length) return { 0: '()', 1: '(A)', '+': '(A[A]*)', parser: '(A[AO]*)' }[action.nargs]
  return { 0: '(-*-*)', 1: '(-*A-*)', '+': '(-*A[A-]*)', parser: '(-*A[-AO]*)' }[action.nargs]
}

function matchArgument(action: Action, pattern: string): number {
  const match = new RegExp(`^${nargsPattern(action)}`).exec(pattern)
  if (!match) throw new ArgumentError(action, action.nargs === '+' ? 'expected at least one argument' : 'expected one argument')
  return match[1].length
}

function convert(action: Action, text: string): string | bigint {
  if (!action.int) return text
  const value = pyInt(text)
  if (value === null) throw new ArgumentError(action, `invalid int value: ${repr(text)}`)
  return value
}

function check(action: Action, value: string | bigint): void {
  if (action.choices && !action.choices.includes(value as string)) {
    throw new ArgumentError(action, `invalid choice: ${typeof value === 'string' ? repr(value) : value} (choose from ${action.choices.map(repr).join(', ')})`)
  }
}

// Returns the arguments that fit no action; a subcommand's go to unknown.
function parseKnown(p: Parser, args: string[], namespace: Record<string, unknown>, unknown: string[]): string[] {
  const options = new Map<number, Found>()
  let pattern = ''
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      pattern += `-${'A'.repeat(args.length - i - 1)}`
      break
    }
    const found = parseOptional(p, args[i])
    if (found) options.set(i, found)
    pattern += found ? 'O' : 'A'
  }
  const seen = new Set<Action>()
  const extras: string[] = []

  const take = (action: Action, strings: string[]) => {
    seen.add(action)
    if (action.nargs !== 'parser') {
      const dash = strings.indexOf('--')
      if (dash >= 0) strings = [...strings.slice(0, dash), ...strings.slice(dash + 1)]
    }
    let value: string | bigint | (string | bigint)[]
    if (strings.length === 1 && action.nargs === 1) {
      value = convert(action, strings[0])
      check(action, value)
    } else {
      value = strings.map((text) => convert(action, text))
      if (action.nargs === 'parser') check(action, value[0])
      else for (const item of value) check(action, item)
    }
    // Every value argparse takes here differs from its action's default, so each one counts against the others in its group.
    for (const other of p.exclusive?.includes(action) ? p.exclusive : []) {
      if (other !== action && seen.has(other)) throw new ArgumentError(action, `not allowed with argument ${actionName(other)}`)
    }
    if (action.kind === 'help') {
      process.stdout.write(helpText(p, columns() - 2))
      throw new Exit(0)
    }
    if (action.kind === 'true') namespace[action.dest] = true
    else if (action.kind === 'parsers') {
      const [name, ...rest] = value as string[]
      namespace[action.dest] = name
      const [sub, more] = parseKnownArgs((p.parsers as Record<string, Parser>)[name], rest)
      Object.assign(namespace, sub)
      unknown.push(...more)
    } else namespace[action.dest] = value
  }

  const consumeOptional = (start: number): number => {
    let [action, flag, explicit] = options.get(start) as Found
    const taken: [Action, string[]][] = []
    let stop: number
    for (;;) {
      if (!action) {
        extras.push(args[start])
        return start + 1
      }
      if (explicit !== null) {
        const count = matchArgument(action, 'A')
        if (count === 0 && flag[1] !== '-' && explicit !== '') {
          // -hx reads as -h -x.
          taken.push([action, []])
          flag = flag[0] + explicit[0]
          const next = p.flags.get(flag)
          if (!next) throw new ArgumentError(action, `ignored explicit argument ${repr(explicit)}`)
          action = next
          explicit = explicit.slice(1) || null
        } else if (count === 1) {
          stop = start + 1
          taken.push([action, [explicit]])
          break
        } else throw new ArgumentError(action, `ignored explicit argument ${repr(explicit)}`)
      } else {
        const begin = start + 1
        stop = begin + matchArgument(action, pattern.slice(begin))
        taken.push([action, args.slice(begin, stop)])
        break
      }
    }
    for (const [each, strings] of taken) take(each, strings)
    return stop
  }

  let positionals = p.actions.filter((action) => !action.flags.length)
  const consumePositionals = (start: number): number => {
    let counts: number[] = []
    for (let i = positionals.length; i > 0; i--) {
      const match = new RegExp(`^${positionals.slice(0, i).map(nargsPattern).join('')}`).exec(pattern.slice(start))
      if (match) {
        counts = match.slice(1).map((group) => group.length)
        break
      }
    }
    counts.forEach((count, i) => {
      take(positionals[i], args.slice(start, start + count))
      start += count
    })
    positionals = positionals.slice(counts.length)
    return start
  }

  let start = 0
  const last = options.size ? Math.max(...options.keys()) : -1
  while (start <= last) {
    const next = Math.min(...[...options.keys()].filter((index) => index >= start))
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
  extras.push(...args.slice(consumePositionals(start)))

  const missing = p.actions.filter((action) => action.required && !seen.has(action)).map(actionName)
  if (missing.length) fail(p, `the following arguments are required: ${missing.join(', ')}`)
  if (p.exclusive && !p.exclusive.some((action) => seen.has(action))) {
    fail(p, `one of the arguments ${p.exclusive.map(actionName).join(' ')} is required`)
  }
  return extras
}

// repr() of a string, as argparse quotes a value in its errors.
function repr(text: string): string {
  const mark = text.includes("'") && !text.includes('"') ? '"' : "'"
  let result = mark
  for (const c of text) {
    const code = c.codePointAt(0) as number
    if (c === mark || c === '\\') result += `\\${c}`
    else if (c === '\t') result += '\\t'
    else if (c === '\n') result += '\\n'
    else if (c === '\r') result += '\\r'
    else if (code < 0x20 || code === 0x7f) result += `\\x${code.toString(16).padStart(2, '0')}`
    else if (code > 0x7f && /[\p{C}\p{Z}]/u.test(c)) {
      result += code < 0x100 ? `\\x${code.toString(16).padStart(2, '0')}` : code < 0x10000 ? `\\u${code.toString(16).padStart(4, '0')}` : `\\U${code.toString(16).padStart(8, '0')}`
    } else result += c
  }
  return result + mark
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
