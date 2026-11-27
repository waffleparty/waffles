import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Host, Memory, Names, SessionState } from '../core/host.ts'
import { CREATE_SCRIPT } from './create'
import { openAtStart, openUnlessClosed } from './plan-ui'

// The session's values are `$.state` atoms, so a drawing that reads one is drawn again when the core
// writes it. A file that draws declares its own copy of the atoms it reads. The engine lists the values a
// module reads and writes from its source, so each atom is a const here and each key names its own.
const mode = atom({ plugin: 'waffles', key: 'mode' } as const, 'production')
const rapidBase = atom({ plugin: 'waffles', key: 'rapidBase' } as const, null)
const run = atom({ plugin: 'waffles', key: 'run' } as const, false)
const runDenials = atom({ plugin: 'waffles', key: 'runDenials' } as const, 0)
const runStartedAt = atom({ plugin: 'waffles', key: 'runStartedAt' } as const, null)
const runAsking = atom({ plugin: 'waffles', key: 'runAsking' } as const, false)
const rapidStated = atom({ plugin: 'waffles', key: 'rapidStated' } as const, false)
const planGoal = atom({ plugin: 'waffles', key: 'planGoal' } as const, null)
const planTree = atom({ plugin: 'waffles', key: 'planTree' } as const, null)
const planKept = atom({ plugin: 'waffles', key: 'planKept' } as const, null)
const planKeptIssue = atom({ plugin: 'waffles', key: 'planKeptIssue' } as const, null)
const planError = atom({ plugin: 'waffles', key: 'planError' } as const, null)
const planOthers = atom({ plugin: 'waffles', key: 'planOthers' } as const, [])
const planChanged = atom({ plugin: 'waffles', key: 'planChanged' } as const, [])
const planFetched = atom({ plugin: 'waffles', key: 'planFetched' } as const, false)

type Key = keyof SessionState

async function getState($: EngineInterface, key: Key): Promise<SessionState[Key]> {
  switch (key) {
    case 'mode':
      return read($, mode)
    case 'rapidBase':
      return read($, rapidBase)
    case 'run':
      return read($, run)
    case 'runDenials':
      return read($, runDenials)
    case 'runStartedAt':
      return read($, runStartedAt)
    case 'runAsking':
      return read($, runAsking)
    case 'rapidStated':
      return read($, rapidStated)
    case 'planGoal':
      return read($, planGoal)
    case 'planTree':
      return read($, planTree)
    case 'planKept':
      return read($, planKept)
    case 'planKeptIssue':
      return read($, planKeptIssue)
    case 'planError':
      return read($, planError)
    case 'planOthers':
      return read($, planOthers)
    case 'planChanged':
      return read($, planChanged)
    case 'planFetched':
      return read($, planFetched)
  }
}

async function setState($: EngineInterface, key: Key, value: SessionState[Key]): Promise<void> {
  switch (key) {
    case 'mode':
      await update($, mode, () => value as SessionState['mode'])
      return
    case 'rapidBase':
      await update($, rapidBase, () => value as SessionState['rapidBase'])
      return
    case 'run':
      await update($, run, () => value as SessionState['run'])
      return
    case 'runDenials':
      await update($, runDenials, () => value as SessionState['runDenials'])
      return
    case 'runStartedAt':
      await update($, runStartedAt, () => value as SessionState['runStartedAt'])
      return
    case 'runAsking':
      await update($, runAsking, () => value as SessionState['runAsking'])
      return
    case 'rapidStated':
      await update($, rapidStated, () => value as SessionState['rapidStated'])
      return
    case 'planGoal':
      await update($, planGoal, () => value as SessionState['planGoal'])
      return
    case 'planTree':
      await update($, planTree, () => value as SessionState['planTree'])
      return
    case 'planKept':
      await update($, planKept, () => value as SessionState['planKept'])
      return
    case 'planKeptIssue':
      await update($, planKeptIssue, () => value as SessionState['planKeptIssue'])
      return
    case 'planError':
      await update($, planError, () => value as SessionState['planError'])
      return
    case 'planOthers':
      await update($, planOthers, () => value as SessionState['planOthers'])
      return
    case 'planChanged':
      await update($, planChanged, () => value as SessionState['planChanged'])
      return
    case 'planFetched':
      await update($, planFetched, () => value as SessionState['planFetched'])
      return
  }
}

// One Claude Code process serves one session, so one object holds what the core keeps in memory. It
// starts over on a reload, as the module does.
const memory: Memory = {}

