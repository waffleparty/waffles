// Build a throwaway local branch in the main checkout that merges every pull request waiting for the person.
//
// Usage:
//   node review-branch.ts build --repo DIR (--pr N... | --waiting)
//   node review-branch.ts done --repo DIR
//
// The person reviews several finished UI items at once: one branch, `waffles-review`, holds the default branch with each
// pull request merged into it, and one dev server serves it. The branch is never pushed: it has no upstream, and done
// deletes it.
//
// build fetches each pull request's head from origin (refs/pull/<n>/head, kept under refs/waffles-review/), starts
// `waffles-review` from origin's default branch, and merges them in the order given, unsigned, since the merges never leave
// this machine. A pull request that conflicts with the ones before it is left out, and the output names it. --waiting
// takes the open pull requests that are ready and ask the person for a review (`gh pr list --search
// review-requested:@me`). Run build again to rebuild the branch after a waiting pull request changed. It refuses a
// checkout with changes to tracked files, since it switches branches. It records the branch the checkout was on in
// `<git dir>/waffles/review.json`.
//
// done switches back to that branch and deletes `waffles-review` and its fetched refs. Both build and done refuse when
// `waffles-review` holds a commit that is not a merge of the pull requests (someone's own work, or their own branch of that
// name), since they would lose it.
//
// Prints 1 line of JSON. Exit codes: 0 when done; 3 when refused, with the reason on stderr; 1 when git or gh failed,
// with its message on stderr; 2 for wrong arguments.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

const USAGE = 'usage: node review-branch.ts build --repo DIR (--pr N... | --waiting), or done --repo DIR'
const BRANCH = 'waffles-review'
const REFS = 'refs/waffles-review'

type Out = { write(text: string): unknown }
type State = { branch: string; from: string; base: string; merged: number[]; conflicts: number[] }

class Refused extends Error {}
class Failed extends Error {}

// git and gh get the caller's stdin, as when they run from the shell. One that cannot start throws, and the script ends
// with exit 1.
function run(argv: [string, ...string[]], cwd?: string) {
  const [file, ...args] = argv
  const done = spawnSync(file, args, { cwd, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: Infinity })
  if (done.error) throw done.error
  return done
}

function git(cwd: string, args: string[], check = true) {
  const done = run(['git', '-C', cwd, ...args])
  if (check && done.status !== 0) throw new Failed(`git ${args.join(' ')} failed: ${done.stderr.trim()}`)
  return done
}

function outOf(cwd: string, ...args: string[]): string {
  return git(cwd, args).stdout.trim()
}

function statePath(main: string): string {
  return join(outOf(main, 'rev-parse', '--absolute-git-dir'), 'waffles', 'review.json')
}

// null when no build wrote the file, or it does not read as JSON.
function readState(main: string): State | null {
  const path = statePath(main)
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as State
  } catch {
    return null
  }
}

