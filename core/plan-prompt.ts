import type { EngineInterface } from 'claude-code'

import { activeGoal, logFailure, openGoalLines } from './plan'
import { findPlanRoot, goalName, listGoals } from './plan-store'
import { renderTree } from '../core/plan-tree.ts'

// A system prompt section with the same bytes in every request, so the prompt cache holds; the tree
// goes in the first message instead. It is there in a checkout with no .tmp/plan/ too: the rules say when
// to start the first goal.
export const RULES = {
  id: 'waffles:plan-outline',
  scope: 'session',
  text: `# waffles plan outline

The waffles plugin keeps a plan outline: a tree of the work in this checkout, stored as one goal file per goal in .tmp/plan/ and shown to the person beside the chat. It shows the path from the goal to the current step, so the person can find the way back after side quests. Change it only with the mcp__waffles__plan tool, never by editing its goal files. The plan outline is not Claude Code's plan mode.

A session has 1 goal at a time. With no active goal, start one for any work that isn't done in the same reply; a question answered or a single change finished in the same reply gets none. When a prompt makes 2 or more steps, start the goal with those steps before starting the work. When a single change grows more steps, start the goal then. When the work matches an open goal named in the plan outline context, continue it with switch instead. While a goal is active, never start or switch to another goal, even for work that seems unrelated: it goes into the active goal's tree, so the way back stays in 1 tree. The other open goals are the work of other sessions.

A step is work with its own outcome that its parent depends on: a phase (spec, design, build, ship), a planned sub-step, or a detour. Kinds: planned (part of the agreed plan), work (a detour to change something), research (a detour to research, analyze, or decide). A detour is any topic that opens while a goal is active, whoever opens it: work the current step turns out to need, a question you put to the person, one they ask, or new work they bring. It gets a step when it takes research (reading code, history, or docs), settles a decision a step depends on, or takes more than a single edit or command, even if it opens and closes in one reply. A one-line factual answer, a single edit, or a single command gets none. On each prompt from the person, and when a skill steers the conversation, check whether it opens or settles a detour. A detour goes under the current step. When it is not clear that it belongs there, ask the person with AskUserQuestion before you add it, with these options: the current step, by ID and title (recommended); another step that could fit, if there is one; a new top-level step of the active goal; and another step, whose ID the person types. During a non-interactive run, add it under the current step without asking. Add a detour with focus when it opens, and close it with done in the same reply that settles it; the tool moves focus back and says where. Drop a step that is no longer needed.

A step with 2 or more parts gets a child step for each part as soon as the parts are known, whoever names them. A step has 1 outcome: never list parts in its title. Before you report what is left of a step, add its parts as child steps.

When you start a background subagent for a step, begin the Agent call's description with the step's ID and a colon, such as "8.1: Merge the API fixes". The plan outline then shows that step as the subagent's while it works, and focus moving on doesn't park it. When the subagent finishes, the step shows ◐: read its report, then close the step, or focus it to take the work over.

The person steers by step ID in plain language. "drop 1.1": drop with cascade. "close out 1.1.1–1.1.3": done with the IDs listed out. "move on to 2" or "skip ahead to 2.1.3": focus. "that's a detour under 4": move. "backlog 3.4": the waffles:backlog skill writes the item, then defer with its file. Set cascade only when the person asks to close a step with its children.

The person sees each plan outline change in the transcript, so a reply needs to mention one only when it matters to what comes next. Keep it during a non-interactive run too, so the person can see where the run stands when they return. Subagents don't use the plan outline.`,
} as const

/**
 * The first message's plan outline block: the active goal's tree, or the open goals no other session holds.
 * Empty in a checkout with no `.tmp/plan/` folder, which it never creates, and when the plan outline can't
 * be read: why goes to the debug log.
 */
export async function planContext($: EngineInterface): Promise<string> {
  try {
    const { isGitDown, ...root } = await findPlanRoot($)
    // Git failed inside a repository: the working directory's .tmp/plan is not the checkout's.
    if (isGitDown) return ''
    // A `.tmp/plan` that is a file holds no goals.
    const isOutline = (await $.fs.exists(root.outline)) && (await $.fs.stat(root.outline)).kind === 'dir'
    if (!isOutline) return ''
    const files = await listGoals($, root.outline)
    const slug = await activeGoal($)
    if (slug !== null) {
      const mine = files.find(f => f.slug === slug)
      if (mine && 'goal' in mine) return [`plan outline: ${mine.goal.title} (${goalName(slug)})`, ...renderTree(mine.goal)].join('\n')
      return `plan outline: the active goal can't be read. ${mine ? mine.error : `No goal file ${goalName(slug)}`}`
    }
    const lines = await openGoalLines($, files, root, { isInUseShown: false })
    return lines.length ? ['plan outline: no active goal. Open goals:', ...lines].join('\n') : 'plan outline: no active goal and no open goals.'
  } catch (error) {
    logFailure($, 'the first message goes without its plan outline block', error)
    return ''
  }
}
