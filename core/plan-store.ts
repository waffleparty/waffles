import type { Host } from './host.ts'
import { parseGoal, serializeGoal, PlanError, type Goal } from './plan-tree.ts'

/** A session lock older than this (ms) no longer holds its goal. */
export const STALE_MS = 120_000

/** A goal file, parsed, or with the error that kept it from being read or parsed. */
export type GoalFile = { slug: string; goal: Goal } | { slug: string; error: string }

/** The part of the host the store calls, which a test can stand in for whole; every Host is one. The store reads only text. */
export type StoreEngine = {
  fs: Host['fs']
  process: Host['process']
  session: Pick<Host['session'], 'cwd'>
}

// The lines git prints, or null when it fails or prints nothing.
async function gitLines($: StoreEngine, args: string[]): Promise<string[] | null> {
  try {
    const git = await $.process.run(['git', 'rev-parse', ...args])
    return git.exitCode === 0 && git.stdout.trim() ? git.stdout.trim().split('\n') : null
  } catch {
    return null
  }
}

/**
 * The plan outline's folders, as absolute paths. `outline` holds the goal files: `.tmp/plan` at the
 * top level of the checkout, committed on the branch, so a clone reads it after a pull. `state` holds
 * the locks and the session records: `waffles` in the checkout's git dir, which git never commits. Each
 * worktree has its own of both.
 */
export type Where = { outline: string; state: string }

/**
 * `Where` for this checkout, and whether git gave it. Where git gave nothing, both folders are in the
 * working directory's `.tmp`, and `isFromGit` is false: outside git, in a bare repository, which has
 * no checkout, or where git failed (a timeout). `isGitDown` tells the last apart: the working
 * directory or a folder above it holds a `.git`, file or folder, so the fallback folders would be in
 * a working tree, where nothing may be written.
 */
export async function findPlanRoot($: StoreEngine): Promise<Where & { isFromGit: boolean; isGitDown: boolean }> {
  const lines = await gitLines($, ['--path-format=absolute', '--show-toplevel', '--git-dir'])
  const [top, dir] = (lines ?? []).map(line => line.replace(/\/+$/, ''))
  if (top && dir) return { outline: `${top}/.tmp/plan`, state: `${dir}/waffles`, isFromGit: true, isGitDown: false }
  const cwd = await $.session.cwd()
  return { outline: `${cwd}/.tmp/plan`, state: `${cwd}/.tmp/waffles`, isFromGit: false, isGitDown: await isInWorkTree($, cwd) }
}

// Whether the folder or one above it holds a `.git`: a folder in a clone, a file in a worktree or a submodule.
async function isInWorkTree($: StoreEngine, folder: string): Promise<boolean> {
  for (let dir = folder.replace(/\/+$/, ''); ; dir = dir.slice(0, dir.lastIndexOf('/'))) {
    if (await $.fs.exists(`${dir}/.git`)) return true
    if (!dir.includes('/')) return false
  }
}

/** `findPlanRoot` without whether git gave it. */
export async function planRoot($: StoreEngine): Promise<Where> {
  const { outline, state } = await findPlanRoot($)
  return { outline, state }
}

/** A goal file's path as the person reads it, relative to the checkout. */
export const goalName = (slug: string) => `.tmp/plan/${slug}.md`
const goalPath = (outline: string, slug: string) => `${outline}/${slug}.md`
const lockPath = (state: string, slug: string) => `${state}/locks/${slug}.json`
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Whether a read that failed found nothing there, rather than failing on a file that is there. The
// question goes to `exists`, as the errors a read rejects with differ by system.
async function isGone($: StoreEngine, path: string): Promise<boolean> {
  return !(await $.fs.exists(path))
}

// Throws PlanError when something is at the path but isn't a folder. A write makes a missing folder.
async function ensureFolder($: StoreEngine, path: string): Promise<void> {
  if ((await $.fs.exists(path)) && (await $.fs.stat(path)).kind !== 'dir') throw new PlanError(`Not a folder: ${path}`)
}

// Writes the state folder's `.gitignore`, `*`, when absent. In a git dir it changes nothing; outside
// git, in `.tmp/waffles`, it keeps the locks and records out of a repository made there later. Throws
// PlanError when the state folder isn't a folder.
async function ensureState($: StoreEngine, state: string): Promise<void> {
  const path = `${state}/.gitignore`
  if (await $.fs.exists(path)) return
  await ensureFolder($, state)
  await $.fs.write(path, '*\n')
}

