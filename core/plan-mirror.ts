import { notStarted } from './commands.ts'
import type { Host, RunResult } from './host.ts'
import { outlineIn, stateIn } from './plan-store.ts'
import { remoteName } from './settings.ts'

/*
 * Keeps a copy of the plan outline on the remote, so another machine or a fresh clone finds it. The
 * goal files are in the git dir, which no push carries: this copy is how they travel.
 *
 * The ref. One ref per branch, `refs/waffles/plan/<branch>`, with the branch name as it is: `feat/x`
 * gives `refs/waffles/plan/feat/x`. Git never lets one branch name be the folder of another, so 2
 * branches never share a ref. A detached HEAD has no branch: there nothing is copied or restored.
 *
 * What it holds. A commit whose tree is the files of the plan folder, `<git dir>/waffles/plan/`: the
 * goal files, `assumed-for-you.md`, and any other Markdown file there, all at the top of the tree. It is
 * made with git's plumbing (`hash-object -w`, `mktree`, `commit-tree`, `update-ref`), which leaves the
 * index, the working tree, and every branch as they are. The commit is never signed, and names waffles
 * as its author and committer, so it needs neither the person's key nor their identity. Its parent is
 * the ref's last commit, so the ref keeps the outline's history.
 *
 * The remote. The one the branch's upstream names (`branch.<branch>.remote`), else $WAFFLES_REMOTE, else
 * `origin`. With
 * neither, nothing is copied or restored.
 *
 * When it is written. After a `git push` or a `gh pr create` that worked, by `afterShell` in
 * checkpoint.ts, in the folder the command ran in. The local ref is the copy last pushed or fetched:
 * when the plan folder's tree is the same as its tree, nothing is pushed. Otherwise the new commit is
 * pushed with force, then the local ref moves to it. A failure never fails the command or the
 * checkpoint: the model reads one line.
 *
 * Restore. At the session's first plan outline call or poll, once per session: when the plan folder
 * holds no Markdown file and the branch's ref is on the remote, it is fetched into the local ref and its
 * files are written. A file that is already there is never written over.
 *
 * Both sides changed. Local wins: a plan folder that holds a file is not restored, and the next push
 * writes the local tree over the ref.
 *
 * After the merge. After a `gh pr merge` that worked, when gh reports the pull request merged or
 * closed, the ref of its head branch is deleted on the remote and in the local repository. A pull
 * request merged another way (on GitHub's site, or by a merge queue) leaves its ref, which
 * `git push origin --delete refs/waffles/plan/<branch>` removes.
 *
 * Hosting. Git and GitHub take pushes to refs outside `refs/heads` and `refs/tags`. GitHub shows them
 * nowhere on its site, and a clone or a fetch of the branches does not fetch them.
 */

/** The ref that holds a branch's plan outline, on the remote and in the local repository. */
export const planRef = (branch: string) => `refs/waffles/plan/${branch}`

// A file of the plan folder the ref holds: Markdown, not hidden, at the top of the folder.
const NAME = /^[^./][^/]*\.md$/
// The restore's commands together: the session's first poll waits for them, network included.
const RESTORE_MS = 10_000
// The copy's commands together, the push included.
const MIRROR_MS = 30_000
// The commit names waffles, is never signed, and asks for nothing.
const IDENTITY = ['-c', 'user.name=waffles', '-c', 'user.email=waffles@localhost', '-c', 'commit.gpgSign=false']

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
const firstLine = (text: string) => text.trim().split('\n')[0]?.trim() ?? ''

/** A git command that failed: its message names the command and git's first line. */
class GitError extends Error {}

/** Where git runs (the host's working directory when `cwd` is left out), and when its time runs out (ms since the epoch). */
type Git = { $: Host; cwd?: string; deadline: number }

async function git(g: Git, args: readonly string[], stdin?: string): Promise<string> {
  const command = args.find(arg => /^[a-z][a-z-]*$/.test(arg)) ?? ''
  const timeoutMs = g.deadline - (await g.$.clock.now())
  if (timeoutMs <= 0) throw new GitError(`git ${command} ran out of time`)
  let done: RunResult
  try {
    done = await g.$.process.run(['git', ...args], { cwd: g.cwd, stdin, timeoutMs })
  } catch (error) {
    throw new GitError(notStarted(`git ${command}`, error))
  }
  if (done.exitCode !== 0) throw new GitError(`git ${command} failed: ${firstLine(done.stderr) || firstLine(done.stdout) || `exit code ${done.exitCode}`}`)
  return done.stdout
}

async function tryGit(g: Git, args: readonly string[]): Promise<string | null> {
  try {
    return await git(g, args)
  } catch (error) {
    if (error instanceof GitError) return null
    throw error
  }
}

