import type { FsEntry, FsStat, On, ProcessRunResult } from 'claude-code'

import type { StoreEngine } from '../core/plan-store.ts'

// Every set of a file gives it a modification time no file had before, in this test or another, as a
// write on disk does: the store's cache, which outlives a test, then never takes one file for another.
let clock = 0
class Stamped extends Map<string, string> {
  readonly stamps = new Map<string, number>()
  override set(path: string, text: string): this {
    this.stamps?.set(path, ++clock)
    return super.set(path, text)
  }
}

export type GitAnswer = { exitCode: number; stdout: string }

/** What git answers in a checkout at /repo: its top level and git dir to the plan outline's query, `/repo/.git` to any other. */
export const inRepo = (argv: readonly string[]): GitAnswer =>
  argv.includes('--git-dir') ? { exitCode: 0, stdout: '/repo\n/repo/.git\n' } : { exitCode: 0, stdout: '/repo/.git\n' }

export type Disk = {
  /** Path to text: every file there is, each with its modification time. */
  files: Stamped
  /** Paths read, in order, refused reads included. */
  reads: string[]
  /** Paths written, in order. */
  writes: string[]
  /** Paths `rm -f` removed, in order. */
  removed: string[]
  /** Every argv run that wasn't `rm`. */
  ran: string[][]
  /** `rm` is refused, as a run that fails to start is. */
  isRmBroken: boolean
  /** Every read of a file that is there is refused, as on a disk error. */
  isReadBroken: boolean
  /** Every write is refused, as on a disk that is full or read-only. */
  isWriteBroken: boolean
  /** What `git` answers: one answer for every git run, or one per argv. */
  git: GitAnswer | ((argv: readonly string[]) => GitAnswer)
  /** While set, `git` answers only once it settles. */
  gitGate: Promise<void> | null
  /** While set, a read answers only once this settles, run after the text was taken: work that lands while a read is under way. */
  duringRead: ((path: string) => Promise<void>) | null
  cwd: string
}

function newDisk(): Disk {
  return {
    files: new Stamped(),
    reads: [],
    writes: [],
    removed: [],
    ran: [],
    isRmBroken: false,
    isReadBroken: false,
    isWriteBroken: false,
    git: inRepo,
    gitGate: null,
    duringRead: null,
    cwd: '/cwd',
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// The disk's answers, one implementation behind both fakes: `rm -f` is recorded and drops the file, `git`
// answers `disk.git`, and anything else (lsof) finds nothing. A missing file is refused, as a read of
// one fails. A path with no file at it stats as a folder, there or not.
function answers(disk: Disk) {
  const under = (dir: string) => [...disk.files.keys()].filter(p => p.startsWith(`${dir}/`))
  return {
    read(path: string): string {
      disk.reads.push(path)
      const text = disk.files.get(path)
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      if (disk.isReadBroken) throw new Error(`EIO ${path}`)
      return text
    },
    write(path: string, text: string): void {
      if (disk.isWriteBroken) throw new Error(`EROFS ${path}`)
      disk.writes.push(path)
      disk.files.set(path, text)
    },
    exists: (path: string): boolean => disk.files.has(path) || under(path).length > 0,
    list: (path: string): FsEntry[] =>
      [...new Set(under(path).map(p => p.slice(path.length + 1).split('/')[0] ?? ''))].map(name => ({
        name,
        kind: disk.files.has(`${path}/${name}`) ? 'file' : 'dir',
        size: disk.files.get(`${path}/${name}`)?.length ?? 0,
        mtimeMs: disk.files.stamps.get(`${path}/${name}`) ?? 0,
        isLink: false,
      })),
    stat(path: string, resolve: boolean): FsStat {
      const text = disk.files.get(path)
      const stat: FsStat = text === undefined ? { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } : { kind: 'file', size: text.length, mtimeMs: disk.files.stamps.get(path) ?? 0, isLink: false }
      return resolve ? { ...stat, realPath: path } : stat
    },
    async run(argv: readonly string[]): Promise<ProcessRunResult> {
      const done = (exitCode: number, stdout: string): ProcessRunResult => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
      if (argv[0] === 'rm') {
        if (disk.isRmBroken) throw new Error(`EPERM ${argv.join(' ')}`)
        const path = argv[argv.length - 1] ?? ''
        disk.removed.push(path)
        disk.files.delete(path)
        return done(0, '')
      }
      disk.ran.push([...argv])
      if (argv[0] !== 'git') return done(0, '')
      if (disk.gitGate) await disk.gitGate
      const git = typeof disk.git === 'function' ? disk.git(argv) : disk.git
      return done(git.exitCode, git.stdout)
    },
  }
}

// An in-memory disk behind the plugin's `$.fs`, `$.process.run` and `$.session.cwd`, answered by the
// test's hooks beneath the plugin; a refusal is a deny with the error's message.
export function fakeDisk(on: On): Disk {
  const disk = newDisk()
  const at = answers(disk)
  const refused = (error: unknown) => ({ deny: messageOf(error) })

  on('fs.read', ($, e) => {
    try {
      const value = at.read(e.path)
      return disk.duringRead ? disk.duringRead(e.path).then(() => ({ value })) : { value }
    } catch (error) {
      return refused(error)
    }
  })
  on('fs.write', ($, e) => {
    try {
      return { value: at.write(e.path, e.text) }
    } catch (error) {
      return refused(error)
    }
  })
  on('fs.exists', ($, e) => ({ value: at.exists(e.path) }))
  on('fs.list', ($, e) => ({ value: at.list(e.path) }))
  on('fs.stat', ($, e) => ({ value: at.stat(e.path, e.resolve) }))
  on('session.cwd', () => ({ value: disk.cwd }))
  on('process.run', async ($, e) => {
    try {
      return { value: await at.run(e.argv) }
    } catch (error) {
      return refused(error)
    }
  })
  return disk
}

// The same disk as a `$` of its own, for calling the store directly: a hook in a test is handed the
// test plugin's `$`, which refuses fs, process and session calls its hooks module does not make.
export function fakeStoreDisk(): Disk & { $: StoreEngine } {
  const disk = newDisk()
  const at = answers(disk)
  const $: StoreEngine = {
    fs: {
      read: async path => {
        const text = at.read(path)
        if (disk.duringRead) await disk.duringRead(path)
        return text
      },
      write: async (path, text) => at.write(path, text),
      exists: async path => at.exists(path),
      list: async path => at.list(path),
      stat: async path => at.stat(path, false),
      remove: async path => {
        await at.run(['rm', '-f', path])
      },
      realPath: async path => path,
    },
    process: { run: argv => at.run(argv) },
    session: { cwd: async () => disk.cwd },
  }
  return Object.assign(disk, { $ })
}
