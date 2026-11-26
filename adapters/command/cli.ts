import { nodeHost, stateFolder } from '../node/host.ts'
import { codex } from './codex.ts'
import { handle } from './neutral.ts'
import type { Platform } from './platform.ts'

// The command a platform's hook runs for each event: `node <plugin>/adapters/command/cli.ts <platform>
// <event>`. It reads the event's JSON from stdin, runs the core for it, and prints the platform's JSON
// answer. A hook must never stop the platform by failing, so any failure, and work that outlasts the
// event's budget, ends with exit 0 and nothing printed; with `WAFFLES_DEBUG` set, the failure goes to stderr.

const PLATFORMS: Record<string, Platform> = { codex }

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
  const $ = nodeHost({
    sessionId: where.sessionId,
    cwd: where.cwd,
    names: platform.names,
    stateFolder: folder,
    parts: {
      // A mode change's note goes back as this event's context, where the platform reads any.
      conversation: { lastReply: async () => '', note: async text => hasContext && notes.push(text) > 0 },
      log: debug,
    },
  })
  const output = platform.output(eventName, await handle({ $, sessionId: where.sessionId, stateFolder: folder }, event, notes))
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

process.on('uncaughtException', error => {
  debug(`uncaught: ${describe(error)}`)
  process.exit(0)
})
process.on('unhandledRejection', error => {
  debug(`unhandled: ${describe(error)}`)
  process.exit(0)
})

void main()
