import { nodeHost } from '../adapters/node/host.ts'
import { checkpoint, parseArgs, USAGE } from '../core/checkpoint.ts'
import type { RunResult } from '../core/host.ts'

/*
 * Renders the plan outline into its section of the pull request's description: core/checkpoint.ts
 * says how. The checkpoint tool does the same; this is for a person, and for a platform where the
 * tool is missing.
 *
 * Usage: node scripts/checkpoint.ts [--pr NUMBER] [--dry-run]
 *
 * Run in a checkout. Exit codes: 0 when the description is up to date or there is nothing to do, 1
 * when git or gh fails, 2 for bad arguments. What it did goes to stdout; why it failed, and the
 * usage, go to stderr.
 */

// The checkpoint reads no session value and names nothing to a model.
const NAMES = { assistant: 'Agent', product: 'waffles', planTool: 'plan', ask: 'question', planMode: null }

/** What the command prints and its exit code, for the arguments, run in `cwd`. */
export async function main(argv: readonly string[], cwd: string = process.cwd()): Promise<RunResult> {
  const options = parseArgs(argv)
  if (options === null) return { exitCode: 2, stdout: '', stderr: `${USAGE}\n` }
  return checkpoint(nodeHost({ sessionId: 'checkpoint', cwd, names: NAMES }), cwd, options)
}

if (import.meta.main) {
  const done = await main(process.argv.slice(2))
  process.stdout.write(done.stdout)
  process.stderr.write(done.stderr)
  process.exitCode = done.exitCode
}
