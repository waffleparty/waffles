// A lock between processes on 1 machine, kept in a lock file: the queue of backlog-queue.ts and the test slots of
// builders.ts.
//
// Node has no flock, and flock does not exist on Windows. Here the lock is a file that 1 process creates exclusively
// (open with O_CREAT | O_EXCL, Node's 'wx'), which no other process can then create, and which holds the creator's
// pid. Release deletes the file. A lock whose pid no longer runs is stale, and the next process that wants it deletes
// it and takes it. While pids are not reused, that gives what flock gives: 1 holder at a time, and a holder that died,
// killed or not, holds nothing. A caller that holds the
// lock only for moments can also name an age past which a lock is stale even when its pid runs, against a pid that
// the system gave to a new process.
//
// Taking over a stale lock is itself locked, by a guard file next to the lock: 2 processes that both find the lock
// stale would otherwise each delete it, and the second would delete the lock that the first had just created.

import { closeSync, fstatSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'

// The creator writes its pid right after it creates the file. A file with no pid for this long belongs to a process
// that died between the 2 steps, or to an earlier version of the test slots, which kept no pid in it.
const NO_PID_MS = 10_000
// A guard is held for a few file operations. One this old was left by a process that died while holding it.
const GUARD_MS = 10_000
const POLL_MS = 50

export type LockOptions = {
  /** An age in milliseconds past which a lock is stale even when its holder runs. Unset, only a holder's end frees it. */
  staleMs?: number
}

export type Held = {
  /** Deletes the lock file, unless another process took it over as stale. Once is enough; again does nothing. */
  release(): void
}

type Holder = { pid: number | null; ino: bigint; mtimeMs: number; text: string }

function holder(path: string): Holder | null {
  try {
    const stat = statSync(path, { bigint: true })
    const text = readFileSync(path, 'utf8')
    const pid = /^[0-9]+\n?$/.test(text) ? Number(text.trim()) : null
    return { pid, ino: stat.ino, mtimeMs: Number(stat.mtimeMs), text }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Whether a process with this pid runs. Signal 0 tests for it, on Windows too; EPERM means it runs as another user. */
export function alive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function stale(found: Holder, options: LockOptions): boolean {
  const age = Date.now() - found.mtimeMs
  if (found.pid === null) return age > NO_PID_MS
  if (!alive(found.pid)) return true
  return options.staleMs !== undefined && age > options.staleMs
}

/** Deletes the stale lock that was found, under the guard, if it is still that same file with the same content. */
function takeOver(path: string, found: Holder): void {
  const guard = `${path}.break`
  let fd: number
  try {
    fd = openSync(guard, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    try {
      if (Date.now() - statSync(guard).mtimeMs > GUARD_MS) unlinkSync(guard)
    } catch {
      // Another process removed it first.
    }
    return
  }
  closeSync(fd)
  try {
    const now = holder(path)
    if (now !== null && now.ino === found.ino && now.text === found.text) unlinkSync(path)
  } finally {
    try {
      unlinkSync(guard)
    } catch {
      // A process that found the guard too old removed it.
    }
  }
}

/** Takes the lock at path if it is free or stale, else returns null at once. */
export function tryLock(path: string, options: LockOptions = {}): Held | null {
  // A second try follows a stale lock's removal; a third, a lock that its holder released while this one looked.
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number
    try {
      fd = openSync(path, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const found = holder(path)
      if (found === null) continue
      if (!stale(found, options)) return null
      takeOver(path, found)
      continue
    }
    let ino: bigint
    try {
      writeSync(fd, `${process.pid}\n`)
      ino = fstatSync(fd, { bigint: true }).ino
    } finally {
      closeSync(fd)
    }
    let released = false
    return {
      release() {
        if (released) return
        released = true
        const now = holder(path)
        if (now !== null && now.ino === ino && now.pid === process.pid) {
          try {
            unlinkSync(path)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      },
    }
  }
  return null
}

/** Blocks the thread for ms milliseconds. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Takes the lock at path, waiting as long as another process holds it. */
export function lock(path: string, options: LockOptions = {}): Held {
  for (;;) {
    const held = tryLock(path, options)
    if (held !== null) return held
    sleepSync(POLL_MS)
  }
}
