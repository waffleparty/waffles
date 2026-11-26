import type { EngineInterface, On, ToolCallInput, ToolCallResult } from 'claude-code'

import { textOf, TOOLS } from '../core/tools.ts'
import { hostOf } from './host'

/**
 * The core's tools (core/tools.ts) on Claude Code: each registered at the session's start, and answered
 * in this process by a `tool.call` hook. A subagent may call them: only the plan outline tool refuses one.
 *
 * The engine reads a hooked tool's name from this source, and a name built in a loop reads as unknown,
 * so each tool's hook is written out below. tools.test.ts fails for a core tool that has none.
 */

// The keys the engine puts beside a tool's arguments, which the tool itself never takes.
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'requestMeta'])

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// One call of the core tool by that name: its text as the result, or its refusal as a deny. A tool that
// fails is a deny with a short reason, as on the MCP server, and the stack goes to the debug log.
async function answer($: EngineInterface, name: string, e: ToolCallInput): Promise<ToolCallResult> {
  const tool = TOOLS.find(t => t.name === name)
  if (tool === undefined) return { deny: `waffles has no ${name} tool.` }
  const input = Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED.has(key)))
  const host = hostOf($)
  const said = await tool.call(host, input).then(textOf, (error: unknown) => {
    host.log(`the ${name} tool failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    return { refusal: `The ${name} tool failed: ${messageOf(error).split('\n')[0]}` }
  })
  return 'refusal' in said ? { deny: said.refusal } : { result: said.text }
}

export function registerTools(on: On) {
  on('tool.call', { tool: 'mcp__waffles__merge_queue' }, ($, e) => answer($, 'merge_queue', e))
}

// The module's one session.start hook calls this. The engine reads no name here, so every tool registers from the list.
export async function startTools($: EngineInterface) {
  for (const tool of TOOLS) await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
}
