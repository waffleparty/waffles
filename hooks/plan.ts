import type { EngineInterface, On, PromptSubmitInput, SessionEndInput } from 'claude-code'

import {
  callPlan,
  completePlan as complete,
  endPlan as end,
  PLAN_TOOL,
  POLL_MS,
  pressPlan as press,
  spawnPlan,
  startPlan as start,
  stopPlan as stop,
  submitPlan as submit,
  SUBAGENT,
  tickPlan,
} from '../core/plan.ts'
import type { Collapsed, Turn } from '../core/plan-collapse.ts'
import type { Goal, Step } from '../core/plan-tree.ts'
import type { PlanCollapsed, PlanGoal, PlanStep, PlanTurn } from '../types'
import { hostOf } from './host'

/** The plan outline tool's name as the model calls it: Claude Code puts a plugin's tools under `mcp__<plugin>__`. */
export const TOOL = 'mcp__waffles__plan'

// plan-ui.tsx draws types/index.d.ts's copies of Goal, Step, Collapsed and Turn: a change to one side alone fails to compile here.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Holds<T extends true> = T
export type PlanShapes = [Holds<Equal<Goal, PlanGoal>>, Holds<Equal<Step, PlanStep>>, Holds<Equal<Collapsed, PlanCollapsed>>, Holds<Equal<Turn, PlanTurn>>]

// The module's one prompt.submit hook calls this. Only a prompt the person typed clears the
// highlights: a notification, a trigger or a slash command (/waffles:plan opens the pane that shows them) leaves them.
export function submitPlan($: EngineInterface, e: PromptSubmitInput): void {
  if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return
  if (e.command || e.isMeta) return
  submit(hostOf($))
}

// The module's one session.end hook calls this. After /clear the process goes on under a new ID with
// no active goal; after /resume the next poll restores the resumed session's goal.
export async function endPlan($: EngineInterface, e: SessionEndInput) {
  await end(hostOf($), e.sessionId, e.reason === 'clear' || e.reason === 'resume')
}

// A press on a parent step's row in the pane (plan-ui.tsx).
export async function pressPlan($: EngineInterface, id: string) {
  await press(hostOf($), id)
}

// The module's one turn.complete hook calls this for the main thread's turn: the plan outline's turn ends.
export function stopPlan($: EngineInterface) {
  stop(hostOf($))
}

// The module's one turn.complete hook calls this for a subagent's turn.
export async function completePlan($: EngineInterface, agent: string) {
  await complete(hostOf($), agent)
}

export function registerPlan(on: On) {
  // A background subagent the main thread starts for a step marks that step while it works.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.agentId === undefined) return r
    if (!e.background || e.parentAgentId !== undefined || e.isTeammate || e.workflow || e.resume) return r
    spawnPlan(hostOf($), e.description, r.agentId)
    return r
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: SUBAGENT }
    return callPlan(hostOf($), e as unknown as Record<string, unknown>)
  })
}

// The module's one session.start hook calls this.
export async function startPlan($: EngineInterface) {
  await $.tool.register({ ...PLAN_TOOL, isDeferred: false })
  // /waffles:plan comes from the skill skills/plan, and plan-ui.tsx answers it: the toggle never waits on a poll.
  // The first poll is awaited, so the tree is drawn before the first prompt. A goal still active at
  // start shows again where the layout docks the pane.
  await start(hostOf($))
  $.clock.every(POLL_MS, () => void tickPlan(hostOf($)))
}