// Each goal file as last read, by path, with the size and modification time it had then. A poll every
// 5 s re-reads only the files that changed, so done goals left in the outline folder cost a listing,
// not a read.
// Only what a read found is kept, parsed or not: a read that failed is tried again by the next listing.
// Module variables start over on a reload.
const parsed = new Map<string, { size: number; mtimeMs: number; file: GoalFile }>()
// How many times this process has written or removed each goal file. A listing runs outside the queue
// that orders writes, so one that read a file before a write keeps what it read only when the count
// hasn't moved: else its entry could outlive the write, where the new file has the same size and time.
const generation = new Map<string, number>()

function invalidate(path: string): void {
  parsed.delete(path)
  generation.set(path, (generation.get(path) ?? 0) + 1)
}

/**
 * Every goal file in the outline folder, sorted by slug, each read through the cache; a file that can't
 * be read or parsed carries its error. `outline` saves a git run.
 */
export async function listGoals($: StoreEngine, outline?: string): Promise<GoalFile[]> {
  const folder = outline ?? (await planRoot($)).outline
  // Nothing there, or a folder that is a file.
  const kind = await $.fs.stat(folder).then(
    stat => stat.kind,
    async (error: unknown) => {
      if (await isGone($, folder)) return null
      throw error
    },
  )
  if (kind !== 'dir') return []
  const entries = (await $.fs.list(folder))
    .filter(e => e.kind === 'file' && e.name.endsWith('.md') && !e.name.startsWith('.'))
    .map(e => ({ ...e, slug: e.name.slice(0, -3) }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  const files: GoalFile[] = []
  for (const { slug, size, mtimeMs } of entries) {
    const path = goalPath(folder, slug)
    const known = parsed.get(path)
    if (known && known.size === size && known.mtimeMs === mtimeMs) {
      files.push(known.file)
      continue
    }
    const before = generation.get(path)
    let text: string
    try {
      text = await readGoal($, folder, slug)
    } catch (error) {
      files.push({ slug, error: messageOf(error) })
      continue
    }
    let file: GoalFile
    try {
      file = { slug, goal: parseGoal(text, goalName(slug)) }
    } catch (error) {
      file = { slug, error: messageOf(error) }
    }
    if (generation.get(path) === before) parsed.set(path, { size, mtimeMs, file })
    files.push(file)
  }
  // Forget the files gone from this folder.
  const listed = new Set(entries.map(e => `${folder}/${e.name}`))
  for (const path of parsed.keys()) if (path.startsWith(`${folder}/`) && !listed.has(path)) parsed.delete(path)
  return files
}

/** Reads and parses one goal file. Throws PlanError when it is missing, can't be read, or is malformed. `outline` saves a git run. */
export async function loadGoal($: StoreEngine, slug: string, outline?: string): Promise<Goal> {
  outline ??= (await planRoot($)).outline
  return parseGoal(await readGoal($, outline, slug), goalName(slug))
}

/** Whether the goal has a file in this checkout's outline folder. */
export async function hasGoalFile($: StoreEngine, slug: string, { outline }: Pick<Where, 'outline'>): Promise<boolean> {
  return $.fs.exists(goalPath(outline, slug))
}

async function readGoal($: StoreEngine, folder: string, slug: string): Promise<string> {
  const path = goalPath(folder, slug)
  try {
    return await $.fs.read(path)
  } catch (error) {
    if (await isGone($, path)) throw new PlanError(`No goal file ${goalName(slug)}`)
    throw new PlanError(`Can't read ${goalName(slug)}: ${messageOf(error)}`)
  }
}

/** Writes a goal file. Throws PlanError when the outline folder isn't a folder. `outline` saves a git run. */
export async function saveGoal($: StoreEngine, slug: string, goal: Goal, outline?: string): Promise<void> {
  outline ??= (await planRoot($)).outline
  await ensureFolder($, outline)
  const path = goalPath(outline, slug)
  // A write this process makes is never taken for the file it replaced, however close the times: not
  // from the cache, nor from a listing under way.
  invalidate(path)
  try {
    await $.fs.write(path, serializeGoal(goal))
  } finally {
    invalidate(path)
  }
}

/** Deletes a goal file. `outline` saves a git run. */
export async function removeGoal($: StoreEngine, slug: string, outline?: string): Promise<void> {
  const path = goalPath(outline ?? (await planRoot($)).outline, slug)
  invalidate(path)
  await $.fs.remove(path)
}

type Lock = { session: string; heartbeat: string }

// The lock at the path while it is live. A lock that is missing, stale, or doesn't parse is none; so is
// one that can't be read, as the pane and the context block list goals through here and a disk error
// mustn't take them down. A claim then writes over that lock: see `claim`.
async function readLock($: StoreEngine, path: string, now: number): Promise<Lock | null> {
  let text: string
  try {
    text = await $.fs.read(path)
  } catch {
    return null
  }
  let lock: Partial<Lock> | null
  try {
    lock = JSON.parse(text) as Partial<Lock> | null
  } catch {
    return null
  }
  if (typeof lock !== 'object' || lock === null) return null
  const beat = typeof lock.heartbeat === 'string' ? Date.parse(lock.heartbeat) : NaN
  return typeof lock.session === 'string' && now - beat < STALE_MS ? (lock as Lock) : null
}

/** The session ID that holds a live lock on the goal, or null. `state` saves a git run. */
export async function holder($: StoreEngine, slug: string, now: number, state?: string): Promise<string | null> {
  const lock = await readLock($, lockPath(state ?? (await planRoot($)).state, slug), now)
  return lock?.session ?? null
}

/**
 * Takes the goal's lock, or refreshes this session's heartbeat. False when another session's lock is
 * live. `state` saves a git run. Throws PlanError when the state folder isn't a folder.
 *
 * The lock is read and then written: the host's files have no exclusive create, so 2 sessions that claim within
 * the same few milliseconds can both win, the later write holding the lock. The loser finds out at its
 * next heartbeat (every 30 s), whose claim fails on the winner's live lock, and stops holding the goal.
 */
export async function claim($: StoreEngine, slug: string, session: string, now: number, state?: string): Promise<boolean> {
  state ??= (await planRoot($)).state
  const live = await readLock($, lockPath(state, slug), now)
  if (live && live.session !== session) return false
  await ensureState($, state)
  await $.fs.write(lockPath(state, slug), JSON.stringify({ session, heartbeat: new Date(now).toISOString() }))
  return true
}

// A session ID names a file: only IDs that can't leave the folder have a record.
const SESSION = /^[\w-]+$/
/** Another session's record last written more than this (ms) ago is removed by the first poll or call of a later process. */
export const RECORD_MS = 30 * 24 * 60 * 60 * 1000
const recordsPath = (state: string) => `${state}/sessions`
const recordPath = (state: string, session: string) => `${recordsPath(state)}/${session}.json`

/**
 * Records the goal this session has active, so a process that resumes the session (`claude --resume`,
 * or `/resume` in a running one) makes it active again. Unlike the lock, it stays when the session
 * ends. `state` saves a git run. Throws PlanError when the state folder isn't a folder.
 */
export async function recordActive($: StoreEngine, session: string, slug: string, state?: string): Promise<void> {
  if (!SESSION.test(session)) return
  state ??= (await planRoot($)).state
  await ensureState($, state)
  await $.fs.write(recordPath(state, session), JSON.stringify({ goal: slug }))
}

/** Removes this session's record: it has no active goal to come back to. `state` saves a git run. */
export async function forgetActive($: StoreEngine, session: string, state?: string): Promise<void> {
  if (!SESSION.test(session)) return
  const path = recordPath(state ?? (await planRoot($)).state, session)
  if (await $.fs.exists(path)) await $.fs.remove(path)
}

/**
 * The slug this session's record names, or null: no record, or one that can't be read or doesn't
 * parse. The caller checks the slug before it names a file. `state` saves a git run.
 */
export async function recordedActive($: StoreEngine, session: string, state?: string): Promise<string | null> {
  if (!SESSION.test(session)) return null
  let text: string
  try {
    text = await $.fs.read(recordPath(state ?? (await planRoot($)).state, session))
  } catch {
    return null
  }
  try {
    const record = JSON.parse(text) as { goal?: unknown } | null
    return typeof record?.goal === 'string' ? record.goal : null
  } catch {
    return null
  }
}

/** Removes the records of other sessions last written more than RECORD_MS ago. `state` saves a git run. */
export async function pruneRecords($: StoreEngine, session: string, now: number, state?: string): Promise<void> {
  const dir = recordsPath(state ?? (await planRoot($)).state)
  if (!(await $.fs.exists(dir))) return
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || entry.name === `${session}.json` || now - entry.mtimeMs <= RECORD_MS) continue
    await $.fs.remove(`${dir}/${entry.name}`)
  }
}

/**
 * Removes the goal's lock when this session holds it, live or not. No lock, or one that doesn't parse,
 * is nothing to release; a lock that is there but can't be read rejects with the read's error. `state`
 * saves a git run.
 */
export async function release($: StoreEngine, slug: string, session: string, state?: string): Promise<void> {
  const path = lockPath(state ?? (await planRoot($)).state, slug)
  let text: string
  try {
    text = await $.fs.read(path)
  } catch (error) {
    if (await isGone($, path)) return
    throw error
  }
  let lock: Partial<Lock> | null
  try {
    lock = JSON.parse(text) as Partial<Lock> | null
  } catch {
    return
  }
  if (lock?.session !== session) return
  await $.fs.remove(path)
}
