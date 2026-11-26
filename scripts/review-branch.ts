// Build a throwaway local branch in the main checkout that merges every pull request waiting for the person:
// core/review-branch.ts says how. The review_branch tool gives the same answers; this is for a person, and for a
// platform where the tool is missing.
//
// Usage:
//   node review-branch.ts build --repo DIR (--pr N... | --waiting)
//   node review-branch.ts done --repo DIR
//
// Prints 1 line of JSON: the tool's answer. Exit codes: 0 when done; 3 when refused, with the reason on stderr; 1 when
// git or gh failed, with its message on stderr; 2 for wrong arguments.

import { parseArgs } from 'node:util'

import { nodeHost } from '../adapters/node/host.ts'
import { reviewBranch, type ReviewBranchInput } from '../core/review-branch.ts'

const USAGE = 'usage: node review-branch.ts build --repo DIR (--pr N... | --waiting), or done --repo DIR'

// The review branch reads no session value and names nothing to a model.
const NAMES = { assistant: 'Agent', product: 'waffles', planTool: 'plan', ask: 'question', planMode: null }

type Out = { write(text: string): unknown }

// The subcommand, then its options. --pr takes every value up to the next option, as `--pr 1 2 3`.
function parse(argv: string[]): ReviewBranchInput | { op: 'help' } | string {
  const { values, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    tokens: true,
    options: { repo: { type: 'string' }, pr: { type: 'string', multiple: true }, waiting: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  })
  if (values.help) return { op: 'help' }
  let command: string | undefined
  const prs: string[] = []
  let afterPr = false
  for (const token of tokens) {
    if (token.kind === 'option') {
      afterPr = token.name === 'pr'
      if (afterPr && token.value !== undefined) prs.push(token.value)
    } else if (token.kind === 'positional' && afterPr) prs.push(token.value)
    else if (token.kind === 'positional' && command === undefined) command = token.value
    else if (token.kind === 'positional') return `unexpected argument ${token.value}`
    else afterPr = false
  }
  if (command !== 'build' && command !== 'done') return 'expected build or done'
  if (!values.repo) return `${command} needs --repo`
  if (command === 'done') return values.pr || values.waiting ? 'done takes only --repo' : { op: command, repo: values.repo }
  if (Boolean(values.pr) === Boolean(values.waiting)) return 'build needs either --pr or --waiting'
  if (prs.some((pr) => !/^\d+$/.test(pr))) return `--pr takes pull request numbers, not ${prs.join(' ')}`
  return { op: command, repo: values.repo, prs: values.pr ? prs.map(Number) : null, waiting: Boolean(values.waiting) }
}

export async function main(argv: string[], out: Out = process.stdout, err: Out = process.stderr, cwd: string = process.cwd()): Promise<number> {
  let args: ReturnType<typeof parse>
  try {
    args = parse(argv)
  } catch (error) {
    args = (error as Error).message
  }
  if (typeof args === 'string') {
    err.write(`${args} (${USAGE})\n`)
    return 2
  }
  if (args.op === 'help') {
    out.write(`${USAGE}\n`)
    return 0
  }
  const outcome = await reviewBranch(nodeHost({ sessionId: 'review-branch', cwd, names: NAMES }), args)
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
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
