import { chooseLevel, LEVEL_NAMES, nearestLevel, RUN_LEVEL, type EffortLevel } from '../../core/effort.ts'
import type { Host } from '../../core/host.ts'

/** The command that turns auto effort on or off. */
export const EFFORT_COMMAND = 'auto-effort'
export const EFFORT_DESCRIPTION = "Pick the effort level for each prompt: on, or off to use the model's variant"
// The person's choice, in the person's values, as on Claude Code.
const ENABLED = 'effort.enabled'

/** A model as a request names it: OpenCode's variant is the person's effort setting for it. */
export type ModelRef = { providerID: string; id: string; variant?: string }
/** A model variant as OpenCode lists it: provider options under `settings`, raw request fields under `body`. */
export type Variant = { id: string; settings?: Record<string, unknown>; body?: Record<string, unknown>; headers?: Record<string, string> }

// What one main session keeps between its prompt and its turn's requests.
type Turn = {
  // The prompt waiting for its pick at its turn's first request.
  pending: string | null
  // Set once the turn's first request has chosen its level.
  isDecided: boolean
  // The variant the turn started at, and the level it is held at; null runs at the variant.
  base: string
  level: EffortLevel | null
  // What the last turn ran at, for "keep".
  last: string
}

/**
 * Auto effort on OpenCode. A prompt the person types is held until its turn's first model request,
 * which asks a small model for a level (`chooseLevel`); a run holds every turn at RUN_LEVEL. The level
 * reaches the provider as the provider options of the model's own variant of that name: OpenCode's
 * variants already hold the right option for each provider (`effort` for Anthropic, `reasoningEffort`
 * for OpenAI), so no provider is named here. A model with no variants runs as it is.
 */
export function autoEffort(variantsOf: (model: ModelRef) => Promise<readonly Variant[]>) {
  const turns = new Map<string, Turn>()
  const turnOf = (sessionID: string) => {
    let turn = turns.get(sessionID)
    if (!turn) turns.set(sessionID, (turn = { pending: null, isDecided: false, base: '', level: null, last: '' }))
    return turn
  }

  const isEnabled = async ($: Host) => (await $.store.get(ENABLED).catch(() => undefined)) !== false

  // The provider options of the model's variant for `level`; null when the request already runs at it,
  // or the model has none that carries it. A variant that needs raw request fields is left out: a
  // request's options carry provider options only.
  async function optionsFor(model: ModelRef, level: EffortLevel): Promise<Record<string, unknown> | null> {
    const variants = await variantsOf(model).catch(() => [] as readonly Variant[])
    const name = nearestLevel(level, variants.map(v => v.id))
    if (name === null || name === model.variant) return null
    const variant = variants.find(v => v.id === name)
    const isPlain = Object.keys(variant?.body ?? {}).length === 0 && Object.keys(variant?.headers ?? {}).length === 0
    return variant?.settings && isPlain ? variant.settings : null
  }

  return {
    /**
     * A prompt was admitted. One the person typed between turns, with no skill named in it, waits
     * for its pick; anything else the person types starts the next turn at the variant.
     */
    submit(sessionID: string, { isTyped, command, text }: { isTyped: boolean; command: string | undefined; text: string }) {
      if (!isTyped) return
      const turn = turnOf(sessionID)
      const body = text.trim()
      turn.pending = command === undefined && body && !body.startsWith('/') ? body : null
      turn.isDecided = false
      turn.level = null
    },

    /** A model request of the main session's agent loop: the options to add to it, or null for none. */
    async request($: Host, sessionID: string, model: ModelRef): Promise<Record<string, unknown> | null> {
      const turn = turnOf(sessionID)
      const setting = model.variant ?? 'default'
      if (!turn.isDecided) {
        turn.isDecided = true
        const text = turn.pending
        turn.pending = null
        turn.base = setting
        turn.level = null
        if (await isEnabled($)) {
          if (await $.state.get('run')) turn.level = setting === RUN_LEVEL ? null : RUN_LEVEL
          else if (text) turn.level = await chooseLevel($, text, setting, turn.last).catch(() => null)
        }
        turn.last = turn.level ?? setting
      } else if (setting !== turn.base) {
        // The person changed the variant mid-turn: it wins.
        turn.base = setting
        turn.level = null
        turn.last = setting
      }
      return turn.level ? optionsFor(model, turn.level) : null
    },

    /** The session's turn ended: the next one chooses again. */
    complete(sessionID: string) {
      const turn = turns.get(sessionID)
      if (!turn) return
      turn.isDecided = false
      turn.level = null
    },

    forget(sessionID: string) {
      turns.delete(sessionID)
    },

    /** /auto-effort [on|off]: the text the person reads. */
    async command($: Host, args: string): Promise<string> {
      const arg = args.trim().toLowerCase()
      if (arg === 'on' || arg === 'off') await $.store.set(ENABLED, arg === 'on')
      else if (arg) return `Unknown argument: ${arg}. Use on or off.`
      const isOn = await isEnabled($)
      return [
        `Auto effort: ${isOn ? 'on' : 'off'}.`,
        isOn && (await $.state.get('run')) ? `A non-interactive run holds every turn at ${LEVEL_NAMES[RUN_LEVEL]} until you type a prompt.` : '',
        isOn
          ? 'Effort will be automatically selected each turn based on the content of the prompt.'
          : "Every turn runs at the model's variant.",
      ]
        .filter(Boolean)
        .join('\n')
    },
  }
}
