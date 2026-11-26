import { answerOf, deadlineIn, Failed, outcomeOf, Refused, run, type Outcome } from './commands.ts'
import type { Host } from './host.ts'
import { absolute, join } from './paths.ts'
import type { CoreTool, Json } from './tools.ts'

/*
 * Builds a throwaway local branch in the main checkout that merges every pull request waiting for the person. The
 * `review_branch` tool runs it on every platform, and scripts/review-branch.ts on the command line.
 *
 * The person reviews several finished UI items at once: one branch, `waffles-review`, holds the default branch with each
 * pull request merged into it, and one dev server serves it. The branch is never pushed: it has no upstream, and done
 * deletes it.
 *
 * build fetches each pull request's head from origin (refs/pull/<n>/head, kept under refs/waffles-review/), starts
 * `waffles-review` from origin's default branch, and merges them in the order given, unsigned, since the merges never leave
 * this machine. A pull request that conflicts with the ones before it is left out, and the answer names it. waiting
 * takes the open pull requests that are ready and ask the person for a review (`gh pr list --search
 * review-requested:@me`). Build again to rebuild the branch after a waiting pull request changed. It refuses a checkout
 * with changes to tracked files, since it switches branches. It records the branch the checkout was on in
 * `<git dir>/waffles/review.json`.
 *
 * done switches back to that branch and deletes `waffles-review` and its fetched refs. Both build and done refuse when
 * `waffles-review` holds a commit that is not a merge of the pull requests (someone's own work, or their own branch of that
 * name), since they would lose it.
 *
 * Time limits: 30 s for each local git command, 60 s for each merge and for gh, 2 minutes for each fetch; a build
 * takes at most 4 minutes in all, and done 45 s.
 */

const BRANCH = 'waffles-review'
const REFS = 'refs/waffles-review'

const LOCAL_MS = 30_000
const MERGE_MS = 60_000
const GH_MS = 60_000
const FETCH_MS = 120_000
const BUILD_MS = 240_000
const DONE_MS = 45_000

export type BuildAnswer = { branch: string; from: string; base: string; merged: number[]; conflicts: number[] }
export type DoneAnswer = { branch: string; deleted: string }
export type ReviewBranchInput = { op: 'build'; repo: string; prs: number[] | null; waiting: boolean } | { op: 'done'; repo: string }

/** The checkout, and when the call's time runs out. */
type Checkout = { $: Host; main: string; deadline: number }

async function git(c: Checkout, args: string[], { check = true, timeoutMs = LOCAL_MS } = {}) {
  const done = await run(c.$, ['git', ...args], { cwd: c.main, timeoutMs, deadline: c.deadline })
  if (check && done.exitCode !== 0) throw new Failed(`git ${args.join(' ')} failed: ${done.stderr.trim()}`)
  return done
}

const outOf = async (c: Checkout, ...args: string[]) => (await git(c, args)).stdout.trim()

/** The main checkout's top level, from any folder in it. */
async function mainOf($: Host, repo: string, deadline: number): Promise<Checkout> {
  if (!(await $.fs.exists(repo))) throw new Failed(`${repo} does not exist`)
  return { $, deadline, main: await outOf({ $, deadline, main: repo }, 'rev-parse', '--show-toplevel') }
}

async function statePath(c: Checkout): Promise<string> {
  return join(await outOf(c, 'rev-parse', '--absolute-git-dir'), 'waffles', 'review.json')
}

// null when no build wrote the file, or it does not read as JSON.
async function readState(c: Checkout): Promise<BuildAnswer | null> {
  const path = await statePath(c)
  try {
    return JSON.parse(await c.$.fs.read(path)) as BuildAnswer
  } catch {
    return null
  }
}

