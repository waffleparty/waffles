import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Plugin } from '@opencode/plugin'

import { adapterContext } from '../../core/backlog-adapter.ts'
import { afterShell } from '../../core/checkpoint.ts'
import { INITIAL, type Host, type Names, type SessionState } from '../../core/host.ts'
import {
  ASSESS_PROMPT,
  COMMANDS,
  completeMode,
  modeContext,
  MODES_TEXT,
  runBacklog,
  runProd,
  runRapid,
  startMode,
  submitMode,
  wafflesMode,
} from '../../core/modes.ts'
import { callPlan, endPlan, PLAN_TOOL, POLL_MS, startPlan, submitPlan, SUBAGENT, tickPlan } from '../../core/plan.ts'
import { planContext, planRules } from '../../core/plan-prompt.ts'
import { permissionAsked, startUnattended, submitUnattended } from '../../core/unattended.ts'
import { nodeHost } from '../node/host.ts'

/**
 * The waffles plugin's server part for OpenCode 2: the plan outline tool, the modes and their commands,
 * the rules in the system prompt, and the skills. It runs in OpenCode's server process, which serves
 * every session, so each session gets its own host.
 *
 * A push runs the checkpoint.
 *
 * Not here yet: the plan outline's view and the footer (the TUI part), auto effort, the marking of a
 * step by its subagent, and the start of an unattended run.
 */

/** What OpenCode calls its own things. */
export const NAMES: Names = {
  assistant: 'The agent',
  product: 'OpenCode',
  planTool: 'waffles_plan',
  ask: 'question',
  planMode: "OpenCode's plan agent",
}

// The session's metadata key that holds the values a session must get back when it is reopened.
const METADATA = 'waffles'
// The values written to the session's record and read back when the session is reopened.
const KEPT: readonly (keyof SessionState)[] = ['mode', 'rapidBase', 'run']
// The values written to the record for the terminal UI part to draw, and never read back: the plan
// outline is redrawn from its files.
const SHOWN: readonly (keyof SessionState)[] = ['planTree']
// The keys of the session's instruction entries: the blocks the model reads beside the instructions.
const MODE_ENTRY = 'waffles-mode'
const PLAN_ENTRY = 'waffles-plan-outline'
const ADAPTER_ENTRY = 'waffles-backlog-adapter'

