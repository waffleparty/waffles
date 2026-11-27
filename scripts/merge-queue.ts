// Tell how a pull request merges (directly, or through its base branch's merge queue), and where it stands:
// core/merge-queue.ts says how. The merge_queue tool gives the same answers; this is for a person, and for a
// platform where the tool is missing.
//
// Usage:
//   node merge-queue.ts mode PR [--repo OWNER/NAME]
//   node merge-queue.ts state PR [--repo OWNER/NAME]
//
// PR is a number, a URL, or a branch, as gh takes it. --repo is needed when PR is not a URL and the folder is not the
// repo. Prints 1 line of JSON: the tool's answer.
//
// Exit codes: 0 when gh answered; 1 when it did not, with its message on stderr; 2 for wrong arguments.

import { parseArgs } from 'node:util'

import { nodeHost } from '../adapters/node/host.ts'
import { mergeQueue } from '../core/merge-queue.ts'

const USAGE = 'usage: node merge-queue.ts mode|state PR [--repo OWNER/NAME]'

// The merge queue reads no session value and names nothing to a model.
const NAMES = { assistant: 'Agent', product: 'waffles', planTool: 'plan', ask: 'question', planMode: null }

type Out = { write(text: string): unknown }

export async function main(argv: string[], out: Out = process.stdout, err: Out = process.stderr, cwd: string = process.cwd()): Promise<number> {
  let args
  try {
    args = parseArgs({ args: argv, allowPositionals: true, options: { repo: { type: 'string' }, help: { type: 'boolean', short: 'h' } } })
  } catch (error) {
    err.write(`${(error as Error).message} (${USAGE})\n`)
    return 2
  }
  if (args.values.help) {
    out.write(`${USAGE}\n`)
    return 0
  }
  const [op, pr, ...extra] = args.positionals
  if ((op !== 'mode' && op !== 'state') || pr === undefined || extra.length) {
    err.write(`expected mode or state, then 1 pull request (${USAGE})\n`)
    return 2
  }
  const $ = nodeHost({ sessionId: 'merge-queue', cwd, names: NAMES })
  const answer = await mergeQueue($, { op, pr, ...(args.values.repo === undefined ? {} : { repo: args.values.repo }) })
  if ('refusal' in answer) {
    err.write(`${answer.refusal}\n`)
    return 1
  }
  out.write(`${JSON.stringify(answer.value)}\n`)
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
