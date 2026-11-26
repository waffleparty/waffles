// Hold the backlog adapter calls that could not reach the tracker, for replay.
//
// Usage:
//   node backlog-queue.ts add <step> <item> --why <cause> [--data JSON] [--backlog DIR]
//   node backlog-queue.ts list [--backlog DIR]
//   node backlog-queue.ts done <seq> [--id ID] [--backlog DIR]
//
// A repo that names a backlog adapter keeps its backlog in a tracker. When a write to it ends "unreachable", waffles
// queues the call here, in .backlog/queue.json, and replays the queue, in order, at the next adapter call that
// succeeds. The steps that write are raise, claim, ship, and note; pull only reads, so it is never queued.
//
// <item> is the tracker's ID of the item, or the file name of a .backlog/ item that has no ID yet. A raise names the
// file: the file holds the item, and stays until the raise is replayed.
//
//   add   queues 1 call, after every call already queued. --data holds the call's other inputs as a JSON object (the
//         actor of a raise, the event and URL of a ship, the text of a note). Prints the entry as 1 line of JSON.
//   list  prints the queued calls, oldest first, as a JSON array. Each names the item by its ID once a replayed raise
//         gave it one.
//   done  removes call <seq> once the adapter answered it: done, or refused. For a raise, --id is the item's new ID:
//         later calls for the file name that ID, and so does the depends: line of every other item file. The file is
//         deleted when its status is still new; a file that work already started on becomes <ID>.md, with an id:
//         line, as the work-loop's record of it. A raise done with no --id was refused: the later calls for its file
//         are removed with it. The queue file goes when it is empty.
//
// A call's <seq> is never used twice, so a done for a call that another session already replayed exits 2 and removes
// nothing. The script keeps the queue out of git with a line in the checkout's .git/info/exclude: the queue belongs
// to 1 machine. It never calls the tracker, and changes nothing but the queue file, that exclude line, its lock file
// (.backlog/.queue-lock, there only while a session holds it), and, at a raise's done, the item files. Exit codes: 0
// when it worked, 1 when the queue or an item file cannot be read or written, 2 for bad arguments.

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { lock, type Held } from './lock.ts'

const STEPS = ['raise', 'claim', 'ship', 'note']
const QUEUE = 'queue.json'
const EXCLUDES = ['/.backlog/queue.json', '/.backlog/.queue-*']
const STATUS = /^status:[ \t]*(\S*)/m
const DEPENDS = /^depends:.*$/m
// The lock file matches the second exclude line, so git never lists it.
const LOCK = '.queue-lock'
// A session holds the lock for 1 read and 1 write of the queue. One held this long is a pid that the system reused.
const LOCK_STALE_MS = 60_000

/** A queue or item file that cannot be read or written: exit code 1. */
class Failure extends Error {}

/** Bad arguments: exit code 2. */
class Usage extends Error {}

type Entry = { seq: number; step: string; item: string; data: Record<string, unknown>; why: string; at: string }

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isDir(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
}

function git(args: string[]): string | null {
  const done = spawnSync('git', args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] })
  return done.error || done.status !== 0 ? null : done.stdout
}

/** The main checkout's .backlog/: the first worktree that git lists, else the working directory. */
export function defaultBacklog(): string {
  const out = git(['worktree', 'list', '--porcelain']) ?? ''
  const main = out.split('\n').find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
  return join(main ?? process.cwd(), '.backlog')
}

function isFileName(item: string): boolean {
  return item.endsWith('.md')
}

function checkItem(item: string): void {
  if (!item || item.includes('/') || item.startsWith('.')) throw new Usage(`not an item ID or a .backlog/ file name: ${JSON.stringify(item)}`)
}

/** Runs body holding an exclusive lock on the backlog folder, so 2 sessions never write the queue at once. */
function locked<T>(backlog: string, body: () => T): T {
  let held: Held | null = null
  try {
    held = lock(join(backlog, LOCK), { staleMs: LOCK_STALE_MS })
  } catch (error) {
    // A folder that this process cannot write it cannot change either, and every write replaces the queue file in 1
    // rename, so a read needs no lock there. A write fails on its own, with the queue file's name.
    if (!['EACCES', 'EPERM', 'EROFS'].includes(code(error) ?? '')) throw new Failure(`cannot lock ${backlog}: ${message(error)}`)
  }
  try {
    return body()
  } finally {
    held?.release()
  }
}

