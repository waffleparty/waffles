// Tell how a pull request merges (directly, or through its base branch's merge queue), and where it stands.
//
// Usage:
//   node merge_queue.ts mode PR [--repo OWNER/NAME]
//   node merge_queue.ts state PR [--repo OWNER/NAME]
//
// PR is a number, a URL, or a branch, as gh takes it.
//
// mode reads the rules that apply to the pull request's base branch (`gh api repos/<o>/<r>/rules/branches/<base>`). With
// a `merge_queue` rule, "merge" means "add to the queue": `gh pr merge <n>` (no merge method, no --auto), and the queue
// tests it on the newest base branch and merges it later, or removes it. GitHub adds it only when it has a valid
// approval: its review decision (`gh pr view --json reviewDecision`) is APPROVED, or empty when no review is required.
// Without one, GitHub refuses (also for an admin), and the command is the admin bypass, `gh pr merge <n> --admin` with
// the queue's merge method, which merges at once past the queue: a run uses it as its --admin rule says, and outside a
// run the pull request waits for a reviewer. Without a queue, it merges at once: `gh pr merge <n> --squash` with the
// subject and body passed. A plan with no rulesets (a private repo on GitHub's free plan) has no queue. Prints 1 line
// of JSON: queue (true or false), base, approved (with a queue), the review decision, the command, and why.
//
// state prints 1 line of JSON with "state" one of:
//   merged    the pull request is merged;
//   queued    it is in the merge queue ("position", and the entry's "entry" state);
//   waiting   auto-merge is on, and it joins the queue (or merges) once its checks pass;
//   removed   the queue removed it, and auto-merge is off ("reason", from GitHub): move the item back to in work, with
//             a note that gives the reason;
//   closed    it was closed without a merge;
//   open      none of these.
//
// Exit codes: 0 when gh answered; 1 when it did not, with its message; 2 for wrong arguments.
//
// This is a port of merge_queue.py. Its output, help, and argument errors match the Python's byte for byte, so the
// file also carries a small copy of Python's argparse and json.dumps; it stays self-contained, as the Python did.

import { spawnSync } from 'node:child_process'

