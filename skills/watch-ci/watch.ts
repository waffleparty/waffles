// Watch the CI/CD targets in a watch-ci map; exit when the caller must act.
//
// Usage: node watch.ts MAP.json --once
//        node watch.ts MAP.json --until-actionable [--budget SECONDS]
//
// The map is built up front by the agent (see SKILL.md); this script never decides
// what to watch, it only polls the targets the map names. State is kept in
// MAP.state.json, so a restarted watcher never repeats an event.
//
// --once polls every target a single time, prints each one's current state, and exits. It reads the state file and
// never writes it, so a watcher that runs at the same time still prints every event.
//
// --until-actionable polls until something changes that the caller must see, then
// exits. Its last line is one of:
//   RETURN              events above need action (FAIL, WAITING, MISSING, …)
//   ALL_DONE <result>   every target settled
//   CONTINUE <summary>  nothing needs action; a job finished or the budget
//                       (default 540 s) ran out. Run again. <summary> is the
//                       current progress in one line.
//
// A poll fails when gh or the command exits non-zero, runs past its timeout (90 s for gh, 120 s for a command), or
// prints what is not JSON, when a command prints no state, or when the target lacks a field its kind needs. 3 failed
// polls of a target in a row print ERROR with the last one's error, once in each run of the script while they go on
// failing. A map that is missing, has no targets, or has 2 targets with 1 id prints ERROR and exits 2. Wrong arguments
// print the usage and exit 2. Any other error ends the script with exit code 1. SIGTERM ends it at once.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const USAGE = 'usage: node watch.ts MAP.json --once\n       node watch.ts MAP.json --until-actionable [--budget SECONDS]'
const TERMINAL_EVENT = {
  success: 'DONE',
  failure: 'FAIL',
  cancelled: 'CANCELLED',
  skipped: 'SKIPPED',
  missing: 'MISSING',
  waiting: 'WAITING',
}
type Settled = keyof typeof TERMINAL_EVENT
// The settled states without waiting: a job or a target that waits for an approval is not done.
const FINISHED = new Set(['success', 'failure', 'cancelled', 'skipped', 'missing'])
const GH_FAIL = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])
const ERROR_STREAK = 3
// Events that need the main agent. DONE and SKIPPED don't: the final report covers them.
const ACTIONABLE = new Set(['FAIL', 'WAITING', 'MISSING', 'STALLED', 'CANCELLED', 'ERROR'])
const DEFAULT_BUDGET = 540 // stays under the 10-minute limit on a foreground Bash call

type Id = string | number
type Target = {
  id: Id
  label?: string
  kind?: string
  repo?: string
  run_id?: Id
  workflow?: string
  sha?: string
  event?: string
  name?: string
  context?: string
  command?: string | string[]
  after?: Id | Id[]
  needs_success?: unknown
  expected_jobs?: number
  appear_minutes?: number
}
type WatchMap = { context?: string; poll_seconds?: number; stall_minutes?: number; max_minutes?: number; appear_minutes?: number; targets: Target[] }
type Job = { name: string; state: string; steps_done?: number; steps_total?: number; current_step?: string | null; failed_step?: string | null; url?: string | null }
type Result = { state: string; url?: string | null; detail?: string | null; attempt?: number; jobs?: Job[] | null }
// What the state file keeps per target, between runs.
type TargetState = {
  errors?: number
  attempt?: number
  last_state?: string
  reported?: string
  queued_since?: number
  stalled?: boolean
  jobs_done?: number
  run_id?: Id
  deps_done_at?: number
  first_absent?: number
}
type State = { started: number; targets: { [id: string]: TargetState } }
type GhStep = { name: string; status?: string; conclusion?: string | null }
type GhJob = { name?: string; status?: string; conclusion?: string | null; url?: string; steps?: GhStep[] | null }
type GhRun = { status?: string; conclusion?: string | null; url?: string; attempt?: number; jobs?: GhJob[] | null }
type GhCheck = { status?: string; conclusion?: string | null; started_at?: string | null; html_url?: string | null; details_url?: string | null; output?: { title?: string | null } | null }
type GhStatus = { context?: string; state: string; target_url?: string | null; description?: string | null }
export type Argv = [string, ...string[]]
export type Ran = { status: number; stdout: string; stderr: string }

/**
 * The script's contact with the world. Tests replace these to stub gh, the shell, and the clock.
 * exec runs argv and resolves with its exit status and output; it rejects when the program cannot start, or when it
 * runs longer than timeout seconds.
 */
