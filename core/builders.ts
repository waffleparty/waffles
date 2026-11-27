import { answerOf, deadlineIn, Failed, outcomeOf, Refused, run, type Outcome } from './commands.ts'
import type { Host } from './host.ts'
import { remoteName, reviewCap } from './settings.ts'
import { absolute, basename, dirname, inside, join, normalize } from './paths.ts'
import type { CoreTool, Json } from './tools.ts'

/*
 * Gives each builder its own full clone of the repo, on its own branch, within the waffles limits, and removes the
 * clone once merged. The `builders` tool runs clone, remove, and limits on every platform, and scripts/builders.ts on
 * the command line. Test runs stay with the script (`builders.ts test-slot -- <command>`): a test run holds its slot
 * for as long as it runs, minutes, which no tool call may take, and the command is the builder's own shell command.
 *
 * A builder is an agent that builds one item: one clone, one branch, one draft pull request. Builders never share a
 * checkout, and nothing is copied back from a clone: the work reaches the repo as a pull request.
 *
 * clone makes `<root>/<owner>/<repo>/<item>` from the main checkout's remote ($WAFFLES_REMOTE, else `origin`; the
 * clone's own remote is always `origin`, as git names it). The root is $WAFFLES_BUILDERS_ROOT when
 * it is set, so a person can keep clones where they like; otherwise root, which the skills set to `<session
 * scratchpad>/builders`: the session can write there without a permission prompt, and the plugin names no folder of
 * its own. A clone that a later session can't find is made again from its pushed branch. It borrows the main
 * checkout's objects while it clones (--reference-if-able, then --dissociate), so the clone is fast and needs nothing
 * of the main checkout afterwards. The branch starts from origin's base: the default branch, or for an item that
 * depends on one not merged yet, that item's branch (a stacked pull request). A branch that origin already has is
 * checked out as it is. A clone that already exists for the item is used again when it is on the same branch. The
 * answer: path, branch, base, and whether it was reused. It records item, branch, base, and the main checkout in
 * `<clone>/.git/waffles/builder.json`.
 *
 * remove deletes a clone under the root once it holds no change, no stash, and no commit that origin lacks (on a
 * branch or a detached HEAD), and the folders above it that it leaves empty.
 *
 * limits counts, from GitHub, the open pull requests of the repo that wait for human review: marked ready (not a
 * draft), with a review requested from a person or a team. It counts every developer's. At the cap (the call's, else $WAFFLES_REVIEW_CAP; with neither there is no cap, and it only counts) it refuses:
 * waffles starts no builder in that repo until one is reviewed, and the reason lists them. A pull request that an
 * agent will merge itself has no review requested, so it is not counted. A list that the platform cut is refused.
 *
 * Time limits: 30 s for each local git command, 60 s for gh, 2 minutes for a fetch, 5 minutes for the clone itself.
 * A clone call takes at most 6 minutes in all, a remove 3, and limits 45 s.
 */

const LOCAL_MS = 30_000
const GH_MS = 60_000
const FETCH_MS = 120_000
const CLONE_MS = 300_000
const CALL_MS = { clone: 360_000, remove: 180_000, limits: 45_000 }

// git@github.com:owner/repo.git, ssh://git@host/owner/repo.git, https://github.com/owner/repo, or a local path.
const REMOTE = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/

export type Clone = { path: string; branch: string; base: unknown; reused: boolean }
export type Removed = { path: string; removed: true }
/** cap is null when neither the call nor $WAFFLES_REVIEW_CAP sets one. */
export type Limits = { waiting: number; cap: number | null; numbers: number[] }
export type BuildersInput =
  | { op: 'clone'; root?: string; repo: string; item: string; branch: string; base?: string }
  | { op: 'remove'; root?: string; path: string }
  | { op: 'limits'; repo: string; cap?: number }
/** How a message names an input: the tool's name for it, or the command line's flag (`--root`). */
export type Spelling = (input: string) => string

/** The Host, the session's folder, and when the call's time runs out. */
type Call = { $: Host; cwd: string; deadline: number }

async function gitRun(c: Call, cwd: string, args: string[], timeoutMs = LOCAL_MS) {
  return run(c.$, ['git', ...args], { cwd, timeoutMs, deadline: c.deadline })
}

async function git(c: Call, cwd: string, ...args: string[]): Promise<string> {
  const done = await gitRun(c, cwd, args)
  if (done.exitCode !== 0) throw new Failed(`git ${args.join(' ')} failed in ${cwd}: ${done.stderr.trim()}`)
  return done.stdout.trim()
}

const gitOk = async (c: Call, cwd: string, ...args: string[]) => (await gitRun(c, cwd, args)).exitCode === 0