function readQueue(backlog: string): Entry[] {
  const path = join(backlog, QUEUE)
  let entries: unknown
  try {
    entries = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (code(error) === 'ENOENT') return []
    throw new Failure(`cannot read ${path}: ${message(error)}`)
  }
  const valid = Array.isArray(entries) && entries.every((e: Partial<Entry> | null) =>
    Number.isInteger(e?.seq) && typeof e?.item === 'string' && STEPS.includes(e.step as string))
  if (!valid) throw new Failure(`${path} does not hold a list of queued calls`)
  return entries as Entry[]
}

/** Replaces the queue file in 1 rename, so a reader sees the old queue or the new one, never a part. */
function writeQueue(backlog: string, entries: Entry[]): void {
  const path = join(backlog, QUEUE)
  try {
    if (entries.length === 0) {
      if (existsSync(path)) unlinkSync(path)
      return
    }
    const tmp = join(backlog, `.queue-${randomBytes(6).toString('hex')}.json`)
    try {
      writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      renameSync(tmp, path)
    } catch (error) {
      if (existsSync(tmp)) unlinkSync(tmp)
      throw error
    }
  } catch (error) {
    throw new Failure(`cannot write ${path}: ${message(error)}`)
  }
}

/** Adds the queue to the checkout's .git/info/exclude. Outside git, or when that fails, it does nothing. */
function excludeFromGit(backlog: string): void {
  const parent = dirname(resolve(backlog))
  const common = git(['-C', parent, 'rev-parse', '--git-common-dir'])?.trim()
  if (!common) return
  try {
    const info = join(parent, common, 'info')
    const path = join(info, 'exclude')
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const have = new Set(text.split(/\r?\n/).map((line) => line.trim()))
    const missing = EXCLUDES.filter((line) => !have.has(line))
    if (missing.length > 0) {
      mkdirSync(info, { recursive: true })
      // A file that does not end in a newline would join its last line to the first one added.
      appendFileSync(path, (text && !text.endsWith('\n') ? '\n' : '') + missing.map((line) => `${line}\n`).join(''))
    }
  } catch {
    // The queue still works; git only lists it.
  }
}

function add(backlog: string, step: string, item: string, why: string | undefined, data: Record<string, unknown>): Entry {
  if (!STEPS.includes(step)) throw new Usage(`not a step that writes: ${JSON.stringify(step)}; use one of ${STEPS.join(', ')}`)
  checkItem(item)
  if (!why) throw new Usage('--why must say why the tracker could not be reached')
  if (step === 'raise' && !isFileName(item)) throw new Usage(`a raise names the .backlog/ file that holds the item, not ${JSON.stringify(item)}`)
  try {
    mkdirSync(backlog, { recursive: true })
  } catch (error) {
    throw new Failure(`cannot make ${backlog}: ${message(error)}`)
  }
  const entry = locked(backlog, () => {
    if (isFileName(item) && !isFile(join(backlog, item))) throw new Failure(`no item file ${join(backlog, item)}`)
    const entries = readQueue(backlog)
    // Milliseconds since the epoch, past every seq queued: a seq is never used twice, also once the queue was empty.
    const seq = Math.max(Date.now(), ...entries.map((e) => e.seq + 1))
    const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    const entry: Entry = { seq, step, item, data, why, at }
    entries.push(entry)
    writeQueue(backlog, entries)
    return entry
  })
  excludeFromGit(backlog)
  return entry
}

function pending(backlog: string): Entry[] {
  if (!isDir(backlog)) return []
  return locked(backlog, () => readQueue(backlog))
}

/** Removes call seq. Returns the lines that say what changed. */
function done(backlog: string, seq: number, newId: string | undefined): string[] {
  const gone = () => new Usage(`no queued call ${seq}: another session may have replayed it`)
  if (!isDir(backlog)) throw gone()
  return locked(backlog, () => {
    let entries = readQueue(backlog)
    const entry = entries.find((e) => e.seq === seq)
    if (entry === undefined) throw gone()
    const name = entry.item
    const isRaise = entry.step === 'raise' && isFileName(name)
    if (newId !== undefined) {
      checkItem(newId)
      if (isFileName(newId) || !isRaise) throw new Usage('--id goes with a raise of a .backlog/ file only, and names a tracker ID')
    }
    entries = entries.filter((e) => e !== entry)
    const lines = [`Removed queued call ${seq}: ${entry.step} ${name}.`]
    if (isRaise && newId === undefined) {
      // The raise was refused: the calls after it have no item to reach.
      for (const e of entries.filter((e) => e.item === name)) {
        lines.push(`Removed queued call ${e.seq}: ${e.step} ${name}, since ${name} was not raised.`)
      }
      entries = entries.filter((e) => e.item !== name)
    }
    if (newId !== undefined) {
      for (const e of entries) if (e.item === name) e.item = newId
    }
    // The queue first: a file deleted before a queue write that fails would leave a raise with no item.
    writeQueue(backlog, entries)
    if (newId !== undefined) {
      try {
        lines.push(...raised(backlog, name, newId))
      } catch (error) {
        // The queue holds the raise no longer, so a replay cannot raise it twice; the file can still be taken for a
        // local item and raised by hand.
        throw new Failure(
          `${message(error)}. ${name} is ${newId} in the tracker, and the queue no longer holds its raise: rename or ` +
            `delete ${join(backlog, name)} by hand, and check the tracker for a duplicate of ${newId} if the file was ` +
            'raised again',
        )
      }
    }
    return lines
  })
}

