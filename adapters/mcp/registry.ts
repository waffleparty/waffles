import type { Host, Names } from '../../core/host.ts'
import type { CoreTool, Json, ToolAnswer } from '../../core/tools.ts'

/**
 * What the MCP server offers, apart from how it speaks the protocol. Content comes in modules, one file
 * each beside this one: a module contributes tools, prompts, resources, a block of the instructions, and
 * handlers for a session's start, heartbeat, and end. The server (`server.ts`) reads only the registry
 * built here, so a new tool, prompt, or resource is a change to a module, never to the protocol code.
 */

export type { Json, ToolAnnotations, ToolAnswer } from '../../core/tools.ts'

/**
 * A tool as the server offers it: the core's tool (`core/tools.ts`), whose shape exists once, with a
 * handler that gets the request's session in place of the Host alone.
 */
export type Tool = Omit<CoreTool, 'call'> & {
  /** The name in `tools/list`: letters, digits, `_`, `-`, and `.`. */
  name: string
  /** An environment variable that names the tool as the model sees it, in place of the prefix and the name. */
  nameVariable?: string
  /** One call. A handler that throws gives the model a short error, never a protocol error. */
  call(session: Session, input: Json): Promise<ToolAnswer>
}

/** A core tool as the server offers it: its handler gets the session's Host. */
export const toolOf = (tool: CoreTool): Tool => ({ ...tool, call: (session, input) => tool.call(session.$, input) })

export type PromptArgument = { name: string; title?: string; description?: string; required?: boolean }
export type PromptMessage = { role: 'user' | 'assistant'; content: { type: 'text'; text: string } }

export type Prompt = {
  name: string
  title?: string
  /** What the prompt is for, as the person reads it in the client's command list. */
  description?: string
  arguments?: readonly PromptArgument[]
  /** The messages to add to the conversation. It may act first: a prompt can be a command. */
  get(session: Session, args: Record<string, string>): Promise<{ description?: string; messages: PromptMessage[] }>
}

export type Resource = {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  /** The module tells of each change with `session.changed`, so a client may subscribe to it. */
  isWatched?: boolean
  /** The resource's text now. */
  read(session: Session): Promise<string>
}

export type ListKind = 'tools' | 'prompts' | 'resources'

/** What a module's text is written with: the names of this process, which never change while it runs. */
export type TextContext = {
  names: Names
  /** A tool's name as the model sees it. */
  seenAs(tool: string): string
  /** The platform's hooks run beside the server and add their own context, such as the mode statement (`WAFFLES_HOOKS=1`). */
  hasHooks: boolean
}

/** A session as a module sees it. */
export type Session = {
  id: string
  $: Host
  /**
   * Runs `work` after the session's other noted work, and returns what the core added to the
   * conversation (`$.conversation.note`) while it ran. Outside such work the Host refuses a note, as a
   * platform with no conversation rows does.
   */
  noting<T>(work: () => Promise<T>): Promise<{ value: T; notes: string[] }>
  /** Tells the subscribers of a resource that it changed. */
  changed(uri: string): void
  /** Tells the listeners that a list changed; only for a kind the module names in `listChanges`. */
  listChanged(kind: ListKind): void
}

export type Module = {
  /** The name `WAFFLES_MCP_MODULES` selects it by. */
  name: string
  tools?: readonly Tool[]
  prompts?: readonly Prompt[]
  resources?: readonly Resource[]
  /** The lists this module changes while the process runs: their lists are not cached, and their changes are told. */
  listChanges?: readonly ListKind[]
  /** The module's block of the instructions: the same context must give the same bytes. */
  instructions?(text: TextContext): string
  /** The session's first request: once per session. A failure is logged and the session goes on. */
  start?(session: Session): Promise<void>
  /** The heartbeat, every few seconds while the session is live. */
  tick?(session: Session): Promise<void>
  /** The process ends. */
  end?(session: Session): Promise<void>
}

export type Registry = {
  modules: readonly Module[]
  names: Names
  seenAs(tool: string): string
  /** The modules' blocks in module order; empty when none has one. */
  instructions: string
  capabilities: Json
  tools(): Tool[]
  tool(name: string): Tool | undefined
  prompts(): Prompt[]
  prompt(name: string): Prompt | undefined
  resources(): Resource[]
  resource(uri: string): Resource | undefined
  /** Whether a module may change this kind of list while the process runs. */
  isListChanging(kind: ListKind): boolean
}