async function isDir($: Host, path: string): Promise<boolean> {
  if (!(await $.fs.exists(path))) return false
  return $.fs.stat(path).then(
    stat => stat.kind === 'dir',
    () => false,
  )
}

/** The path with its links followed, also when its last parts do not exist yet. */
async function realPathOf($: Host, path: string): Promise<string> {
  const full = normalize(path)
  try {
    return await $.fs.realPath(full)
  } catch {
    const parent = dirname(full)
    return parent === full ? full : join(await realPathOf($, parent), basename(full))
  }
}

async function rootOf(c: Call, option: string | undefined, flag: Spelling): Promise<string> {
  const chosen = (await c.$.env('WAFFLES_BUILDERS_ROOT')) || option
  if (!chosen) throw new Refused(`no folder for the clones: pass ${flag('root')} (the skills pass <session scratchpad>/builders) or set WAFFLES_BUILDERS_ROOT.`)
  let path = chosen
  if (chosen === '~' || chosen.startsWith('~/')) {
    const home = await c.$.home()
    if (!home) throw new Refused(`no home folder is known, so ${chosen} names no folder.`)
    path = home + chosen.slice(1)
  }
  return realPathOf(c.$, absolute(c.cwd, path))
}

export function ownerRepo(url: string): [string, string] {
  const match = REMOTE.exec(url)
  if (!match) throw new Refused(`the remote's URL ${url} names no owner and repo.`)
  return [match[1]!, match[2]!]
}

function slug(text: string): string {
  const clean = text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  if (!clean) throw new Refused(`the item ID ${JSON.stringify(text)} makes no folder name.`)
  return clean
}

const recordOf = (path: string) => join(path, '.git', 'waffles', 'builder.json')

async function recordedBase($: Host, path: string): Promise<unknown> {
  try {
    return (JSON.parse(await $.fs.read(recordOf(path))) as { base?: unknown } | null)?.base ?? null
  } catch {
    return null
  }
}

async function mainOf(c: Call, repo: string): Promise<string> {
  const folder = absolute(c.cwd, repo)
  if (!(await c.$.fs.exists(folder))) throw new Failed(`${folder} does not exist`)
  return realPathOf(c.$, await git(c, folder, 'rev-parse', '--show-toplevel'))
}

async function clone(c: Call, rootFolder: string, repo: string, item: string, branch: string, base: string | undefined): Promise<Clone> {
  const main = await mainOf(c, repo)
  // The main checkout's remote is the person's to name; the clone below is git's own, whose remote is origin.
  const url = await git(c, main, 'remote', 'get-url', await remoteName(c.$))
  const [owner, name] = ownerRepo(url)
  const path = join(rootFolder, owner, name, slug(item))
  if (inside(path, main) || inside(main, path)) throw new Refused(`the clone ${path} would be inside the main checkout ${main}, or hold it.`)

  if (await c.$.fs.exists(path)) {
    if (!(await isDir(c.$, join(path, '.git')))) throw new Refused(`${path} exists and is not a clone.`)
    if ((await git(c, path, 'remote', 'get-url', 'origin')) !== url) throw new Refused(`${path} is a clone of another remote.`)
    const current = await git(c, path, 'branch', '--show-current')
    if (current !== branch) throw new Refused(`${path} is the clone of item ${item} on branch ${current}, not ${branch}.`)
    return { path, branch, base: await recordedBase(c.$, path), reused: true }
  }

  // git clone makes the folders above the clone.
  const common = await realPathOf(c.$, absolute(main, await git(c, main, 'rev-parse', '--git-common-dir')))
  const done = await gitRun(c, main, ['clone', '--quiet', '--reference-if-able', common, '--dissociate', url, path], CLONE_MS)
  if (done.exitCode !== 0) throw new Failed(`git clone ${url} failed: ${done.stderr.trim()}`)
  try {
    if (!base) {
      const head = await git(c, path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
      base = head.slice(head.indexOf('/') + 1)
    }
    if (await gitOk(c, path, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`)) {
      await git(c, path, 'switch', '--quiet', '--track', `origin/${branch}`)
    } else {
      if (!(await gitOk(c, path, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`))) {
        throw new Refused(`origin has no branch ${base} to start ${branch} from. Push the item it depends on first.`)
      }
      await git(c, path, 'switch', '--quiet', '--no-track', '-c', branch, `origin/${base}`)
    }
  } catch (error) {
    if (error instanceof Refused || error instanceof Failed) await c.$.fs.remove(path, { recursive: true })
    throw error
  }
  await c.$.fs.write(recordOf(path), `${JSON.stringify({ item, branch, base, main }, null, 2)}\n`)
  return { path, branch, base, reused: false }
}

