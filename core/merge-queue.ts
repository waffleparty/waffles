import type { Host } from './host.ts'
import type { CoreTool, Json, ToolAnswer } from './tools.ts'

/*
 * Tells how a pull request merges (directly, or through its base branch's merge queue), and where it stands.
 * The `merge_queue` tool answers with it on every platform, and scripts/merge-queue.ts on the command line.
 *
 * The pull request is a number, a URL, or a branch, as gh takes it. The repo is needed when it is not a URL and the
 * session's folder is not the repo.
 *
 * mode reads the rules that apply to the pull request's base branch (`gh api repos/<o>/<r>/rules/branches/<base>`). With
 * a `merge_queue` rule, "merge" means "add to the queue": `gh pr merge <n>` (no merge method, no --auto), and the queue
 * tests it on the newest base branch and merges it later, or removes it. GitHub adds it only when it has a valid
 * approval: its review decision (`gh pr view --json reviewDecision`) is APPROVED, or empty when no review is required.
 * Without one, GitHub refuses (also for an admin), and the command is the admin bypass, `gh pr merge <n> --admin` with
 * the queue's merge method, which merges at once past the queue: a run uses it as its --admin rule says, and outside a
 * run the pull request waits for a reviewer. Without a queue, it merges at once: `gh pr merge <n> --squash` with the
 * subject and body passed. A plan with no rulesets (a private repo on GitHub's free plan) has no queue. The answer:
 * queue (true or false), base, approved (with a queue), the review decision, the command, and why.
 *
 * state answers with "state" one of:
 *   merged    the pull request is merged;
 *   queued    it is in the merge queue ("position", and the entry's "entry" state);
 *   waiting   auto-merge is on, and it joins the queue (or merges) once its checks pass;
 *   removed   the queue removed it, and auto-merge is off ("reason", from GitHub): move the item back to in work, with
 *             a note that gives the reason;
 *   closed    it was closed without a merge;
 *   open      none of these.
 *
 * When gh fails, or can't start, the answer is a refusal with gh's message.
 */

const URL = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
const NO_RULESETS = 'Upgrade to GitHub Pro'
// A merge queue rule's merge_method, as a `gh pr merge` flag.
const METHODS = new Map([['MERGE', '--merge'], ['SQUASH', '--squash'], ['REBASE', '--rebase']])
// gh asks GitHub over the network: one that hangs (a prompt, a stalled connection) is stopped, so the model can go on.
const GH_MS = 60_000
const QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      merged
      isInMergeQueue
      mergeQueueEntry { state position }
      autoMergeRequest { enabledAt }
      timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes {
          __typename
          ... on RemovedFromMergeQueueEvent { createdAt reason }
          ... on AddedToMergeQueueEvent { createdAt }
        }
      }
    }
  }
}
`

export const OPS = ['mode', 'state'] as const
export type MergeQueueOp = (typeof OPS)[number]
export type MergeQueueInput = { op: MergeQueueOp; pr: string; repo?: string }

type View = { number: number; url: string; baseRefName: string; reviewDecision?: string | null }
type Rule = { type?: string; parameters?: { merge_method?: string } | null }
type Event = { __typename: string; createdAt?: string; reason?: string | null }
type Pr = {
  state: string
  merged: boolean
  isInMergeQueue: boolean
  mergeQueueEntry: { state?: string; position?: number } | null
  autoMergeRequest: object | null
  timelineItems: { nodes: Event[] }
}

/** gh failed or could not start: the answer is its message. */
class Failed extends Error {}

async function run($: Host, args: string[]) {
  try {
    return await $.process.run(['gh', ...args], { cwd: await $.session.cwd(), timeoutMs: GH_MS })
  } catch (error) {
    throw new Failed(`gh could not run: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function gh($: Host, ...args: string[]): Promise<string> {
  const done = await run($, args)
  if (done.exitCode !== 0) throw new Failed(`gh ${args.slice(0, 2).join(' ')} failed: ${(done.stderr || done.stdout).trim()}`)
  return done.stdout
}