/** The checked-out branch; null at a detached HEAD. */
async function branchOf(g: Git): Promise<string | null> {
  return (await tryGit(g, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || null
}

/** The remote the branch's upstream names, else $WAFFLES_REMOTE or origin; null when there is neither. */
async function remoteOf(g: Git, branch: string): Promise<string | null> {
  const named = (await tryGit(g, ['config', '--get', `branch.${branch}.remote`]))?.trim()
  // `.` is the repository itself: a branch that tracks another local branch.
  if (named && named !== '.') return named
  const remotes = (await tryGit(g, ['remote']))?.split('\n').map(line => line.trim()) ?? []
  const main = await remoteName(g.$)
  return remotes.includes(main) ? main : null
}

/** The names of the files the ref holds that are in the plan folder, sorted; empty when there is no folder. */
async function planFiles($: Host, outline: string): Promise<string[]> {
  if (!(await $.fs.exists(outline))) return []
  if ((await $.fs.stat(outline)).kind !== 'dir') return []
  return (await $.fs.list(outline))
    .filter(entry => entry.kind === 'file' && NAME.test(entry.name))
    .map(entry => entry.name)
    .sort()
}

/**
 * Copies the plan folder of the checkout at `folder` to its branch's ref on the remote, after a push
 * that worked. Returns the line the model reads when it fails; null when it worked, when nothing changed,
 * and when there is nothing to copy or nowhere to copy it to. Never throws.
 */
export async function mirrorPlan($: Host, folder: string): Promise<string | null> {
  let remote: string | null = null
  try {
    const g: Git = { $, cwd: folder, deadline: (await $.clock.now()) + MIRROR_MS }
    const gitDir = (await tryGit(g, ['rev-parse', '--path-format=absolute', '--git-dir']))?.trim().replace(/\/+$/, '')
    if (!gitDir) return null
    const branch = await branchOf(g)
    if (branch === null) return null
    const outline = outlineIn(stateIn(gitDir))
    const names = await planFiles($, outline)
    if (!names.length) return null
    remote = await remoteOf(g, branch)
    if (remote === null) return null
    const blobs = (await git(g, ['hash-object', '-w', '--no-filters', '--', ...names.map(name => `${outline}/${name}`)])).trim().split('\n')
    if (blobs.length !== names.length) throw new GitError(`git hash-object gave ${blobs.length} objects for ${names.length} files`)
    const tree = (await git(g, ['mktree', '-z'], names.map((name, i) => `100644 blob ${blobs[i]}\t${name}\0`).join(''))).trim()
    const ref = planRef(branch)
    const last = (await tryGit(g, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]))?.trim() || null
    if (last !== null && (await git(g, ['rev-parse', `${last}^{tree}`])).trim() === tree) return null
    const parent = last === null ? [] : ['-p', last]
    const commit = (await git(g, [...IDENTITY, 'commit-tree', '--no-gpg-sign', tree, ...parent, '-m', `waffles plan outline of ${branch}`])).trim()
    // The plugin's own ref: the repository's pre-push hooks are for its branches.
    await git(g, ['push', '--quiet', '--no-verify', remote, `+${commit}:${ref}`])
    await git(g, ['update-ref', ref, commit])
    return null
  } catch (error) {
    return `waffles plan outline: the copy on ${remote ?? 'the remote'} was not updated: ${messageOf(error)}`
  }
}

/**
 * Writes the files of the branch's ref on the remote into an empty plan folder: no Markdown file is
 * there. Never writes over a file. Git runs in the host's working directory, as `findPlanRoot`'s does.
 * Returns the names it wrote; throws when git fails.
 */
export async function restorePlan($: Host, outline: string): Promise<string[]> {
  if ((await planFiles($, outline)).length) return []
  const g: Git = { $, deadline: (await $.clock.now()) + RESTORE_MS }
  const branch = await branchOf(g)
  if (branch === null) return []
  const remote = await remoteOf(g, branch)
  if (remote === null) return []
  const ref = planRef(branch)
  // One round trip when the remote has no copy, which is the common case.
  const listed = (await git(g, ['ls-remote', remote, ref])).split('\n')
  if (!listed.some(line => line.endsWith(`\t${ref}`))) return []
  await git(g, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-gc', remote, `+${ref}:${ref}`])
  const written: string[] = []
  for (const entry of (await git(g, ['ls-tree', '-z', ref])).split('\0')) {
    const m = /^100644 blob ([0-9a-f]+)\t(.+)$/s.exec(entry)
    if (!m || !NAME.test(m[2]!)) continue
    const path = `${outline}/${m[2]}`
    if (await $.fs.exists(path)) continue
    await $.fs.write(path, await git(g, ['cat-file', 'blob', m[1]!]))
    written.push(m[2]!)
  }
  return written
}

/**
 * Deletes the branch's ref on the remote and in the local repository of the checkout at `folder`: its
 * pull request is merged or closed. Returns the line the model reads when it fails; null when it worked
 * or there was no ref. Never throws.
 */
export async function dropPlan($: Host, folder: string, branch: string): Promise<string | null> {
  let remote: string | null = null
  try {
    const g: Git = { $, cwd: folder, deadline: (await $.clock.now()) + MIRROR_MS }
    const ref = planRef(branch)
    remote = await remoteOf(g, branch)
    if (remote !== null) {
      const listed = (await git(g, ['ls-remote', remote, ref])).split('\n')
      if (listed.some(line => line.endsWith(`\t${ref}`))) await git(g, ['push', '--quiet', '--no-verify', remote, `:${ref}`])
    }
    await git(g, ['update-ref', '-d', ref])
    return null
  } catch (error) {
    return `waffles plan outline: the copy on ${remote ?? 'the remote'} was not removed: ${messageOf(error)}`
  }
}
