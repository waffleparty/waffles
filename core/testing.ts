import { INITIAL, type FileEntry, type Host, type Names, type RunResult, type SessionState } from './host.ts'

/**
 * A Host held in memory, for the core's tests: files in a map, commands answered by a script, a clock
 * that moves only when the test moves it, and the session's values in an object. It runs nothing and
 * touches no disk, so a test sees every command the core ran and every file it wrote.
 */

/** What a command answers: its result, or an error when it can't start. */
export type Answer = Partial<RunResult> | Error
export type Ran = { argv: readonly string[]; cwd?: string; stdin?: string; timeoutMs?: number }

export type FakeHost = Host & {
  /** Path to text: every file there is. */
  files: Map<string, string>
  /** Every command run, in order. */
  ran: Ran[]
  /** The session's values set so far. */
  values: Partial<SessionState>
  /** What the model was told, in order. */
  notes: string[]
  /** Moves the clock on. */
  advance(ms: number): void
}

export type FakeHostInit = {
  /** Answers each command; one it doesn't answer exits 127, as a shell's missing command does. */
  run?: (argv: readonly string[], init: { cwd?: string; stdin?: string }) => Answer | undefined | Promise<Answer | undefined>
  files?: Record<string, string>
  cwd?: string
  sessionId?: string
  now?: number
  names?: Partial<Names>
}

const NAMES: Names = { assistant: 'Agent', product: 'the test', planTool: 'plan', ask: 'question', planMode: null }

const missing = (path: string) => Object.assign(new Error(`ENOENT: no such file, '${path}'`), { code: 'ENOENT' })

export function fakeHost({ run, files = {}, cwd = '/work', sessionId = 'test', now = 0, names = {} }: FakeHostInit = {}): FakeHost {
  const disk = new Map(Object.entries(files))
  const ran: Ran[] = []
  const values: Partial<SessionState> = {}
  const notes: string[] = []
  const store = new Map<string, unknown>()
  let clock = now
  // The files right under a folder, and the folders that lead to deeper ones.
  const entries = (path: string): FileEntry[] => {
    const prefix = `${path.replace(/\/$/, '')}/`
    const seen = new Map<string, FileEntry>()
    for (const [file, text] of disk) {
      if (!file.startsWith(prefix)) continue
      const [name = '', ...rest] = file.slice(prefix.length).split('/')
      seen.set(name, rest.length ? { name, kind: 'dir', size: 0, mtimeMs: 0 } : { name, kind: 'file', size: text.length, mtimeMs: 0 })
    }
    return [...seen.values()]
  }
  const isDir = (path: string) => entries(path).length > 0
  return {
    files: disk,
    ran,
    values,
    notes,
    advance: ms => void (clock += ms),
    fs: {
      read: async path => {
        const text = disk.get(path)
        if (text === undefined) throw missing(path)
        return text
      },
      write: async (path, text) => void disk.set(path, text),
      exists: async path => disk.has(path) || isDir(path),
      list: async path => {
        if (!isDir(path)) throw missing(path)
        return entries(path)
      },
      stat: async path => {
        const text = disk.get(path)
        if (text !== undefined) return { kind: 'file', size: text.length, mtimeMs: 0 }
        if (isDir(path)) return { kind: 'dir', size: 0, mtimeMs: 0 }
        throw missing(path)
      },
      remove: async path => void disk.delete(path),
      realPath: async path => path,
    },
    process: {
      run: async (argv, init = {}) => {
        ran.push({ argv: [...argv], ...init })
        const answer = await run?.(argv, init)
        if (answer instanceof Error) throw answer
        if (answer === undefined) return { exitCode: 127, stdout: '', stderr: `${argv[0]}: command not found\n` }
        return { exitCode: 0, stdout: '', stderr: '', ...answer }
      },
    },
    session: { id: async () => sessionId, cwd: async () => cwd },
    clock: { now: async () => clock },
    home: async () => '/home',
    state: {
      get: async key => (key in values ? values[key] : INITIAL[key]) as SessionState[typeof key],
      set: async (key, value) => void Object.assign(values, { [key]: value }),
    },
    store: { get: async key => store.get(key), set: async (key, value) => void store.set(key, value) },
    memory: {},
    agents: { list: async () => [] },
    view: { planActive: async () => undefined },
    model: { ask: async () => null },
    conversation: { lastReply: async () => '', note: async text => (notes.push(text), true) },
    names: { ...NAMES, ...names },
    log: () => undefined,
  }
}