export const io = {
  exec: execute,
  sleep: (seconds: number) => delay(seconds * 1000),
  time: () => Date.now() / 1000,
  emit: (line: string) => {
    process.stdout.write(`${line}\n`)
  },
}

function isSettled(state: string | undefined): state is Settled {
  return state !== undefined && Object.hasOwn(TERMINAL_EVENT, state)
}

// A field the target's kind needs: without it, the poll fails.
function need(t: Target, key: keyof Target): string {
  const value = t[key]
  if (value === undefined) throw new Error(`the target has no ${key}`)
  return String(value)
}

function lastLine(text: string): string | undefined {
  return text.trim().split(/\r?\n/).at(-1) || undefined
}

// The parsed JSON that gh printed, or null when it printed nothing.
async function gh<T>(args: string[]): Promise<T> {
  const proc = await io.exec(['gh', ...args], 90)
  if (proc.status !== 0) throw new Error(lastLine(proc.stderr) ?? `gh exited ${proc.status}`)
  return (proc.stdout.trim() ? JSON.parse(proc.stdout) : null) as T
}

/** Map a GitHub run/job/check status + conclusion to a watch-ci state. */
function ghState(status: string | undefined, conclusion: string | null | undefined): string {
  if (status === 'waiting' || status === 'action_required') return 'waiting'
  if (status !== 'completed') return status === 'in_progress' ? 'running' : 'queued'
  if (conclusion === 'success' || conclusion === 'neutral') return 'success'
  if (conclusion === 'skipped') return 'skipped'
  if (conclusion === 'cancelled' || conclusion === 'stale') return 'cancelled'
  return 'failure'
}

function jobView(job: GhJob): Job {
  const steps = job.steps ?? []
  return {
    name: job.name ?? '?',
    state: ghState(job.status, job.conclusion),
    steps_done: steps.filter((s) => s.status === 'completed').length,
    steps_total: steps.length,
    current_step: steps.find((s) => s.status === 'in_progress')?.name ?? null,
    failed_step: steps.find((s) => GH_FAIL.has(s.conclusion ?? ''))?.name ?? null,
    url: job.url,
  }
}

async function pollGhRun(repo: string, runId: string): Promise<Result> {
  const run = await gh<GhRun>(['run', 'view', runId, '--repo', repo, '--json', 'status,conclusion,url,jobs,attempt'])
  return { state: ghState(run.status, run.conclusion), url: run.url, attempt: run.attempt ?? 1, jobs: (run.jobs ?? []).map(jobView) }
}

// The newest run of the target's workflow on its commit (and of its event, when the target names one), or null.
async function resolveGhWorkflow(t: Target): Promise<Id | null> {
  let runs = await gh<{ databaseId: Id; createdAt: string; event?: string }[]>(['run', 'list', '--repo', need(t, 'repo'), '--workflow', need(t, 'workflow'), '--commit', need(t, 'sha'), '-L', '20', '--json', 'databaseId,createdAt,event'])
  if (t.event) runs = runs.filter((r) => r.event === t.event)
  if (!runs?.length) return null
  return runs.reduce((newest, r) => (r.createdAt > newest.createdAt ? r : newest)).databaseId
}

async function pollGhCheck(t: Target): Promise<Result> {
  const data = await gh<{ check_runs?: GhCheck[] }>(['api', '-X', 'GET', `repos/${need(t, 'repo')}/commits/${need(t, 'sha')}/check-runs`, '-f', `check_name=${need(t, 'name')}`, '-f', 'per_page=100'])
  const checks = data.check_runs ?? []
  if (!checks.length) return { state: 'absent' }
  const c = checks.reduce((newest, check) => ((check.started_at || '') > (newest.started_at || '') ? check : newest))
  return { state: ghState(c.status, c.conclusion), url: c.html_url || c.details_url, detail: c.output?.title }
}

async function pollGhStatus(t: Target): Promise<Result> {
  const statuses = await gh<GhStatus[]>(['api', '-X', 'GET', `repos/${need(t, 'repo')}/commits/${need(t, 'sha')}/statuses`, '-f', 'per_page=100'])
  const context = need(t, 'context')
  const match = statuses.find((s) => s.context === context)
  if (!match) return { state: 'absent' }
  const state = match.state === 'pending' ? 'running' : match.state === 'success' ? 'success' : 'failure'
  return { state, url: match.target_url, detail: match.description }
}

