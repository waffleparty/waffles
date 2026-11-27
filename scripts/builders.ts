// Give each builder its own full clone of the repo, on its own branch, within the waffles limits; remove the clone
// once merged; and run a builder's tests within the machine's test slots.
//
// Usage:
//   node builders.ts clone --root DIR --repo DIR --item ID --branch NAME [--base BRANCH]
//   node builders.ts remove --root DIR --path DIR
//   node builders.ts limits --repo DIR [--cap N]
//   node builders.ts test-slot [--slots N] -- COMMAND...
//
// clone, remove, and limits: core/builders.ts says how, and the builders tool gives the same answers; this is for a
// person, and for a platform where the tool is missing. Each prints 1 line of JSON: the tool's answer.
//
// test-slot is the script's own, and no tool: it runs COMMAND (a test run, a linter, a type check) once one of the
// machine's test slots is free, and holds the slot until COMMAND ends, for minutes, longer than a tool call may take.
// The slots are lock files in $WAFFLES_TEST_SLOTS or /tmp/waffles-test-slots-<uid>, shared by every session of the
// user, 3 of them unless --slots or $WAFFLES_TEST_SLOT_COUNT says another count; a lock goes with its process, also when it is killed (./lock.ts). It exits with COMMAND's code.
//
// Exit codes: 0 when done; 3 when refused, with the reason on stderr; 1 when git or gh failed, with its message on
// stderr; 2 for wrong arguments, with the reason on stderr. test-slot exits with its command's code.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, realpathSync } from 'node:fs'
import { constants, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { nodeHost } from '../adapters/node/host.ts'
import { builders, REVIEW_CAP, type BuildersInput } from '../core/builders.ts'
import { tryLock } from './lock.ts'

export { ownerRepo, REVIEW_CAP } from '../core/builders.ts'

// Builders running tests at once on this machine. A test suite already spreads over several cores, so on a
// many-core workstation the runs finished per minute stop rising at about 3 at once: past that, another run at once
// only slows the others. --slots, else $WAFFLES_TEST_SLOT_COUNT, sets another count for another machine.
export const TEST_SLOTS = 3
const WAIT_MS = 1000

const USAGE = `Usage:
  node builders.ts clone --root DIR --repo DIR --item ID --branch NAME [--base BRANCH]
  node builders.ts remove --root DIR --path DIR
  node builders.ts limits --repo DIR [--cap N]
  node builders.ts test-slot [--slots N] -- COMMAND...`

// The builders read no session value and name nothing to a model.
const NAMES = { assistant: 'Agent', product: 'waffles', planTool: 'plan', ask: 'question', planMode: null }

/** Bad arguments: exit code 2. */
class Usage extends Error {}

/** Where the output goes: stdout, or a test's capture. done runs once what was written before it is out. */
export type Out = { write(text: string, done?: () => void): unknown }

/** The exit status, or minus the signal that ended the process. */
function exitCode(done: SpawnSyncReturns<unknown>): number {
  if (done.status !== null) return done.status
  return -((constants.signals as Record<string, number>)[done.signal ?? ''] ?? 0)
}

function slotsDir(): string {
  if (process.env['WAFFLES_TEST_SLOTS']) return process.env['WAFFLES_TEST_SLOTS']
  // Windows has no uid, and no /tmp: there the folder is in the user's temp folder, named for the user.
  if (process.getuid === undefined) return join(tmpdir(), `waffles-test-slots-${userInfo().username}`)
  return `/tmp/waffles-test-slots-${process.getuid()}`
}

function flush(out: Out): Promise<void> {
  return new Promise((resolve) => out.write('', () => resolve()))
}

/** Runs command holding 1 of the machine's test slots; waits for one while all are held. */
async function testSlot(slots: number, command: string[], out: Out): Promise<number> {
  const folder = slotsDir()
  mkdirSync(folder, { recursive: true })
  let said = false
  for (;;) {
    for (let n = 0; n < slots; n++) {
      // This process holds the slot: it waits for the command, and the lock file names its pid. Killed, it leaves a
      // lock that the next process to look finds stale.
      const held = tryLock(join(folder, `slot-${n}.lock`))
      if (held === null) continue
      try {
        await flush(out)
        const done = spawnSync(command[0]!, command.slice(1), { stdio: 'inherit', env: { ...process.env, WAFFLES_TEST_SLOT: String(n) } })
        if (done.error) throw new Error(`cannot run ${command[0]}: ${done.error.message}`)
        return exitCode(done)
      } finally {
        held.release()
      }
    }
    if (!said) {
      out.write(`Waiting for a test slot: all ${slots} are in use on this machine.\n`)
      said = true
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS))
  }
}

