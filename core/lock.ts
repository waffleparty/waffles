import type { Host } from './host.ts'

/*
 * A lock between sessions and processes on 1 machine, kept in a lock file that the Host creates exclusively
 * (`fs.create`): the backlog queue's. While the file is there, no other caller can create it, and release removes it.
 *
 * The holder writes a token into the file: `waffles <session ID> <random>`. The Host names no process, so a holder
 * that ended without releasing (killed, or its machine asleep) is not seen at once. The stale rule goes by age
 * instead: a lock file last written more than `staleMs` ago is stale, whoever holds it, and the next caller removes it
 * and takes the lock. A holder keeps the lock for moments (one read and one write of the queue), far less than
 * `staleMs`, so a stale lock is one whose holder is gone. A caller waits at most `waitMs` for a lock that is held,
 * then fails; with `waitMs` past `staleMs`, it only fails when it cannot create the file. A lock file that an earlier
 * version wrote, which holds a process ID (scripts/lock.ts), follows the same rule.
 *
 * Taking over a stale lock is itself guarded by a second file, `<lock>.break`, created the same way: 2 callers that
 * both find the lock stale would otherwise each remove it, and the second would remove the lock that the first had
 * just taken. Under the guard, the lock is removed only while it is still the file that was found stale (the same
 * text, written at the same time). A guard older than 10 s was left by a caller that ended while it held it, and is
 * removed. Release removes the lock only while it still holds the holder's token.
 */

const GUARD_MS = 10_000
const POLL_MS = 50

export type LockOptions = {
  /** The age in milliseconds past which a lock is stale. */
  staleMs: number
  /** How long to wait for a lock that is held. */
  waitMs: number
}

/** The lock stayed held for all of the wait. */
export class Busy extends Error {}

type Found = { text: string; mtimeMs: number }

// The file's text and when it was written; null when it is gone, or can't be read, as one being removed.
async function found($: Host, path: string): Promise<Found | null> {
  try {
    const text = await $.fs.read(path)
    return { text, mtimeMs: (await $.fs.stat(path)).mtimeMs }
  } catch {
    return null
  }
}

async function removeIf($: Host, path: string, text: string): Promise<void> {
  if ((await found($, path))?.text === text) await $.fs.remove(path)
}

/** Removes the stale lock that was found, under the guard, if it is still that same file. */
async function takeOver($: Host, path: string, stale: Found, token: string): Promise<void> {
  const guard = `${path}.break`
  if (!(await $.fs.create(guard, token))) {
    const held = await found($, guard)
    if (held !== null && (await $.clock.now()) - held.mtimeMs > GUARD_MS) await removeIf($, guard, held.text)
    return
  }
  try {
    const now = await found($, path)
    if (now !== null && now.text === stale.text && now.mtimeMs === stale.mtimeMs) await $.fs.remove(path)
  } finally {
    await removeIf($, guard, token)
  }
}

/** Takes the lock if it is free or stale; false when it is held. Rejects when the file can't be created. */
async function tryTake($: Host, path: string, token: string, staleMs: number): Promise<boolean> {
  // A second try follows a stale lock's removal; a third, a lock that its holder released while this one looked.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await $.fs.create(path, token)) return true
    const lock = await found($, path)
    if (lock === null) continue
    if ((await $.clock.now()) - lock.mtimeMs <= staleMs) return false
    await takeOver($, path, lock, token)
  }
  return false
}

const random = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)

/**
 * Runs `body` holding the lock at `path`, waiting while another caller holds it. Rejects with Busy when the wait
 * ends, and with the Host's error when the lock file can't be created (a folder that can't be written).
 */
export async function withLock<T>($: Host, path: string, { staleMs, waitMs }: LockOptions, body: () => Promise<T>): Promise<T> {
  const token = `waffles ${await $.session.id()} ${random()}\n`
  const until = (await $.clock.now()) + waitMs
  while (!(await tryTake($, path, token, staleMs))) {
    if ((await $.clock.now()) >= until) throw new Busy(`${path} is held by another session`)
    await $.clock.sleep(POLL_MS)
  }
  try {
    return await body()
  } finally {
    // A release that fails leaves a lock that goes stale.
    await removeIf($, path, token).catch(() => undefined)
  }
}
