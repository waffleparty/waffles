import type { EngineInterface, On, PromptSubmitInput, SessionEndInput, SessionMessage } from 'claude-code'

import {
  ASSESS_PROMPT,
  clearMode,
  commandsOf,
  COMPACT_INSTRUCTIONS,
  completeMode as complete,
  interactionMode as interaction,
  isModeNote,
  modeContext as context,
  modesText,
  runBacklog,
  runProd,
  runRapid,
  startMode as start,
  submitMode as submit,
  wafflesMode as waffles,
} from '../core/modes.ts'
import type { InteractionMode, WafflesMode } from '../types'
import { hostOf, NAMES } from './host'
import { promptOf } from './unattended'

// The engine lists a module's commands from its source, so their names are written here; core/modes.ts
// holds the same names with what each is for.
const BACKLOG_COMMAND = 'backlog-entry'
const PROD_COMMAND = 'prod'
const RAPID_COMMAND = 'rapid'

const described = (name: string) => commandsOf(NAMES).find(c => c.name === name)?.description ?? ''

/** The modes' definitions as a system prompt section: the same bytes in every request, so the prompt cache holds. */
export const MODES_SECTION = { id: 'waffles:modes', scope: 'session', text: modesText(NAMES) } as const

const isNote = (m: SessionMessage) => m.role === 'user' && !m.toolResults?.length && isModeNote(NAMES, m.text)

/** The interaction mode, for the footer under the prompt. */
export async function interactionMode($: EngineInterface): Promise<InteractionMode> {
  return interaction(hostOf($))
}

/** The mode the model is told: a run takes over from the interaction mode. */
export async function wafflesMode($: EngineInterface): Promise<WafflesMode> {
  return waffles(hostOf($))
}

// The module's one session.start hook calls this.
export async function startMode($: EngineInterface) {
  await $.command.register({ name: BACKLOG_COMMAND, description: described(BACKLOG_COMMAND) })
  await $.command.register({ name: PROD_COMMAND, description: described(PROD_COMMAND) })
  await $.command.register({ name: RAPID_COMMAND, description: described(RAPID_COMMAND) })
  await start(hostOf($))
}

// The module's one prompt.submit hook calls this, with the mode before the prompt, after
// submitUnattended; it passes on what this returns.
export async function submitMode($: EngineInterface, e: PromptSubmitInput, before: WafflesMode): Promise<PromptSubmitInput> {
  const line = await submit(hostOf($), promptOf(e), before)
  return line === null ? e : { ...e, context: [...(e.context ?? []), line] }
}

// The module's one turn.complete hook calls this, for a main-chat turn.
export async function completeMode($: EngineInterface) {
  await complete(hostOf($))
}

// The module's one prompt.context hook calls this for the wafflesMode block.
export async function modeContext($: EngineInterface): Promise<string> {
  return context(hostOf($))
}

// The module's one session.end hook calls this. /clear ends the conversation without a
// session.start for the new one.
export async function endMode($: EngineInterface, e: SessionEndInput) {
  if (e.reason !== 'clear') return
  await clearMode(hostOf($))
}

export function registerMode(on: On) {
  on('command.run', { command: BACKLOG_COMMAND }, async $ => ({ text: await runBacklog(hostOf($)) }))

  on('command.run', { command: RAPID_COMMAND }, async $ => ({ text: await runRapid(hostOf($)) }))

  on('command.run', { command: PROD_COMMAND }, async $ => {
    const { text, isHandover } = await runProd(hostOf($))
    // The assessment starts now, not at the next prompt. A command.run hook may not submit a
    // prompt (it would wait on the turn the hook holds), so a timer submits it once the command is
    // done; the prompt runs once the session is idle.
    if (isHandover) $.clock.after(1, () => void $.prompt.submit({ text: ASSESS_PROMPT }).catch(() => undefined))
    return { text }
  })

  // The notes would outlive the mode they state in a summary; the next first message states it.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const instructions = [e.instructions, COMPACT_INSTRUCTIONS].filter(Boolean).join('\n\n')
    return next({ ...e, messages: e.messages.filter(m => !isNote(m)), instructions })
  })
}