/** What Claude Code calls its own things. hooks/plan.ts names the same tool where it hooks its calls. */
export const NAMES: Names = {
  assistant: 'Claude',
  product: 'Claude Code',
  planTool: 'mcp__waffles__plan',
  ask: 'AskUserQuestion',
  planMode: "Claude Code's plan mode",
  // A plugin's skill is `/<plugin>:<skill>` in the prompt and `<plugin>:<skill>` in the Skill tool.
  skill: name => `waffles:${name}`,
  runCommand: '/waffles:non-interactive',
  command: name => `/${name}`,
}

/** The core's host on Claude Code: each call goes to `$`. */
export function hostOf($: EngineInterface): Host {
  return {
    fs: {
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      // `$.fs` has no exclusive create: a shell's noclobber redirect is one (hooks/create.ts).
      create: async (path, text) => {
        const r = await $.process.run(['sh', '-c', CREATE_SCRIPT, 'sh', path], { stdin: text })
        if (r.exitCode === 0) return true
        if (r.exitCode === 3) return false
        throw new Error(`cannot create ${path}: ${r.stderr.trim() || `sh exited with ${r.exitCode}`}`)
      },
      exists: path => $.fs.exists(path),
      list: path => $.fs.list(path),
      stat: path => $.fs.stat(path),
      // `$.fs` removes nothing; `rm -f` leaves a file that isn't there alone. A folder may hold a whole clone:
      // its removal gets 2 minutes, and one that fails rejects, so nothing says a folder is gone that is not.
      remove: async (path, options) => {
        if (!options?.recursive) {
          await $.process.run(['rm', '-f', path])
          return
        }
        const r = await $.process.run(['rm', '-rf', path], { timeoutMs: 120_000 })
        if (r.exitCode !== 0) throw new Error(`cannot remove ${path}: ${r.stderr.trim() || `rm exited with ${r.exitCode}`}`)
      },
      // `$.fs` moves nothing; `mv` within a folder is the system's rename.
      rename: async (from, to) => {
        const r = await $.process.run(['mv', '-f', from, to])
        if (r.exitCode !== 0) throw new Error(`cannot move ${from} to ${to}: ${r.stderr.trim() || `mv exited with ${r.exitCode}`}`)
      },
      realPath: async path => (await $.fs.stat(path, { resolve: true })).realPath ?? path,
    },
    process: {
      // Claude Code passes on the first 4 MiB of each stream and says when it cut one. Answers are read from
      // stdout, so a cut stdout is the one the core is told of.
      run: async (argv, init) => {
        const r = await $.process.run(argv, init)
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, ...(r.isStdoutTruncated ? { isTruncated: true } : {}) }
      },
    },
    session: { id: () => $.session.id(), cwd: () => $.session.cwd() },
    clock: { now: () => $.clock.now(), sleep: ms => $.clock.sleep(ms) },
    home: () => $.env.get('HOME'),
    // The engine reads a variable's name from the call: each one the core reads is written out.
    env: async name => {
      switch (name) {
        case 'WAFFLES_BUILDERS_ROOT':
          return $.env.get('WAFFLES_BUILDERS_ROOT')
        case 'WAFFLES_REMOTE':
          return $.env.get('WAFFLES_REMOTE')
        case 'WAFFLES_REVIEW_CAP':
          return $.env.get('WAFFLES_REVIEW_CAP')
      }
    },
    state: {
      get: key => getState($, key) as Promise<SessionState[typeof key]>,
      set: (key, value) => setState($, key, value),
    },
    store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) },
    memory,
    agents: { list: () => $.agent.list() },
    view: { planActive: when => (when === 'start' ? openAtStart($) : openUnlessClosed($)) },
    // A session no plugin may shape refuses the row, as may a plugin above.
    model: {
      ask: async (prompt, { maxTokens, timeoutMs }) => {
        const r = await $.model.complete({ model: 'haiku', prompt, maxTokens, effort: 'low', timeoutMs })
        return r.isAnswered ? r.text : null
      },
    },
    conversation: {
      lastReply: async () => {
        const messages = await $.session.messages()
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const m = messages[i]!
          if (m.role === 'assistant' && m.text.trim()) return m.text
        }
        return ''
      },
      note: text => $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).then(r => r.deny === undefined),
    },
    names: NAMES,
    log: message => $.ui.log(message, { to: 'debug' }),
  }
}