/** Escapes text for a pattern with the u flag, which refuses an escaped character that is not syntax. */
function escape(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

/** After a replayed raise: names the ID in other items' depends:, and deletes or renames the item file. */
function raised(backlog: string, name: string, newId: string): string[] {
  const lines: string[] = []
  // The name as a whole word: not a part of a longer file name.
  const word = '[\\p{L}\\p{N}_.-]'
  const mention = new RegExp(`(?<!${word})${escape(name)}(?!${word})`, 'gu')
  for (const other of readdirSync(backlog).sort()) {
    const path = join(backlog, other)
    if (other === name || !isFileName(other) || !isFile(path)) continue
    try {
      const text = readFileSync(path, 'utf8')
      const updated = text.replace(DEPENDS, (line) => line.replace(mention, () => newId))
      if (updated !== text) {
        writeFileSync(path, updated)
        lines.push(`${other} now depends on ${newId}.`)
      }
    } catch (error) {
      throw new Failure(`cannot update ${path}: ${message(error)}`)
    }
  }
  const path = join(backlog, name)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (code(error) === 'ENOENT') return [...lines, `${name} is ${newId} in the tracker.`]
    throw new Failure(`cannot read ${path}: ${message(error)}`)
  }
  const status = STATUS.exec(text)?.[1] ?? ''
  try {
    if (status === '' || status === 'new') {
      unlinkSync(path)
      lines.push(`${name} is ${newId} in the tracker; deleted ${path}.`)
    } else {
      const record = join(backlog, `${newId}.md`)
      if (existsSync(record)) return [...lines, `${name} is ${newId} in the tracker; kept ${path}, since ${record} exists.`]
      // The id line takes the line end of the header's first line, so a file with crlf line ends keeps them.
      writeFileSync(record, text.replace(/^---(\r?\n)/, (_, eol: string) => `---${eol}id: ${newId}${eol}`))
      unlinkSync(path)
      lines.push(`${name} is ${newId} in the tracker; its work goes on, so it is now ${record}.`)
    }
  } catch (error) {
    throw new Failure(`cannot update ${path}: ${message(error)}`)
  }
  const folder = path.slice(0, -'.md'.length)
  if (isDir(folder)) lines.push(`Kept ${folder}/: check that the tracker holds its files, then delete it.`)
  return lines
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: { backlog: { type: 'string' }, why: { type: 'string' }, data: { type: 'string' }, id: { type: 'string' } },
    })
  } catch (error) {
    throw new Usage(message(error))
  }
}

export function main(argv: string[]): number {
  try {
    const { values: args, positionals } = parse(argv)
    const backlog = args.backlog || defaultBacklog()
    const [command, ...rest] = positionals
    if (command === 'add') {
      if (rest.length !== 2) throw new Usage('add takes <step> <item>')
      let data: unknown = {}
      if (args.data !== undefined) {
        try {
          data = JSON.parse(args.data)
        } catch (error) {
          throw new Usage(`--data is not JSON: ${message(error)}`)
        }
        if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Usage('--data must be a JSON object')
      }
      process.stdout.write(`${JSON.stringify(add(backlog, rest[0]!, rest[1]!, args.why, data as Record<string, unknown>))}\n`)
    } else if (command === 'list') {
      if (rest.length > 0) throw new Usage('list takes no arguments')
      process.stdout.write(`${JSON.stringify(pending(backlog), null, 2)}\n`)
    } else if (command === 'done') {
      if (rest.length !== 1 || !/^[0-9]+$/.test(rest[0]!)) throw new Usage('done takes the <seq> of a queued call')
      process.stdout.write(`${done(backlog, Number(rest[0]), args.id).join('\n')}\n`)
    } else if (command === undefined) {
      throw new Usage('name a command: add, list, or done')
    } else {
      throw new Usage(`unknown command ${JSON.stringify(command)}`)
    }
  } catch (error) {
    process.stderr.write(`backlog-queue: ${message(error)}\n`)
    return error instanceof Usage ? 2 : 1
  }
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
