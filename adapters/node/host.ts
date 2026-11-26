import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { INITIAL, type FileKind, type Host, type Names, type SessionState } from '../../core/host.ts'

/**
 * The core's host on plain Node.js, for a platform that hands the core no file or process calls of
 * its own: the command adapter, the MCP server, and OpenCode. The session's values and the person's
 * values are JSON files in the state folder, so every process that serves the session reads the same
 * ones. A caller replaces any part its platform does better (`parts`).
 */
export type NodeHostInit = {
  sessionId: string
  /** The shell's working directory. */
  cwd: string
  names: Names
  /** Where the values are kept; `stateFolder()` by default. */
  stateFolder?: string
  parts?: Partial<Pick<Host, 'state' | 'store' | 'agents' | 'view' | 'model' | 'conversation' | 'log'>>
}

/**
 * The folder for waffles' values on this machine: `WAFFLES_STATE_DIR`, else `waffles` in the state
 * folder the system names (`XDG_STATE_HOME`, `LOCALAPPDATA` on Windows), else `~/.local/state/waffles`.
 * It is never in a repository: a mode is one person's session state.
 */
export function stateFolder(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WAFFLES_STATE_DIR) return env.WAFFLES_STATE_DIR
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, 'waffles')
  if (process.platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'waffles')
  return join(homedir(), '.local', 'state', 'waffles')
}

/** A session's values last written more than this (ms) ago are removed when another session starts. */
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000

// A session ID names a file: one that could leave the folder is named by its hash.
const fileOf = (sessionId: string) => (/^[\w-]{1,128}$/.test(sessionId) ? sessionId : createHash('sha256').update(sessionId).digest('hex'))

const kindOf = (entry: { isFile(): boolean; isDirectory(): boolean }): FileKind => (entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other')

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

// The JSON object in a file; empty when the file is missing or holds no object. A value file is small
// and other processes write it, so each read goes to the disk.
async function readObject(path: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return {}
    throw error
  }
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    // A file that doesn't parse reads as empty: every key then has its default, which is the safe one.
    return {}
  }
}

// Written beside the file and renamed into place, so a reader never sees half a file.
async function writeObject(path: string, value: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const draft = `${path}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(draft, JSON.stringify(value))
  await fs.rename(draft, path)
}

/** The format of a value file; a file with another number reads as empty. */
const FORMAT = 1

function values(path: string) {
  // Writes of one process run one at a time: each reads the file, changes one key, and writes it back.
  let queue: Promise<unknown> = Promise.resolve()
  const read = async () => {
    const file = await readObject(path)
    return file.format === FORMAT && typeof file.values === 'object' && file.values !== null ? (file.values as Record<string, unknown>) : {}
  }
  return {
    read,
    set(key: string, value: unknown): Promise<void> {
      const done = queue.then(async () => writeObject(path, { format: FORMAT, values: { ...(await read()), [key]: value } }))
      queue = done.catch(() => undefined)
      return done
    },
  }
}

/** The path of a session's value file in the state folder. */
export const sessionPath = (folder: string, sessionId: string) => join(folder, 'sessions', `${fileOf(sessionId)}.json`)

/** Removes a session's values: its session ended for good. */
export async function forgetSession(folder: string, sessionId: string): Promise<void> {
  await fs.rm(sessionPath(folder, sessionId), { force: true })
}

/**
 * Removes the files in the sessions folder last written more than SESSION_MS ago, other than this
 * session's values: other sessions' values, and the files an adapter keeps beside them, including
 * one a process that stopped midway left behind.
 */
export async function pruneSessions(folder: string, sessionId: string, now = Date.now()): Promise<void> {
  const dir = join(folder, 'sessions')
  const keep = `${fileOf(sessionId)}.json`
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (name === keep) continue
    const stat = await fs.stat(join(dir, name)).catch(() => null)
    if (stat?.isFile() && now - stat.mtimeMs > SESSION_MS) await fs.rm(join(dir, name), { force: true })
  }
}

export function nodeHost({ sessionId, cwd, names, stateFolder: folder = stateFolder(), parts = {} }: NodeHostInit): Host {
  const session = values(sessionPath(folder, sessionId))
  const person = values(join(folder, 'store.json'))
  return {
    fs: {
      read: path => fs.readFile(path, 'utf8'),
      write: async (path, text) => {
        await fs.mkdir(dirname(path), { recursive: true })
        await fs.writeFile(path, text)
      },
      // `wx` opens with O_CREAT | O_EXCL: the system creates the file, or finds one there, in one step.
      create: async (path, text) => {
        await fs.mkdir(dirname(path), { recursive: true })
        try {
          await fs.writeFile(path, text, { flag: 'wx' })
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return false
          throw error
        }
      },
      exists: path =>
        fs.lstat(path).then(
          () => true,
          () => false,
        ),
      list: async path => {
        const entries = await fs.readdir(path, { withFileTypes: true })
        return Promise.all(
          entries.map(async entry => {
            const stat = await fs.stat(join(path, entry.name)).catch(() => null)
            return { name: entry.name, kind: stat ? kindOf(stat) : kindOf(entry), size: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 }
          }),
        )
      },
      stat: async path => {
        const stat = await fs.stat(path)
        return { kind: kindOf(stat), size: stat.size, mtimeMs: stat.mtimeMs }
      },
      remove: (path, options) => fs.rm(path, { force: true, recursive: options?.recursive ?? false }),
      realPath: path => fs.realpath(path),
    },
    process: {
      run: (argv, init = {}) =>
        new Promise((resolve, reject) => {
          const [command, ...args] = argv
          if (command === undefined) return reject(new Error('No command to run.'))
          const child = spawn(command, args, { cwd: init.cwd ?? cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
          let [stdout, stderr] = ['', '']
          const timer = init.timeoutMs === undefined ? undefined : setTimeout(() => child.kill(), init.timeoutMs)
          child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
          child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
          // A command that isn't there, or that the system refuses to start.
          child.on('error', error => {
            clearTimeout(timer)
            reject(error)
          })
          child.on('close', (code, signal) => {
            clearTimeout(timer)
            if (signal !== null) reject(new Error(`${command} was stopped by ${signal}${init.timeoutMs === undefined ? '' : ` after ${init.timeoutMs} ms`}`))
            else resolve({ exitCode: code ?? 1, stdout, stderr })
          })
          // A command that reads no input may close the pipe first: that is not a failure of the run.
          child.stdin.on('error', () => undefined)
          child.stdin.end(init.stdin ?? '')
        }),
    },
    session: { id: async () => sessionId, cwd: async () => cwd },
    clock: { now: async () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) },
    home: async () => homedir() || undefined,
    env: async name => process.env[name],
    state: parts.state ?? {
      get: async key => {
        const all = await session.read()
        return (key in all ? all[key] : INITIAL[key]) as SessionState[typeof key]
      },
      set: (key, value) => session.set(key, value),
    },
    store: parts.store ?? {
      get: async key => (await person.read())[key],
      set: (key, value) => person.set(key, value),
    },
    memory: {},
    agents: parts.agents ?? { list: async () => [] },
    view: parts.view ?? { planActive: async () => undefined },
    model: parts.model ?? { ask: async () => null },
    conversation: parts.conversation ?? { lastReply: async () => '', note: async () => false },
    names,
    log:
      parts.log ??
      (message => {
        if (process.env.WAFFLES_DEBUG) process.stderr.write(`waffles: ${message}\n`)
      }),
  }
}