async function pollCommand(t: Target): Promise<Result> {
  const command = t.command
  if (command === undefined) throw new Error('the target has no command')
  const words = typeof command === 'string' ? [command] : command.map(String)
  // On Windows the shell is cmd.exe, which takes the whole command line as it is.
  const windows = process.platform === 'win32'
  const argv: Argv = windows ? [process.env.ComSpec || join(process.env.SystemRoot ?? '', 'System32', 'cmd.exe'), '/c', `"${words.join(' ')}"`] : ['/bin/sh', '-c', ...words]
  const proc = await io.exec(argv, 120, windows)
  if (proc.status !== 0) throw new Error(lastLine(proc.stderr) ?? `command exited ${proc.status}`)
  const result = JSON.parse(proc.stdout)
  if (typeof result?.state !== 'string') throw new Error('the command printed no "state"')
  return result
}

async function poll(t: Target, st: TargetState): Promise<Result> {
  if (t.kind === 'gh-run') return pollGhRun(need(t, 'repo'), need(t, 'run_id'))
  if (t.kind === 'gh-workflow') {
    const runId = st.run_id || (await resolveGhWorkflow(t))
    if (runId === null) return { state: 'absent' }
    st.run_id = runId
    return pollGhRun(need(t, 'repo'), String(runId))
  }
  if (t.kind === 'gh-check') return pollGhCheck(t)
  if (t.kind === 'gh-status') return pollGhStatus(t)
  if (t.kind === 'command') return pollCommand(t)
  throw new Error(`unknown kind ${JSON.stringify(t.kind ?? null)}`)
}

/** Decide what a target that hasn't appeared yet means. */
function resolveAbsent(t: Target, st: TargetState, states: Map<Id, string>, now: number, m: WatchMap, labels: Map<Id, string>): Partial<Result> {
  // One id may stand alone, without a list around it.
  const deps: Id[] = Array.isArray(t.after) ? t.after : t.after === undefined ? [] : [t.after]
  const appear = 60 * (t.appear_minutes ?? m.appear_minutes ?? 10)
  const label = (d: Id) => labels.get(d) ?? d
  let since: number
  if (deps.length) {
    const needsSuccess = 'needs_success' in t ? t.needs_success : true
    if (needsSuccess) {
      const bad = deps.filter((d) => ['failure', 'cancelled', 'skipped', 'missing'].includes(states.get(d) ?? ''))
      if (bad.length) return { state: 'skipped', detail: `${bad.map(label).join(', ')} did not succeed` }
    }
    if (!deps.every((d) => FINISHED.has(states.get(d) ?? ''))) return { state: 'absent', detail: `starts after ${deps.map(label).join(', ')}` }
    since = st.deps_done_at ??= now
  } else {
    since = st.first_absent ??= now
  }
  if (now - since > appear) return { state: 'missing', detail: `no run appeared within ${Math.floor(appear / 60)} min` }
  return { state: 'absent', detail: 'not started yet' }
}

function jobsDone(jobs: Job[]): number {
  return jobs.filter((j) => FINISHED.has(j.state)).length
}

function describe(label: string, r: Result, expectedJobs: number | undefined): string {
  const jobs = r.jobs ?? []
  if (!jobs.length) {
    if (r.state === 'absent') return `${label}: ${r.detail || 'not started yet'}`
    return `${label}: ${r.state}${r.detail ? ` (${r.detail})` : ''}`
  }
  const total = Math.max(jobs.length, expectedJobs || 0)
  const parts: string[] = []
  for (const j of jobs) {
    if (j.state === 'running') {
      const step = j.current_step ? `, now "${j.current_step}"` : ''
      parts.push(`monitoring ${j.name} (${j.steps_done}/${j.steps_total} steps completed${step})`)
    } else if (j.state === 'waiting') {
      parts.push(`${j.name} waiting for approval`)
    }
  }
  return `${label}: ${parts.length ? parts.join('; ') : r.state} · ${jobsDone(jobs)}/${total} jobs done`
}

/** One compact progress fragment for the CONTINUE summary. */
function short(label: string, r: Result, expectedJobs: number | undefined): string {
  const jobs = r.jobs ?? []
  if (isSettled(r.state)) return `${label} ${TERMINAL_EVENT[r.state].toLowerCase()}`
  if (!jobs.length) return `${label} ${r.state === 'absent' ? 'not started' : r.state}`
  const total = Math.max(jobs.length, expectedJobs || 0)
  const running = jobs.find((j) => j.state === 'running')
  const now = running ? running.current_step || running.name : null
  return `${label} ${jobsDone(jobs)}/${total} jobs` + (now ? ` · now "${now}"` : '')
}

