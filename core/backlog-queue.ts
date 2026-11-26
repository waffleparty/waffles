import { answerOf, deadlineIn, Failed, outcomeOf, Refused, run, type Outcome } from './commands.ts'
import type { Host } from './host.ts'
import { Busy, withLock } from './lock.ts'
import { absolute, dirname, join } from './paths.ts'
import type { CoreTool, Json } from './tools.ts'

/*
 * Holds the backlog adapter calls that could not reach the tracker, for replay. The `backlog_queue` tool runs it on
 * every platform, and scripts/backlog-queue.ts on the command line.
 *
 * A repo that names a backlog adapter keeps its backlog in a tracker. When a write to it ends "unreachable", waffles
 * queues the call here, in .backlog/queue.json, and replays the queue, in order, at the next adapter call that
 * succeeds. The steps that write are raise, claim, ship, and note; pull only reads, so it is never queued.
 *
 * The item is the tracker's ID of the item, or the file name of a .backlog/ item that has no ID yet. A raise names the
 * file: the file holds the item, and stays until the raise is replayed.
 *
 *   add   queues 1 call, after every call already queued. data holds the call's other inputs as a JSON object (the
 *         actor of a raise, the event and URL of a ship, the text of a note). The answer is the entry.
 *   list  the queued calls, oldest first. Each names the item by its ID once a replayed raise gave it one.
 *   done  removes call seq once the adapter answered it: done, or refused. For a raise, id is the item's new ID:
 *         later calls for the file name that ID, and so does the depends: line of every other item file. The file is
 *         deleted when its status is still new; a file that work already started on becomes <ID>.md, with an id:
 *         line, as the work-loop's record of it. A raise done with no id was refused: the later calls for its file
 *         are removed with it. The queue file goes when it is empty.
 *
 * A call's seq is never used twice, so a done for a call that another session already replayed is refused and removes
 * nothing. The queue stays out of git through a line in the checkout's .git/info/exclude: the queue belongs to 1
 * machine. It never calls the tracker, and changes nothing but the queue file, that exclude line, its lock file
 * (.backlog/.queue-lock, there only while a session holds it; core/lock.ts), and, at a raise's done, the item files.
 *
 * Every read and write of the queue holds the lock, so 2 sessions never write it at once. The Host has no rename, so
 * a write replaces the queue file's text in place, under the lock. A folder that can't be written takes no lock file,
 * and can't be changed either: there a list reads the queue without the lock, and add and done fail.
 *
 * The backlog folder is the one given (absolute, or from the session's folder), else .backlog/ of the main checkout:
 * the first worktree that git lists, else the session's folder. Each git command may take 10 s.
 */

const STEPS = ['raise', 'claim', 'ship', 'note']
const QUEUE = 'queue.json'
const EXCLUDES = ['/.backlog/queue.json', '/.backlog/.queue-*']
const STATUS = /^status:[ \t]*(\S*)/m
const DEPENDS = /^depends:.*$/m
// The lock file matches the second exclude line, so git never lists it.
const LOCK_FILE = '.queue-lock'
// A session holds the lock for 1 read and 1 write of the queue: one held 15 s was left by a session that ended.
const LOCKING = { staleMs: 15_000, waitMs: 20_000 }
const GIT_MS = 10_000

export type Entry = { seq: number; step: string; item: string; data: Record<string, unknown>; why: string; at: string }
export type BacklogQueueInput =
  | { op: 'add'; step: string; item: string; why?: string; data?: Record<string, unknown>; backlog?: string }
  | { op: 'list'; backlog?: string }
  | { op: 'done'; seq: number; id?: string; backlog?: string }
export type DoneAnswer = { removed: number[]; lines: string[] }
/** How a message names an input: the tool's name for it, or the command line's flag (`--why`). */
export type Spelling = (input: string) => string

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function kindOf($: Host, path: string): Promise<string | null> {
  if (!(await $.fs.exists(path))) return null
  return $.fs.stat(path).then(
    stat => stat.kind,
    () => null,
  )
}

