import type { EngineInterface } from 'claude-code'

import { planContext as context, planRules } from '../core/plan-prompt.ts'
import { hostOf } from './host'
import { TOOL } from './plan'

/** The plan outline's rules as a system prompt section: the same bytes in every request, so the prompt cache holds. */
export const RULES = {
  id: 'waffles:plan-outline',
  scope: 'session',
  text: planRules({ tool: TOOL, ask: 'AskUserQuestion', planMode: "Claude Code's plan mode" }),
} as const

/** The first message's plan outline block; empty with nothing to say. */
export async function planContext($: EngineInterface): Promise<string> {
  return context(hostOf($))
}