function terminalLine(label: string, r: Result, state: Settled): string {
  const event = TERMINAL_EVENT[state]
  const url = r.url ? ` ${r.url}` : ''
  const jobs = r.jobs ?? []
  if (state === 'failure') {
    const bad = jobs.filter((j) => j.state === 'failure')
    if (bad.length) {
      const where = bad.map((j) => `job ${j.name}` + (j.failed_step ? `, step "${j.failed_step}"` : '') + (j.url ? ` ${j.url}` : '')).join('; ')
      return `${event} ${label}: ${where}`
    }
  }
  if (state === 'waiting') {
    const who = jobs.filter((j) => j.state === 'waiting').map((j) => j.name)
    const what = who.length ? `job ${who.join(', ')} ` : ''
    return `${event} ${label}: ${what}waiting for approval${url}`
  }
  if (state === 'skipped' && r.detail) return `${event} ${label}: ${r.detail}`
  const detail = r.detail ? ` (${r.detail})` : ''
  const jobsNote = jobs.length && state === 'success' ? ` (${jobs.length} jobs)` : ''
  return `${event} ${label}: ${state}${jobsNote}${detail}${url}`
}

function overall(states: Map<Id, string>): string {
  const vals = new Set(states.values())
  if (vals.has('failure') || vals.has('missing')) return 'failure'
  if (vals.has('cancelled')) return 'cancelled'
  if (vals.has('waiting')) return 'waiting'
  return 'success'
}

