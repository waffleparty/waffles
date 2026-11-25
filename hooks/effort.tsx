import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PromptSubmitInput, SessionMessage } from 'claude-code'

import type { EffortLevel } from '../types'
import { isRunCommand, isTypedPrompt } from './unattended'

const current = atom({ plugin: 'waffles', key: 'effort' } as const, null)
const setting = atom({ plugin: 'waffles', key: 'effortSetting' } as const, null)
const shown = atom({ plugin: 'waffles', key: 'effortMode' } as const, 'auto')
const picking = atom({ plugin: 'waffles', key: 'effortPicking' } as const, false)

const COMMAND = 'auto-effort'
const LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh']
const NAMES: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high' }
const PICK_MS = 8_000
// Unattended runs hold every main-chat turn here until the person types again.
const RUN_LEVEL: EffortLevel = 'xhigh'

type Pick = { level: EffortLevel | 'keep'; why: string }

// Stops at the first match, so the order is the rubric.
function pickPrompt(text: string, lastReply: string, setting: string) {
  return `You pick the reasoning effort a coding agent (Claude Code) should use for one prompt. Effort sets how much the agent reads, checks and thinks before acting. Pick the lowest level that will get the job done right.

Go through these in order and stop at the first that fits:

1. keep: the prompt only approves, answers a question Claude asked, picks an option, or says to go on with earlier work ("yes", "2", "go on", "do it", "looks good").
2. low: a question about code or a tool, a lookup, a rename, a small edit the prompt spells out, a shell or git one-liner, a commit message or a piece of copy.
3. high: debugging where the cause is unknown, a change across several files, a refactor, a review for correctness, designing an API or a schema, or anything that touches auth, security, data migrations, money or concurrency.
4. xhigh: the person hands off a long, hard job and walks away, with no time to answer questions ("build all of X, don't ask me").
5. medium: everything else, such as ordinary feature work in one area, a single-file bug fix, tests for existing code, or docs. If you are not sure, medium.

A long prompt is not a hard task. Following a written recipe stays low or medium.

The current setting: ${setting}

Claude's last reply (first 600 characters, for context):
<reply>
${lastReply || '(none, this is the first prompt)'}
</reply>

The new prompt:
<prompt>
${text}
</prompt>

Reply with JSON only: {"level": "low|medium|high|xhigh|keep", "why": "the reason in under 8 plain words"}`
}

function parsePick(text: string): Pick | null {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) return null
  try {
    const { level, why } = JSON.parse(json) as { level?: unknown; why?: unknown }
    const isLevel = level === 'keep' || LEVELS.includes(level as EffortLevel)
    if (!isLevel) return null
    const reason = typeof why === 'string' ? why.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '') : ''
    return { level: level as Pick['level'], why: reason.slice(0, 80) }
  } catch {
    return null
  }
}

function lastAssistantText(messages: readonly SessionMessage[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.text.trim()) return m.text
  }
  return ''
}

async function pick($: EngineInterface, text: string, setting: string): Promise<Pick | null> {
  const lastReply = lastAssistantText(await $.session.messages()).slice(0, 600)
  const r = await $.model.complete({
    model: 'haiku',
    prompt: pickPrompt(text.slice(0, 4000), lastReply, setting),
    maxTokens: 100,
    effort: 'low',
    timeoutMs: PICK_MS,
  })
  return r.isAnswered ? parsePick(r.text) : null
}

const label = (level: string) => NAMES[level]?.toLowerCase() ?? level

/**
 * The footer's effort state: the setting while auto effort is off, else `auto`,
 * with the level a running turn was given.
 */
export async function effortLabel($: EngineInterface): Promise<string | null> {
  const m = await read($, shown)
  const s = await read($, setting)
  if (m === 'off') return s ? `effort: ${label(s)}` : null
  if (await read($, picking)) return 'effort: auto (picking…)'
  const level = await read($, current)
  return level ? `effort: auto (${label(level)})` : 'effort: auto'
}

// Module variables start over on a reload; what the footer shows lives in $.state.
let isEnabled = true
// The prompt waiting for its pick at its turn's first request.
let pending: string | null = null
// The setting the running turn started at, and the level the mod holds it at.
let base = ''
let turnLevel: EffortLevel | null = null
// What the last turn ran at, for "keep".
let lastLevel = ''
// A /waffles:non-interactive run in progress.
let isRun = false