const isDir = async ($: Host, path: string) => (await kindOf($, path)) === 'dir'
const isFile = async ($: Host, path: string) => (await kindOf($, path)) === 'file'

async function git($: Host, cwd: string, args: string[]): Promise<string | null> {
  try {
    const done = await run($, ['git', ...args], { cwd, timeoutMs: GIT_MS, deadline: await deadlineIn($, GIT_MS) })
    return done.exitCode === 0 ? done.stdout : null
  } catch {
    return null
  }
}

/** The main checkout's .backlog/: the first worktree that git lists, else the folder. */
export async function defaultBacklog($: Host, cwd: string): Promise<string> {
  const out = (await git($, cwd, ['worktree', 'list', '--porcelain'])) ?? ''
  const main = out.split('\n').find(line => line.startsWith('worktree '))?.slice('worktree '.length)
  return join(main ?? cwd, '.backlog')
}

const isFileName = (item: string) => item.endsWith('.md')

function checkItem(item: string): void {
  if (!item || item.includes('/') || item.startsWith('.')) throw new Refused(`not an item ID or a .backlog/ file name: ${JSON.stringify(item)}`)
}

/** Runs body holding the lock on the backlog folder, so 2 sessions never write the queue at once. */
async function locked<T>($: Host, backlog: string, isRead: boolean, body: () => Promise<T>): Promise<T> {
  let isStarted = false
  try {
    return await withLock($, join(backlog, LOCK_FILE), LOCKING, () => ((isStarted = true), body()))
  } catch (error) {
    if (isStarted) throw error
    if (error instanceof Busy) throw new Failed(`cannot lock ${backlog}: ${error.message}`)
    // The lock file could not be made: a folder that this session cannot write it cannot change either, so a read
    // needs no lock there. A change fails.
    if (!isRead) throw new Failed(`cannot lock ${backlog}: ${messageOf(error)}`)
    return body()
  }
}

async function readQueue($: Host, backlog: string): Promise<Entry[]> {
  const path = join(backlog, QUEUE)
  if (!(await $.fs.exists(path))) return []
  let entries: unknown
  try {
    entries = JSON.parse(await $.fs.read(path))
  } catch (error) {
    throw new Failed(`cannot read ${path}: ${messageOf(error)}`)
  }
  const valid =
    Array.isArray(entries) &&
    entries.every((e: Partial<Entry> | null) => Number.isInteger(e?.seq) && typeof e?.item === 'string' && STEPS.includes(e.step as string))
  if (!valid) throw new Failed(`${path} does not hold a list of queued calls`)
  return entries as Entry[]
}

async function writeQueue($: Host, backlog: string, entries: Entry[]): Promise<void> {
  const path = join(backlog, QUEUE)
  try {
    if (entries.length === 0) await $.fs.remove(path)
    else await $.fs.write(path, `${JSON.stringify(entries, null, 2)}\n`)
  } catch (error) {
    throw new Failed(`cannot write ${path}: ${messageOf(error)}`)
  }
}

/** Adds the queue to the checkout's .git/info/exclude. Outside git, or when that fails, it does nothing. */
async function excludeFromGit($: Host, backlog: string): Promise<void> {
  const parent = dirname(backlog)
  const common = (await git($, parent, ['rev-parse', '--git-common-dir']))?.trim()
  if (!common) return
  try {
    const path = join(absolute(parent, common), 'info', 'exclude')
    const text = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    const have = new Set(text.split(/\r?\n/).map(line => line.trim()))
    const missing = EXCLUDES.filter(line => !have.has(line))
    // A file that does not end in a newline would join its last line to the first one added.
    if (missing.length > 0) await $.fs.write(path, text + (text && !text.endsWith('\n') ? '\n' : '') + missing.map(line => `${line}\n`).join(''))
  } catch {
    // The queue still works; git only lists it.
  }
}