function count(name: string, text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback
  if (!/^-?[0-9]+$/.test(text.trim())) throw new Usage(`--${name} takes a whole number, not ${JSON.stringify(text)}`)
  return Number(text)
}

/** test-slot's arguments: --slots, then the command, after `--` or from its first word that is not an option. */
function slotArgs(argv: string[]): { help: boolean; slots: string | undefined; command: string[] } {
  let slots: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-h' || arg === '--help') return { help: true, slots, command: [] }
    if (arg === '--') return { help: false, slots, command: argv.slice(i + 1) }
    if (arg.startsWith('--slots=')) slots = arg.slice('--slots='.length)
    else if (arg === '--slots') {
      if (i + 1 >= argv.length) throw new Usage('--slots needs a value')
      slots = argv[++i]
    } else if (arg.startsWith('-')) throw new Usage(`unknown option ${arg}`)
    else return { help: false, slots, command: argv.slice(i) }
  }
  return { help: false, slots, command: [] }
}

const OPTIONS = {
  clone: ['root', 'repo', 'item', 'branch', 'base'],
  remove: ['root', 'path'],
  limits: ['repo', 'cap'],
} as const
const REQUIRED: Record<string, string[]> = { clone: ['repo', 'item', 'branch'], remove: ['path'], limits: ['repo'] }

function parse(command: keyof typeof OPTIONS, argv: string[]): Record<string, string | undefined> | null {
  const options = Object.fromEntries(OPTIONS[command].map((name) => [name, { type: 'string' as const }]))
  let values: Record<string, string | boolean | undefined>
  try {
    values = parseArgs({ args: argv, options: { ...options, help: { type: 'boolean', short: 'h' } } }).values
  } catch (error) {
    throw new Usage((error as Error).message)
  }
  if (values['help']) return null
  const missing = REQUIRED[command]!.filter((name) => values[name] === undefined)
  if (missing.length > 0) throw new Usage(`${command} needs ${missing.map((name) => `--${name}`).join(', ')}`)
  return values as Record<string, string | undefined>
}

function inputOf(command: keyof typeof OPTIONS, args: Record<string, string | undefined>): BuildersInput {
  const given = (name: string) => (args[name] === undefined ? {} : { [name]: args[name] })
  if (command === 'clone') return { op: 'clone', repo: args['repo']!, item: args['item']!, branch: args['branch']!, ...given('root'), ...given('base') }
  if (command === 'remove') return { op: 'remove', path: args['path']!, ...given('root') }
  // With no --cap, the core takes $WAFFLES_REVIEW_CAP, else 10.
  return { op: 'limits', repo: args['repo']!, ...(args['cap'] === undefined ? {} : { cap: count('cap', args['cap'], REVIEW_CAP) }) }
}

export async function main(argv: string[], out: Out = process.stdout, err: Out = process.stderr, cwd: string = process.cwd()): Promise<number> {
  const [command, ...rest] = argv
  try {
    if (command === '-h' || command === '--help') {
      out.write(`${USAGE}\n`)
      return 0
    }
    if (command === 'test-slot') {
      const args = slotArgs(rest)
      if (args.help) {
        out.write(`${USAGE}\n`)
        return 0
      }
      const set = process.env['WAFFLES_TEST_SLOT_COUNT']?.trim()
      if (args.slots === undefined && set && !/^[1-9][0-9]*$/.test(set)) throw new Usage(`WAFFLES_TEST_SLOT_COUNT must be a count from 1 up, not ${JSON.stringify(set)}`)
      const slots = count('slots', args.slots ?? (set || undefined), TEST_SLOTS)
      if (args.command.length === 0 || slots < 1) throw new Usage('test-slot needs a command after --, and 1 slot or more.')
      return await testSlot(slots, args.command, out)
    }
    if (command !== 'clone' && command !== 'remove' && command !== 'limits') {
      throw new Usage(command === undefined ? 'name a command: clone, remove, limits, or test-slot' : `unknown command ${JSON.stringify(command)}`)
    }
    const args = parse(command, rest)
    if (args === null) {
      out.write(`${USAGE}\n`)
      return 0
    }
    const outcome = await builders(nodeHost({ sessionId: 'builders', cwd, names: NAMES }), inputOf(command, args), (name) => `--${name}`)
    if ('refused' in outcome) {
      err.write(`Refused: ${outcome.refused}\n`)
      return 3
    }
    if ('failed' in outcome) {
      err.write(`${outcome.failed}\n`)
      return 1
    }
    out.write(`${JSON.stringify(outcome.value)}\n`)
    return 0
  } catch (error) {
    err.write(`builders: ${(error as Error).message}\n`)
    return error instanceof Usage ? 2 : 1
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
