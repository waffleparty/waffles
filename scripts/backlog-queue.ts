// Hold the backlog adapter calls that could not reach the tracker, for replay: core/backlog-queue.ts says how. The
// backlog_queue tool gives the same answers; this is for a person, and for a platform where the tool is missing.
//
// Usage:
//   node backlog-queue.ts add <step> <item> --why <cause> [--data JSON] [--backlog DIR]
//   node backlog-queue.ts list [--backlog DIR]
//   node backlog-queue.ts done <seq> [--id ID] [--backlog DIR]
//
// add prints the entry as 1 line of JSON; list prints the queued calls, oldest first, as a JSON array; done prints the
// lines that say what changed. Without --backlog, the folder is .backlog/ of the main checkout. Exit codes: 0 when it
// worked, 1 when the queue or an item file cannot be read or written, 2 for bad arguments (and for a done of a call
// that is not queued, or an --id that does not go with it).

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { nodeHost } from '../adapters/node/host.ts'
import { backlogQueue, type BacklogQueueInput, type DoneAnswer } from '../core/backlog-queue.ts'

// The queue reads no session value and names nothing to a model.
const NAMES = { assistant: 'Agent', product: 'waffles', planTool: 'plan', ask: 'question', planMode: null }

/** Bad arguments: exit code 2. */
class Usage extends Error {}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: { backlog: { type: 'string' }, why: { type: 'string' }, data: { type: 'string' }, id: { type: 'string' } },
    })
  } catch (error) {
    throw new Usage(messageOf(error))
  }
}

function inputOf(argv: string[]): BacklogQueueInput {
  const { values: args, positionals } = parse(argv)
  const at = args.backlog ? { backlog: args.backlog } : {}
  const [command, ...rest] = positionals
  if (command === 'add') {
    if (rest.length !== 2) throw new Usage('add takes <step> <item>')
    let data: unknown = {}
    if (args.data !== undefined) {
      try {
        data = JSON.parse(args.data)
      } catch (error) {
        throw new Usage(`--data is not JSON: ${messageOf(error)}`)
      }
      if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Usage('--data must be a JSON object')
    }
    return { op: 'add', step: rest[0]!, item: rest[1]!, ...(args.why === undefined ? {} : { why: args.why }), data: data as Record<string, unknown>, ...at }
  }
  if (command === 'list') {
    if (rest.length > 0) throw new Usage('list takes no arguments')
    return { op: 'list', ...at }
  }
  if (command === 'done') {
    if (rest.length !== 1 || !/^[0-9]+$/.test(rest[0]!)) throw new Usage('done takes the <seq> of a queued call')
    return { op: 'done', seq: Number(rest[0]), ...(args.id === undefined ? {} : { id: args.id }), ...at }
  }
  throw new Usage(command === undefined ? 'name a command: add, list, or done' : `unknown command ${JSON.stringify(command)}`)
}

export async function main(argv: string[], cwd: string = process.cwd()): Promise<number> {
  let input: BacklogQueueInput
  try {
    input = inputOf(argv)
  } catch (error) {
    process.stderr.write(`backlog-queue: ${messageOf(error)}\n`)
    return 2
  }
  const outcome = await backlogQueue(nodeHost({ sessionId: 'backlog-queue', cwd, names: NAMES }), input, (name) => `--${name}`)
  if ('refused' in outcome || 'failed' in outcome) {
    process.stderr.write(`backlog-queue: ${'refused' in outcome ? outcome.refused : outcome.failed}\n`)
    return 'refused' in outcome ? 2 : 1
  }
  const value = outcome.value
  if (input.op === 'add') process.stdout.write(`${JSON.stringify(value)}\n`)
  else if (input.op === 'list') process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  else process.stdout.write(`${(value as DoneAnswer).lines.join('\n')}\n`)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
