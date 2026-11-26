import type { Host, InteractionMode } from '../../core/host.ts'
import {
  ASSESS_PROMPT,
  BACKLOG_COMMAND,
  COMMANDS,
  modeContext,
  MODES_TEXT,
  PROD_COMMAND,
  RAPID_COMMAND,
  runBacklog,
  runProd,
  runRapid,
  startMode,
} from '../../core/modes.ts'
import { userText, type Module, type Session, type Tool } from './registry.ts'

/**
 * The modes: /prod, /rapid, and /backlog-entry as prompts, which most clients show as slash commands; a
 * `mode` tool for a client that shows no prompts; and the modes' definitions as the instructions.
 *
 * The current mode is not in the instructions. A 2025-11-25 client reads them once, at `initialize`, and a
 * 2026-07-28 client caches them with the rest of `server/discover`, so a statement there would be stale
 * after the first change, and a fresh one each time would change the client's system prompt and spoil
 * its cache. The prompts and the tool return the statement instead.
 */

const MODES: readonly InteractionMode[] = ['production', 'rapid', 'backlog']

// What each change does: the text the person reads, and whether pending rapid work was handed over.
const RUN: Record<InteractionMode, ($: Host) => Promise<{ text: string; isHandover?: boolean }>> = {
  production: runProd,
  rapid: async $ => ({ text: await runRapid($) }),
  backlog: async $ => ({ text: await runBacklog($) }),
}

const MODE_OF: Record<string, InteractionMode> = {
  [PROD_COMMAND]: 'production',
  [RAPID_COMMAND]: 'rapid',
  [BACKLOG_COMMAND]: 'backlog',
}

/**
 * Changes the mode. `person` is what Claude Code shows the person for the command; `model` is what the
 * model must read: the notes the core added to the conversation (the statement of the change), or the
 * current statement where nothing changed, and on a handover of rapid work the prompt that starts its
 * assessment.
 */
async function change(session: Session, mode: InteractionMode): Promise<{ person: string; model: string }> {
  const { value, notes } = await session.noting(async () => {
    const done = await RUN[mode](session.$)
    return { ...done, current: await modeContext(session.$) }
  })
  const said = notes.length ? notes : [value.current]
  return { person: value.text, model: [...said, ...(value.isHandover ? [ASSESS_PROMPT] : [])].join('\n\n') }
}

const MODE_TOOL: Tool = {
  name: 'mode',
  description: `Reads or sets the waffles mode of this session. With no input, it returns the current mode statement. With set, it changes the mode as the /${PROD_COMMAND}, /${RAPID_COMMAND} and /${BACKLOG_COMMAND} commands do, and returns the statement of the change. Set it only when the person asks for that mode.`,
  inputSchema: {
    type: 'object',
    properties: {
      set: { type: 'string', enum: MODES, description: 'The mode to change to. Leave it out to read the current mode.' },
    },
    additionalProperties: false,
  },
  // Not read-only: a call with set changes the mode. Repeating a call changes nothing more.
  annotations: { idempotentHint: true, openWorldHint: false },
  call: async (session, input) => {
    const { set } = input
    if (set === undefined) return { text: (await session.noting(() => modeContext(session.$))).value }
    if (typeof set !== 'string' || !(MODES as readonly string[]).includes(set)) {
      return { refusal: `set must be one of ${MODES.join(', ')}, or left out to read the mode.` }
    }
    return { text: (await change(session, set as InteractionMode)).model }
  },
}

export const modesModule: Module = {
  name: 'modes',
  tools: [MODE_TOOL],
  prompts: COMMANDS.map(({ name, description }) => ({
    name,
    description,
    get: async session => {
      const { person, model } = await change(session, MODE_OF[name]!)
      return { description: person, messages: [userText(model)] }
    },
  })),
  // Where the platform's hooks run, they send the mode statement with the first message, so the
  // instructions don't say that none comes.
  instructions: ({ seenAs, hasHooks }) =>
    `${MODES_TEXT}

On this client the /${PROD_COMMAND}, /${RAPID_COMMAND} and /${BACKLOG_COMMAND} commands are prompts of the waffles MCP server, ${
      hasHooks ? 'and the' : 'and no mode statement comes with the first message: the'
    } ${seenAs(MODE_TOOL.name)} tool returns the current ${hasHooks ? 'mode statement' : 'one'} when called with no input.`,
  // The mode comes back from the session's values.
  start: async ({ $ }) => {
    await startMode($)
  },
}
