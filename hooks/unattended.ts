import type { EngineInterface, On, PromptSubmitInput, Timer } from 'claude-code'

import type { Prompt } from '../core/host.ts'
import {
  closed,
  isRunCommand,
  isRunning as running,
  noAnswer,
  permissionAsked,
  questionAsked,
  questionDone,
  questionFailed,
  START_ANSWER_MS,
  submitUnattended as submit,
  writeChecked,
  writeEnded,
} from '../core/unattended.ts'
import { hostOf, NAMES } from './host'

// The tool Claude asks the person a question with.
const QUESTION = 'AskUserQuestion'

export { isRunCommand }

// Typed by the person, not a notification, a trigger or a message delivered mid-turn.
export const isTypedPrompt = (e: PromptSubmitInput) =>
  (e.origin.kind === 'composer' || e.origin.kind === 'bridge') && !e.turnId

/** A submitted prompt as the core reads it. */
export function promptOf(e: PromptSubmitInput): Prompt {
  return {
    isPerson: e.origin.kind === 'composer' || e.origin.kind === 'bridge',
    isTyped: isTypedPrompt(e),
    command: e.command?.name,
    isMeta: Boolean(e.isMeta),
    text: e.text,
  }
}

/** A run is active, for the footer under the prompt. */
export async function isRunning($: EngineInterface) {
  return running(hostOf($))
}

// The module's one prompt.submit hook calls this.
export async function submitUnattended($: EngineInterface, e: PromptSubmitInput) {
  await submit(hostOf($), promptOf(e))
}

export function registerUnattended(on: On) {
  // Nobody can answer a prompt during a run, so deny it rather than wait all night.
  on('classic.PermissionRequest', async ($, e, next) => {
    const message = await permissionAsked(hostOf($), { isQuestion: e.tool_name === QUESTION, isAgent: e.agent_id !== undefined })
    return message === null ? next(e) : { decision: { behavior: 'deny', message } }
  })

  // The run's start question goes to the person for START_ANSWER_MS; every other question during
  // a run is refused at once, so none waits all night.
  on('tool.call', { tool: QUESTION }, async ($, e, next) => {
    const asked = await questionAsked(hostOf($), e.agentId !== undefined)
    if ('pass' in asked) return next(e)
    if ('deny' in asked) return { deny: asked.deny }

    let timer: Timer | undefined
    const timeout = new Promise<'timeout'>(resolve => {
      timer = $.clock.after(START_ANSWER_MS, () => resolve('timeout'))
    })
    try {
      // Settling here while the dialog is open ends the dispatch beneath, and with it the dialog.
      const answer = await Promise.race([next(e).catch(() => 'closed' as const), timeout])
      if (answer === 'timeout') return { deny: noAnswer(NAMES) }
      if (answer === 'closed') return { deny: closed(NAMES) }
      return answer
    } finally {
      timer?.cancel()
      await questionDone(hostOf($))
    }
    // A check that fails must not leave a dialog open all night: during a run, refuse.
  }).catch(async ($, e, next) => {
    const deny = await questionFailed(hostOf($))
    return deny === null ? next(e) : { deny }
  })

  // A write that ran means approvals are flowing again: the count starts over.
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (e.tool_use_id && !e.isReadOnly) await writeChecked(hostOf($), e.tool_use_id)
    return r
  })
  on('classic.PostToolUse', async ($, e, next) => {
    await writeEnded(hostOf($), e.tool_use_id, true)
    return next(e)
  })
  on('classic.PostToolUseFailure', async ($, e, next) => {
    await writeEnded(hostOf($), e.tool_use_id, false)
    return next(e)
  })
}