async function add($: Host, backlog: string, step: string, item: string, why: string | undefined, data: Record<string, unknown>, flag: Spelling): Promise<Entry> {
  if (!STEPS.includes(step)) throw new Refused(`not a step that writes: ${JSON.stringify(step)}; use one of ${STEPS.join(', ')}`)
  checkItem(item)
  if (!why) throw new Refused(`${flag('why')} must say why the tracker could not be reached`)
  if (step === 'raise' && !isFileName(item)) throw new Refused(`a raise names the .backlog/ file that holds the item, not ${JSON.stringify(item)}`)
  // The lock file's create makes the folder.
  const entry = await locked($, backlog, false, async () => {
    if (isFileName(item) && !(await isFile($, join(backlog, item)))) throw new Failed(`no item file ${join(backlog, item)}`)
    const entries = await readQueue($, backlog)
    const now = await $.clock.now()
    // Milliseconds since the epoch, past every seq queued: a seq is never used twice, also once the queue was empty.
    const seq = Math.max(now, ...entries.map(e => e.seq + 1))
    const at = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z')
    const entry: Entry = { seq, step, item, data, why, at }
    entries.push(entry)
    await writeQueue($, backlog, entries)
    return entry
  })
  await excludeFromGit($, backlog)
  return entry
}

async function pending($: Host, backlog: string): Promise<Entry[]> {
  if (!(await isDir($, backlog))) return []
  return locked($, backlog, true, () => readQueue($, backlog))
}

/** Removes call seq: the seqs removed, and the lines that say what changed. */
async function done($: Host, backlog: string, seq: number, newId: string | undefined, flag: Spelling): Promise<DoneAnswer> {
  const gone = () => new Refused(`no queued call ${seq}: another session may have replayed it`)
  if (!(await isDir($, backlog))) throw gone()
  return locked($, backlog, false, async () => {
    let entries = await readQueue($, backlog)
    const entry = entries.find(e => e.seq === seq)
    if (entry === undefined) throw gone()
    const name = entry.item
    const isRaise = entry.step === 'raise' && isFileName(name)
    if (newId !== undefined) {
      checkItem(newId)
      if (isFileName(newId) || !isRaise) throw new Refused(`${flag('id')} goes with a raise of a .backlog/ file only, and names a tracker ID`)
    }
    entries = entries.filter(e => e !== entry)
    const removed = [seq]
    const lines = [`Removed queued call ${seq}: ${entry.step} ${name}.`]
    if (isRaise && newId === undefined) {
      // The raise was refused: the calls after it have no item to reach.
      for (const e of entries.filter(e => e.item === name)) {
        removed.push(e.seq)
        lines.push(`Removed queued call ${e.seq}: ${e.step} ${name}, since ${name} was not raised.`)
      }
      entries = entries.filter(e => e.item !== name)
    }
    if (newId !== undefined) {
      for (const e of entries) if (e.item === name) e.item = newId
    }
    // The queue first: a file deleted before a queue write that fails would leave a raise with no item.
    await writeQueue($, backlog, entries)
    if (newId !== undefined) {
      try {
        lines.push(...(await raised($, backlog, name, newId)))
      } catch (error) {
        // The queue holds the raise no longer, so a replay cannot raise it twice; the file can still be taken for a
        // local item and raised by hand.
        throw new Failed(
          `${messageOf(error)}. ${name} is ${newId} in the tracker, and the queue no longer holds its raise: rename or ` +
            `delete ${join(backlog, name)} by hand, and check the tracker for a duplicate of ${newId} if the file was ` +
            'raised again',
        )
      }
    }
    return { removed, lines }
  })
}