const URL = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
const NO_RULESETS = 'Upgrade to GitHub Pro'
// A merge queue rule's merge_method, as a `gh pr merge` flag.
const METHODS: Record<string, string> = { MERGE: '--merge', SQUASH: '--squash', REBASE: '--rebase' }
const QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      merged
      isInMergeQueue
      mergeQueueEntry { state position }
      autoMergeRequest { enabledAt }
      timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes {
          __typename
          ... on RemovedFromMergeQueueEvent { createdAt reason }
          ... on AddedToMergeQueueEvent { createdAt }
        }
      }
    }
  }
}
`

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Dict = { [key: string]: Json }
type Out = { write(text: string): unknown }

class Failed extends Error {}

type Done = { status: number | null; stdout: string; stderr: string }

// Like Python's subprocess.run with capture_output and text: stdin stays the caller's, there is no output limit, and
// text mode turns \r\n and \r into \n. A program that cannot start throws, as Python's FileNotFoundError does, and so
// does an argument that is not a string (`mode -- --` leaves PR an empty list), as Python's TypeError does.
function run(argv: string[]): Done {
  const bad = argv.find((arg) => typeof arg !== 'string')
  if (bad !== undefined) throw new TypeError(`expected str, bytes or os.PathLike object, not ${Array.isArray(bad) ? 'list' : typeof bad}`)
  const done = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: Infinity })
  if (done.error) throw done.error
  const text = (s: string) => s.replace(/\r\n?/g, '\n')
  return { status: done.status, stdout: text(done.stdout), stderr: text(done.stderr) }
}

function gh(...args: string[]): string {
  const done = run(['gh', ...args])
  if (done.status !== 0) {
    throw new Failed(`gh ${args[0]} ${args.length > 1 ? args[1] : ''} failed: ${strip(done.stderr || done.stdout)}`)
  }
  return done.stdout
}

function pullRequest(selector: string, repo: string | null): [string, string, Json, Json, Json] {
  const flags = repo ? ['-R', repo] : []
  const view = JSON.parse(gh('pr', 'view', selector, ...flags, '--json', 'number,url,baseRefName,reviewDecision')) as Dict
  const match = URL.exec(view.url as string)
  if (!match) throw new Failed(`gh gave no GitHub URL for ${selector}: ${view.url}`)
  return [match[1], match[2], view.number, view.baseRefName, truthy(view.reviewDecision) ? view.reviewDecision : '']
}

export function mode(selector: string, repo: string | null): Dict {
  const [owner, name, number, base, review] = pullRequest(selector, repo)
  const branch = quote(String(base))
  const done = run(['gh', 'api', `repos/${owner}/${name}/rules/branches/${branch}`])
  let rules: Dict[]
  let why: string | null
  if (done.status !== 0 && (done.stdout + done.stderr).includes(NO_RULESETS)) {
    rules = []
    why = "the repo's plan has no rulesets, so its base branch has no merge queue"
  } else if (done.status !== 0) {
    throw new Failed(`gh api rules/branches/${base} failed: ${strip(done.stderr || done.stdout)}`)
  } else {
    rules = JSON.parse(done.stdout) as Dict[]
    why = null
  }
  const queue = rules.find((rule) => rule.type === 'merge_queue')
  if (queue && (review === 'APPROVED' || review === '')) {
    return {
      queue: true, base, approved: true, review: truthy(review) ? review : null, command: `gh pr merge ${number}`,
      why: `${base} has a merge queue, and the pull request has a valid approval or needs none: the command adds it to the queue once its checks pass, and the queue merges it later or removes it`,
    }
  }
  if (queue) {
    const method = (truthy(queue.parameters) ? (queue.parameters as Dict) : {}).merge_method
    const flag = typeof method === 'string' && Object.hasOwn(METHODS, method) ? METHODS[method] : '--squash'
    const message = flag === '--rebase' ? '' : ' --subject <subject> --body <digest>'
    return {
      queue: true, base, approved: false, review, command: `gh pr merge ${number} ${flag} --admin${message}`,
      why: `${base} has a merge queue, and the pull request has no valid approval (review decision ${review}), so GitHub refuses to add it to the queue, also for an admin: in a run, the command merges it at once past the queue, as the run's --admin rule says; outside a run, leave it for a reviewer, whose approval lets \`gh pr merge ${number}\` add it to the queue`,
    }
  }
  return {
    queue: false, base, command: `gh pr merge ${number} --squash --subject <subject> --body <digest>`,
    why: why ?? `${base} has no merge queue: the pull request merges at once`,
  }
}

