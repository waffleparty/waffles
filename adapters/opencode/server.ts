import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Plugin } from '@opencode/plugin'

import { adapterContext } from '../../core/backlog-adapter.ts'
import { afterShell } from '../../core/checkpoint.ts'
import { lowestLevel } from '../../core/effort.ts'
import { INITIAL, type AgentInfo, type Host, type Names, type SessionState } from '../../core/host.ts'
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
import { callPlan, completePlan, endPlan, PLAN_TOOL, POLL_MS, spawnPlan, startPlan, submitPlan, SUBAGENT, tickPlan } from '../../core/plan.ts'
import { planContext, planRules } from '../../core/plan-prompt.ts'
import { isRunCommand, permissionAsked, submitUnattended } from '../../core/unattended.ts'
import { nodeHost } from '../node/host.ts'
import { autoEffort, EFFORT_COMMAND, EFFORT_DESCRIPTION, type ModelRef, type Variant } from './effort.ts'
import { guardQuestion, QUESTION_TOOL } from './unattended.ts'
import { NOTICE } from './view.ts'

/**
 * The waffles plugin's server part for OpenCode 2: the plan outline tool, the modes and their commands,
 * the rules in the system prompt, and the skills. It runs in OpenCode's server process, which serves
 * every session, so each session gets its own host.
 *
 * A push runs the checkpoint.
 *
 * An unattended run starts when the person names the `non-interactive` skill in a prompt (`@non-interactive`,
 * which OpenCode sends as the prompt's skill attachment), and ends at the next prompt they type between
 * turns. During a run, permission requests are denied and questions refused with the texts the core
 * gives; the run's start question waits START_ANSWER_MS for the person, and is then taken off the screen.
 *
 * Auto effort picks a level for each prompt the person types and applies it to the turn's model requests
 * as the model's own variant of that level; /auto-effort turns it on or off. The small model it asks is the
 * session's own, at its lowest variant: price alone does not tell a fast cheap model in a provider's list.
 *
 * A subagent the main session starts with the subagent tool, whose description names a step first with a
 * colon (`6.2: Build the parser`), marks that step while it works; its session's turn end sets the step to
 * review. The plan outline's view and the footer are the terminal UI part's (tui.tsx).
 *
 * Not here: the waffles agents and the dev servers item, which only Claude Code has, and a reply to /prod,
 * /rapid and /backlog-entry, whose text OpenCode gives no place (only /auto-effort's shows, as a toast).
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
/** OpenCode's built-in tool that starts a subagent in a child session; it always runs in the background. */
export const SUBAGENT_TOOL = 'subagent'
// How long the list of models, and their variants, is used before it is read again.
const MODELS_MS = 60_000