async function remove(c: Call, rootFolder: string, given: string): Promise<Removed> {
  const path = await realPathOf(c.$, absolute(c.cwd, given))
  if (!inside(path, rootFolder) || path === rootFolder) throw new Refused(`${path} is not a builder's clone under ${rootFolder}.`)
  if (!(await isDir(c.$, join(path, '.git')))) throw new Refused(`${path} is not a clone.`)
  if (await git(c, path, 'status', '--porcelain')) throw new Refused(`${path} holds changes that are not committed.`)
  if (await git(c, path, 'stash', 'list')) throw new Refused(`${path} holds stashed changes.`)
  const fetched = await gitRun(c, path, ['fetch', '--quiet', 'origin'], FETCH_MS)
  if (fetched.exitCode !== 0) throw new Failed(`git fetch --quiet origin failed in ${path}: ${fetched.stderr.trim()}`)
  const ahead = await git(c, path, 'log', '--oneline', 'HEAD', '--branches', '--not', '--remotes')
  if (ahead) throw new Refused(`${path} holds commits that origin lacks:\n${ahead}`)
  await c.$.fs.remove(path, { recursive: true })
  let parent = dirname(path)
  while (parent !== rootFolder && inside(parent, rootFolder) && (await c.$.fs.list(parent)).length === 0) {
    await c.$.fs.remove(parent, { recursive: true })
    parent = dirname(parent)
  }
  return { path, removed: true }
}

type PullRequest = { number?: number; title?: string; url?: string; isDraft?: boolean; reviewRequests?: unknown[] }

/** The open pull requests that wait for human review: ready, with a review requested. */
async function waitingForReview(c: Call, repo: string): Promise<PullRequest[]> {
  const argv = ['gh', 'pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,url,isDraft,reviewRequests']
  const done = await run(c.$, argv, { cwd: repo, timeoutMs: GH_MS, deadline: c.deadline, isWhole: true })
  if (done.exitCode !== 0) {
    throw new Failed(`gh pr list failed in ${repo}, so the pull requests that wait for review are not counted: ${done.stderr.trim()}`)
  }
  let prs: unknown
  try {
    prs = JSON.parse(done.stdout)
  } catch (error) {
    throw new Failed(`gh pr list answered no JSON: ${(error as Error).message}`)
  }
  if (!Array.isArray(prs)) throw new Failed('gh pr list answered no list of pull requests')
  return (prs as PullRequest[]).filter(pr => !pr.isDraft && (pr.reviewRequests?.length ?? 0) > 0)
}

/** A line of the refusal for 1 pull request: what gh gave of its number, title, and URL. */
function listLine(pr: PullRequest): string {
  const name = [typeof pr.number === 'number' ? `#${pr.number}` : '', pr.title || ''].filter(Boolean).join(' ')
  return `- ${[name, pr.url || ''].filter(Boolean).join(': ') || 'a pull request that gh gave no number, title, or URL for'}`
}

async function limits(c: Call, repo: string, cap: number | null): Promise<Limits> {
  const main = await mainOf(c, repo)
  const waiting = (await waitingForReview(c, main)).sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
  if (cap !== null && waiting.length >= cap) {
    const listed = waiting.map(listLine).join('\n')
    throw new Refused(
      `${waiting.length} open pull requests in ${basename(main)} wait for human review (ready, with a review ` +
        `requested), and the cap is ${cap}. Start no builder in this repo until one of them is reviewed:\n${listed}`,
    )
  }
  return { waiting: waiting.length, cap, numbers: waiting.flatMap(pr => (typeof pr.number === 'number' ? [pr.number] : [])) }
}

/** Runs one builders command; folders are absolute, or from the session's folder. */
export async function builders($: Host, input: BuildersInput, flag: Spelling = name => name): Promise<Outcome<Clone | Removed | Limits>> {
  const c: Call = { $, cwd: await $.session.cwd(), deadline: await deadlineIn($, CALL_MS[input.op]) }
  return outcomeOf<Clone | Removed | Limits>(async () => {
    if (input.op === 'clone') return clone(c, await rootOf(c, input.root, flag), input.repo, input.item, input.branch, input.base)
    if (input.op === 'remove') return remove(c, await rootOf(c, input.root, flag), input.path)
    return limits(c, input.repo, input.cap ?? (await reviewCap($)))
  })
}

const KEYS: Record<string, string[]> = { clone: ['root', 'repo', 'item', 'branch', 'base'], remove: ['root', 'path'], limits: ['repo', 'cap'] }
const REQUIRED: Record<string, string[]> = { clone: ['repo', 'item', 'branch'], remove: ['path'], limits: ['repo'] }
const ALL = ['op', 'root', 'repo', 'item', 'branch', 'base', 'path', 'cap']