/** Escapes text for a pattern with the u flag, which refuses an escaped character that is not syntax. */
function escape(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** After a replayed raise: names the ID in other items' depends:, and deletes or renames the item file. */
async function raised($: Host, backlog: string, name: string, newId: string): Promise<string[]> {
  const lines: string[] = []
  // The name as a whole word: not a part of a longer file name.
  const word = '[\\p{L}\\p{N}_.-]'
  const mention = new RegExp(`(?<!${word})${escape(name)}(?!${word})`, 'gu')
  for (const other of (await $.fs.list(backlog)).map(entry => entry.name).sort(byName)) {
    const path = join(backlog, other)
    if (other === name || !isFileName(other) || !(await isFile($, path))) continue
    try {
      const text = await $.fs.read(path)
      const updated = text.replace(DEPENDS, line => line.replace(mention, () => newId))
      if (updated !== text) {
        await $.fs.write(path, updated)
        lines.push(`${other} now depends on ${newId}.`)
      }
    } catch (error) {
      throw new Failed(`cannot update ${path}: ${messageOf(error)}`)
    }
  }
  const path = join(backlog, name)
  if (!(await $.fs.exists(path))) return [...lines, `${name} is ${newId} in the tracker.`]
  let text: string
  try {
    text = await $.fs.read(path)
  } catch (error) {
    throw new Failed(`cannot read ${path}: ${messageOf(error)}`)
  }
  const status = STATUS.exec(text)?.[1] ?? ''
  try {
    if (status === '' || status === 'new') {
      await $.fs.remove(path)
      lines.push(`${name} is ${newId} in the tracker; deleted ${path}.`)
    } else {
      const record = join(backlog, `${newId}.md`)
      if (await $.fs.exists(record)) return [...lines, `${name} is ${newId} in the tracker; kept ${path}, since ${record} exists.`]
      // The id line takes the line end of the header's first line, so a file with crlf line ends keeps them.
      await $.fs.write(record, text.replace(/^---(\r?\n)/, (_, eol: string) => `---${eol}id: ${newId}${eol}`))
      await $.fs.remove(path)
      lines.push(`${name} is ${newId} in the tracker; its work goes on, so it is now ${record}.`)
    }
  } catch (error) {
    throw new Failed(`cannot update ${path}: ${messageOf(error)}`)
  }
  const folder = path.slice(0, -'.md'.length)
  if (await isDir($, folder)) lines.push(`Kept ${folder}/: check that the tracker holds its files, then delete it.`)
  return lines
}

/** What a command answers: the entry it queued (add), the queued calls (list), or what it removed (done). */
export type Answer = Entry | Entry[] | DoneAnswer

/** Runs one queue command on the backlog folder the input names, or the main checkout's. */
export async function backlogQueue($: Host, input: BacklogQueueInput, flag: Spelling = name => name): Promise<Outcome<Answer>> {
  const cwd = await $.session.cwd()
  return outcomeOf<Answer>(async () => {
    const backlog = input.backlog ? absolute(cwd, input.backlog) : await defaultBacklog($, cwd)
    if (input.op === 'add') return add($, backlog, input.step, input.item, input.why, input.data ?? {}, flag)
    if (input.op === 'list') return pending($, backlog)
    return done($, backlog, input.seq, input.id, flag)
  })
}

const KEYS: Record<string, string[]> = { add: ['step', 'item', 'why', 'data'], list: [], done: ['seq', 'id'] }
const ALL = ['op', 'step', 'item', 'why', 'data', 'seq', 'id', 'backlog']

/** The input as the tool takes it; a string that tells what is wrong with it otherwise. */
export function inputOf(input: Json): BacklogQueueInput | string {
  const unknown = Object.keys(input).filter(key => !ALL.includes(key))
  if (unknown.length) return `The backlog_queue tool takes ${ALL.join(', ')}, not ${unknown.join(', ')}.`
  const { op, backlog, ...rest } = input
  if (op !== 'add' && op !== 'list' && op !== 'done') return 'op must be one of add, list, done.'
  const other = Object.keys(rest).filter(key => !KEYS[op]!.includes(key))
  if (other.length) return `op ${op} takes ${['op', ...KEYS[op]!, 'backlog'].join(', ')}, not ${other.join(', ')}.`
  if (backlog !== undefined && (typeof backlog !== 'string' || !backlog.trim())) return 'backlog must be the path of a .backlog/ folder, or left out.'
  const at = backlog === undefined ? {} : { backlog }
  if (op === 'list') return { op, ...at }
  if (op === 'done') {
    const seq = typeof rest.seq === 'string' && /^[0-9]+$/.test(rest.seq) ? Number(rest.seq) : rest.seq
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return 'seq must be the seq of a queued call.'
    if (rest.id !== undefined && typeof rest.id !== 'string') return 'id must be the tracker ID of a raised item, or left out.'
    return { op, seq, ...(rest.id === undefined ? {} : { id: rest.id }), ...at }
  }
  const { step, item, why, data } = rest
  if (typeof step !== 'string' || typeof item !== 'string') return 'add takes the step and the item.'
  if (why !== undefined && typeof why !== 'string') return 'why must say why the tracker could not be reached'
  if (data !== undefined && (data === null || typeof data !== 'object' || Array.isArray(data))) return 'data must be a JSON object'
  return { op, step, item, ...(why === undefined ? {} : { why }), ...(data === undefined ? {} : { data: data as Record<string, unknown> }), ...at }
}

const ENTRY = {
  type: 'object',
  required: ['seq', 'step', 'item', 'data', 'why', 'at'],
  properties: {
    seq: { type: 'integer', description: 'The call\'s number in the queue, which done takes.' },
    step: { type: 'string', enum: STEPS },
    item: { type: 'string', description: "The item's tracker ID, or its .backlog/ file name." },
    data: { type: 'object', description: "The call's other inputs." },
    why: { type: 'string', description: 'Why the tracker could not be reached.' },
    at: { type: 'string', description: 'When the call was queued (UTC, ISO 8601).' },
  },
}

export const BACKLOG_QUEUE_TOOL: CoreTool = {
  name: 'backlog_queue',
  title: 'Backlog queue',
  description:
    "Holds the backlog adapter calls that could not reach the tracker, in .backlog/queue.json of the main checkout, for replay in order at the next call that reaches it. op add queues 1 call (step raise, claim, ship, or note; the item's tracker ID, or for a raise its .backlog/ file name; why: the cause; data: the call's other inputs) and answers with its entry. op list answers with the queued calls, oldest first, as entries. op done removes call seq once the adapter answered it: for a raise the tracker gave an ID, pass id, which later calls and the other items' depends: then name, and the item file is deleted or becomes <id>.md; a raise done without id was refused, and the later calls for its file go with it. It never calls the tracker. backlog names another .backlog/ folder.",
  inputSchema: {
    type: 'object',
    required: ['op'],
    properties: {
      op: { type: 'string', enum: ['add', 'list', 'done'] },
      step: { type: 'string', enum: STEPS, description: 'add: the adapter step that did not reach the tracker.' },
      item: { type: 'string', description: "add: the item's tracker ID, or the .backlog/ file name of an item with no ID (always, for a raise)." },
      why: { type: 'string', description: 'add: why the tracker could not be reached, as the adapter said.' },
      data: { type: 'object', description: "add: the call's other inputs, such as {\"actor\": \"agent\"} or {\"text\": \"<note>\"}." },
      seq: { type: 'integer', minimum: 0, description: 'done: the seq of the queued call the adapter answered.' },
      id: { type: 'string', description: 'done, for a raise the tracker made: the new item ID.' },
      backlog: { type: 'string', description: "The .backlog/ folder, absolute or relative to the session's folder. Left out: the main checkout's." },
    },
    additionalProperties: false,
  },
  // One schema per op: an entry (add), the queued calls (list), or what done removed.
  outputSchema: {
    type: 'object',
    oneOf: [
      ENTRY,
      {
        type: 'object',
        required: ['entries'],
        properties: { entries: { type: 'array', items: ENTRY, description: 'The queued calls, oldest first.' } },
        additionalProperties: false,
      },
      {
        type: 'object',
        required: ['removed', 'lines'],
        properties: {
          removed: { type: 'array', items: { type: 'integer' }, description: 'The seqs removed.' },
          lines: { type: 'array', items: { type: 'string' }, description: 'What changed, one line each.' },
        },
        additionalProperties: false,
      },
    ],
  },
  annotations: { destructiveHint: false, openWorldHint: false },
  call: async ($, input) => {
    const parsed = inputOf(input)
    if (typeof parsed === 'string') return { refusal: parsed }
    const outcome = await backlogQueue($, parsed)
    // A structured answer is an object: the list goes under `entries`.
    return answerOf('value' in outcome && Array.isArray(outcome.value) ? { value: { entries: outcome.value } } : outcome)
  },
}