/** The server's name: the entry a client is told to add, and the default prefix of a tool's name. */
export const SERVER_NAME = 'waffles'

/**
 * A tool's name as the model sees it. A client shows an MCP tool under a name of its own, most often
 * `mcp__<server>__<tool>`; `WAFFLES_TOOL_PREFIX` replaces the prefix for every tool, and a tool's own
 * variable (`WAFFLES_PLAN_TOOL`) replaces its whole name. Text that names a tool goes through here, so
 * it stays right on every client.
 */
export function seenAsOf(env: NodeJS.ProcessEnv, tools: readonly Tool[]): (tool: string) => string {
  const prefix = env.WAFFLES_TOOL_PREFIX ?? `mcp__${SERVER_NAME}__`
  return tool => {
    const variable = tools.find(t => t.name === tool)?.nameVariable
    return (variable && env[variable]) || `${prefix}${tool}`
  }
}

/**
 * The names the core's text uses. Where the client has no tool to ask the person a question with, the
 * default ask reads as plain words and the model asks in the chat. A skill goes by its folder name
 * after `WAFFLES_SKILL_PREFIX`, and a run by `WAFFLES_RUN_COMMAND`, unset where the client's form is not
 * known. The mode commands are this server's prompts, which the instructions name as `/prod`.
 */
function namesOf(env: NodeJS.ProcessEnv, seenAs: (tool: string) => string): Names {
  const prefix = env.WAFFLES_SKILL_PREFIX ?? ''
  return {
    assistant: 'The agent',
    product: 'the MCP client',
    planTool: seenAs('plan'),
    ask: env.WAFFLES_ASK_TOOL || 'a multiple-choice question',
    planMode: null,
    skill: name => `${prefix}${name}`,
    ...(env.WAFFLES_RUN_COMMAND ? { runCommand: env.WAFFLES_RUN_COMMAND } : {}),
  }
}

// A name used twice would make one of the two unreachable: that is a mistake in the module list.
function unique<T>(items: readonly T[], key: (item: T) => string, what: string): T[] {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(key(item))) throw new Error(`Two MCP ${what} are named ${key(item)}.`)
    seen.add(key(item))
  }
  return [...items]
}

/** The registry of the modules given, in their order. */
export function registryOf(modules: readonly Module[], env: NodeJS.ProcessEnv = process.env): Registry {
  unique(modules, m => m.name, 'modules')
  // Read at each call, so a module that changes a list (and says so in `listChanges`) is served the new one.
  const tools = () => unique(modules.flatMap(m => m.tools ?? []), t => t.name, 'tools')
  const prompts = () => unique(modules.flatMap(m => m.prompts ?? []), p => p.name, 'prompts')
  const resources = () => unique(modules.flatMap(m => m.resources ?? []), r => r.uri, 'resources')
  // A name used twice fails here, at the start, not at a client's first list.
  prompts()
  const seenAs = seenAsOf(env, tools())
  const names = namesOf(env, seenAs)
  const hasHooks = env.WAFFLES_HOOKS === '1'
  const instructions = modules
    .map(m => m.instructions?.({ names, seenAs, hasHooks }) ?? '')
    .filter(Boolean)
    .join('\n\n')
  const isListChanging = (kind: ListKind) => modules.some(m => m.listChanges?.includes(kind))
  // A capability is announced only for what the modules provide, and a flag only where one of them uses it.
  const flags = (kind: ListKind, extra: Json = {}): Json => ({ ...(isListChanging(kind) ? { listChanged: true } : {}), ...extra })
  const hasAny = (kind: ListKind) => modules.some(m => (m[kind]?.length ?? 0) > 0 || m.listChanges?.includes(kind))
  const capabilities: Json = {
    ...(hasAny('tools') ? { tools: flags('tools') } : {}),
    ...(hasAny('prompts') ? { prompts: flags('prompts') } : {}),
    ...(hasAny('resources') ? { resources: flags('resources', resources().some(r => r.isWatched) ? { subscribe: true } : {}) } : {}),
  }
  return {
    modules,
    names,
    seenAs,
    instructions,
    capabilities,
    tools,
    tool: name => tools().find(t => t.name === name),
    prompts,
    prompt: name => prompts().find(p => p.name === name),
    resources,
    resource: uri => resources().find(r => r.uri === uri),
    isListChanging,
  }
}

/** One user message of text: what most prompts return. */
export const userText = (text: string): PromptMessage => ({ role: 'user', content: { type: 'text', text } })
