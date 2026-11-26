// Tell how a pull request merges (directly, or through its base branch's merge queue), and where it stands.
//
// Usage:
//   node merge-queue.ts mode PR [--repo OWNER/NAME]
//   node merge-queue.ts state PR [--repo OWNER/NAME]
//
// PR is a number, a URL, or a branch, as gh takes it. --repo is needed when PR is not a URL and the folder is not the
// repo.
//
// mode reads the rules that apply to the pull request's base branch (`gh api repos/<o>/<r>/rules/branches/<base>`). With
// a `merge_queue` rule, "merge" means "add to the queue": `gh pr merge <n>` (no merge method, no --auto), and the queue
// tests it on the newest base branch and merges it later, or removes it. GitHub adds it only when it has a valid
// approval: its review decision (`gh pr view --json reviewDecision`) is APPROVED, or empty when no review is required.
// Without one, GitHub refuses (also for an admin), and the command is the admin bypass, `gh pr merge <n> --admin` with
// the queue's merge method, which merges at once past the queue: a run uses it as its --admin rule says, and outside a
// run the pull request waits for a reviewer. Without a queue, it merges at once: `gh pr merge <n> --squash` with the
// subject and body passed. A plan with no rulesets (a private repo on GitHub's free plan) has no queue. Prints 1 line
// of JSON: queue (true or false), base, approved (with a queue), the review decision, the command, and why.
//
// state prints 1 line of JSON with "state" one of:
//   merged    the pull request is merged;
//   queued    it is in the merge queue ("position", and the entry's "entry" state);
//   waiting   auto-merge is on, and it joins the queue (or merges) once its checks pass;
//   removed   the queue removed it, and auto-merge is off ("reason", from GitHub): move the item back to in work, with
//             a note that gives the reason;
//   closed    it was closed without a merge;
//   open      none of these.
//
// Exit codes: 0 when gh answered; 1 when it did not, with its message on stderr; 2 for wrong arguments.

import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const USAGE = 'usage: node merge-queue.ts mode|state PR [--repo OWNER/NAME]'
const URL = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
const NO_RULESETS = 'Upgrade to GitHub Pro'
// A merge queue rule's merge_method, as a `gh pr merge` flag.
const METHODS = new Map([['MERGE', '--merge'], ['SQUASH', '--squash'], ['REBASE', '--rebase']])
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

type Out = { write(text: string): unknown }
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

class Failed extends Error {}

// gh gets the caller's stdin, as when it runs from the shell. A gh that cannot start throws, and the script ends with exit 1.
function run(args: string[]) {
  const done = spawnSync('gh', args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: Infinity })
  if (done.error) throw done.error
  return done
}

function gh(...args: string[]): string {
  const done = run(args)
  if (done.status !== 0) throw new Failed(`gh ${args.slice(0, 2).join(' ')} failed: ${(done.stderr || done.stdout).trim()}`)
  return done.stdout
}

function pullRequest(selector: string, repo: string | undefined) {
  const flags = repo ? ['-R', repo] : []
  const view = JSON.parse(gh('pr', 'view', selector, ...flags, '--json', 'number,url,baseRefName,reviewDecision')) as View
  const match = URL.exec(view.url)
  if (!match) throw new Failed(`gh gave no GitHub URL for ${selector}: ${view.url}`)
  const [, owner = '', name = ''] = match
  return { owner, name, number: view.number, base: view.baseRefName, review: view.reviewDecision || '' }
}

// encodeURIComponent leaves !'()* as they are; the branch is one path segment, so they are escaped too.
function quote(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function mode(selector: string, repo?: string): object {
  const { owner, name, number, base, review } = pullRequest(selector, repo)
  const done = run(['api', `repos/${owner}/${name}/rules/branches/${quote(base)}`])
  let rules: Rule[] = []
  let why: string | undefined
  if (done.status !== 0 && (done.stdout + done.stderr).includes(NO_RULESETS)) {
    why = "the repo's plan has no rulesets, so its base branch has no merge queue"
  } else if (done.status !== 0) {
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

export function state(selector: string, repo?: string): object {
  const { owner, name, number } = pullRequest(selector, repo)
  // Owner and name go as strings (-f), so an all-digit name is not sent as a number; the number as -F.
  const data = JSON.parse(gh('api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`, '-f', `query=${QUERY}`))
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

export function main(argv: string[], out: Out = process.stdout, err: Out = process.stderr): number {
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
  const [command, pr, ...extra] = args.positionals
  if ((command !== 'mode' && command !== 'state') || pr === undefined || extra.length) {
    err.write(`expected mode or state, then 1 pull request (${USAGE})\n`)
    return 2
  }
  let result: object
  try {
    result = command === 'mode' ? mode(pr, args.values.repo) : state(pr, args.values.repo)
  } catch (error) {
    if (!(error instanceof Failed)) throw error
    err.write(`${error.message}\n`)
    return 1
  }
  out.write(`${JSON.stringify(result)}\n`)
  return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
