export type DevServerUrls = string[]

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh'

export type EffortMode = 'auto' | 'off'

export type InteractionMode = 'production' | 'rapid' | 'backlog'

/** The mode the model is told: the interaction mode, or a /waffles:non-interactive run over it. */
export type WafflesMode = InteractionMode | 'non-interactive'

/** One step of a plan outline goal, as core/plan-tree.ts reads it from `<git dir>/waffles/plan/<slug>.md` (its `Step`). */
export type PlanStep = {
  id: string
  title: string
  kind: 'planned' | 'work' | 'research'
  state: 'open' | 'parked' | 'review' | 'done' | 'dropped' | 'deferred'
  parkedAt?: string
  agent?: string
  backlog?: string
  aliases: string[]
  children: PlanStep[]
}

/** A plan outline goal, as core/plan-tree.ts reads it (its `Goal`). */
export type PlanGoal = {
  title: string
  status: 'open' | 'done'
  current: string | null
  created: string
  updated: string
  steps: PlanStep[]
}

/** A goal file other than the session's active goal, for drawing and for the context block. */
export type PlanOther = {
  slug: string
  title: string
  /** The goal's current step, `<id> <title>`; null when it has none. */
  current: string | null
  /** Another session that is still running has it active. */
  inUse: boolean
}

/** The drawn goal's collapsed steps (core/plan-collapse.ts's `Collapsed`). */
export type PlanCollapsed = {
  /** The slug of the goal they are steps of. */
  goal: string
  /** The IDs of its collapsed steps; a step not listed is expanded. */
  ids: string[]
}

/** The tree drawn at the last turn boundary, for the collapse rules at the next (core/plan-collapse.ts's `Turn`). */
export type PlanTurn = {
  /** The drawn goal's slug; null with none. */
  goal: string | null
  /** Its tree; null when it could not be read. */
  tree: PlanGoal | null
  /** From the prompt the person typed to begin a turn until that turn's end. */
  isOpen: boolean
}

/** Where rapid work started: HEAD then, and the paths already changed then, relative to the repository root. */
export type RapidBase = { head: string; dirty: string[] }

declare module 'claude-code' {
  interface PluginState {
    'waffles': {
      urls: DevServerUrls
      /** The level the running main-chat turn runs at, while auto effort is on. */
      effort: string | null
      /** The effort setting, as the last turn or /effort left it. */
      effortSetting: string | null
      /** /auto-effort's state, for the footer under the prompt. */
      effortMode: EffortMode
      /** Auto effort is asking the model for this turn's level. */
      effortPicking: boolean
      /** A /waffles:non-interactive run is active; it ends at a typed prompt, /backlog-entry, /prod, /rapid or /clear. */
      run: boolean
      /** Permission requests denied in a row during the run. */
      runDenials: number
      /** When the run's command was typed, in ms since the epoch; null with no run, and once its start question is asked. */
      runStartedAt: number | null
      /** The run's start question is on screen. */
      runAsking: boolean
      /** The first message named pending rapid work; the turn that reads it takes it over. */
      rapidStated: boolean
      /** /prod (the default), /rapid or /backlog-entry, until another of them or /clear. */
      mode: InteractionMode
      /** The base of rapid work not yet handed to the model in production mode; null when none is pending. */
      rapidBase: RapidBase | null
      /** The slug of the session's active goal; null when it has none. */
      planGoal: string | null
      /** The active goal as last read, for drawing; with none active, the kept goal's. */
      planTree: PlanGoal | null
      /** The slug of the goal the pane keeps drawn after it ended or stopped being active here; null while a goal is active or none was. */
      planKept: string | null
      /** Why the kept goal's file can't be drawn from: 'missing' (deleted) or 'unreadable' (read or parse failed); null when it reads, or no goal is kept. */
      planKeptIssue: 'missing' | 'unreadable' | null
      /** The active goal's parse error, for drawing. */
      planError: string | null
      /** The open goals other than the active one. */
      planOthers: PlanOther[]
      /** Step IDs changed since the person's last prompt. */
      planChanged: string[]
      /** The drawn goal's collapsed steps, for drawing: view state, in no goal file. Null when none is collapsed. */
      planCollapsed: PlanCollapsed | null
      /** The tree drawn at the last turn boundary, for the collapse rules at the next; null before the first. */
      planTurn: PlanTurn | null
      /** The session looked for the plan outline's copy on the remote, at its first poll or call in a repository. */
      planFetched: boolean
    }
  }
}
