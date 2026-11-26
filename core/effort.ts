import type { Host, Names } from './host.ts'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh'

/** The levels auto effort picks from, lowest first. */
export const LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh']
/** Each level as the person reads it. */
export const LEVEL_NAMES: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high' }
const PICK_MS = 8_000
// Unattended runs hold every main-chat turn here until the person types again.
export const RUN_LEVEL: EffortLevel = 'xhigh'

/** What the model picked: a level, or `keep` for the level of the turn before. */
export type EffortPick = { level: EffortLevel | 'keep'; why: string }

// Stops at the first match, so the order is the rubric.
function pickPrompt(text: string, lastReply: string, setting: string, { assistant, product }: Names) {
  return `You pick the reasoning effort a coding agent (${product}) should use for one prompt. Effort sets how much the agent reads, checks and thinks before acting. Pick the lowest level that will get the job done right.

Go through these in order and stop at the first that fits:

1. keep: the prompt only approves, answers a question ${assistant} asked, picks an option, or says to go on with earlier work ("yes", "2", "go on", "do it", "looks good").
2. low: a question about code or a tool, a lookup, a rename, a small edit the prompt spells out, a shell or git one-liner, a commit message or a piece of copy.
3. high: debugging where the cause is unknown, a change across several files, a refactor, a review for correctness, designing an API or a schema, or anything that touches auth, security, data migrations, money or concurrency.
4. xhigh: the person hands off a long, hard job and walks away, with no time to answer questions ("build all of X, don't ask me").
5. medium: everything else, such as ordinary feature work in one area, a single-file bug fix, tests for existing code, or docs. If you are not sure, medium.

A long prompt is not a hard task. Following a written recipe stays low or medium.

The current setting: ${setting}

${assistant}'s last reply (first 600 characters, for context):
<reply>
${lastReply || '(none, this is the first prompt)'}
</reply>

The new prompt:
<prompt>
${text}
</prompt>

Reply with JSON only: {"level": "low|medium|high|xhigh|keep", "why": "the reason in under 8 plain words"}`
}

function parsePick(text: string): EffortPick | null {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) return null
  try {
    const { level, why } = JSON.parse(json) as { level?: unknown; why?: unknown }
    const isLevel = level === 'keep' || LEVELS.includes(level as EffortLevel)
    if (!isLevel) return null
    const reason = typeof why === 'string' ? why.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '') : ''
    return { level: level as EffortPick['level'], why: reason.slice(0, 80) }
  } catch {
    return null
  }
}

/** Asks the model which level fits the prompt; null when it gives no answer that names one. */
export async function pickEffort($: Host, text: string, setting: string): Promise<EffortPick | null> {
  const lastReply = (await $.conversation.lastReply()).slice(0, 600)
  const answer = await $.model.ask(pickPrompt(text.slice(0, 4000), lastReply, setting, $.names), { maxTokens: 100, timeoutMs: PICK_MS })
  return answer === null ? null : parsePick(answer)
}

/**
 * The level a turn runs at: the model's pick for the prompt, with `keep` read as `last`, the level the
 * turn before ran at. Null to run at `setting`: no pick, or a pick that is the setting already.
 */
export async function chooseLevel($: Host, text: string, setting: string, last: string): Promise<EffortLevel | null> {
  const pick = await pickEffort($, text, setting)
  if (!pick) return null
  const level = pick.level === 'keep' ? last : pick.level
  return LEVELS.includes(level as EffortLevel) && level !== setting ? (level as EffortLevel) : null
}

// The effort names models offer, lowest first. `none` turns reasoning off, so no level falls back to it.
const SCALE: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The name among the levels a model offers that carries `level`: the same name, else the nearest above
 * it, else the nearest below it. Null when the model offers none but `none`, or no level at all.
 */
export function nearestLevel(level: EffortLevel, offered: readonly string[]): string | null {
  if (offered.includes(level)) return level
  const at = SCALE.indexOf(level)
  const known = offered.filter(name => name !== 'none' && SCALE.includes(name))
  const above = known.filter(name => SCALE.indexOf(name) > at).sort((a, b) => SCALE.indexOf(a) - SCALE.indexOf(b))
  const below = known.filter(name => SCALE.indexOf(name) < at).sort((a, b) => SCALE.indexOf(b) - SCALE.indexOf(a))
  return above[0] ?? below[0] ?? null
}

/** The lowest level a model offers, for a quick answer: `none` when it can turn reasoning off; null when it offers none. */
export function lowestLevel(offered: readonly string[]): string | null {
  return [...offered].filter(name => SCALE.includes(name)).sort((a, b) => SCALE.indexOf(a) - SCALE.indexOf(b))[0] ?? null
}

/** A level as the footer names it. */
export const levelLabel = (level: string) => LEVEL_NAMES[level]?.toLowerCase() ?? level
