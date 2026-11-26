import type { Names } from '../../core/host.ts'
import type { NeutralAnswer, NeutralEvent } from './neutral.ts'

/**
 * A platform's translation table: its hook input to a neutral event, and the neutral answer to its hook
 * output. `name` is the platform's own name for the event, as the hook command passes it.
 */
export type Platform = {
  names: Names
  /** The session's ID and working directory from the hook's input; null when the input has none. */
  session(input: Record<string, unknown>): { sessionId: string; cwd: string } | null
  /** The neutral event; null for an event, or an input, the adapter leaves alone. */
  event(name: string, input: Record<string, unknown>): NeutralEvent | null
  /** The JSON the hook prints; null to print nothing, which lets the platform go on as it would. */
  output(name: string, answer: NeutralAnswer): object | null
  /** How long the event's work may take before the hook gives up and prints nothing, in ms. */
  budgetMs(name: string): number
  /** Whether the platform reads added context from the event's output, so a mode change's note reaches the model. */
  hasContext(name: string): boolean
}