type Session = {
  $: Host
  /** The session whose child this session is, when it is a subagent's. */
  parentID: string | null
  /** Whether the session is another session's child: a subagent. */
  isChild: boolean
  /** Set once the session's first prompt has started the core for it. */
  started: Promise<void> | null
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The plugin's folder: two levels above this file. */
export const pluginRoot = () => join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Skills that only work where a hook answers them. `plan` opens Claude Code's pane; on OpenCode the
// sidebar always shows the plan outline, and the skill's text would tell the model the plugin is broken.
const NOT_HERE: readonly string[] = ['plan']

/**
 * The `name` and `description` of a skill file's front matter, and whether the model may load the skill
 * by itself: `disable-model-invocation: true` keeps a skill for the person to call. Null when the file
 * names no skill.
 */
export function skillHeader(text: string): { name: string; description: string; autoinvoke: boolean } | null {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  if (front === undefined) return null
  const field = (key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(front)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
  const [name, description] = [field('name'), field('description')]
  return name && description ? { name, description, autoinvoke: field('disable-model-invocation') !== 'true' } : null
}

type SkillFile = { id: string; name: string; description: string; autoinvoke: boolean; path: string; content: string }

/** The skills in the plugin's `skills/` folder that work here, one per folder with a SKILL.md that names itself. */
export async function readSkills(root: string): Promise<SkillFile[]> {
  const folder = join(root, 'skills')
  const names = await fs.readdir(folder).catch(() => [] as string[])
  const skills: SkillFile[] = []
  for (const id of names.sort()) {
    if (NOT_HERE.includes(id)) continue
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
    // The sessions whose turn is running: a prompt typed into one is delivered into that turn.
    const busy = new Set<string>()

    // The models OpenCode offers, with their variants, read again after MODELS_MS.
    let models: { at: number; list: Promise<readonly { providerID: string; id: string; variants?: readonly Variant[] }[]> } | null = null
    const modelList = () => {
      if (!models || Date.now() - models.at > MODELS_MS) {
        const list = ctx.model.list().then(answer => answer.data as never)
        models = { at: Date.now(), list }
        list.catch(() => (models = null))
      }
      return models.list
    }
    const variantsOf = async (model: ModelRef) => (await modelList()).find(m => m.providerID === model.providerID && m.id === model.id)?.variants ?? []
    const effort = autoEffort(variantsOf)

    // The model a quick question goes to: the session's own, else the default, at its lowest variant.
    const quickModel = async (sessionID: string): Promise<ModelRef | null> => {
      const info = await ctx.session.get({ sessionID })
      const fallback = info.model ? null : (await ctx.model.default()).data
      const ref = info.model ?? (fallback ? { providerID: fallback.providerID, id: fallback.id } : null)
      if (!ref) return null
      const variant = lowestLevel((await variantsOf(ref)).map(v => v.id))
      return { providerID: ref.providerID, id: ref.id, ...(variant === null ? {} : { variant }) }
    }

    // The subagents a session started: its child sessions, running while their last turn has not ended.
    const childrenOf = async (sessionID: string): Promise<AgentInfo[]> => {
      const page = await ctx.session.list({ parentID: sessionID, limit: 200 })
      return page.data.map(child => {
        const { busy, idle } = child.time
        const status = busy === undefined ? (idle === undefined ? 'pending' : 'completed') : idle === undefined || busy > idle ? 'running' : 'completed'
        return { id: child.id, status }
      })
    }

    // The text of the session's last assistant message that holds any.
    const lastReplyOf = async (sessionID: string): Promise<string> => {
      const messages = await ctx.session.context({ sessionID })
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]!
        if (message.type !== 'assistant') continue
        const text = message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n')
        if (text.trim()) return text
      }
      return ''
    }

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
              lastReply: () => lastReplyOf(sessionID).catch(() => ''),
              note: text => entry(MODE_ENTRY, text).then(() => true),
            },
            agents: { list: () => childrenOf(sessionID) },
            // A question that gets no answer in time is stopped, so it costs nothing more.
            model: {
              ask: async (prompt, { timeoutMs }) => {
                const model = await quickModel(sessionID).catch(() => null)
                if (!model) return null
                const stop = AbortSignal.timeout(timeoutMs)
                return ctx.experimental.generate.text({ model, prompt }, { signal: stop }).then(
                  answer => answer.text,
                  () => null,
                )
              },
            },
            log: message => console.debug(`waffles: ${message}`),
          },
        })
        const parentID = info.parentID ?? null
        return { $, parentID, isChild: parentID !== null, started: null }
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
        await startMode($)
        await startPlan($).catch(error => $.log(`the plan outline did not start: ${messageOf(error)}`))
        const put = (key: string, value: string) =>
          value ? ctx.session.instructions.entry.put({ sessionID, key, value }) : Promise.resolve()
        await put(MODE_ENTRY, await modeContext($))
        await put(PLAN_ENTRY, await planContext($).catch(() => ''))
        await put(ADAPTER_ENTRY, await adapterContext($))
      })())

    // The host that holds a session's unattended run: a run belongs to the main session, and a subagent's
    // session, at any depth, asks under its rules. Null when the session can't be read.
    const runOf = async (sessionID: string): Promise<{ $: Host; isChild: boolean } | null> => {
      const session = await sessionOf(sessionID).catch(() => null)
      if (!session) return null
      let [id, root] = [sessionID, session]
      for (let depth = 0; root.parentID !== null && depth < 8; depth++) {
        const parent = await sessionOf(root.parentID).catch(() => null)
        if (!parent) break
        ;[id, root] = [root.parentID, parent]
      }
      await started(id, root)
      return { $: root.$, isChild: session.isChild }
    }

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
      // During an unattended run the question tool asks only the run's start question.
      editor.update(QUESTION_TOOL, tool => {
        tool.execute = guardQuestion(tool.execute, runOf)
      })
    })

    // What each command does, by name: the text the person reads, and whether rapid work was handed over.
    const run: Record<string, ($: Host) => Promise<{ text: string; isHandover?: boolean }>> = {
      'backlog-entry': async $ => ({ text: await runBacklog($) }),
      rapid: async $ => ({ text: await runRapid($) }),
      prod: runProd,
    }
    // The last line a command has for the person, for the terminal UI part to show.
    const notify = async (sessionID: string, text: string) => {
      const info = await ctx.session.get({ sessionID })
      await ctx.session.update({ sessionID, metadata: { ...info.metadata, [NOTICE]: { text, at: Date.now() } } as never })
    }
    await ctx.command.transform(editor => {
      editor.add({
        name: EFFORT_COMMAND,
        description: EFFORT_DESCRIPTION,
        execute: async ({ sessionID, prompt }) => {
          const session = await sessionOf(sessionID)
          await notify(sessionID, await effort.command(session.$, prompt.text))
        },
      })
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
    // The main session's turn runs at the level auto effort chose for it; a subagent runs at its own variant.
    const context = await ctx.session.hook('context', async event => {
      event.system.push({ type: 'text', text: MODES_TEXT }, { type: 'text', text: rules })
      const session = await sessionOf(event.sessionID).catch(() => null)
      if (!session || session.isChild) return
      const options = await effort.request(session.$, event.sessionID, event.model).catch(() => null)
      if (options) Object.assign(event.options, options)
    })

    const prompt = await ctx.session.hook('prompt', async event => {
      const session = await sessionOf(event.sessionID)
      if (session.isChild) return
      await started(event.sessionID, session)
      const { $ } = session
      // OpenCode hands this hook the prompts a person or a command sends, not synthetic messages. A skill
      // named in the prompt is what a slash command is on Claude Code; a prompt typed while a turn runs is
      // delivered into that turn, and neither starts nor ends a run.
      const skills = (event.prompt.skills ?? []).map(skill => skill.id as string)
      const command = skills.find(isRunCommand) ?? skills[0]
      const typed = { isPerson: true, isTyped: !busy.has(event.sessionID), command, isMeta: false, text: event.prompt.text }
      const before = await wafflesMode($)
      await submitUnattended($, typed)
      effort.submit(event.sessionID, typed)
      submitPlan($)
      // The line that states backlog mode beside a prompt is not added here: the mode block always holds the current mode.
      await submitMode($, typed, before)
    })

    // During an unattended run nobody can answer a permission request, so it is denied with what to do next.
    const permission = await ctx.permission.hook('evaluate', async event => {
      if (event.effect !== 'ask') return
      const session = await runOf(event.sessionID)
      if (!session) return
      const message = await permissionAsked(session.$, { isQuestion: event.action === NAMES.ask, isAgent: session.isChild })
      if (message === null) return
      event.effect = 'deny'
      event.message = message
    })

    // After a shell command that pushed or opened a pull request, the plan outline goes into the pull
    // request's description, and the model reads what the checkpoint did after the command's own output.
    // A subagent the main session starts marks the step its description names first. A follow-up to a
    // subagent (an input with a sessionID) is not a new one.
    const spawned = async (event: { sessionID: string; input: unknown; result: { metadata?: unknown } }) => {
      const input = event.input as { description?: unknown; sessionID?: unknown } | null
      const child = (event.result.metadata as { sessionID?: unknown } | undefined)?.sessionID
      if (typeof input?.description !== 'string' || input.sessionID !== undefined || typeof child !== 'string') return
      const session = await sessionOf(event.sessionID).catch(() => null)
      if (!session || session.isChild) return
      await started(event.sessionID, session)
      spawnPlan(session.$, input.description, child)
    }

    const after = await ctx.tool.hook('execute.after', async event => {
      if (event.tool === SUBAGENT_TOOL && event.status === 'completed') return spawned(event)
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

    // A turn's start and end, a session's removal, and the heartbeat that keeps each session's lock on its
    // goal. A turn ends when the session's execution settles: OpenCode 2.4 sends plugins no session.idle.
    const TURN_ENDS: readonly string[] = ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.idle']
    const types = ['session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.idle', 'session.deleted'] as const
    // A subagent's turn end sets its step to review; the main session's ends the turn's effort and mode work.
    const turnEnded = async (sessionID: string, session: Session) => {
      if (session.parentID !== null) {
        const parent = await sessionOf(session.parentID).catch(() => null)
        if (parent && !parent.isChild) await completePlan(parent.$, sessionID).catch(() => undefined)
        return
      }
      effort.complete(sessionID)
      await completeMode(session.$).catch(() => undefined)
    }
    const events = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: [...types], signal: events.signal })) {
        const sessionID = (event as { data?: { sessionID?: string } }).data?.sessionID
        if (sessionID === undefined) continue
        if (event.type === 'session.execution.started') busy.add(sessionID)
        else busy.delete(sessionID)
        // A turn's end is looked up even for a session no hook has met yet: a subagent may run no tool at all.
        const isEnd = TURN_ENDS.includes(event.type)
        const known = sessions.get(sessionID) ?? (isEnd ? sessionOf(sessionID) : undefined)
        const session = known === undefined ? null : await known.catch(() => null)
        if (!session) continue
        if (isEnd) await turnEnded(sessionID, session)
        else if (event.type === 'session.deleted') {
          await endPlan(session.$, sessionID, false).catch(() => undefined)
          effort.forget(sessionID)
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
      await Promise.all([context.dispose(), prompt.dispose(), permission.dispose(), after.dispose()].map(done => Promise.resolve(done).catch(() => undefined)))
    }
  },
}

export default plugin