/** The input as the tool takes it; a string that tells what is wrong with it otherwise. */
export function inputOf(input: Json): BuildersInput | string {
  const unknown = Object.keys(input).filter(key => !ALL.includes(key))
  if (unknown.length) return `The builders tool takes ${ALL.join(', ')}, not ${unknown.join(', ')}.`
  const { op, ...rest } = input
  if (op === 'test-slot') return 'test-slot is not a tool: run tests as `node <scripts>/builders.ts test-slot -- <command>`.'
  if (op !== 'clone' && op !== 'remove' && op !== 'limits') return 'op must be one of clone, remove, limits.'
  const other = Object.keys(rest).filter(key => !KEYS[op]!.includes(key))
  if (other.length) return `op ${op} takes ${['op', ...KEYS[op]!].join(', ')}, not ${other.join(', ')}.`
  const missing = REQUIRED[op]!.filter(key => rest[key] === undefined)
  if (missing.length) return `op ${op} needs ${missing.join(', ')}.`
  const texts = Object.entries(rest).filter(([key]) => key !== 'cap')
  const bad = texts.find(([, value]) => typeof value !== 'string' || !value.trim())
  if (bad) return `${bad[0]} must be text.`
  if (rest.cap !== undefined && !Number.isInteger(rest.cap)) return 'cap must be a whole number.'
  return { op, ...rest } as BuildersInput
}

const CLONE_ANSWER = {
  type: 'object',
  required: ['path', 'branch', 'base', 'reused'],
  properties: {
    path: { type: 'string', description: "The clone's folder." },
    branch: { type: 'string' },
    base: { type: ['string', 'null'], description: 'The branch it started from; null for a reused clone with no record of it.' },
    reused: { type: 'boolean', description: 'The clone was there already, on the branch.' },
  },
  additionalProperties: false,
}
const REMOVED_ANSWER = {
  type: 'object',
  required: ['path', 'removed'],
  properties: { path: { type: 'string' }, removed: { const: true } },
  additionalProperties: false,
}
const LIMITS_ANSWER = {
  type: 'object',
  required: ['waiting', 'cap', 'numbers'],
  properties: {
    waiting: { type: 'integer', description: 'The open pull requests that wait for human review.' },
    cap: { type: ['integer', 'null'], description: 'The cap in force; null when none is set.' },
    numbers: { type: 'array', items: { type: 'integer' }, description: 'Their numbers.' },
  },
  additionalProperties: false,
}

export const BUILDERS_TOOL: CoreTool = {
  name: 'builders',
  title: 'Builders',
  description:
    "Gives a builder (an agent that builds one item) its own full clone of the repo, removes it once merged, and checks the open pull request limit. op clone makes <root>/<owner>/<repo>/<item> from the main checkout repo's remote ($WAFFLES_REMOTE, else origin), on branch (checked out from origin when it is there, else started from origin's base, the default branch when left out), and answers with its path; a clone of the item on the same branch is reused, and one on another branch is refused. op remove deletes the clone at path, under root, and refuses one that holds changes, a stash, or commits that origin lacks. op limits counts the open pull requests of repo that wait for human review (ready, with a review requested), and, when a cap is set (cap, else $WAFFLES_REVIEW_CAP; with neither there is none), refuses at it, listing them: then start no builder in that repo. $WAFFLES_BUILDERS_ROOT, when set, takes the place of root. Test runs are not this tool: run each through the shell command `node <scripts>/builders.ts test-slot -- <command>`, which holds 1 of the machine's test slots for as long as the command runs, longer than a tool call may take.",
  inputSchema: {
    type: 'object',
    required: ['op'],
    properties: {
      op: { type: 'string', enum: ['clone', 'remove', 'limits'] },
      root: { type: 'string', description: 'clone, remove: the folder that holds the clones, such as <session scratchpad>/builders.' },
      repo: { type: 'string', description: "clone, limits: the main checkout, or any folder in it: absolute, or relative to the session's folder." },
      item: { type: 'string', description: "clone: the item's ID, which names the clone's folder." },
      branch: { type: 'string', description: "clone: the builder's branch." },
      base: { type: 'string', description: "clone: the branch to start from, for an item stacked on another's. Left out: origin's default branch." },
      path: { type: 'string', description: "remove: the clone's folder." },
      cap: { type: 'integer', description: 'limits: the cap. Left out: $WAFFLES_REVIEW_CAP, and no cap when that is unset.' },
    },
    additionalProperties: false,
  },
  // One schema per op: a clone has `reused`, a removal `removed`, a count `waiting`.
  outputSchema: { type: 'object', oneOf: [CLONE_ANSWER, REMOVED_ANSWER, LIMITS_ANSWER] },
  annotations: { destructiveHint: true, openWorldHint: true },
  call: async ($, input) => {
    const parsed = inputOf(input)
    return typeof parsed === 'string' ? { refusal: parsed } : answerOf(await builders($, parsed))
  },
}
