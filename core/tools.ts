import type { Host } from './host.ts'
import { MERGE_QUEUE_TOOL } from './merge-queue.ts'

/*
 * How to add a tool:
 * 1. Write its logic in a core file that reaches files and processes only through the Host (`$`).
 * 2. Export a `CoreTool` from that file: name, description, input schema, and a `call` that returns an answer.
 * 3. Add it to `TOOLS` below. The MCP server and OpenCode then offer it with no other change.
 * 4. On Claude Code, add its name to `NAMES` in hooks/tools.ts: the engine reads a tool's name from the
 *    hooks module's source. hooks/tools.test.ts fails until `NAMES` and `TOOLS` agree.
 * 5. Test the logic in a `core/*.spec.ts` with the fake Host of core/testing.ts.
 */

export type Json = Record<string, unknown>

/** The spec's hints on a tool's behavior. A client may show them and must not trust them. */
export type ToolAnnotations = {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/**
 * A tool's answer: text the model reads; a structured value, which the model reads as its JSON; or a
 * refusal, which the model reads as the call's error and can correct.
 */
export type ToolAnswer = { text: string } | { value: unknown } | { refusal: string }

/**
 * A tool as the core defines it, once for every platform. Each adapter registers it in its own way:
 * Claude Code and OpenCode call `call` in their own process, and the MCP server offers it to the rest.
 * A subagent may call it: the adapters refuse a subagent only the plan outline tool.
 */
export type CoreTool = {
  /** Letters, digits, and `_`: the name every platform takes, before the prefix it adds. */
  name: string
  title?: string
  /** What the tool does, as the model reads it. */
  description: string
  /** A JSON Schema with `type: 'object'` at the root. */
  inputSchema: Json
  /** A JSON Schema the structured value of every answer conforms to. */
  outputSchema?: Json
  annotations?: ToolAnnotations
  /** One call. It refuses an input it can't use; a handler that throws is a failure of the tool. */
  call($: Host, input: Json): Promise<ToolAnswer>
}

/** The core's tools: each adapter offers every one. */
export const TOOLS: readonly CoreTool[] = [MERGE_QUEUE_TOOL]

/** An answer as text, for a platform whose tools return text alone: a structured value as its JSON. */
export const textOf = (answer: ToolAnswer): { text: string } | { refusal: string } =>
  'value' in answer ? { text: JSON.stringify(answer.value) ?? 'null' } : answer