async function pullRequest($: Host, selector: string, repo: string | undefined) {
  const flags = repo ? ['-R', repo] : []
  const view = JSON.parse(await gh($, 'pr', 'view', selector, ...flags, '--json', 'number,url,baseRefName,reviewDecision')) as View
  const match = URL.exec(view.url)
  if (!match) throw new Failed(`gh gave no GitHub URL for ${selector}: ${view.url}`)
  const [, owner = '', name = ''] = match
  return { owner, name, number: view.number, base: view.baseRefName, review: view.reviewDecision || '' }
}

// encodeURIComponent leaves !'()* as they are; the branch is one path segment, so they are escaped too.
function quote(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

async function mode($: Host, selector: string, repo?: string): Promise<object> {
  const { owner, name, number, base, review } = await pullRequest($, selector, repo)
  const done = await run($, ['api', `repos/${owner}/${name}/rules/branches/${quote(base)}`])
  let rules: Rule[] = []
  let why: string | undefined
  if (done.exitCode !== 0 && (done.stdout + done.stderr).includes(NO_RULESETS)) {
    why = "the repo's plan has no rulesets, so its base branch has no merge queue"
  } else if (done.exitCode !== 0) {
    throw new Failed(`gh api rules/branches/${base} failed: ${(done.stderr || done.stdout).trim()}`)
  } else {
    rules = JSON.parse(done.stdout) as Rule[]
  }
  const queue = rules.find((rule) => rule.type === 'merge_queue')
  if (queue && (review === 'APPROVED' || review === '')) {
    return {
      queue: true, base, approved: true, review: review || null, command: `gh pr merge ${number}`,
      why: `${base} has a merge queue, and the pull request has a valid approval or needs none: the command adds it to the queue once its checks pass, and the queue merges it later or removes it`,
    }
  }
  if (queue) {
    const flag = METHODS.get(queue.parameters?.merge_method ?? '') ?? '--squash'
    const message = flag === '--rebase' ? '' : ' --subject <subject> --body <digest>'
    return {
      queue: true, base, approved: false, review, command: `gh pr merge ${number} ${flag} --admin${message}`,
      why: `${base} has a merge queue, and the pull request has no valid approval (review decision ${review}), so GitHub refuses to add it to the queue, also for an admin: in a run, the command merges it at once past the queue, as the run's --admin rule says; outside a run, leave it for a reviewer, whose approval lets \`gh pr merge ${number}\` add it to the queue`,
    }
  }
  return {
    queue: false, base, command: `gh pr merge ${number} --squash --subject <subject> --body <digest>`,
    why: why ?? `${base} has no merge queue: the pull request merges at once`,
  }
}

async function state($: Host, selector: string, repo?: string): Promise<object> {
  const { owner, name, number } = await pullRequest($, selector, repo)
  // Owner and name go as strings (-f), so an all-digit name is not sent as a number; the number as -F.
  const data = JSON.parse(await gh($, 'api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`, '-f', `query=${QUERY}`))
  const pr = data.data.repository.pullRequest as Pr
  const last = pr.timelineItems.nodes.at(-1)
  if (pr.merged) return { state: 'merged', number }
  if (pr.isInMergeQueue) {
    const entry = pr.mergeQueueEntry ?? {}
    return { state: 'queued', number, position: entry.position ?? null, entry: entry.state ?? null }
  }
  if (pr.state === 'CLOSED') return { state: 'closed', number }
  if (pr.autoMergeRequest) return { state: 'waiting', number }
  if (last?.__typename === 'RemovedFromMergeQueueEvent') {
    return { state: 'removed', number, reason: last.reason || 'GitHub gave no reason', at: last.createdAt ?? null }
  }
  return { state: 'open', number }
}

/** How the pull request merges, or where it stands: the answer as a value, or gh's message as a refusal. */
export async function mergeQueue($: Host, { op, pr, repo }: MergeQueueInput): Promise<{ value: object } | { refusal: string }> {
  try {
    return { value: op === 'mode' ? await mode($, pr, repo) : await state($, pr, repo) }
  } catch (error) {
    if (error instanceof Failed) return { refusal: error.message }
    throw error
  }
}

/** The input as the tool takes it; a string that tells what is wrong with it otherwise. */
export function inputOf(input: Json): MergeQueueInput | string {
  const { op, pr, repo, ...extra } = input
  if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) return `op must be one of ${OPS.join(', ')}.`
  // A model may send the number as a number; gh takes it as text.
  const selector = typeof pr === 'number' && Number.isInteger(pr) ? String(pr) : pr
  if (typeof selector !== 'string' || !selector.trim()) return 'pr must name 1 pull request: its number, its URL, or its branch.'
  if (repo !== undefined && (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo))) return 'repo must be OWNER/NAME, or left out.'
  const unknown = Object.keys(extra)
  if (unknown.length) return `The merge_queue tool takes op, pr, and repo, not ${unknown.join(', ')}.`
  return { op: op as MergeQueueOp, pr: selector.trim(), ...(repo === undefined ? {} : { repo }) }
}

const MODE_ANSWER = {
  type: 'object',
  required: ['queue', 'base', 'command', 'why'],
  properties: {
    queue: { type: 'boolean', description: 'The base branch has a merge queue.' },
    base: { type: 'string', description: "The pull request's base branch." },
    approved: { type: 'boolean', description: 'With a queue: the pull request has a valid approval, or needs none.' },
    review: { type: ['string', 'null'], description: "With a queue: GitHub's review decision; null when it has none." },
    command: { type: 'string', description: 'The command that merges the pull request, or adds it to the queue.' },
    why: { type: 'string' },
  },
  additionalProperties: false,
}

const STATE_ANSWER = {
  type: 'object',
  required: ['state', 'number'],
  properties: {
    state: { type: 'string', enum: ['merged', 'queued', 'waiting', 'removed', 'closed', 'open'] },
    number: { type: 'integer' },
    position: { type: ['integer', 'null'], description: "queued: the pull request's place in the queue." },
    entry: { type: ['string', 'null'], description: "queued: the queue entry's state." },
    reason: { type: 'string', description: "removed: GitHub's reason." },
    at: { type: ['string', 'null'], description: 'removed: when the queue removed it.' },
  },
  additionalProperties: false,
}

export const MERGE_QUEUE_TOOL: CoreTool = {
  name: 'merge_queue',
  title: 'Merge queue',
  description:
    "Tells how a GitHub pull request merges, and where it stands in its base branch's merge queue. op mode: whether the base branch has a merge queue, whether the pull request has a valid approval, and the command that merges it or adds it to the queue, with why. op state: merged, queued (with its position), waiting (auto-merge is on), removed (the queue removed it, with GitHub's reason), closed, or open. It reads GitHub with gh and changes nothing.",
  inputSchema: {
    type: 'object',
    required: ['op', 'pr'],
    properties: {
      op: { type: 'string', enum: OPS, description: 'mode: how it merges. state: where it stands.' },
      pr: { type: 'string', description: 'The pull request: its number, its URL, or its branch, as gh takes it.' },
      repo: { type: 'string', description: "OWNER/NAME. Needed when pr is not a URL and the session's folder is not a checkout of the repo." },
    },
    additionalProperties: false,
  },
  // One schema per op: an answer has `queue` (mode) or `state` (state), never both.
  outputSchema: { type: 'object', oneOf: [MODE_ANSWER, STATE_ANSWER] },
  annotations: { readOnlyHint: true, openWorldHint: true },
  call: async ($, input): Promise<ToolAnswer> => {
    const parsed = inputOf(input)
    return typeof parsed === 'string' ? { refusal: parsed } : mergeQueue($, parsed)
  },
}
