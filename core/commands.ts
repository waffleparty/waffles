import type { Host, RunResult } from './host.ts'
import type { ToolAnswer } from './tools.ts'

/*
 * What the tools that run git and gh share: a refusal by the tool's own rules and a failure of a command,
 * which the command line tells apart by its exit code (3 and 1), and a run with a time limit.
 *
 * Every command gets its own limit, sized to what it does, and never more than what is left of the call's:
 * a tool call ends well inside what a platform gives one, and a command that hangs (a prompt, a stalled
 * connection) is stopped, so the model can go on.
 */

/** The tool refuses by its own rules: the reason says why. */
export class Refused extends Error {}

/** A command failed, could not start, ran out of time, or printed more than the platform passes on. */
export class Failed extends Error {}

/** What a tool's work came to: its value, a refusal, or a failure, each with its message. */
export type Outcome<T> = { value: T } | { refused: string } | { failed: string }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The work's value, or its Refused or Failed as an outcome; anything else it throws is a defect, and throws on. */
export async function outcomeOf<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { value: await work() }
  } catch (error) {
    if (error instanceof Refused) return { refused: error.message }
    if (error instanceof Failed) return { failed: error.message }
    throw error
  }
}

// What to do about a program that is not there, for the ones waffles names.
const INSTALL: Record<string, string> = {
  gh: 'Install the GitHub CLI (https://cli.github.com) and sign in with `gh auth login`.',
  git: 'Install git.',
  lsof: 'Install lsof.',
}

/** The platform could not start the program because no such program is on the PATH. */
const isAbsent = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === 'ENOENT' || /\bENOENT\b|command not found|No such file or directory/i.test(messageOf(error))

/**
 * Why a command did not start, from what the platform's run rejected with. A program that is not installed is
 * named as that, with what to install; `command` is the program with its first words, as the other messages name it.
 */
export function notStarted(command: string, error: unknown): string {
  const program = command.split(' ')[0]!
  if (isAbsent(error)) return `${program} is not installed, or not on the PATH. ${INSTALL[program] ?? `Install ${program}.`}`
  return `${command} could not run: ${messageOf(error)}`
}

/** An outcome as the model reads it: a refusal starts "Refused: ", as the command line prints it. */
export const answerOf = (outcome: Outcome<unknown>): ToolAnswer =>
  'value' in outcome ? { value: outcome.value } : { refusal: 'refused' in outcome ? `Refused: ${outcome.refused}` : outcome.failed }

/** When a call that may take `ms` runs out of time, in ms since the epoch. */
export const deadlineIn = async ($: Host, ms: number) => (await $.clock.now()) + ms

export type RunInit = {
  cwd: string
  /** The command's own limit. */
  timeoutMs: number
  /** When the call's time runs out; the command gets no more than what is left. */
  deadline: number
  stdin?: string
  /** The answer is read from all of stdout: a cut one is a failure. */
  isWhole?: boolean
}

/** Runs the command to its end, any exit code; Failed when it can't start, runs out of time, or its stdout was cut. */
export async function run($: Host, argv: readonly string[], { cwd, timeoutMs, deadline, stdin, isWhole = false }: RunInit): Promise<RunResult> {
  const left = deadline - (await $.clock.now())
  if (left <= 0) throw new Failed(`${argv.slice(0, 2).join(' ')} did not run: the tool call ran out of time`)
  let done: RunResult
  try {
    done = await $.process.run(argv, { cwd, timeoutMs: Math.min(timeoutMs, left), ...(stdin === undefined ? {} : { stdin }) })
  } catch (error) {
    throw new Failed(notStarted(argv.slice(0, 2).join(' '), error))
  }
  if (isWhole && done.isTruncated) {
    throw new Failed(`${argv.slice(0, 3).join(' ')} printed more than the platform passes on, so nothing is answered from a part of it`)
  }
  return done
}
