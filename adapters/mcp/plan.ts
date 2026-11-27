import { memoryOf } from '../../core/host.ts'
import { callPlan, endPlan, planTool, startPlan, tickPlan } from '../../core/plan.ts'
import { planRules } from '../../core/plan-prompt.ts'
import type { Module, Session } from './registry.ts'

/**
 * The plan outline: its tool, its rules as the instructions, and a resource that holds what `show`
 * prints, for a client to read or to watch where it has no pane that draws the outline.
 */

export const PLAN_OUTLINE_URI = 'waffles://plan-outline'

// What the outline was when last looked at, so a change is told once.
const seen = ($: Session['$']) => memoryOf<{ last: string | null }>($, 'mcp-plan-outline', () => ({ last: null }))

/** Tells the resource's subscribers when the outline differs from when it was last looked at. */
async function looked({ $, changed }: Session): Promise<void> {
  const now = JSON.stringify(await Promise.all([$.state.get('planGoal'), $.state.get('planTree'), $.state.get('planOthers'), $.state.get('planError')]))
  const v = seen($)
  const was = v.last
  v.last = now
  if (was !== null && was !== now) changed(PLAN_OUTLINE_URI)
}

export const planModule: Module = {
  name: 'plan',
  tools: [
    {
      ...planTool,
      nameVariable: 'WAFFLES_PLAN_TOOL',
      // A refusal is the tool's answer, which the model reads and acts on, not a failure of the protocol.
      call: async (session, input) => {
        const answer = await planTool.call(session.$, input)
        await looked(session)
        return answer
      },
    },
  ],
  resources: [
    {
      uri: PLAN_OUTLINE_URI,
      name: 'plan-outline',
      title: 'Plan outline',
      description: "The session's active goal as a tree, with the other open goals; with no active goal, the open goals.",
      mimeType: 'text/plain',
      isWatched: true,
      read: async ({ $ }) => {
        const answer = await callPlan($, { op: 'show' })
        return 'deny' in answer ? answer.deny : answer.result
      },
    },
  ],
  instructions: ({ names }) => planRules(names),
  // The first poll is awaited, so a goal still active from an earlier process is restored first.
  start: async session => {
    await startPlan(session.$)
    await looked(session)
  },
  // The heartbeat keeps the session's lock on its goal live; a goal another session took is a change too.
  tick: async session => {
    await tickPlan(session.$)
    await looked(session)
  },
  end: session => endPlan(session.$, session.id, false),
}
