import { appendFileSync, promises as fs, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nodeHost, sessionPath, stateFolder } from '../node/host.ts'
import { antigravity } from './antigravity.ts'
import { codex } from './codex.ts'
import { cursor } from './cursor.ts'
import { handle } from './neutral.ts'
import type { Platform } from './platform.ts'

// The command a platform's hook runs for each event: `node <plugin>/adapters/command/cli.ts <platform>
// <event>`. It reads the event's JSON from stdin, runs the core for it, and prints the platform's JSON
// answer. A hook must never stop the platform by failing, so any failure, and work that outlasts the
// event's budget, ends with exit 0 and nothing printed; with `WAFFLES_DEBUG` set, the failure goes to stderr.

const PLATFORMS: Record<string, Platform> = { antigravity, codex, cursor }

const debug = (message: string) => {
  if (process.env.WAFFLES_DEBUG) process.stderr.write(`waffles: ${message}\n`)
}

const describe = (error: unknown) => (error instanceof Error ? (error.stack ?? error.message) : String(error))

async function readStdin(): Promise<string> {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  return text
}

// Context a platform defers waits in a file beside the session's values, so their pruning removes it.
// Each block is one JSON line, added with an append: two events that defer at once both keep their
// blocks, and a take never makes blocks come back, since no defer reads the file and writes it again.
const deferredPath = (folder: string, sessionId: string) => sessionPath(folder, sessionId).replace(/\.json$/, '.context.jsonl')

/** Adds blocks to the session's deferred context; a block added twice is taken once. */
export async function defer(folder: string, sessionId: string, blocks: readonly string[]): Promise<void> {
  if (blocks.length === 0) return
  const path = deferredPath(folder, sessionId)
  await fs.mkdir(dirname(path), { recursive: true })
  // One write of every line, synchronous, so no take in this process runs between its open and its write.
  appendFileSync(path, blocks.map(block => `${JSON.stringify(block)}\n`).join(''))
}

// Takes in this process so far: each take's file has its own name, even beside another take of this process.
let takes = 0

/** The session's deferred context, taken: the file is renamed first, so two events never both take it. */
export async function takeDeferred(folder: string, sessionId: string): Promise<string[]> {
  const path = deferredPath(folder, sessionId)
  takes += 1
  const taken = `${path}.${process.pid}.${takes}.taken`
  if (!(await fs.rename(path, taken).then(() => true, () => false))) return []
  const blocks = await readBlocks(taken)
  await fs.rm(taken, { force: true })
  return [...new Set(blocks)]
}

// The blocks of a deferred context file, in the order added; a line that isn't a JSON string is left out.
async function readBlocks(path: string): Promise<string[]> {
  const text = await fs.readFile(path, 'utf8').catch(() => '')
  return text.split('\n').flatMap(line => {
    try {
      const block: unknown = JSON.parse(line)
      return typeof block === 'string' ? [block] : []
    } catch {
      return []
    }
  })
}

/** The text the hook prints for one event: empty to print nothing. */
async function answer(platformName: string | undefined, eventName: string | undefined, raw: string): Promise<string> {
  const platform = PLATFORMS[platformName ?? '']
  if (!platform || !eventName) throw new Error(`usage: cli.ts <${Object.keys(PLATFORMS).join('|')}> <event>`)
  const input: unknown = JSON.parse(raw)
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('the hook input is not a JSON object')
  const where = platform.session(input as Record<string, unknown>)
  const event = platform.event(eventName, input as Record<string, unknown>)
  if (where === null || event === null) return ''
  const folder = stateFolder()
  const notes: string[] = []
  const hasContext = platform.hasContext(eventName)
  const defers = !hasContext && (platform.defersContext?.(eventName) ?? false)
  const $ = nodeHost({
    sessionId: where.sessionId,
    cwd: where.cwd,
    names: platform.names,
    stateFolder: folder,
    parts: {
      // A mode change's note goes back as this event's context, where the platform reads any. A
      // deferred one is kept for later, but refused now: the model hasn't read it.
      conversation: {
        lastReply: async () => '',
        note: async text => {
          if (hasContext || defers) notes.push(text)
          return hasContext
        },
      },
      log: debug,
    },
  })
  const reply = await handle({ $, sessionId: where.sessionId, stateFolder: folder }, event, notes)
  if (defers && reply.context.length > 0) await defer(folder, where.sessionId, reply.context)
  // Deferred context goes first, at the first event since that reads any.
  const context = defers ? [] : hasContext && platform.defersContext ? [...(await takeDeferred(folder, where.sessionId)), ...reply.context] : reply.context
  const output = platform.output(eventName, { ...reply, context }, input as Record<string, unknown>)
  return output === null ? '' : JSON.stringify(output)
}

async function main() {
  const [platformName, eventName] = process.argv.slice(2)
  const budget = PLATFORMS[platformName ?? '']?.budgetMs(eventName ?? '') ?? 5_000
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<string>(resolve => {
    timer = setTimeout(() => {
      debug(`${platformName} ${eventName} took longer than ${budget} ms; it printed nothing`)
      resolve('')
    }, budget)
  })
  const text = await Promise.race([
    readStdin().then(raw => answer(platformName, eventName, raw)),
    late,
  ]).catch((error: unknown) => {
    debug(`${platformName} ${eventName} failed: ${describe(error)}`)
    return ''
  })
  clearTimeout(timer)
  // Exits at once: a git or gh run still going after the budget must not hold the platform's hook.
  if (text) process.stdout.write(`${text}\n`, () => process.exit(0))
  else process.exit(0)
}

// Run as a program, not imported by a test.
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) {
  process.on('uncaughtException', error => {
    debug(`uncaught: ${describe(error)}`)
    process.exit(0)
  })
  process.on('unhandledRejection', error => {
    debug(`unhandled: ${describe(error)}`)
    process.exit(0)
  })
  void main()
}