// The parsed file, or undefined when it cannot be read or is not JSON.
function load(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

// A temporary file of its own, renamed over the state file: a reader sees the old state or the new one, never a part,
// and 2 writers never write into the same temporary file.
function save(path: string, data: State): void {
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { flag: 'wx' })
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

function isMap(m: unknown): m is WatchMap {
  return typeof m === 'object' && m !== null && Array.isArray((m as WatchMap).targets) && (m as WatchMap).targets.length > 0
}

export async function run(mapPath: string, once: boolean, budget: number): Promise<number> {
  const m = load(mapPath)
  if (!isMap(m)) {
    io.emit(`ERROR map ${mapPath} is missing or has no targets`)
    return 2
  }
  const statePath = `${mapPath}.state.json`
  const state = (load(statePath) ?? { started: io.time(), targets: {} }) as State
  const targets = m.targets
  const labels = new Map<Id, string>()
  // By the id as the state file keys it: 1 and "1" share a record there.
  const ids = new Set<string>()
  for (const t of targets) {
    if (t?.id === undefined) throw new Error(`a target in ${mapPath} has no id`)
    if (ids.has(String(t.id))) {
      io.emit(`ERROR map ${mapPath} has more than 1 target with the id ${JSON.stringify(String(t.id))}`)
      return 2
    }
    ids.add(String(t.id))
    labels.set(t.id, String(t.label ?? t.id))
  }
  const pollS = m.poll_seconds ?? 30
  const stallS = 60 * (m.stall_minutes ?? 30)
  const maxS = 60 * (m.max_minutes ?? 180)
  const began = io.time()
  // The targets whose streak of failed polls this run has printed ERROR for: the count lives on in the state file, so
  // a later run, perhaps after a fix, prints ERROR again at its first poll that still fails.
  const erred = new Set<string>()

  if (once) io.emit(`SNAPSHOT ${targets.length} targets for ${m.context ?? 'this change'}: ${[...labels.values()].join(', ')}`)

  for (;;) {
    const now = io.time()
    const states = new Map<Id, string>()
    const summary: string[] = []
    let actionable = false
    let jobsMoved = false
    // map order: upstream targets come before their dependents
    for (const t of targets) {
      const label = labels.get(t.id) ?? String(t.id)
      const st = (state.targets[String(t.id)] ??= {})
      let r: Result
      try {
        r = await poll(t, st)
        st.errors = 0
        erred.delete(String(t.id))
      } catch (error) {
        // one bad poll must not kill the watch
        st.errors = (st.errors ?? 0) + 1
        if (st.errors >= ERROR_STREAK && !erred.has(String(t.id))) {
          io.emit(`ERROR ${label}: ${error instanceof Error ? error.message : String(error)}`)
          erred.add(String(t.id))
          actionable = true
        }
        states.set(t.id, st.last_state ?? 'queued')
        summary.push(`${label} poll failing`)
        continue
      }
      if (r.state === 'absent') r = { ...r, ...resolveAbsent(t, st, states, now, m, labels) }
      const s = r.state
      states.set(t.id, s)
      const attempt = r.attempt ?? 1
      if (st.attempt !== attempt) {
        st.attempt = attempt
        delete st.reported
        delete st.queued_since
        delete st.stalled
        delete st.jobs_done
      }
      st.last_state = s
      summary.push(short(label, r, t.expected_jobs))

      if (isSettled(s)) {
        if (once || st.reported !== s) {
          io.emit(terminalLine(label, r, s))
          st.reported = s
          actionable ||= ACTIONABLE.has(TERMINAL_EVENT[s])
          jobsMoved = true
        }
        continue
      }
      delete st.reported

      if (s === 'queued') {
        const since = (st.queued_since ??= now)
        if (now - since > stallS && !st.stalled) {
          io.emit(`STALLED ${label}: queued for ${Math.floor((now - since) / 60)} min${r.url ? ` ${r.url}` : ''}`)
          st.stalled = true
          actionable = true
        }
      } else {
        delete st.queued_since
      }

      const done = jobsDone(r.jobs ?? [])
      if (done !== (st.jobs_done ?? 0)) {
        st.jobs_done = done
        jobsMoved = true
      }
      if (once) io.emit(`PROGRESS ${describe(label, r, t.expected_jobs)}`)
    }

    // A snapshot leaves the state to the watcher: what it marks as reported, a watcher would never print.
    if (!once) save(statePath, state)
    const settled = [...states.values()].filter(isSettled).length
    const total = targets.length
    if (settled === total) {
      io.emit(`ALL_DONE ${overall(states)}`)
      return 0
    }
    if (once) {
      io.emit(`PENDING ${settled}/${total} targets settled`)
      return 0
    }
    if (now - state.started > maxS) {
      io.emit(`TIMEOUT after ${Math.floor(maxS / 60)} min; ${settled}/${total} targets settled`)
      io.emit('ALL_DONE incomplete')
      return 0
    }
    if (actionable) {
      io.emit('RETURN')
      return 0
    }
    if (jobsMoved || io.time() - began + pollS > budget) {
      io.emit(`CONTINUE ${summary.join(' · ')}`)
      return 0
    }
    await io.sleep(pollS)
  }
}

export async function main(argv: string[]): Promise<number> {
  let args
  try {
    args = parseArgs({ args: argv, allowPositionals: true, options: { once: { type: 'boolean' }, 'until-actionable': { type: 'boolean' }, budget: { type: 'string' } } })
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}\n`)
    return 2
  }
  const { once = false, 'until-actionable': until = false, budget = String(DEFAULT_BUDGET) } = args.values
  const [map, ...extra] = args.positionals
  if (map === undefined || extra.length || once === until || !/^[+-]?\d+$/.test(budget.trim())) {
    process.stderr.write(`${USAGE}\n`)
    return 2
  }
  return run(resolve(map), once, Number(budget))
}

/**
 * Run argv and resolve with its exit status (128 + the signal's number when a signal ended it) and its output. stdin
 * stays the caller's. A timeout kills the process and rejects once it has exited, without waiting for its output,
 * which a process it started may still hold open. verbatim passes a Windows command line as it is.
 */
export function execute(argv: Argv, timeout: number, verbatim = false): Promise<Ran> {
  return new Promise((done, failed) => {
    const [file, ...args] = argv
    const child = spawn(file, args, { stdio: ['inherit', 'pipe', 'pipe'], windowsVerbatimArguments: verbatim })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    let over = false
    const finish = (then: () => void) => {
      if (over) return
      over = true
      clearTimeout(timer)
      then()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      const expire = () =>
        finish(() => {
          child.stdout.destroy()
          child.stderr.destroy()
          failed(new Error(`${argv.join(' ')} timed out after ${timeout} s`))
        })
      if (child.exitCode !== null || child.signalCode !== null) expire()
      else child.once('exit', expire)
    }, timeout * 1000)
    child.once('error', (error) => finish(() => failed(error)))
    child.once('close', (code, signal) =>
      finish(() => {
        const status = code ?? 128 + (signal ? constants.signals[signal] : 0)
        done({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
      }),
    )
  })
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
