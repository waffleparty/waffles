import { randomUUID } from 'node:crypto'

import { POLL_MS } from '../../core/plan.ts'
import { forgetSession, nodeHost, pruneSessions, stateFolder } from '../node/host.ts'
import type { Json, ListKind, Module, Registry, Session } from './registry.ts'

/**
 * The MCP server's sessions: one Host and one in-memory record per session, kept in a map for the life
 * of the process. The protocol gives a server no session ID, so `idOf` decides which session a request
 * belongs to; a later source of the ID (a request's `_meta`, a tool argument from a hook) is a change
 * there alone.
 */

/** What the sessions tell the server, for it to pass on to the clients that listen. */
export type Change = { type: 'resource'; uri: string; sessionId: string } | { type: 'list'; kind: ListKind }

export type Sessions = {
  /** The session of a request, started: its modules' `start` ran once, before this returns. */
  of(params: Json): Promise<Session>
  /** Ends every session the process started; the process is ending. */
  end(): Promise<void>
}

export type SessionsInit = {
  registry: Registry
  env: NodeJS.ProcessEnv
  emit(change: Change): void
  log(message: string): void
}

// The heartbeat's period: the plan outline keeps its lock and redraws at this rate.
const HEARTBEAT_MS = POLL_MS

type SessionRecord = {
  session: Session
  /** Made up by this process: nothing can name it again once the process ends. */
  isOwn: boolean
  started: Promise<void>
  isLive: boolean
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function sessionsOf({ registry, env, emit, log }: SessionsInit): Sessions {
  const folder = stateFolder(env)
  const cwd = env.WAFFLES_CWD || process.cwd()
  // With no ID from the environment, the session is this process.
  const madeId = `mcp-${randomUUID()}`
  const records = new Map<string, SessionRecord>()
  let timer: ReturnType<typeof setInterval> | undefined
  let isEnded = false

  /**
   * The session a request belongs to. One the platform's hooks share comes from the environment, so the
   * mode and the goal agree between them and this server; else the session is this process.
   */
  const idOf = (_params: Json): string => env.WAFFLES_SESSION_ID || madeId

  const each = async (record: SessionRecord, step: 'start' | 'tick' | 'end', modules: readonly Module[]) => {
    for (const module of modules) {
      const handler = module[step]
      if (handler === undefined) continue
      await handler(record.session).catch(error => log(`the ${module.name} module did not ${step}: ${messageOf(error)}`))
    }
  }

  const heartbeat = () => {
    if (timer !== undefined) return
    timer = setInterval(() => {
      for (const record of records.values()) if (record.isLive) void each(record, 'tick', registry.modules)
    }, HEARTBEAT_MS)
    timer.unref()
  }

  function make(id: string): SessionRecord {
    // Notes go to the work that collects them, one piece of work at a time.
    let collecting: string[] | null = null
    let queue: Promise<unknown> = Promise.resolve()
    const $ = nodeHost({
      sessionId: id,
      cwd,
      names: registry.names,
      stateFolder: folder,
      parts: {
        conversation: {
          lastReply: async () => '',
          note: async text => {
            if (collecting === null) return false
            collecting.push(text)
            return true
          },
        },
      },
    })
    const session: Session = {
      id,
      $,
      noting: work => {
        const run = queue.then(async () => {
          const notes: string[] = []
          collecting = notes
          try {
            return { value: await work(), notes }
          } finally {
            collecting = null
          }
        })
        queue = run.catch(() => undefined)
        return run
      },
      changed: uri => emit({ type: 'resource', uri, sessionId: id }),
      listChanged: kind => emit({ type: 'list', kind }),
    }
    const record: SessionRecord = { session, isOwn: id === madeId, started: Promise.resolve(), isLive: false }
    record.started = (async () => {
      await pruneSessions(folder, id).catch(error => log(`old sessions were not pruned: ${messageOf(error)}`))
      await each(record, 'start', registry.modules)
      record.isLive = !isEnded
      if (record.isLive) heartbeat()
    })()
    return record
  }

  return {
    async of(params) {
      const id = idOf(params)
      let record = records.get(id)
      if (record === undefined) {
        record = make(id)
        records.set(id, record)
      }
      await record.started
      return record.session
    },

    /**
     * The lock on each session's goal is released. A session's record stays, so a later process with the
     * same session ID continues it; the values of a session this process made up are removed.
     */
    async end() {
      isEnded = true
      clearInterval(timer)
      for (const record of records.values()) {
        record.isLive = false
        await record.started
        await each(record, 'end', [...registry.modules].reverse())
        if (record.isOwn) await forgetSession(folder, record.session.id).catch(() => undefined)
      }
    },
  }
}
