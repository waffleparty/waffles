import { notStarted } from './commands.ts'
import type { Host, RunResult } from './host.ts'
import { absolute } from './paths.ts'
import { dropPlan, mirrorPlan } from './plan-mirror.ts'
import { outlineIn, stateIn } from './plan-store.ts'
import { remoteName } from './settings.ts'
import type { CoreTool, Json } from './tools.ts'

/*
 * Renders the plan outline into its section of the pull request's description.
 *
 * Usage: node scripts/checkpoint.ts [--pr NUMBER] [--dry-run]. The hook in hooks/checkpoint.ts runs
 * the same checkpoint after a `git push` or a `gh pr create` that worked, and the `checkpoint` tool
 * (CHECKPOINT_TOOL, below) runs it on every platform.
 *
 * Run in a checkout. The checkpoint reads the plan outline from the checkout's plan folder,
 * <git dir>/waffles/plan/, and writes it as a checklist between the markers below, in the description
 * of the open pull request for the checked-out branch (or of --pr NUMBER, which must be for that
 * branch). It leaves the rest of the description as it is. Where the description has no markers yet,
 * the section takes the place of a "## Plan outline" section, or goes after the other sections, ahead
 * of the attribution lines at the end.
 *
 * When assumed-for-you.md is in the plan folder, the section ends with its list under "### Assumed for
 * you": the decisions an agent made in the person's place.
 *
 * The checklist says "Ahead of the branch" when the branch is not pushed or has commits that are not
 * pushed. The checkpoint never commits or pushes. A second run with nothing changed changes nothing.
 * --dry-run prints the new description instead of writing it.
 *
 * Exit codes: 0 when the description is up to date or there is nothing to do, 1 when git or gh
 * fails, 2 for bad arguments. What it did goes to stdout; why it failed goes to stderr.
 *
 * It reads text as Python's text mode did when this was a Python script: `\r\n` and a lone `\r` read
 * as `\n`, whitespace and digits are Unicode's, and names sort by code point. The text it prints is
 * the same, byte for byte.
 */

export const START = '<!-- waffles:plan-outline:start -->'
export const END = '<!-- waffles:plan-outline:end -->'
const HEADING = '## Plan outline'
// The record of decisions made for the person, beside the outline; rendered after the checklist, never read as a checklist.
const ASSUMED = 'assumed-for-you.md'
const ASSUMED_HEADING = '### Assumed for you'

/** The line printed for bad arguments, to stderr. */
export const USAGE = 'Usage: node checkpoint.ts [--pr NUMBER] [--dry-run]'

// Whitespace as Python's `str.strip` and `\s` see it: JavaScript's `\s` leaves out \x1c-\x1f and \x85, and adds ﻿.
const WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'

// A step of a goal file, as the plan tool writes it: indent, box, ID, kind marker, title.
const GOAL_STEP = new RegExp(`^( *)- \\[([ ~rx>-])\\] ([^${WS}]+) (?:([?⤷]) )?(.*)$`, 'su')
// Any Markdown task list item.
const TASK = new RegExp(`^([${WS}]*)[-*+] \\[([ xX])\\] (.*)$`, 'su')
const NOTE = / <!-- (?:(?!<!--).)* -->$/su
const LINK = new RegExp(`^(.*?) → ([^${WS}]+)$`, 'su')
const ESCAPED = /^\\+[?⤷](?: |$)/u
const STEP_ID = /^\p{Nd}+(?:\.\p{Nd}+)*\.?$/u
const LIST_LINE = new RegExp(`^[${WS}]*(?:[-*+]|\\p{Nd}+\\.) |^[${WS}]*>`, 'u')
const FOOTER = /^(?:Written by Claude(?![\p{L}\p{N}_])|🤖 Generated with |https:\/\/claude\.ai\/code\/)/u

// A pull request's number: ASCII digits only, since gh finds no pull request for another script's digits.
const DIGITS = /^[0-9]+$/