export function state(selector: string, repo: string | null): Dict {
  const [owner, name, number] = pullRequest(selector, repo)
  const data = JSON.parse(gh('api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`, '-f', `query=${QUERY}`)) as Dict
  const pr = ((data.data as Dict).repository as Dict).pullRequest as Dict
  const events = (pr.timelineItems as Dict).nodes as Dict[]
  const last = events.length ? events[events.length - 1] : null
  if (truthy(pr.merged)) return { state: 'merged', number }
  if (truthy(pr.isInMergeQueue)) {
    const entry = truthy(pr.mergeQueueEntry) ? (pr.mergeQueueEntry as Dict) : {}
    return { state: 'queued', number, position: entry.position ?? null, entry: entry.state ?? null }
  }
  if (pr.state === 'CLOSED') return { state: 'closed', number }
  if (truthy(pr.autoMergeRequest)) return { state: 'waiting', number }
  if (last && last.__typename === 'RemovedFromMergeQueueEvent') {
    return { state: 'removed', number, reason: truthy(last.reason) ? last.reason : 'GitHub gave no reason', at: last.createdAt ?? null }
  }
  return { state: 'open', number }
}

export function main(argv: string[], out: Out = process.stdout): number {
  let args: Record<string, unknown>
  try {
    args = parseArgs(PARSER, argv)
  } catch (error) {
    if (error instanceof Exit) return error.code ? 2 : 0
    throw error
  }
  const pr = args.pr as string
  const repo = args.repo as string | null
  let result: Dict
  try {
    result = args.command === 'mode' ? mode(pr, repo) : state(pr, repo)
  } catch (error) {
    if (!(error instanceof Failed)) throw error
    out.write(`${error.message}\n`)
    return 1
  }
  out.write(`${dumps(result)}\n`)
  return 0
}

// Python's truth test, which the Python script applies to gh's JSON: an empty string, list, or object is false.
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

// urllib.parse.quote(text, safe=''): encodeURIComponent leaves !'()* as they are; Python escapes them.
function quote(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

// json.dumps with its defaults: ", " and ": " between items, and every character outside printable ASCII escaped.
function dumps(value: Json): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value).toString() : String(value)
  if (typeof value === 'string') return encode(value)
  if (Array.isArray(value)) return `[${value.map(dumps).join(', ')}]`
  return `{${Object.entries(value).map(([key, item]) => `${encode(key)}: ${dumps(item)}`).join(', ')}}`
}

const ESCAPES: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' }
function encode(text: string): string {
  return `"${text.replace(/["\\]|[^\x20-\x7e]/g, (c) => ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`
}

// The argument parser: a port of the parts of Python 3.12's argparse that this parser uses, so that help, usage, and
// every error read and exit as they did. Help and usage wrap to the terminal's width (COLUMNS, else stdout's, else 80).

type Action = {
  dest: string
  flags: string[]
  nargs: 0 | 1
  kind: 'help' | 'store'
  required?: boolean
  choices?: string[]
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

function parser(prog: string, usage: [string[], string[]], sections: [string, Row[]][], actions: Action[]): Parser {
  const flags = new Map<string, Action>()
  for (const action of actions) for (const flag of action.flags) flags.set(flag, action)
  return { prog, usage, sections, actions, flags }
}

const HELP: Action = { dest: 'help', flags: ['-h', '--help'], nargs: 0, kind: 'help' }
const PARSER = parser(
  'merge_queue.ts',
  [['[-h]', '[--repo REPO]'], ['{mode,state}', 'pr']],
  [
    ['positional arguments', [['{mode,state}', '', 0], ['pr', '', 0]]],
    ['options', [['-h, --help', 'show this help message and exit', 0], ['--repo REPO', 'OWNER/NAME, when PR is not a URL and the folder is not the repo', 0]]],
  ],
  [
    HELP,
    { dest: 'command', flags: [], nargs: 1, kind: 'store', required: true, choices: ['mode', 'state'] },
    { dest: 'pr', flags: [], nargs: 1, kind: 'store', required: true },
    { dest: 'repo', flags: ['--repo'], nargs: 1, kind: 'store' },
  ],
)

function actionName(action: Action): string {
  return action.flags.length ? action.flags.join('/') : action.dest
}

function columns(): number {
  const env = pyInt(process.env.COLUMNS ?? '')
  if (env !== null && env > 0) return env
  return (process.stdout.isTTY && process.stdout.columns) || 80
}

function pyInt(text: string): number | null {
  const digits = strip(text)
  return /^[+-]?\d+(?:_\d+)*$/.test(digits) ? Number(digits.replace(/_/g, '')) : null
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
  // argparse measures every invocation at the section's indent, also the ones it shows deeper.
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
  const namespace: Record<string, unknown> = {}
  for (const action of p.actions) if (action.kind !== 'help') namespace[action.dest] = null
  let extras: string[]
  try {
    extras = parseKnown(p, args, namespace)
  } catch (error) {
    if (error instanceof ArgumentError) fail(p, `argument ${actionName(error.action)}: ${error.message}`)
    throw error
  }
  if (extras.length) fail(p, `unrecognized arguments: ${extras.join(' ')}`)
  return namespace
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
  if (action.flags.length) return action.nargs === 0 ? '()' : '(A)'
  return '(-*A-*)'
}

function matchArgument(action: Action, pattern: string): number {
  const match = new RegExp(`^${nargsPattern(action)}`).exec(pattern)
  if (!match) throw new ArgumentError(action, 'expected one argument')
  return match[1].length
}

// Returns the arguments that fit no action.
function parseKnown(p: Parser, args: string[], namespace: Record<string, unknown>): string[] {
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
    const dash = strings.indexOf('--')
    if (dash >= 0) strings = [...strings.slice(0, dash), ...strings.slice(dash + 1)]
    const value = strings.length === 1 && action.nargs === 1 ? strings[0] : strings
    for (const item of typeof value === 'string' ? [value] : value) {
      if (action.choices && !action.choices.includes(item)) {
        throw new ArgumentError(action, `invalid choice: ${repr(item)} (choose from ${action.choices.map(repr).join(', ')})`)
      }
    }
    if (action.kind === 'help') {
      process.stdout.write(helpText(p, columns() - 2))
      throw new Exit(0)
    }
    namespace[action.dest] = value
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