type Session = {
  $: Host
  /** Whether the session is another session's child: a subagent. */
  isChild: boolean
  /** Set once the session's first prompt has started the core for it. */
  started: Promise<void> | null
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The plugin's folder: two levels above this file. */
export const pluginRoot = () => join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The `name` and `description` of a skill file's front matter; null when it has none. */
export function skillHeader(text: string): { name: string; description: string } | null {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  if (front === undefined) return null
  const field = (key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(front)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
  const [name, description] = [field('name'), field('description')]
  return name && description ? { name, description } : null
}

type SkillFile = { id: string; name: string; description: string; path: string; content: string }

/** The skills in the plugin's `skills/` folder, one per folder with a SKILL.md that names itself. */
export async function readSkills(root: string): Promise<SkillFile[]> {
  const folder = join(root, 'skills')
  const names = await fs.readdir(folder).catch(() => [] as string[])
  const skills: SkillFile[] = []
  for (const id of names.sort()) {
    const path = join(folder, id, 'SKILL.md')
    const content = await fs.readFile(path, 'utf8').catch(() => null)
    const header = content === null ? null : skillHeader(content)
    if (content !== null && header) skills.push({ id, ...header, path, content })
  }
  return skills
}

/** A session's values in the server's memory, with the kept ones written through to the session's record. */
export function sessionState(ctx: Pick<Plugin.Context, 'session'>, sessionID: string): Host['state'] {
  const values: Partial<SessionState> = {}
  let loaded: Promise<void> | null = null
  const load = () =>
    (loaded ??= (async () => {
      // A record that can't be read leaves every key at its default, which is the safe one.
      const info = await ctx.session.get({ sessionID }).catch(() => null)
      const kept = (info?.metadata as Record<string, unknown> | undefined)?.[METADATA]
      if (typeof kept !== 'object' || kept === null) return
      for (const key of KEPT) if (key in kept) Object.assign(values, { [key]: (kept as Record<string, unknown>)[key] })
    })())
  return {
    get: async key => {
      await load()
      return (key in values ? values[key] : INITIAL[key]) as SessionState[typeof key]
    },
    set: async (key, value) => {
      await load()
      values[key] = value
      if (!KEPT.includes(key) && !SHOWN.includes(key)) return
      const info = await ctx.session.get({ sessionID })
      const kept = Object.fromEntries([...KEPT, ...SHOWN].filter(k => k in values).map(k => [k, values[k]]))
      await ctx.session.update({ sessionID, metadata: { ...info.metadata, [METADATA]: kept } as never })
    },
  }
}

const plugin: Plugin.Plugin = {
  id: 'waffles',
  async setup(ctx) {
    const sessions = new Map<string, Promise<Session>>()

    // One host per session, made at the session's first event and kept until the session is removed.
    const sessionOf = (sessionID: string): Promise<Session> => {
      const known = sessions.get(sessionID)
      if (known) return known
      const made = (async (): Promise<Session> => {
        const info = await ctx.session.get({ sessionID })
        const entry = (key: string, value: string) =>
          value ? ctx.session.instructions.entry.put({ sessionID, key, value }) : ctx.session.instructions.entry.remove({ sessionID, key })
        const $ = nodeHost({
          sessionId: sessionID,
          cwd: info.location.directory,
          names: NAMES,
          parts: {
            state: sessionState(ctx, sessionID),
            store: {
              get: key => ctx.storage.get(`store/${key}`),
              set: (key, value) => ctx.storage.set(`store/${key}`, value as never),
            },
            // A change of mode replaces the session's mode block; the model is told at the next step.
            conversation: {
              lastReply: async () => '',
              note: text => entry(MODE_ENTRY, text).then(() => true),
            },
            log: message => console.debug(`waffles: ${message}`),
          },
        })
        return { $, isChild: info.parentID !== undefined && info.parentID !== null, started: null }
      })()
      sessions.set(sessionID, made)
      // A session that can't be read is looked up again at its next event.
      made.catch(() => sessions.delete(sessionID))
      return made
    }

    // The core starts for a session at its first prompt: OpenCode has no hook for a session's start.
    // The mode, the plan outline, and a named backlog adapter go to the model as instruction entries.
    const started = (sessionID: string, session: Session): Promise<void> =>
      (session.started ??= (async () => {
        const { $ } = session
        await startUnattended($)
        await startMode($)
        await startPlan($).catch(error => $.log(`the plan outline did not start: ${messageOf(error)}`))
        const put = (key: string, value: string) =>
          value ? ctx.session.instructions.entry.put({ sessionID, key, value }) : Promise.resolve()
        await put(MODE_ENTRY, await modeContext($))
        await put(PLAN_ENTRY, await planContext($).catch(() => ''))
        await put(ADAPTER_ENTRY, await adapterContext($))
      })())

    const skills = await readSkills(pluginRoot())
    await ctx.skill.transform(editor => {
      for (const skill of skills) editor.add(skill as never)
    })

    await ctx.tool.transform(editor => {
      editor.add({
        name: NAMES.planTool,
        description: PLAN_TOOL.description,
        input: PLAN_TOOL.inputSchema as never,
        execute: async (input, context) => {
          const session = await sessionOf(context.sessionID)
          // A refusal is thrown, so the model reads it as the call's error.
          if (session.isChild) throw new Error(SUBAGENT)
          await started(context.sessionID, session)
          const answer = await callPlan(session.$, input as Record<string, unknown>)
          if ('deny' in answer) throw new Error(answer.deny)
          return { content: answer.result }
        },
      })
    })

    // What each command does, by name: the text the person reads, and whether rapid work was handed over.
    const run: Record<string, ($: Host) => Promise<{ text: string; isHandover?: boolean }>> = {
      'backlog-entry': async $ => ({ text: await runBacklog($) }),
      rapid: async $ => ({ text: await runRapid($) }),
      prod: runProd,
    }
    await ctx.command.transform(editor => {
      for (const { name, description } of COMMANDS) {
        editor.add({
          name,
          description,
          execute: async ({ sessionID }) => {
            const session = await sessionOf(sessionID)
            await started(sessionID, session)
            const { isHandover } = await run[name]!(session.$)
            // The assessment of rapid work starts now, not at the next prompt.
            if (isHandover) await ctx.session.prompt({ sessionID, text: ASSESS_PROMPT })
          },
        })
      }
    })

    // The rules go last in the system prompt, with the same bytes in every request, so the prompt cache holds.
    const rules = planRules(NAMES)
    const context = await ctx.session.hook('context', event => {
      event.system.push({ type: 'text', text: MODES_TEXT }, { type: 'text', text: rules })
    })

    const prompt = await ctx.session.hook('prompt', async event => {
      const session = await sessionOf(event.sessionID)
      if (session.isChild) return
      await started(event.sessionID, session)
      const { $ } = session
      // OpenCode hands this hook the prompts a person or a command sends, not synthetic messages.
      const typed = { isPerson: true, isTyped: true, command: undefined, isMeta: false, text: event.prompt.text }
      const before = await wafflesMode($)
      await submitUnattended($, typed)
      submitPlan($)
      // The line that states backlog mode beside a prompt is not added here: the mode block always holds the current mode.
      await submitMode($, typed, before)
    })

    // During an unattended run nobody can answer a permission request, so it is denied with what to do next.
    const permission = await ctx.permission.hook('evaluate', async event => {
      if (event.effect !== 'ask') return
      const session = await sessionOf(event.sessionID).catch(() => null)
      if (!session) return
      const message = permissionAsked(session.$, { isQuestion: event.action === NAMES.ask, isAgent: session.isChild })
      if (message === null) return
      event.effect = 'deny'
      event.message = message
    })

    // After a shell command that pushed or opened a pull request, the plan outline goes into the pull
    // request's description, and the model reads what the checkpoint did after the command's own output.
    const shell = await ctx.tool.hook('execute.after', async event => {
      if (event.tool !== 'shell' || event.status !== 'completed') return
      const input = event.input as { command?: unknown; workdir?: unknown } | null
      if (typeof input?.command !== 'string') return
      const session = await sessionOf(event.sessionID).catch(() => null)
      if (!session) return
      // A checkpoint that fails leaves the command's result as it was.
      const line = await afterShell(session.$, input.command, typeof input.workdir === 'string' ? input.workdir : undefined).catch(() => null)
      if (line === null) return
      const content: unknown = event.result.content
      if (typeof content === 'string') event.result = { ...event.result, content: `${content}\n\n${line}` }
    })

    // A turn's end, a session's removal, and the heartbeat that keeps each session's lock on its goal.
    const events = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ['session.idle', 'session.deleted'], signal: events.signal })) {
        const sessionID = (event as { properties?: { sessionID?: string }; sessionID?: string }).properties?.sessionID ?? (event as { sessionID?: string }).sessionID
        const known = sessionID === undefined ? undefined : sessions.get(sessionID)
        if (sessionID === undefined || known === undefined) continue
        const session = await known.catch(() => null)
        if (!session) continue
        if (event.type === 'session.idle') await completeMode(session.$).catch(() => undefined)
        else {
          await endPlan(session.$, sessionID, false).catch(() => undefined)
          sessions.delete(sessionID)
        }
      }
    })().catch(() => undefined)

    const timer = setInterval(() => {
      for (const known of sessions.values()) {
        void known.then(session => (session.started && !session.isChild ? tickPlan(session.$) : undefined)).catch(() => undefined)
      }
    }, POLL_MS)
    timer.unref?.()

    return async () => {
      clearInterval(timer)
      events.abort()
      await Promise.all([context.dispose(), prompt.dispose(), permission.dispose(), shell.dispose()].map(done => Promise.resolve(done).catch(() => undefined)))
    }
  },
}

export default plugin