const LEADING = new RegExp(`^[${WS}]+`, 'u')
const TRAILING = new RegExp(`[${WS}]+$`, 'u')
const lstrip = (s: string) => s.replace(LEADING, '')
const rstrip = (s: string) => s.replace(TRAILING, '')
const strip = (s: string) => rstrip(lstrip(s))
// Text as a file or a command's output reads in text mode.
const universal = (s: string) => s.replace(/\r\n?/g, '\n')
const byCodePoint = (a: string, b: string) => {
  const [x, y] = [[...a], [...b]]
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!
    if (d) return d
  }
  return x.length - y.length
}
// A JSON value as Python's `str` writes it, for the values the messages name.
const str = (value: unknown) =>
  value === null || value === undefined ? 'None' : typeof value === 'boolean' ? (value ? 'True' : 'False') : typeof value === 'string' ? value : typeof value === 'number' ? String(value) : JSON.stringify(value)

/** A git or gh command that failed: the checkpoint prints its message and ends with 1. */
class Failure extends Error {}

/** A command whose stdout the platform cut: a failure, never an answer such as "no pull request". */
class Cut extends Failure {}

/** A command that could not start: a failure, never an answer such as "no pull request". */
class NotStarted extends Failure {}

/** The checkout the checkpoint runs in, and when its time runs out (ms since the epoch); null for no limit. */
type Checkout = { $: Host; folder: string; deadline: number | null }

/** The command's stdout; throws Failure with its stderr when it fails. */
async function run(c: Checkout, argv: string[], stdin?: string): Promise<string> {
  let timeoutMs: number | undefined
  if (c.deadline !== null) {
    timeoutMs = c.deadline - (await c.$.clock.now())
    if (timeoutMs <= 0) throw new Failure(`${argv[0]} could not run: the checkpoint ran out of time`)
  }
  let done: RunResult
  try {
    done = await c.$.process.run(argv, { cwd: c.folder, stdin, timeoutMs })
  } catch (error) {
    throw new NotStarted(notStarted(argv[0]!, error))
  }
  if (done.exitCode !== 0) throw new Failure(`${argv.slice(0, 3).join(' ')} failed: ${strip(universal(done.stderr)) || strip(universal(done.stdout))}`)
  // A description read in part would be written back in part.
  if (done.isTruncated) throw new Cut(`${argv.slice(0, 3).join(' ')} printed more than the platform passes on, so the checkpoint does not go on from a part of it`)
  return universal(done.stdout)
}

const git = (c: Checkout, ...args: string[]) => run(c, ['git', ...args])

async function tryGit(c: Checkout, ...args: string[]): Promise<string | null> {
  try {
    return await git(c, ...args)
  } catch (error) {
    if (error instanceof Failure) return null
    throw error
  }
}

// --- Reading the outline ---------------------------------------------------

/** An outline file: its name in the plan folder and its text. */
export type OutlineFile = [name: string, text: string]

/** (front matter, body lines) of a goal file, or (null, all lines) when it has no front matter. */
function splitFront(text: string): [Map<string, string> | null, string[]] {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  if (lines[0] === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i] !== '---') continue
      const front = new Map<string, string>()
      for (const line of lines.slice(1, i)) {
        const at = line.indexOf(': ')
        front.set(at < 0 ? line : line.slice(0, at), at < 0 ? '' : line.slice(at + 2))
      }
      const status = front.get('status')
      if (front.get('goal') && (status === 'open' || status === 'done')) return [front, lines.slice(i + 1)]
      break
    }
  }
  return [null, lines]
}

/** Whether a file that is not a goal file is a plain checklist: headings and task items only. */
function isChecklist(lines: string[]): boolean {
  const rows = lines.filter(line => strip(line))
  return rows.some(r => TASK.test(r)) && rows.every(r => TASK.test(r) || lstrip(r).startsWith('#'))
}

