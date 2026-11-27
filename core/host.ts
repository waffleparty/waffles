import type { Collapsed } from './plan-collapse.ts'
import type { Goal } from './plan-tree.ts'

/**
 * What the core needs from the platform it runs on. The core imports nothing else from outside
 * `core/`: no platform API, no Node.js module. Each adapter hands it a Host: Claude Code's wraps its
 * `$`, the others wrap Node.js. A core function takes the Host as its first parameter, named `$`.
 */
export type Host = {
  fs: {
    read(path: string): Promise<string>
    /** Makes the folders above the file. */
    write(path: string, text: string): Promise<void>
    /**
     * Writes the file only when nothing is at the path, making the folders above it: true when it wrote the file,
     * false when something was there. The check and the create are one step, so of 2 callers at once 1 gets true.
     */
    create(path: string, text: string): Promise<boolean>
    exists(path: string): Promise<boolean>
    list(path: string): Promise<FileEntry[]>
    stat(path: string): Promise<FileStat>
    /** Removes a file, or with `recursive` a folder and all it holds; one that isn't there is nothing to remove. */
    remove(path: string, options?: { recursive?: boolean }): Promise<void>
    /**
     * Moves a file to another path in the same folder, in place of what is there. It is one step: a reader sees the
     * old file or the new one, never a part of either.
     */
    rename(from: string, to: string): Promise<void>
    /** The path with every link in it followed. */
    realPath(path: string): Promise<string>
  }
  process: {
    /** Runs a command to its end. Rejects when it can't start. */
    run(argv: readonly string[], init?: { cwd?: string; stdin?: string; timeoutMs?: number }): Promise<RunResult>
  }
  session: {
    id(): Promise<string>
    /** The shell's working directory. */
    cwd(): Promise<string>
  }
  clock: {
    /** Milliseconds since the epoch. */
    now(): Promise<number>
    /** Resolves after `ms` milliseconds: the core has no timers of its own. */
    sleep(ms: number): Promise<void>
  }
  /** The person's home folder, where the platform knows it. */
  home(): Promise<string | undefined>
  /** A variable of the environment the platform runs in; undefined when it is not set. */
  env(name: EnvName): Promise<string | undefined>
  /**
   * The session's values: they last as long as the session, come back when it is resumed, and never
   * reach another session. A key never set reads as `INITIAL` has it.
   */
  state: {
    get<K extends keyof SessionState>(key: K): Promise<SessionState[K]>
    set<K extends keyof SessionState>(key: K, value: SessionState[K]): Promise<void>
  }
  /** The person's values: they hold for every session on the machine until changed. A key never set reads as undefined. */
  store: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }
  /**
   * What lives only in this process, one object per session: timers' bookkeeping and caches. An adapter
   * whose process serves one event starts each event with an empty one, which every module allows for.
   */
  memory: Memory
  /** The subagents the session knows; a platform that lists none answers with none. */
  agents: {
    list(): Promise<readonly AgentInfo[]>
  }
  /** What the plan outline asks of a platform that draws it; a platform with no view does nothing. */
  view: {
    /** A goal became active: at the session's start, or by a call. */
    planActive(when: 'start' | 'call'): Promise<void>
  }
  model: {
    /** One question to a fast, cheap model: its answer's text, or null when it gave none in time. */
    ask(prompt: string, init: { maxTokens: number; timeoutMs: number }): Promise<string | null>
  }
  conversation: {
    /** The assistant's last reply that holds text; empty when there is none. */
    lastReply(): Promise<string>
    /** Adds a row the model reads at the end of the conversation. False where the platform refuses it. */
    note(text: string): Promise<boolean>
  }
  /** What the platform calls its own things, in text the model reads. */
  names: Names
  /** A line for the platform's debug log. */
  log(message: string): void
}

export type Names = {
  /** What the person calls the assistant. */
  assistant: string
  /** The product the assistant runs in. */
  product: string
  /** The plan outline tool's name, as the model calls it. */
  planTool: string
  /** The tool the model asks the person a multiple-choice question with. */
  ask: string
  /** The platform's own feature named "plan mode", which the plan outline is not; null where it has none. */
  planMode: string | null
  /**
   * A skill of the plugin as the platform names it, from the skill's folder name: `waffles:backlog` on
   * Claude Code. Unset, the text names it by its folder name alone, which is true anywhere.
   */
  skill?: (name: string) => string
  /**
   * What the person types to start an unattended run: `/waffles:non-interactive` on Claude Code. Unset
   * where the platform's form is not known: the text then names the run by its skill.
   */
  runCommand?: string
  /** A mode command as the person types it, from its name: `/prod`. Unset, a slash and the name. */
  command?: (name: string) => string
}

/** A skill of the plugin by name, as the model reads it in "the … skill". */
export const skillName = (names: Names, skill: string) => names.skill?.(skill) ?? skill

