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
//         actor of a raise, the event and URL of a ship, the text of a note). Prints the entry.
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
//
// The output and the files are byte for byte what backlog_queue.py writes (./pycompat.ts keeps Python's JSON, repr,
// and error texts), so either version reads the other's queue.

import { spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, openSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { lock, type Held } from './lock.ts'
import {
  NOT_SPACE,
  PyException,
  ValueError,
  abspath,
  asInt,
  byCodePoint,
  decodeUtf8,
  dirname,
  dumps,
  exists,
  isErrno,
  isInt,
  isdir,
  isfile,
  join,
  loads,
  makedirs,
  osErrorText,
  osException,
  readText,
  repr,
  splitlines,
  str,
  strip,
  universalNewlines,
  type PyDict,
  type PyValue,
} from './pycompat.ts'

const STEPS = ['raise', 'claim', 'ship', 'note']
const QUEUE = 'queue.json'
const EXCLUDES = ['/.backlog/queue.json', '/.backlog/.queue-*']
const STATUS = new RegExp(`(?<=^|\\n)status:[ \\t]*(${NOT_SPACE}*)`, 'u')
const DEPENDS = /(?<=^|\n)depends:[^\n]*/
// The lock file matches the second exclude line, so git never lists it.
const LOCK = '.queue-lock'
// A session holds the lock for 1 read and 1 write of the queue. One held this long is a pid that the system reused.
const LOCK_STALE_MS = 60_000

/** A queue or item file that cannot be read or written: exit code 1. */
class Failure extends Error {}

/** Bad arguments: exit code 2. */
class Usage extends Error {}

type Entry = PyDict

/** Runs git with its output captured and stdin passed on, as subprocess.run(capture_output=True) does. */
function git(args: string[]) {
  return spawnSync('git', args, { stdio: ['inherit', 'pipe', 'pipe'] })
}

/** The main checkout's .backlog/: the first worktree that git lists, else the working directory. */
export function defaultBacklog(): string {
  let main: string | undefined
  const done = git(['worktree', 'list', '--porcelain'])
  if (!done.error && done.status === 0) {
    const out = universalNewlines(decodeUtf8(done.stdout))
    main = splitlines(out).find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
  }
  return join(main ?? process.cwd(), '.backlog')
}

function isFileName(item: string): boolean {
  return item.endsWith('.md')
}

function checkItem(item: string): void {
  if (!item || item.includes('/') || item.startsWith('.')) throw new Usage(`not an item ID or a .backlog/ file name: ${repr(item)}`)
}

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

/** Runs body holding an exclusive lock on the backlog folder, so 2 sessions never write the queue at once. */
function locked<T>(backlog: string, body: () => T): T {
  let held: Held | null = null
  try {
    held = lock(join(backlog, LOCK), { staleMs: LOCK_STALE_MS })
  } catch (error) {
    // A folder that this process cannot write it cannot change either, and every write replaces the queue file in 1
    // rename, so a read needs no lock there. A write fails on its own, with the queue file's name.
    if (!isErrno(error, 'EACCES', 'EPERM', 'EROFS')) throw osException(error, backlog)
  }
  try {
    return body()
  } finally {
    held?.release()
  }
}

function readQueue(backlog: string): Entry[] {
  const path = join(backlog, QUEUE)
  let entries: PyValue
  try {
    entries = loads(readText(path))
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return []
    if (isErrno(error)) throw new Failure(`cannot read ${path}: ${osErrorText(error)}`)
    if (error instanceof ValueError) throw new Failure(`cannot read ${path}: ${error.message}`)
    throw error
  }
  const valid = Array.isArray(entries) && entries.every((e) => {
    if (!(e instanceof Map)) return false
    const step = e.get('step')
    return isInt(e.get('seq')) && typeof e.get('item') === 'string' && typeof step === 'string' && STEPS.includes(step)
  })
  if (!valid) throw new Failure(`${path} does not hold a list of queued calls`)
  return entries as Entry[]
}

/** tempfile.mkstemp: a new file only this user can read, named like `.queue-k3x_9a2b.json`. */
function mkstemp(folder: string, prefix: string, suffix: string): [number, string] {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789_'
  for (let attempt = 0; ; attempt++) {
    const name = Array.from({ length: 8 }, () => chars[randomInt(chars.length)]).join('')
    const path = join(folder, `${prefix}${name}${suffix}`)
    try {
      return [openSync(path, 'wx', 0o600), path]
    } catch (error) {
      if (!isErrno(error, 'EEXIST') || attempt >= 10000) throw error
    }
  }
}

function writeQueue(backlog: string, entries: Entry[]): void {
  const path = join(backlog, QUEUE)
  try {
    if (entries.length === 0) {
      if (exists(path)) unlinkSync(path)
      return
    }
    const [fd, tmp] = mkstemp(backlog, '.queue-', '.json')
    try {
      try {
        writeSync(fd, `${dumps(entries, 2)}\n`)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, path)
    } catch (error) {
      unlinkSync(tmp)
      throw error
    }
  } catch (error) {
    if (isErrno(error)) throw new Failure(`cannot write ${path}: ${osErrorText(error)}`)
    throw error
  }
}

/** Adds the queue to the checkout's .git/info/exclude. Outside git, or when that fails, it does nothing. */
function excludeFromGit(backlog: string): void {
  try {
    const parent = dirname(abspath(backlog))
    const done = git(['-C', parent, 'rev-parse', '--git-common-dir'])
    if (done.error || done.status !== 0) return
    const out = strip(universalNewlines(decodeUtf8(done.stdout)))
    const info = join(parent, out, 'info')
    const path = join(info, 'exclude')
    const text = exists(path) ? readText(path) : ''
    const have = new Set(splitlines(text).map((line) => strip(line)))
    const missing = EXCLUDES.filter((line) => !have.has(line))
    if (missing.length > 0) {
      makedirs(info)
      // A file that does not end in a newline would join its last line to the first one added.
      appendFileSync(path, (text && !text.endsWith('\n') ? '\n' : '') + missing.map((line) => `${line}\n`).join(''))
    }
  } catch (error) {
    if (!isErrno(error)) throw error
  }
}

function add(backlog: string, step: string, item: string, why: string | null, data: PyValue): Entry {
  if (!STEPS.includes(step)) throw new Usage(`not a step that writes: ${repr(step)}; use one of ${STEPS.join(', ')}`)
  checkItem(item)
  if (!why) throw new Usage('--why must say why the tracker could not be reached')
  if (step === 'raise' && !isFileName(item)) throw new Usage(`a raise names the .backlog/ file that holds the item, not ${repr(item)}`)
  try {
    makedirs(backlog)
  } catch (error) {
    if (isErrno(error)) throw new Failure(`cannot make ${backlog}: ${osErrorText(error)}`)
    throw error
  }
  const entry = locked(backlog, () => {
    if (isFileName(item) && !isfile(join(backlog, item))) throw new Failure(`no item file ${join(backlog, item)}`)
    const entries = readQueue(backlog)
    // Milliseconds since the epoch, past every seq queued: a seq is never used twice, also once the queue was empty.
    let seq = BigInt(Date.now())
    for (const e of entries) {
      const next = asInt(e.get('seq') as bigint | boolean) + 1n
      if (next > seq) seq = next
    }
    const entry: Entry = new Map<string, PyValue>([['seq', seq], ['step', step], ['item', item], ['data', data], ['why', why], ['at', now()]])
    entries.push(entry)
    writeQueue(backlog, entries)
    return entry
  })
  excludeFromGit(backlog)
  return entry
}

function pending(backlog: string): Entry[] {
  if (!isdir(backlog)) return []
  return locked(backlog, () => readQueue(backlog))
}

/** Removes call seq. Returns the lines that say what changed. */
function done(backlog: string, seq: bigint, newId: string | null): string[] {
  if (!isdir(backlog)) throw new Usage(`no queued call ${seq}: another session may have replayed it`)
  return locked(backlog, () => {
    let entries = readQueue(backlog)
    const entry = entries.find((e) => asInt(e.get('seq') as bigint | boolean) === seq)
    if (entry === undefined) throw new Usage(`no queued call ${seq}: another session may have replayed it`)
    const name = entry.get('item') as string
    const isRaise = entry.get('step') === 'raise' && isFileName(name)
    if (newId !== null) {
      checkItem(newId)
      if (isFileName(newId) || !isRaise) throw new Usage('--id goes with a raise of a .backlog/ file only, and names a tracker ID')
    }
    entries = entries.filter((e) => e !== entry)
    const lines = [`Removed queued call ${seq}: ${str(entry.get('step')!)} ${name}.`]
    if (isRaise && newId === null) {
      // The raise was refused: the calls after it have no item to reach.
      const dropped = entries.filter((e) => e.get('item') === name)
      entries = entries.filter((e) => e.get('item') !== name)
      lines.push(...dropped.map((e) => `Removed queued call ${str(e.get('seq')!)}: ${str(e.get('step')!)} ${name}, since ${name} was not raised.`))
    }
    if (newId !== null) {
      for (const e of entries) if (e.get('item') === name) e.set('item', newId)
    }
    // The queue first: a file deleted before a queue write that fails would leave a raise with no item.
    writeQueue(backlog, entries)
    if (newId !== null) {
      try {
        lines.push(...raised(backlog, name, newId))
      } catch (error) {
        if (!(error instanceof Failure)) throw error
        // The queue holds the raise no longer, so a replay cannot raise it twice; the file can still be taken for a
        // local item and raised by hand.
        throw new Failure(
          `${error.message}. ${name} is ${newId} in the tracker, and the queue no longer holds its raise: rename or delete ` +
            `${join(backlog, name)} by hand, and check the tracker for a duplicate of ${newId} if the ` +
            'file was raised again',
        )
      }
    }
    return lines
  })
}

/**
 * The text that re.sub puts in for a replacement string: Python reads its backslash escapes. A tracker ID holds none,
 * but the port keeps what Python would do with one.
 */
function template(replacement: string): string {
  return replacement.replace(/\\(.?)/gs, (whole, c: string, at: number) => {
    const escapes: Record<string, string> = { '\\': '\\', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }
    if (c in escapes) return escapes[c]!
    if (c === '') throw new PyException('re.error', `bad escape (end of pattern) at position ${at}`)
    if (/[0-9g]/.test(c)) throw new PyException('re.error', `invalid group reference at position ${at + 1}`)
    if (/[A-Za-z]/.test(c)) throw new PyException('re.error', `bad escape \\${c} at position ${at}`)
    return whole
  })
}

/** re.escape for a JS pattern with the u flag, which refuses an escaped character that is not syntax. */
function escape(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

/** After a replayed raise: names the ID in other items' depends:, and deletes or renames the item file. */
function raised(backlog: string, name: string, newId: string): string[] {
  const lines: string[] = []
  // Python's \w: letters, digits, and the underscore of every script.
  const word = '[\\p{L}\\p{N}_.-]'
  const mention = new RegExp(`(?<!${word})${escape(name)}(?!${word})`, 'gu')
  for (const other of readdirSync(backlog).sort(byCodePoint)) {
    const path = join(backlog, other)
    if (other === name || !isFileName(other) || !isfile(path)) continue
    try {
      const text = readText(path)
      // re.sub reads its replacement before it looks for a match, so an ID that it refuses fails at any depends: line.
      const updated = text.replace(DEPENDS, (line) => {
        const replacement = template(newId)
        return line.replace(mention, () => replacement)
      })
      if (updated !== text) {
        writeFileSync(path, updated)
        lines.push(`${other} now depends on ${newId}.`)
      }
    } catch (error) {
      if (isErrno(error)) throw new Failure(`cannot update ${path}: ${osErrorText(error)}`)
      throw error
    }
  }
  const path = join(backlog, name)
  let text: string
  try {
    text = readText(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [...lines, `${name} is ${newId} in the tracker.`]
    if (isErrno(error)) throw new Failure(`cannot read ${path}: ${osErrorText(error)}`)
    throw error
  }
  const status = STATUS.exec(text)
  try {
    if (status === null || status[1] === '' || status[1] === 'new') {
      unlinkSync(path)
      lines.push(`${name} is ${newId} in the tracker; deleted ${path}.`)
    } else {
      const record = join(backlog, `${newId}.md`)
      if (exists(record)) return [...lines, `${name} is ${newId} in the tracker; kept ${path}, since ${record} exists.`]
      const header = template(`---\nid: ${newId}\n`)
      writeFileSync(record, text.replace(/^---\n/, () => header))
      unlinkSync(path)
      lines.push(`${name} is ${newId} in the tracker; its work goes on, so it is now ${record}.`)
    }
  } catch (error) {
    if (isErrno(error)) throw new Failure(`cannot update ${path}: ${osErrorText(error)}`)
    throw error
  }
  const folder = path.slice(0, -'.md'.length)
  if (isdir(folder)) lines.push(`Kept ${folder}/: check that the tracker holds its files, then delete it.`)
  return lines
}

type Args = { backlog: string | null; why: string | null; data: string | null; id: string | null }

function parse(argv: string[]): [string[], Args] {
  const args: Args = { backlog: null, why: null, data: null, id: null }
  const positional: string[] = []
  for (let i = 0; i < argv.length;) {
    const arg = argv[i]!
    if (arg === '--backlog' || arg === '--why' || arg === '--data' || arg === '--id') {
      if (i + 1 >= argv.length) throw new Usage(`${arg} needs a value`)
      args[arg.slice(2) as keyof Args] = argv[i + 1]!
      i += 2
    } else if (arg.startsWith('--')) {
      throw new Usage(`unknown option ${arg}`)
    } else {
      positional.push(arg)
      i++
    }
  }
  if (positional.length === 0) throw new Usage('name a command: add, list, or done')
  return [positional, args]
}

export function main(argv: string[]): number {
  try {
    const [positional, args] = parse(argv)
    const backlog = args.backlog || defaultBacklog()
    const [command, ...rest] = positional as [string, ...string[]]
    if (command === 'add') {
      if (rest.length !== 2) throw new Usage('add takes <step> <item>')
      let data: PyValue = new Map()
      if (args.data !== null) {
        try {
          data = loads(args.data)
        } catch (error) {
          if (error instanceof ValueError) throw new Usage(`--data is not JSON: ${error.message}`)
          throw error
        }
        if (!(data instanceof Map)) throw new Usage('--data must be a JSON object')
      }
      process.stdout.write(`${dumps(add(backlog, rest[0]!, rest[1]!, args.why, data))}\n`)
    } else if (command === 'list') {
      if (rest.length > 0) throw new Usage('list takes no arguments')
      process.stdout.write(`${dumps(pending(backlog), 2)}\n`)
    } else if (command === 'done') {
      if (rest.length !== 1 || !/^[0-9]+$/.test(rest[0]!)) throw new Usage('done takes the <seq> of a queued call')
      process.stdout.write(`${done(backlog, BigInt(rest[0]!), args.id).join('\n')}\n`)
    } else {
      throw new Usage(`unknown command ${repr(command)}`)
    }
  } catch (error) {
    if (error instanceof Usage) {
      process.stderr.write(`backlog_queue: ${error.message}\n`)
      return 2
    }
    if (error instanceof Failure) {
      process.stderr.write(`backlog_queue: ${error.message}\n`)
      return 1
    }
    throw error
  }
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    // Where Python ends with a traceback, the port ends with its last line and the same exit code.
    const python = error instanceof PyException ? error : isErrno(error) ? osException(error) : null
    if (python === null) throw error
    process.stderr.write(`${python}\n`)
    process.exitCode = 1
  }
}