const STATES: Record<string, 'open' | 'done' | 'dropped' | 'deferred'> = { ' ': 'open', '~': 'open', r: 'open', x: 'done', '-': 'dropped', '>': 'deferred' }

/** The checklist lines of a goal file's steps. */
function goalItems(body: string[]): string[] {
  const items: string[] = []
  for (const line of body) {
    const m = GOAL_STEP.exec(line)
    if (!m) continue
    const [indent, box, stepId] = [m[1]!, m[2]!, m[3]!]
    let title = m[5]!.replace(NOTE, '')
    // The plan tool escapes a planned title that starts like a kind marker.
    if (ESCAPED.test(title)) title = title.slice(1)
    const state = STATES[box]!
    if (state === 'deferred') {
      const link = LINK.exec(title)
      title = link ? `${link[1]} (moved to the backlog: ${link[2]})` : `${title} (moved to the backlog)`
    } else if (state === 'dropped') {
      title = `~~${title}~~ (dropped)`
    }
    const mark = state === 'open' ? ' ' : 'x'
    items.push(`${indent}- [${mark}] ${stepId}. ${title}`)
  }
  return items
}

/** The task items of a plain checklist file, with each step ID written as `1.`. */
function checklistItems(lines: string[]): string[] {
  const items: string[] = []
  for (const line of lines) {
    const m = TASK.exec(line)
    if (!m) continue
    const [indent, box] = [m[1]!, m[2]!]
    let text = m[3]!
    const at = text.indexOf(' ')
    const [first, rest] = at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)]
    if (STEP_ID.test(first) && rest) text = `${first.replace(/\.+$/, '')}. ${rest}`
    const mark = box === 'x' || box === 'X' ? 'x' : ' '
    items.push(`${indent}- [${mark}] ${text}`)
  }
  return items
}

/** The lines of the "assumed for you" file without its headings, and without blank lines at either end. */
function assumedItems(text: string): string[] {
  const lines = text
    .replaceAll('\r\n', '\n')
    .split('\n')
    .filter(line => !line.startsWith('#'))
    .map(rstrip)
  while (lines.length && !strip(lines[0]!)) lines.shift()
  while (lines.length && !strip(lines.at(-1)!)) lines.pop()
  return lines
}

/**
 * The checklist for the outline files, sorted by name, then the "assumed for you" list when there is
 * one; null when no file is an outline.
 */