/** A mode command as the person types it. */
export const commandName = (names: Pick<Names, 'command'>, command: string) => names.command?.(command) ?? `/${command}`

/** An unattended run, without its article: by the command that starts it where the platform's form is known, else by its skill. */
export const runName = (names: Names) =>
  names.runCommand === undefined ? `run of the ${skillName(names, 'non-interactive')} skill` : `${names.runCommand} run`

/** The variables the core reads. Claude Code lists the ones a module reads from its source, so each has its name here. */
export type EnvName = 'WAFFLES_BUILDERS_ROOT' | 'WAFFLES_REMOTE' | 'WAFFLES_REVIEW_CAP'

export type FileKind = 'file' | 'dir' | 'other'
export type FileEntry = { name: string; kind: FileKind; size: number; mtimeMs: number }
export type FileStat = { kind: FileKind; size: number; mtimeMs: number }
/**
 * A command's end. `isTruncated` is true where the platform kept only the start of what the command printed to
 * stdout (Claude Code passes on 4 MiB): an answer read from stdout is then read from a part of it.
 */
export type RunResult = { exitCode: number; stdout: string; stderr: string; isTruncated?: boolean }
export type AgentInfo = { id: string; status: string }

export type InteractionMode = 'production' | 'rapid' | 'backlog'
/** The mode the model is told: the interaction mode, or an unattended run over it. */
export type WafflesMode = InteractionMode | 'non-interactive'
/** A prompt as the core reads it. */
export type Prompt = {
  /** From the person: typed, including over a running turn, not a notification or a trigger. */
  isPerson: boolean
  /** Typed by the person and not delivered into a running turn. */
  isTyped: boolean
  /** The slash command it runs, by name; undefined for plain text. */
  command: string | undefined
  /** The platform made it, not the person. */
  isMeta: boolean
  text: string
}
/** Where rapid work started: HEAD then, and the paths already changed then, relative to the repository root. */
export type RapidBase = { head: string; dirty: string[] }
/** A goal file other than the session's active goal. */
export type OtherGoal = {
  slug: string
  title: string
  /** The goal's current step, `<id> <title>`; null when it has none. */
  current: string | null
  /** Another session that is still running has it active. */
  inUse: boolean
}

/** The session's values, by key. types/index.d.ts states the same contract for Claude Code's `$.state`. */
export type SessionState = {
  /** /prod (the default), /rapid or /backlog-entry, until another of them or /clear. */
  mode: InteractionMode
  /** The base of rapid work not yet handed to the model in production mode; null when none is pending. */
  rapidBase: RapidBase | null
  /** An unattended run is active. */
  run: boolean
  /** Permission requests denied in a row during the run. */
  runDenials: number
  /** When the run's command was typed, in ms since the epoch; null with no run, and once its start question is asked. */
  runStartedAt: number | null
  /** The run's start question is on screen. */
  runAsking: boolean
  /** The first message named pending rapid work; the turn that reads it takes it over. */
  rapidStated: boolean
  /** The slug of the session's active goal; null when it has none. */
  planGoal: string | null
  /** The active goal as last read, for drawing; with none active, the kept goal's. */
  planTree: Goal | null
  /** The slug of the goal a view keeps drawn after it ended or stopped being active here. */
  planKept: string | null
  /** Why the kept goal's file can't be drawn from; null when it reads, or no goal is kept. */
  planKeptIssue: 'missing' | 'unreadable' | null
  /** The active goal's parse error, for drawing. */
  planError: string | null
  /** The open goals other than the active one. */
  planOthers: OtherGoal[]
  /** Step IDs changed since the person's last prompt. */
  planChanged: string[]
  /** The drawn goal's collapsed steps, for drawing: view state, in no goal file. Null when none is collapsed. */
  planCollapsed: Collapsed | null
  /** The session looked for the plan outline's copy on the remote, at its first poll or call in a repository. */
  planFetched: boolean
}

/** What each key reads as before it is set. */
export const INITIAL: SessionState = {
  mode: 'production',
  rapidBase: null,
  run: false,
  runDenials: 0,
  runStartedAt: null,
  runAsking: false,
  rapidStated: false,
  planGoal: null,
  planTree: null,
  planKept: null,
  planKeptIssue: null,
  planError: null,
  planOthers: [],
  planChanged: [],
  planCollapsed: null,
  planFetched: false,
}

/** Each module's in-process values, under its own key; a module makes its entry at first use. */
export type Memory = Record<string, unknown>

/** The module's entry in the host's memory, made by `make` at first use. */
export function memoryOf<T>($: Pick<Host, 'memory'>, key: string, make: () => T): T {
  if (!(key in $.memory)) $.memory[key] = make()
  return $.memory[key] as T
}