// Commits on waffles-review that are not the merges this script made: someone's own work, which a rebuild or done would lose.
function ownCommits(main: string): string {
  if (git(main, ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`], false).status !== 0) return ''
  const fallback = git(main, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], false).stdout.trim() || 'HEAD'
  return outOf(main, 'log', '--oneline', '--no-merges', BRANCH, '--not', fallback, `--glob=${REFS}/*`)
}

function refuseOwnCommits(main: string): void {
  const own = ownCommits(main)
  if (own) {
    throw new Refused(
      `the branch ${BRANCH} holds commits that are not merges of the pull requests, and rebuilding or deleting it ` +
        `would lose them. Move them to another branch first:\n${own}`,
    )
  }
}

function waiting(main: string): number[] {
  const done = run(['gh', 'pr', 'list', '--state', 'open', '--search', 'review-requested:@me', '--json', 'number,isDraft'], main)
  if (done.status !== 0) throw new Failed(`gh pr list failed: ${done.stderr.trim()}`)
  const prs = JSON.parse(done.stdout) as { number: number; isDraft?: boolean }[]
  return prs.filter((pr) => !pr.isDraft).map((pr) => pr.number).sort((a, b) => a - b)
}

export function build(repo: string, prs: number[] | null, fromGh: boolean): State {
  const main = outOf(repo, 'rev-parse', '--show-toplevel')
  if (outOf(main, 'status', '--porcelain', '--untracked-files=no')) {
    throw new Refused(`${main} has changes to tracked files. Commit or stash them, then build the review branch.`)
  }
  const numbers = fromGh ? waiting(main) : (prs ?? [])
  if (!numbers.length) throw new Refused('no pull request waits for review.')
  const current = outOf(main, 'branch', '--show-current')
  const state = readState(main)
  const back = state && current === BRANCH ? state.from : current
  if (!back) throw new Refused(`${main} is not on a branch (a detached HEAD), so done could not switch back.`)

  refuseOwnCommits(main)
  git(main, ['fetch', '--quiet', 'origin'])
  const base = outOf(main, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  git(main, ['fetch', '--quiet', 'origin', ...numbers.map((n) => `+refs/pull/${n}/head:${REFS}/pr-${n}`)])
  git(main, ['switch', '--quiet', '--no-track', '-C', BRANCH, base])
  const merged: number[] = []
  const conflicts: number[] = []
  for (const n of numbers) {
    const done = git(main, ['-c', 'commit.gpgsign=false', 'merge', '--quiet', '--no-ff', '--no-edit', '-m', `Review: pull request #${n}`, `${REFS}/pr-${n}`], false)
    if (done.status === 0) merged.push(n)
    else {
      git(main, ['merge', '--abort'], false)
      conflicts.push(n)
    }
  }
  const path = statePath(main)
  mkdirSync(dirname(path), { recursive: true })
  const result = { branch: BRANCH, from: back, base, merged, conflicts }
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  return result
}

export function done(repo: string): { branch: string; deleted: string } {
  const main = outOf(repo, 'rev-parse', '--show-toplevel')
  const state = readState(main)
  if (!state) throw new Refused(`no review branch was built in ${main}.`)
  refuseOwnCommits(main)
  if (outOf(main, 'branch', '--show-current') === BRANCH) {
    if (outOf(main, 'status', '--porcelain', '--untracked-files=no')) {
      throw new Refused(`${BRANCH} has changes to tracked files. Discard or keep them elsewhere first.`)
    }
    git(main, ['switch', '--quiet', state.from])
  }
  git(main, ['branch', '-D', BRANCH], false)
  for (const ref of outOf(main, 'for-each-ref', '--format=%(refname)', REFS).split('\n').filter(Boolean)) git(main, ['update-ref', '-d', ref])
  rmSync(statePath(main))
  return { branch: state.from, deleted: BRANCH }
}

type Args = { command: 'build'; repo: string; prs: number[] | null; waiting: boolean } | { command: 'done'; repo: string } | { command: 'help' }

// The subcommand, then its options. --pr takes every value up to the next option, as `--pr 1 2 3`.
function parse(argv: string[]): Args | string {
  const { values, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    tokens: true,
    options: { repo: { type: 'string' }, pr: { type: 'string', multiple: true }, waiting: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  })
  if (values.help) return { command: 'help' }
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
  if (command === 'done') return values.pr || values.waiting ? 'done takes only --repo' : { command, repo: values.repo }
  if (Boolean(values.pr) === Boolean(values.waiting)) return 'build needs either --pr or --waiting'
  if (prs.some((pr) => !/^\d+$/.test(pr))) return `--pr takes pull request numbers, not ${prs.join(' ')}`
  return { command, repo: values.repo, prs: values.pr ? prs.map(Number) : null, waiting: Boolean(values.waiting) }
}

export function main(argv: string[], out: Out = process.stdout, err: Out = process.stderr): number {
  let args: Args | string
  try {
    args = parse(argv)
  } catch (error) {
    args = (error as Error).message
  }
  if (typeof args === 'string') {
    err.write(`${args} (${USAGE})\n`)
    return 2
  }
  if (args.command === 'help') {
    out.write(`${USAGE}\n`)
    return 0
  }
  let result: object
  try {
    result = args.command === 'build' ? build(args.repo, args.prs, args.waiting) : done(args.repo)
  } catch (error) {
    if (error instanceof Refused) {
      err.write(`Refused: ${error.message}\n`)
      return 3
    }
    if (error instanceof Failed) {
      err.write(`${error.message}\n`)
      return 1
    }
    throw error
  }
  out.write(`${JSON.stringify(result)}\n`)
  return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