// Commits on waffles-review that are not the merges this tool made: someone's own work, which a rebuild or done would lose.
async function ownCommits(c: Checkout): Promise<string> {
  if ((await git(c, ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`], { check: false })).exitCode !== 0) return ''
  const fallback = (await git(c, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { check: false })).stdout.trim() || 'HEAD'
  return outOf(c, 'log', '--oneline', '--no-merges', BRANCH, '--not', fallback, `--glob=${REFS}/*`)
}

async function refuseOwnCommits(c: Checkout): Promise<void> {
  const own = await ownCommits(c)
  if (own) {
    throw new Refused(
      `the branch ${BRANCH} holds commits that are not merges of the pull requests, and rebuilding or deleting it ` +
        `would lose them. Move them to another branch first:\n${own}`,
    )
  }
}

async function waiting(c: Checkout): Promise<number[]> {
  const argv = ['gh', 'pr', 'list', '--state', 'open', '--search', 'review-requested:@me', '--json', 'number,isDraft']
  const done = await run(c.$, argv, { cwd: c.main, timeoutMs: GH_MS, deadline: c.deadline, isWhole: true })
  if (done.exitCode !== 0) throw new Failed(`gh pr list failed: ${done.stderr.trim()}`)
  const prs = JSON.parse(done.stdout) as { number: number; isDraft?: boolean }[]
  return prs.filter(pr => !pr.isDraft).map(pr => pr.number).sort((a, b) => a - b)
}

async function build($: Host, repo: string, prs: number[] | null, fromGh: boolean): Promise<BuildAnswer> {
  const c = await mainOf($, repo, await deadlineIn($, BUILD_MS))
  if (await outOf(c, 'status', '--porcelain', '--untracked-files=no')) {
    throw new Refused(`${c.main} has changes to tracked files. Commit or stash them, then build the review branch.`)
  }
  const numbers = fromGh ? await waiting(c) : (prs ?? [])
  if (!numbers.length) throw new Refused('no pull request waits for review.')
  const current = await outOf(c, 'branch', '--show-current')
  const state = await readState(c)
  const back = state && current === BRANCH ? state.from : current
  if (!back) throw new Refused(`${c.main} is not on a branch (a detached HEAD), so done could not switch back.`)

  await refuseOwnCommits(c)
  await git(c, ['fetch', '--quiet', 'origin'], { timeoutMs: FETCH_MS })
  const base = await outOf(c, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  await git(c, ['fetch', '--quiet', 'origin', ...numbers.map(n => `+refs/pull/${n}/head:${REFS}/pr-${n}`)], { timeoutMs: FETCH_MS })
  await git(c, ['switch', '--quiet', '--no-track', '-C', BRANCH, base])
  const merged: number[] = []
  const conflicts: number[] = []
  for (const n of numbers) {
    const args = ['-c', 'commit.gpgsign=false', 'merge', '--quiet', '--no-ff', '--no-edit', '-m', `Review: pull request #${n}`, `${REFS}/pr-${n}`]
    if ((await git(c, args, { check: false, timeoutMs: MERGE_MS })).exitCode === 0) merged.push(n)
    else {
      await git(c, ['merge', '--abort'], { check: false })
      conflicts.push(n)
    }
  }
  const result = { branch: BRANCH, from: back, base, merged, conflicts }
  await $.fs.write(await statePath(c), `${JSON.stringify(result, null, 2)}\n`)
  return result
}

async function done($: Host, repo: string): Promise<DoneAnswer> {
  const c = await mainOf($, repo, await deadlineIn($, DONE_MS))
  const state = await readState(c)
  if (!state) throw new Refused(`no review branch was built in ${c.main}.`)
  await refuseOwnCommits(c)
  if ((await outOf(c, 'branch', '--show-current')) === BRANCH) {
    if (await outOf(c, 'status', '--porcelain', '--untracked-files=no')) {
      throw new Refused(`${BRANCH} has changes to tracked files. Discard or keep them elsewhere first.`)
    }
    await git(c, ['switch', '--quiet', state.from])
  }
  await git(c, ['branch', '-D', BRANCH], { check: false })
  // Every ref is deleted, so the list is read whole.
  const refs = await run($, ['git', 'for-each-ref', '--format=%(refname)', REFS], { cwd: c.main, timeoutMs: LOCAL_MS, deadline: c.deadline, isWhole: true })
  if (refs.exitCode !== 0) throw new Failed(`git for-each-ref --format=%(refname) ${REFS} failed: ${refs.stderr.trim()}`)
  for (const ref of refs.stdout.trim().split('\n').filter(Boolean)) await git(c, ['update-ref', '-d', ref])
  await $.fs.remove(await statePath(c))
  return { branch: state.from, deleted: BRANCH }
}

/** Builds the review branch or ends it, in the main checkout at `repo` (absolute, or from the session's folder). */
export async function reviewBranch($: Host, input: ReviewBranchInput): Promise<Outcome<BuildAnswer | DoneAnswer>> {
  const repo = absolute(await $.session.cwd(), input.repo)
  return outcomeOf<BuildAnswer | DoneAnswer>(() => (input.op === 'build' ? build($, repo, input.prs, input.waiting) : done($, repo)))
}

/** The input as the tool takes it; a string that tells what is wrong with it otherwise. */
export function inputOf(input: Json): ReviewBranchInput | string {
  const { op, repo, prs, waiting, ...extra } = input
  const unknown = Object.keys(extra)
  if (unknown.length) return `The review_branch tool takes op, repo, prs, and waiting, not ${unknown.join(', ')}.`
  if (op !== 'build' && op !== 'done') return 'op must be one of build, done.'
  if (typeof repo !== 'string' || !repo.trim()) return 'repo must be the path of the main checkout.'
  if (waiting !== undefined && typeof waiting !== 'boolean') return 'waiting must be true or false, or left out.'
  if (op === 'done') return prs !== undefined || waiting !== undefined ? 'done takes only repo.' : { op, repo }
  if ((prs !== undefined) === Boolean(waiting)) return 'build takes either prs or waiting: true.'
  if (prs !== undefined && (!Array.isArray(prs) || !prs.length || !prs.every(n => Number.isInteger(n) && n > 0))) {
    return 'prs must be a list of pull request numbers.'
  }
  return { op, repo, prs: (prs as number[] | undefined) ?? null, waiting: Boolean(waiting) }
}

const BUILD_ANSWER = {
  type: 'object',
  required: ['branch', 'from', 'base', 'merged', 'conflicts'],
  properties: {
    branch: { type: 'string', description: 'The review branch, now checked out in the main checkout.' },
    from: { type: 'string', description: 'The branch done switches back to.' },
    base: { type: 'string', description: "Origin's default branch, which the review branch starts from." },
    merged: { type: 'array', items: { type: 'integer' }, description: 'The pull requests merged into it, in order.' },
    conflicts: { type: 'array', items: { type: 'integer' }, description: 'The pull requests left out: each conflicts with the ones before it.' },
  },
  additionalProperties: false,
}

const DONE_ANSWER = {
  type: 'object',
  required: ['branch', 'deleted'],
  properties: {
    branch: { type: 'string', description: 'The branch the main checkout is on again.' },
    deleted: { type: 'string', description: 'The review branch, deleted.' },
  },
  additionalProperties: false,
}

export const REVIEW_BRANCH_TOOL: CoreTool = {
  name: 'review_branch',
  title: 'Review branch',
  description:
    "Builds or ends the local review branch, waffles-review, in the main checkout: the default branch with each pull request that waits for the person merged into it, so one dev server serves them all. op build merges prs (pull request numbers, in order) or, with waiting: true, the open ready pull requests that ask the person for a review; it switches the checkout to the branch, and names each pull request that conflicted and was left out. Build again to rebuild it. op done switches the checkout back and deletes the branch. Both refuse a branch that holds commits of someone's own, and build refuses a checkout with changes to tracked files. The branch is never pushed.",
  inputSchema: {
    type: 'object',
    required: ['op', 'repo'],
    properties: {
      op: { type: 'string', enum: ['build', 'done'] },
      repo: { type: 'string', description: "The main checkout, or any folder in it: an absolute path, or one relative to the session's folder." },
      prs: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, description: 'build: the pull requests to merge, in order.' },
      waiting: { type: 'boolean', description: 'build: merge the open, ready pull requests that ask the person for a review.' },
    },
    additionalProperties: false,
  },
  // One schema per op: a build answer has `merged`, a done answer `deleted`.
  outputSchema: { type: 'object', oneOf: [BUILD_ANSWER, DONE_ANSWER] },
  annotations: { destructiveHint: false, openWorldHint: true },
  call: async ($, input) => {
    const parsed = inputOf(input)
    return typeof parsed === 'string' ? { refusal: parsed } : answerOf(await reviewBranch($, parsed))
  },
}