// Returns the level to hold the turn at, or null to run at the setting.
async function choose($: EngineInterface, text: string, setting: string): Promise<EffortLevel | null> {
  await update($, picking, () => true)
  let p: Pick | null = null
  try {
    p = await pick($, text, setting)
  } finally {
    await update($, picking, () => false)
  }
  if (!p) return null
  const level = p.level === 'keep' ? lastLevel : p.level
  if (!LEVELS.includes(level as EffortLevel) || level === setting) return null
  return level as EffortLevel
}

// The module's one session.start hook calls this.
export async function startEffort($: EngineInterface) {
  await $.command.register({
    name: COMMAND,
    description: 'Pick the effort level for each prompt: on, or off to use your /effort setting',
    argumentHint: '[on|off]',
  })
  isEnabled = (await $.store.get('effort.enabled')) !== false
  await update($, shown, () => (isEnabled ? 'auto' : 'off'))
  // Until the first turn says otherwise, the saved default.
  if ((await read($, setting)) === null) {
    const saved = await $.settings.read({ key: 'effortLevel' })
    if (typeof saved === 'string') await update($, setting, () => saved)
  }
}

// The module's one prompt.submit hook calls this.
export function submitEffort(e: PromptSubmitInput) {
  // Typed prompts only: no slash commands, notifications, triggers or messages delivered mid-turn.
  const isTyped = isTypedPrompt(e)
  const text = e.text.trim()
  pending = isEnabled && isTyped && !e.command && text && !text.startsWith('/') ? text : null
  // Anything typed ends a run; the run's command starts one.
  if (isTyped) {
    isRun = isEnabled && isRunCommand(e.command?.name)
  }
}

// The module's one turn.complete hook calls this, for a main-chat turn.
export async function completeEffort($: EngineInterface) {
  turnLevel = null
  await update($, current, () => null)
}

export function registerEffort(on: On) {
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || typeof e.effort !== 'string') return yield* next(e)

    if (e.index === 0) {
      base = e.effort
      const text = pending
      pending = null
      turnLevel = null
      if (isRun) {
        turnLevel = base === RUN_LEVEL ? null : RUN_LEVEL
      } else if (text) {
        turnLevel = await choose($, text, base).catch(() => null)
      }
      lastLevel = turnLevel ?? base
      await update($, setting, () => base)
      await update($, current, () => (isEnabled ? lastLevel : null))
    } else if (e.effort !== base) {
      // The setting moved mid-turn: it wins, and ends a run's hold.
      if (turnLevel) isRun = false
      base = e.effort
      turnLevel = null
      lastLevel = base
      await update($, setting, () => base)
      await update($, current, cur => (cur ? base : null))
    }

    if (!turnLevel || turnLevel === e.effort) return yield* next(e)
    return yield* next({ ...e, effort: turnLevel })
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      isEnabled = arg === 'on'
      if (!isEnabled) isRun = false
      await $.store.set('effort.enabled', isEnabled)
    } else if (arg) {
      return { text: `Unknown argument: ${arg}. Use on or off.` }
    }
    await update($, shown, () => (isEnabled ? 'auto' : 'off'))
    return {
      text: [
        `Auto effort: ${isEnabled ? 'on' : 'off'}.`,
        isRun ? `A non-interactive run holds every turn at ${NAMES[RUN_LEVEL]} until you type a prompt.` : '',
        isEnabled
          ? 'Effort will be automatically selected each turn based on the content of the prompt.'
          : 'Every turn runs at your effort setting.',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  })

  // /effort between turns: the footer shows the new setting before the next turn starts.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const r = await next(e)
    const arg = e.args.trim().toLowerCase()
    const saved = LEVELS.includes(arg as EffortLevel) ? arg : await $.settings.read({ key: 'effortLevel' })
    await update($, setting, () => (typeof saved === 'string' ? saved : null))
    // Setting the effort by hand turns auto effort off, as /auto-effort off does.
    if (arg && isEnabled) {
      isEnabled = false
      isRun = false
      pending = null
      await $.store.set('effort.enabled', false)
      await update($, shown, () => 'off')
    }
    return r
  })
}