export function render(files: readonly OutlineFile[]): string[] | null {
  const goals: [string, string[]][] = []
  const plain: [string, string[]][] = []
  let assumed: string[] = []
  for (const [name, text] of files) {
    if (name === ASSUMED) {
      assumed = assumedItems(text)
      continue
    }
    const [front, body] = splitFront(text)
    if (front !== null) {
      goals.push([front.get('goal')!, goalItems(body)])
    } else if (isChecklist(body)) {
      const heading = body.find(line => line.startsWith('#'))
      const title = heading === undefined ? name.slice(0, -3) : strip(heading.replace(/^#+/, ''))
      plain.push([title, checklistItems(body)])
    }
  }
  // A plan document beside the goal files is not a checklist; goal files come first when both are there.
  const parts = goals.length ? goals : plain
  if (!parts.length) return null
  let lines: string[]
  if (parts.length === 1) {
    lines = [...parts[0]![1]]
  } else {
    lines = []
    for (const [title, items] of parts) lines.push(...(lines.length ? [''] : []), `### ${title}`, '', ...items)
  }
  if (assumed.length) lines.push('', ASSUMED_HEADING, '', ...assumed)
  return lines
}

const isOutlineName = (name: string) => name.endsWith('.md') && !name.startsWith('.')

/** The checkout's plan folder: `waffles/plan` in its git dir, as the plan outline keeps it. */
async function planFolder(c: Checkout): Promise<string> {
  return outlineIn(stateIn(strip(await git(c, 'rev-parse', '--path-format=absolute', '--git-dir')).replace(/\/+$/, '')))
}

/** The outline files in the plan folder, sorted by name; empty when there is no folder. */
async function outlineFiles(c: Checkout, folder: string): Promise<OutlineFile[]> {
  if (!(await isFolder(c.$, folder))) return []
  const files: OutlineFile[] = []
  const entries = (await c.$.fs.list(folder)).filter(entry => isOutlineName(entry.name))
  for (const entry of entries.sort((a, b) => byCodePoint(a.name, b.name))) {
    if (entry.kind === 'file') files.push([entry.name, universal(await c.$.fs.read(`${folder}/${entry.name}`))])
  }
  return files
}

// Whether a folder is at the path, through any link.
async function isFolder($: Host, path: string): Promise<boolean> {
  if (!(await $.fs.exists(path))) return false
  return $.fs.stat(path).then(
    stat => stat.kind === 'dir',
    () => false,
  )
}

// --- The state of the checkout --------------------------------------------

/** The "ahead of the branch" line, or null when every commit is pushed. */
async function aheadNote(c: Checkout, branch: string): Promise<string | null> {
  const upstream = await tryGit(c, 'rev-parse', '--verify', '-q', `refs/remotes/${await remoteName(c.$)}/${branch}`)
  let reason: string
  if (upstream === null) {
    reason = 'the branch is not pushed'
  } else {
    const count = Number(strip(await git(c, 'rev-list', '--count', `${strip(upstream)}..HEAD`)) || 0)
    if (!count) return null
    reason = `${count} commit${count !== 1 ? 's' : ''} not pushed`
  }
  return `> **Ahead of the branch:** this checklist includes work that is not on the branch yet (${reason}).`
}

// --- The description -------------------------------------------------------

/** The section's lines: the markers around the heading, the note, and the items. */
export function section(items: readonly string[], note: string | null): string[] {
  return [START, HEADING, '', ...(note ? [note, ''] : []), ...items, END]
}

/** The description with the section replaced, or added where it belongs. */
export function place(body: string, block: readonly string[]): string {
  const newline = body.includes('\r\n') ? '\r\n' : '\n'
  const lines = body ? body.split(newline) : []
  const start = lines.indexOf(START)
  const end = start >= 0 ? lines.indexOf(END, start) : -1
  if (end >= 0) {
    lines.splice(start, end - start + 1, ...block)
    return lines.join(newline)
  }
  const heading = lines.findIndex(line => strip(line).toLowerCase() === HEADING.toLowerCase())
  if (heading >= 0) {
    let end = heading + 1
    let last = heading
    while (end < lines.length && (!strip(lines[end]!) || LIST_LINE.test(lines[end]!))) {
      if (strip(lines[end]!)) last = end
      end += 1
    }
    lines.splice(heading, last - heading + 1, ...block)
    return lines.join(newline)
  }
  // After the other sections, ahead of the attribution lines at the end.
  let at = lines.length
  while (at > 0 && (!strip(lines[at - 1]!) || FOOTER.test(lines[at - 1]!))) at -= 1
  const footer = lines.slice(at).filter(line => strip(line))
  if (!footer.length) {
    at = lines.length
    while (at > 0 && !strip(lines[at - 1]!)) at -= 1
  }
  const head = lines.slice(0, at)
  const tail = lines.slice(at)
  const gapBefore = head.length ? [''] : []
  const gapAfter = tail.length && strip(tail[0]!) ? [''] : []
  return [...head, ...gapBefore, ...block, ...gapAfter, ...tail].join(newline)
}

// --- The checkpoint --------------------------------------------------------

export type CheckpointOptions = {
  /** The pull request's number, as typed (digits); without it, the open pull request for the checked-out branch. */
  pr?: string
  /** Print the new description instead of writing it. */
  isDryRun?: boolean
  /** How long (ms) all of the checkpoint's commands may take together; no limit without it. */
  timeoutMs?: number
}

/** The options the command line gives, or null for bad arguments. */
export function parseArgs(argv: readonly string[]): CheckpointOptions | null {
  const options: CheckpointOptions = {}
  const args = [...argv]
  while (args.length) {
    const arg = args.shift()!
    if (arg === '--dry-run') options.isDryRun = true
    else if (arg === '--pr' && args.length && DIGITS.test(args[0]!)) options.pr = args.shift()!
    else return null
  }
  return options
}

/**
 * Renders the plan outline into the pull request's description, for the checkout at `folder`. What it
 * prints and its exit code, as the command line has them; it never throws.
 */
export async function checkpoint($: Host, folder: string, options: CheckpointOptions = {}): Promise<RunResult> {
  const out = (line: string): RunResult => ({ exitCode: 0, stdout: `${line}\n`, stderr: '' })
  try {
    const c: Checkout = { $, folder, deadline: options.timeoutMs === undefined ? null : (await $.clock.now()) + options.timeoutMs }
    const { pr, isDryRun = false } = options
    try {
      const plan = await planFolder(c)
      const branch = strip(await git(c, 'rev-parse', '--abbrev-ref', 'HEAD'))
      let view: string
      try {
        view = await run(c, ['gh', 'pr', 'view', ...(pr ? [pr] : []), '--json', 'number,url,body,headRefName,state'])
      } catch (error) {
        if (!(error instanceof Failure) || error instanceof Cut || error instanceof NotStarted) throw error
        return out(`No pull request for ${pr ? `#${pr}` : `the branch ${branch}`}: nothing to update.`)
      }
      const info: unknown = JSON.parse(view)
      if (typeof info !== 'object' || info === null || Array.isArray(info)) throw new TypeError(`Not a JSON object: ${view}`)
      const get = (key: string) => (info as Record<string, unknown>)[key]
      // A key the messages name must be there.
      const number = () => {
        if (!('number' in info)) throw new TypeError('No "number" in the pull request.')
        return str(get('number'))
      }
      // A field gh left out says so, rather than reading as None.
      if (get('state') == null) return out(`gh gave no state for pull request #${number()}: nothing to update.`)
      if (get('state') !== 'OPEN') return out(`Pull request #${number()} is ${str(get('state')).toLowerCase()}: its checklist stays as it ended.`)
      if (get('headRefName') == null) return out(`gh gave no head branch for pull request #${number()}: nothing to update.`)
      if (get('headRefName') !== branch) return out(`Pull request #${number()} is for ${str(get('headRefName'))}, not ${branch}: nothing to update.`)
      const files = await outlineFiles(c, plan)
      if (!files.length) return out(`No plan outline in ${plan}: #${number()} stays as it is.`)
      const items = render(files)
      if (items === null) return out(`No checklist in ${plan}: #${number()} stays as it is.`)
      const note = await aheadNote(c, branch)
      const body = (get('body') || '') as string
      const next = place(body, section(items, note))
      if (isDryRun) return out(next)
      if (next === body) return out(`The plan outline in #${number()} is up to date.`)
      await run(c, ['gh', 'pr', 'edit', number(), '--body-file', '-'], next)
      // The description is written: a url that gh left out only shortens the line.
      const url = get('url')
      return out(`Updated the plan outline in #${number()}${note ? ' (ahead of the branch)' : ''}${url == null ? '.' : `: ${str(url)}`}`)
    } catch (error) {
      if (error instanceof Failure) return { exitCode: 1, stdout: '', stderr: `checkpoint: ${error.message}\n` }
      throw error
    }
  } catch (error) {
    // Anything else prints its stack after the line, as an error the script did not expect did.
    return { exitCode: 1, stdout: '', stderr: `checkpoint: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n` }
  }
}

// --- The tool ----------------------------------------------------------------

// All of a tool call's git and gh commands together: inside the 60 s that some MCP clients (Codex) give a tool call.
const TOOL_MS = 45_000

/** The tool's input as the checkpoint takes it; a string that tells what is wrong with it otherwise. */
export function checkpointInputOf(input: Json): (CheckpointOptions & { folder?: string }) | string {
  const { pr, dryRun, folder, ...extra } = input
  const unknown = Object.keys(extra)
  if (unknown.length) return `The checkpoint tool takes pr, dryRun, and folder, not ${unknown.join(', ')}.`
  // A model may send the number as a number; gh takes it as text.
  const number = typeof pr === 'number' && Number.isInteger(pr) && pr > 0 ? String(pr) : pr
  if (number !== undefined && (typeof number !== 'string' || !DIGITS.test(number))) return 'pr must be a pull request number, or left out.'
  if (dryRun !== undefined && typeof dryRun !== 'boolean') return 'dryRun must be true or false, or left out.'
  if (folder !== undefined && (typeof folder !== 'string' || !folder.trim())) return 'folder must be the path of a checkout, or left out.'
  return { ...(number === undefined ? {} : { pr: number }), ...(dryRun ? { isDryRun: true } : {}), ...(folder === undefined ? {} : { folder }) }
}

export const CHECKPOINT_TOOL: CoreTool = {
  name: 'checkpoint',
  title: 'Checkpoint',
  description:
    "Renders the plan outline into its section of a pull request's description: the open pull request for the checked-out branch of the checkout at folder (the session's folder when left out), or pull request pr, which must be for that branch. It leaves the rest of the description as it is, commits and pushes nothing, and a second call with nothing changed changes nothing. With dryRun, it answers with the new description and writes nothing. The answer is the checkpoint's line: what it did, or why there was nothing to do. A hook already runs it after a git push or gh pr create that worked; call it where no hook ran, or to see the description first.",
  inputSchema: {
    type: 'object',
    properties: {
      pr: { type: 'string', pattern: '^[0-9]+$', description: 'The pull request number. Left out: the open pull request for the checked-out branch.' },
      dryRun: { type: 'boolean', description: 'Answer with the new description, and write nothing.' },
      folder: { type: 'string', description: "The checkout, as an absolute path or one relative to the session's folder. Left out: the session's folder." },
    },
    additionalProperties: false,
  },
  annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  call: async ($, input) => {
    const parsed = checkpointInputOf(input)
    if (typeof parsed === 'string') return { refusal: parsed }
    const { folder, ...options } = parsed
    const done = await checkpoint($, absolute(await $.session.cwd(), folder ?? '.'), { ...options, timeoutMs: TOOL_MS })
    if (done.exitCode === 0) return { text: done.stdout.replace(/\n$/, '') }
    // The stack of an error the checkpoint did not expect goes to the log, and its first line to the model.
    const [line = '', ...stack] = done.stderr.trim().split('\n')
    if (stack.length) $.log(done.stderr)
    return { refusal: line }
  },
}

// --- After a shell command ---------------------------------------------------

// A cheap first look at a shell command; the checkpoint reads the checkout properly. A `git push`
// inside quoted text only costs a checkpoint that finds nothing.
const PUSH = /\bgit\s+(?:-C\s+\S+\s+)?push\b/
// Opening the pull request renders the checklist too: the first push found no pull request to update.
const CREATE = /\bgh\s+pr\s+create\b/
// A merge renders nothing: it removes the merged branch's copy of the plan outline from the remote.
const MERGE = /\bgh\s+pr\s+merge\b/
// The pull request a merge names by number; with none, gh merges the checked-out branch's.
const MERGE_NUMBER = /\bgh\s+pr\s+merge\s+([0-9]+)(?=\s|$)/
// A command that starts `cd <dir> &&`, or a `git -C <dir> push`, runs the push in that folder.
const CD = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*&&/
const DASH_C = /\bgit\s+-C\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s+push\b/

// All of a checkpoint's git and gh commands together: each one is given the time that is left.
const CHECKPOINT_MS = 60_000

/**
 * The folder a shell command runs its push in: the one its leading `cd` or `git -C` names, else
 * the shell's. `~` is the home folder. Null when that can't be told: a path that holds `$`, or `~` with no
 * home folder known.
 */
export function folderOf(command: string, cwd: string, isPush: boolean, home: string | undefined): string | null {
  const named = (isPush ? DASH_C.exec(command) : null) ?? CD.exec(command)
  const dir = named?.[1]?.replace(/^(["'])(.*)\1$/, '$2')
  if (!dir) return cwd
  if (dir.includes('$')) return null
  if (dir === '~' || dir.startsWith('~/')) return home ? `${home.replace(/\/+$/, '')}${dir.slice(1)}` : null
  if (dir.startsWith('/')) return dir
  return `${cwd.replace(/\/+$/, '')}/${dir}`
}

/** Whether a shell command, at a cheap look, pushes a branch or opens a pull request. */
export const isPushLike = (command: string) => PUSH.test(command) || CREATE.test(command)

/** Whether `afterShell` has work for a shell command, at a cheap look: a push, a new pull request, or a merge. */
export const isWatched = (command: string) => isPushLike(command) || MERGE.test(command)

/**
 * A shell command that pushed, opened a pull request, or merged one ended well. After a push or a new
 * pull request, the checkpoint renders the plan outline into the pull request's description, and the
 * plan outline's copy on the remote is brought up to date (plan-mirror.ts). After a merge, the merged
 * branch's copy is removed. Returns the lines the model reads, or null with nothing to say: another kind
 * of command, a folder that can't be told (a checkpoint of the wrong checkout could change another pull
 * request), or nothing printed and nothing failed. `cwd` is where the command ran.
 */
export async function afterShell($: Host, command: string, cwd?: string): Promise<string | null> {
  if (!isWatched(command)) return null
  const isPush = isPushLike(command)
  const home = await $.home().catch(() => undefined)
  const folder = folderOf(command, cwd ?? (await $.session.cwd()), isPush, home)
  if (folder === null) return null
  if (!isPush) return afterMerge($, folder, MERGE_NUMBER.exec(command)?.[1])
  const done = await checkpoint($, folder, { timeoutMs: CHECKPOINT_MS }).catch((error: unknown) => ({
    stdout: '',
    stderr: `checkpoint: did not run: ${error instanceof Error ? error.message : String(error)}`,
  }))
  // A failure's line, without the stack an error the checkpoint did not expect prints after it.
  const line = done.stdout.trim() || (done.stderr.trim().split('\n')[0] ?? '')
  const lines = [line ? `waffles checkpoint: ${line}` : null, await mirrorPlan($, folder)].filter(text => text !== null)
  return lines.length ? lines.join('\n') : null
}

// How long gh may take to say whether a merged pull request is merged.
const VIEW_MS = 30_000

/**
 * After a merge: when gh reports the pull request merged or closed, its head branch's copy of the plan
 * outline is removed from the remote and from the local repository. A pull request from another
 * repository has no copy here. The line the model reads when the removal fails; null otherwise.
 */
async function afterMerge($: Host, folder: string, pr: string | undefined): Promise<string | null> {
  const view = await $.process
    .run(['gh', 'pr', 'view', ...(pr ? [pr] : []), '--json', 'state,headRefName,isCrossRepository'], { cwd: folder, timeoutMs: VIEW_MS })
    .catch(() => null)
  if (view?.exitCode !== 0) return null
  let info: { state?: unknown; headRefName?: unknown; isCrossRepository?: unknown }
  try {
    info = JSON.parse(view.stdout) as typeof info
  } catch {
    return null
  }
  // A merge queue or --auto leaves it open: the copy stays until a merge that gh reports done.
  if (info?.state !== 'MERGED' && info?.state !== 'CLOSED') return null
  if (info.isCrossRepository !== false || typeof info.headRefName !== 'string' || !info.headRefName) return null
  return dropPlan($, folder, info.headRefName)
}
