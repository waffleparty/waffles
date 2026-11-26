// Watch the CI/CD targets in a watch-ci map; exit when the caller must act.
//
// Usage: node watch.ts MAP.json --once
//        node watch.ts MAP.json --until-actionable [--budget SECONDS]
//
// The map is built up front by the agent (see SKILL.md); this script never decides
// what to watch, it only polls the targets the map names. State is kept in
// MAP.state.json, so a restarted watcher never repeats an event.
//
// --once polls every target a single time, prints each one's current state, and exits.
//
// --until-actionable polls until something changes that the caller must see, then
// exits. Its last line is one of:
//   RETURN              events above need action (FAIL, WAITING, MISSING, …)
//   ALL_DONE <result>   every target settled
//   CONTINUE <summary>  nothing needs action; a job finished or the budget
//                       (default 540 s) ran out. Run again. <summary> is the
//                       current progress in one line.

// The comment above is also the usage text that wrong arguments print, as the Python printed its docstring.
//
// This is a port of watch.py, line for line where the output depends on it: the same polls, timeouts, state file,
// and output lines. The map and the CI systems' answers are JSON that the Python read into dicts, lists, ints, and
// floats, so this file reads JSON as Python does (a float stays a float, and a decode error reads the same), and it
// treats those values as Python does: the same truth test, the same text in an f-string, and the same KeyError or
// TypeError where the Python raised one. A poll that raises counts toward the 3 failed polls that print ERROR, with
// the error's text; an error outside a poll ends the script with exit code 1, as an uncaught Python exception did.

import { spawn } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const SETTLED = new Set(['success', 'failure', 'cancelled', 'skipped', 'missing', 'waiting'])
// SETTLED without waiting: a job or a target that waits for an approval is not done.
const FINISHED = new Set(['success', 'failure', 'cancelled', 'skipped', 'missing'])
const TERMINAL_EVENT: Record<string, string> = {
  success: 'DONE',
  failure: 'FAIL',
  cancelled: 'CANCELLED',
  skipped: 'SKIPPED',
  missing: 'MISSING',
  waiting: 'WAITING',
}
const GH_FAIL = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])
const ERROR_STREAK = 3
// Events that need the main agent. DONE and SKIPPED don't: the final report covers them.
const ACTIONABLE = new Set(['FAIL', 'WAITING', 'MISSING', 'STALLED', 'CANCELLED', 'ERROR'])
const DEFAULT_BUDGET = 540 // stays under the 10-minute limit on a foreground Bash call

type Dict = Record<string, unknown>
export type Ran = { status: number; stdout: string; stderr: string }

/**
 * The script's contact with the world. Tests replace these to stub gh, the shell, and the clock.
 * exec runs argv and resolves with its exit status and output; it rejects when the program cannot start, or when it
 * runs longer than timeout seconds (then `shown` is the command as the error names it).
 */
export const io = {
  exec: execute,
  sleep,
  time: () => Date.now() / 1000,
  emit: (line: string) => {
    process.stdout.write(`${line}\n`)
  },
}

async function gh(args: unknown[]): Promise<unknown> {
  const argv = strings(['gh', ...args])
  const proc = await io.exec(argv, 90, repr(argv))
  if (proc.status !== 0) {
    const err = splitlines(strip(proc.stderr))
    throw new PyError(err.length ? err[err.length - 1] : `gh exited ${proc.status}`)
  }
  return strip(proc.stdout) ? loads(proc.stdout) : null
}

/** Map a GitHub run/job/check status + conclusion to a watch-ci state. */
export function ghState(status: unknown, conclusion: unknown): string {
  if (eq(status, 'waiting') || eq(status, 'action_required')) return 'waiting'
  if (!eq(status, 'completed')) return eq(status, 'in_progress') ? 'running' : 'queued'
  if (eq(conclusion, 'success') || eq(conclusion, 'neutral')) return 'success'
  if (eq(conclusion, 'skipped')) return 'skipped'
  if (eq(conclusion, 'cancelled') || eq(conclusion, 'stale')) return 'cancelled'
  if (inSet(conclusion, GH_FAIL)) return 'failure'
  return 'failure'
}

function jobView(job: unknown): Dict {
  const steps = or(get(job, 'steps'), [])
  const list = iterate(steps)
  const done = list.filter((s) => eq(get(s, 'status'), 'completed')).length
  const current = list.find((s) => eq(get(s, 'status'), 'in_progress'))
  const currentName = current === undefined ? null : item(current, 'name')
  const failed = list.find((s) => inSet(get(s, 'conclusion'), GH_FAIL))
  const failedName = failed === undefined ? null : item(failed, 'name')
  return dict({
    name: get(job, 'name', '?'),
    state: ghState(get(job, 'status'), get(job, 'conclusion')),
    steps_done: done,
    steps_total: len(steps),
    current_step: currentName,
    failed_step: failedName,
    url: get(job, 'url'),
  })
}

async function pollGhRun(repo: unknown, runId: unknown): Promise<Dict> {
  const run = await gh(['run', 'view', str(runId), '--repo', repo, '--json', 'status,conclusion,url,jobs,attempt'])
  return dict({
    state: ghState(get(run, 'status'), get(run, 'conclusion')),
    url: get(run, 'url'),
    attempt: get(run, 'attempt', 1),
    jobs: iterate(or(get(run, 'jobs'), [])).map(jobView),
  })
}

async function resolveGhWorkflow(t: unknown): Promise<unknown> {
  let runs = await gh(['run', 'list', '--repo', item(t, 'repo'), '--workflow', item(t, 'workflow'), '--commit', item(t, 'sha'), '-L', '20', '--json', 'databaseId,createdAt,event'])
  if (truthy(get(t, 'event'))) runs = iterate(runs).filter((r) => eq(get(r, 'event'), item(t, 'event')))
  if (!truthy(runs)) return null
  return item(maxBy(iterate(runs), (r) => item(r, 'createdAt')), 'databaseId')
}

async function pollGhCheck(t: unknown): Promise<Dict> {
  const data = await gh(['api', '-X', 'GET', `repos/${str(item(t, 'repo'))}/commits/${str(item(t, 'sha'))}/check-runs`, '-f', `check_name=${str(item(t, 'name'))}`, '-f', 'per_page=100'])
  const checks = or(get(data, 'check_runs'), [])
  if (!truthy(checks)) return dict({ state: 'absent' })
  const c = maxBy(iterate(checks), (check) => or(get(check, 'started_at'), ''))
  const title = get(or(get(c, 'output'), dict({})), 'title')
  return dict({
    state: ghState(get(c, 'status'), get(c, 'conclusion')),
    url: or(get(c, 'html_url'), get(c, 'details_url')),
    detail: title,
  })
}

async function pollGhStatus(t: unknown): Promise<Dict> {
  const statuses = await gh(['api', '-X', 'GET', `repos/${str(item(t, 'repo'))}/commits/${str(item(t, 'sha'))}/statuses`, '-f', 'per_page=100'])
  const match = iterate(statuses).find((s) => eq(get(s, 'context'), item(t, 'context')))
  if (match === undefined) return dict({ state: 'absent' })
  const raw = item(match, 'state')
  hashKey(raw)
  const state = raw === 'pending' ? 'running' : raw === 'success' ? 'success' : 'failure'
  return dict({ state, url: get(match, 'target_url'), detail: get(match, 'description') })
}

async function pollCommand(t: unknown): Promise<unknown> {
  const command = item(t, 'command')
  const [argv, verbatim] = shell(command)
  const proc = await io.exec(argv, 120, str(command), verbatim)
  if (proc.status !== 0) {
    const err = splitlines(strip(proc.stderr))
    throw new PyError(err.length ? err[err.length - 1] : `command exited ${proc.status}`)
  }
  return loads(proc.stdout)
}

/**
 * The argv that Python's subprocess runs for shell=True, and whether to pass it verbatim. On POSIX that is
 * /bin/sh -c, with any further list items as the shell's $0, $1, …. On Windows it is `%ComSpec% /c "<command>"`,
 * passed to the process as one verbatim command line, as Python builds it.
 */
function shell(command: unknown): [string[], boolean] {
  const args = typeof command === 'string' ? [command] : iterate(command)
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || join(process.env.SystemRoot ?? '', 'System32', 'cmd.exe')
    return [[comspec, '/c', `"${strings(args).join(' ')}"`], true]
  }
  return [strings(['/bin/sh', '-c', ...args]), false]
}

async function poll(t: unknown, st: Dict): Promise<unknown> {
  const kind = item(t, 'kind')
  if (eq(kind, 'gh-run')) return pollGhRun(item(t, 'repo'), item(t, 'run_id'))
  if (eq(kind, 'gh-workflow')) {
    let runId = get(st, 'run_id')
    if (!truthy(runId)) runId = await resolveGhWorkflow(t)
    if (runId === null) return dict({ state: 'absent' })
    st.run_id = runId
    return pollGhRun(item(t, 'repo'), runId)
  }
  if (eq(kind, 'gh-check')) return pollGhCheck(t)
  if (eq(kind, 'gh-status')) return pollGhStatus(t)
  if (eq(kind, 'command')) return pollCommand(t)
  throw new PyError(`unknown kind ${repr(kind)}`)
}

/** Decide what a target that hasn't appeared yet means. */
function resolveAbsent(t: unknown, st: Dict, states: Map<unknown, unknown>, now: number, m: unknown, labels: Map<unknown, unknown>): Dict {
  const deps = or(get(t, 'after'), [])
  const appear = times60(get(t, 'appear_minutes', get(m, 'appear_minutes', 10)))
  const label = (d: unknown) => (labels.has(hashKey(d)) ? labels.get(hashKey(d)) : d)
  let since: unknown
  if (truthy(deps)) {
    const list = iterate(deps)
    const depStates = list.map((d) => states.get(hashKey(d)) ?? null)
    if (truthy(get(t, 'needs_success', true))) {
      const bad = list.filter((d) => ['failure', 'cancelled', 'skipped', 'missing'].some((s) => eq(states.get(hashKey(d)) ?? null, s)))
      if (bad.length) return dict({ state: 'skipped', detail: `${join_(', ', bad.map(label))} did not succeed` })
    }
    if (!depStates.every((s) => inSet(s, FINISHED))) return dict({ state: 'absent', detail: `starts after ${join_(', ', list.map(label))}` })
    if (!Object.hasOwn(st, 'deps_done_at')) st.deps_done_at = now
    since = st.deps_done_at
  } else {
    if (!Object.hasOwn(st, 'first_absent')) st.first_absent = now
    since = st.first_absent
  }
  if (greater(subtract(now, since), appear)) return dict({ state: 'missing', detail: `no run appeared within ${str(floor60(appear))} min` })
  return dict({ state: 'absent', detail: 'not started yet' })
}

export function describe(label: unknown, r: unknown, expectedJobs: unknown): string {
  const state = item(r, 'state')
  const jobs = get(r, 'jobs')
  if (!truthy(jobs)) {
    if (eq(state, 'absent')) return `${str(label)}: ${str(or(get(r, 'detail'), 'not started yet'))}`
    const extra = truthy(get(r, 'detail')) ? ` (${str(item(r, 'detail'))})` : ''
    return `${str(label)}: ${str(state)}${extra}`
  }
  const total = max(len(jobs), or(expectedJobs, 0))
  const list = iterate(jobs)
  const done = list.filter((j) => inSet(item(j, 'state'), FINISHED)).length
  const parts: string[] = []
  for (const j of list) {
    if (eq(item(j, 'state'), 'running')) {
      const step = truthy(get(j, 'current_step')) ? `, now "${str(item(j, 'current_step'))}"` : ''
      parts.push(`monitoring ${str(item(j, 'name'))} (${str(item(j, 'steps_done'))}/${str(item(j, 'steps_total'))} steps completed${step})`)
    } else if (eq(item(j, 'state'), 'waiting')) {
      parts.push(`${str(item(j, 'name'))} waiting for approval`)
    }
  }
  const body = parts.length ? parts.join('; ') : str(state)
  return `${str(label)}: ${body} · ${done}/${str(total)} jobs done`
}

/** One compact progress fragment for the CONTINUE summary. */
export function short(label: unknown, r: unknown, expectedJobs: unknown): string {
  const state = item(r, 'state')
  const jobs = or(get(r, 'jobs'), [])
  if (inSet(state, SETTLED)) return `${str(label)} ${TERMINAL_EVENT[state as string].toLowerCase()}`
  if (!truthy(jobs)) return `${str(label)} ${eq(state, 'absent') ? 'not started' : str(state)}`
  const total = max(len(jobs), or(expectedJobs, 0))
  const list = iterate(jobs)
  const done = list.filter((j) => inSet(item(j, 'state'), FINISHED)).length
  const running = list.find((j) => eq(item(j, 'state'), 'running'))
  const now = running === undefined ? null : or(get(running, 'current_step'), () => item(running, 'name'))
  return `${str(label)} ${done}/${str(total)} jobs` + (truthy(now) ? ` · now "${str(now)}"` : '')
}

export function terminalLine(label: unknown, r: unknown): string {
  const state = item(r, 'state') as string
  const event = TERMINAL_EVENT[state]
  const url = truthy(get(r, 'url')) ? ` ${str(item(r, 'url'))}` : ''
  const jobs = or(get(r, 'jobs'), [])
  if (state === 'failure') {
    const bad = iterate(jobs).filter((j) => eq(item(j, 'state'), 'failure'))
    if (bad.length) {
      const where = bad
        .map((j) => `job ${str(item(j, 'name'))}` + (truthy(get(j, 'failed_step')) ? `, step "${str(item(j, 'failed_step'))}"` : '') + (truthy(get(j, 'url')) ? ` ${str(item(j, 'url'))}` : ''))
        .join('; ')
      return `${event} ${str(label)}: ${where}`
    }
  }
  if (state === 'waiting') {
    const who = iterate(jobs).filter((j) => eq(item(j, 'state'), 'waiting')).map((j) => item(j, 'name'))
    const what = who.length ? `job ${join_(', ', who)} ` : ''
    return `${event} ${str(label)}: ${what}waiting for approval${url}`
  }
  if (state === 'skipped' && truthy(get(r, 'detail'))) return `${event} ${str(label)}: ${str(item(r, 'detail'))}`
  const detail = truthy(get(r, 'detail')) ? ` (${str(item(r, 'detail'))})` : ''
  const jobsNote = truthy(jobs) && state === 'success' ? ` (${len(jobs)} jobs)` : ''
  return `${event} ${str(label)}: ${state}${jobsNote}${detail}${url}`
}

export function overall(states: Map<unknown, unknown>): string {
  const vals = [...states.values()]
  const has = (s: string) => vals.some((v) => eq(v, s))
  if (has('failure') || has('missing')) return 'failure'
  if (has('cancelled')) return 'cancelled'
  if (has('waiting')) return 'waiting'
  return 'success'
}

function load(path: string, fallback: unknown): unknown {
  try {
    return loads(decode(readFileSync(path)))
  } catch (error) {
    // Python's load caught OSError and ValueError; ValueError takes in bad JSON and text that is not UTF-8.
    if (error instanceof PyError && error.type === 'RecursionError') throw error
    return fallback
  }
}

function save(path: string, data: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, dumps(data, 2))
  renameSync(tmp, path)
}

// The state file's per-target records: a dict keyed by target id, kept as a Map so that an id that is a number stays
// apart from the same digits as a string, as Python's dict keeps them.
function targetsOf(state: unknown): Map<unknown, Dict> {
  const targets = item(state, 'targets')
  if (targets instanceof Map) return targets
  if (!isDict(targets)) throw new PyError(`'${typeName(targets)}' object has no attribute 'setdefault'`, 'AttributeError')
  const map = new Map<unknown, Dict>(Object.entries(targets) as [string, Dict][])
  ;(state as Dict).targets = map
  return map
}

export async function run(mapPath: string, once: boolean, budget: number): Promise<number> {
  const m = load(mapPath, null)
  if (!truthy(m) || !truthy(get(m, 'targets'))) {
    io.emit(`ERROR map ${mapPath} is missing or has no targets`)
    return 2
  }
  const statePath = `${mapPath}.state.json`
  const state = load(statePath, dict({ started: io.time(), targets: dict({}) }))
  const targets = item(m, 'targets')
  const labels = new Map<unknown, unknown>()
  for (const t of iterate(targets)) labels.set(hashKey(item(t, 'id')), get(t, 'label', item(t, 'id')))
  const pollS = get(m, 'poll_seconds', 30)
  const stallS = times60(get(m, 'stall_minutes', 30))
  const maxS = times60(get(m, 'max_minutes', 180))
  const began = io.time()

  if (once) {
    io.emit(`SNAPSHOT ${len(targets)} targets for ${str(get(m, 'context', 'this change'))}: ` + join_(', ', [...labels.values()]))
  }

  for (;;) {
    const now = io.time()
    const states = new Map<unknown, unknown>()
    const summary: string[] = []
    let actionable = false
    let jobsMoved = false
    for (const t of iterate(targets)) {
      // map order: upstream targets come before their dependents
      const tid = hashKey(item(t, 'id'))
      const records = targetsOf(state)
      if (!records.has(tid)) records.set(tid, dict({}))
      const st = records.get(tid) as Dict
      const label = labels.get(tid)
      let r: unknown
      try {
        r = await poll(t, st)
        st.errors = 0
      } catch (error) {
        // one bad poll must not kill the watch
        st.errors = add1(get(st, 'errors', 0))
        if (eq(st.errors, ERROR_STREAK)) {
          io.emit(`ERROR ${str(label)}: ${errorText(error)}`)
          actionable = true
        }
        states.set(tid, get(st, 'last_state', 'queued'))
        summary.push(`${str(label)} poll failing`)
        continue
      }
      if (eq(item(r, 'state'), 'absent')) r = dict({ ...(r as Dict), ...resolveAbsent(t, st, states, now, m, labels) })
      const s = item(r, 'state')
      states.set(tid, s)
      const attempt = get(r, 'attempt', 1)
      if (!eq(get(st, 'attempt'), attempt)) {
        st.attempt = attempt
        for (const k of ['reported', 'queued_since', 'stalled', 'jobs_done']) delete st[k]
      }
      st.last_state = s
      summary.push(short(label, r, get(t, 'expected_jobs')))

      if (inSet(s, SETTLED)) {
        if (once || !eq(get(st, 'reported'), s)) {
          const line = terminalLine(label, r)
          io.emit(line)
          st.reported = s
          actionable ||= ACTIONABLE.has(line.split(' ')[0])
          jobsMoved = true
        }
        continue
      }
      delete st.reported

      if (eq(s, 'queued')) {
        if (!Object.hasOwn(st, 'queued_since')) st.queued_since = now
        if (greater(subtract(now, st.queued_since), stallS) && !truthy(get(st, 'stalled'))) {
          const minutes = Math.floor(subtract(now, st.queued_since) / 60)
          io.emit(rstrip(`STALLED ${str(label)}: queued for ${minutes} min ${str(get(r, 'url', ''))}`))
          st.stalled = true
          actionable = true
        }
      } else {
        delete st.queued_since
      }

      const done = iterate(or(get(r, 'jobs'), [])).filter((j) => inSet(item(j, 'state'), FINISHED)).length
      if (!eq(done, get(st, 'jobs_done', 0))) {
        st.jobs_done = done
        jobsMoved = true
      }
      if (once) io.emit('PROGRESS ' + describe(label, r, get(t, 'expected_jobs')))
    }

    save(statePath, state)
    const settled = [...states.values()].filter((s) => inSet(s, SETTLED)).length
    const total = len(targets)
    if (settled === total) {
      io.emit(`ALL_DONE ${overall(states)}`)
      return 0
    }
    if (once) {
      io.emit(`PENDING ${settled}/${total} targets settled`)
      return 0
    }
    if (greater(subtract(now, item(state, 'started')), maxS)) {
      io.emit(`TIMEOUT after ${str(floor60(maxS))} min; ${settled}/${total} targets settled`)
      io.emit('ALL_DONE incomplete')
      return 0
    }
    if (actionable) {
      io.emit('RETURN')
      return 0
    }
    if (jobsMoved || io.time() - began + number(pollS) > budget) {
      io.emit('CONTINUE ' + summary.join(' · '))
      return 0
    }
    await io.sleep(number(pollS))
  }
}

export async function main(argv: string[]): Promise<number> {
  argv = [...argv]
  let budget = DEFAULT_BUDGET
  const i = argv.indexOf('--budget')
  if (i >= 0) {
    if (i + 1 >= argv.length) throw new PyError('list index out of range', 'IndexError')
    const value = pyInt(argv[i + 1])
    if (value === null) throw new PyError(`invalid literal for int() with base 10: ${repr(argv[i + 1])}`, 'ValueError')
    budget = value
    argv.splice(i, 2)
  }
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const args = argv.filter((a) => !a.startsWith('--'))
  if (args.length !== 1 || Number(flags.has('--once')) + Number(flags.has('--until-actionable')) !== 1) {
    process.stderr.write(`${usage()}\n`)
    return 2
  }
  return run(resolve(args[0]), flags.has('--once'), budget)
}

function usage(): string {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
  const header = lines.slice(0, lines.findIndex((line) => !line.startsWith('//')))
  return strip(header.map((line) => line.replace(/^\/\/ ?/, '')).join('\n'))
}

// Running commands

/**
 * Python's subprocess.run(argv, capture_output=True, text=True, timeout=timeout): stdin stays the caller's, output is
 * UTF-8 with \r\n and \r read as \n, and a timeout kills the process and raises at once. Like Python on POSIX, it then
 * waits for the process but not for its output, which a process it started may still hold open.
 */
export function execute(argv: string[], timeout: number, shown: string, verbatim = false): Promise<Ran> {
  return new Promise((done, failed) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['inherit', 'pipe', 'pipe'], windowsVerbatimArguments: verbatim })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk))
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
          child.stdout?.destroy()
          child.stderr?.destroy()
          failed(new PyError(`Command '${shown}' timed out after ${timeout} seconds`, 'TimeoutExpired'))
        })
      if (child.exitCode !== null || child.signalCode !== null) expire()
      else child.once('exit', expire)
    }, timeout * 1000)
    child.once('error', (error: NodeJS.ErrnoException) => finish(() => failed(osError(error, argv[0]))))
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) =>
      finish(() => {
        try {
          const status = code ?? -((signal && constants.signals[signal]) || 0)
          done({ status, stdout: decode(Buffer.concat(out)), stderr: decode(Buffer.concat(err)) })
        } catch (error) {
          failed(error)
        }
      }),
    )
  })
}

const STRERROR: Record<string, string> = {
  ENOENT: 'No such file or directory',
  EACCES: 'Permission denied',
  ENOEXEC: 'Exec format error',
  ENOTDIR: 'Not a directory',
}

function osError(error: NodeJS.ErrnoException, file: string): PyError {
  const code = error.code ?? ''
  const errno = (constants.errno as Record<string, number>)[code]
  if (errno === undefined) return new PyError(error.message, 'OSError')
  return new PyError(`[Errno ${errno}] ${STRERROR[code] ?? code}: ${repr(file)}`, 'OSError')
}

// Python reads text as strict UTF-8 and keeps a byte order mark; bytes that are not UTF-8 raise UnicodeDecodeError.
function decode(bytes: Uint8Array): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new PyError(utf8Error(bytes), 'UnicodeDecodeError')
  }
  return text.replace(/\r\n?/g, '\n')
}

function utf8Error(b: Uint8Array): string {
  const message = (start: number, end: number, reason: string) =>
    start === end
      ? `'utf-8' codec can't decode byte 0x${b[start].toString(16).padStart(2, '0')} in position ${start}: ${reason}`
      : `'utf-8' codec can't decode bytes in position ${start}-${end}: ${reason}`
  for (let i = 0; i < b.length; ) {
    const c = b[i]
    if (c < 0x80) {
      i++
      continue
    }
    let need: number
    let low = 0x80
    let high = 0xbf
    if (c >= 0xc2 && c <= 0xdf) need = 1
    else if (c >= 0xe0 && c <= 0xef) {
      need = 2
      if (c === 0xe0) low = 0xa0
      if (c === 0xed) high = 0x9f
    } else if (c >= 0xf0 && c <= 0xf4) {
      need = 3
      if (c === 0xf0) low = 0x90
      if (c === 0xf4) high = 0x8f
    } else return message(i, i, 'invalid start byte')
    for (let k = 1; k <= need; k++) {
      if (i + k >= b.length) return message(i, b.length - 1, 'unexpected end of data')
      const d = b[i + k]
      if (d < (k === 1 ? low : 0x80) || d > (k === 1 ? high : 0xbf)) return message(i, i + k - 1, 'invalid continuation byte')
    }
    i += need + 1
  }
  return "'utf-8' codec can't decode the output"
}

async function sleep(seconds: number): Promise<void> {
  if (seconds < 0) throw new PyError('sleep length must be non-negative', 'ValueError')
  // A timer holds at most 2^31 - 1 ms (about 24 days); a longer sleep takes several.
  for (let left = seconds * 1000; left > 0; left -= 2 ** 31 - 1) await delay(Math.min(left, 2 ** 31 - 1))
}

// Python values
//
// JSON reads into null, booleans, numbers (Python's ints), Float (Python's floats), strings, arrays, and dicts:
// objects without a prototype, so that any key, __proto__ too, is a plain key.

export class Float {
  value: number
  constructor(value: number) {
    this.value = value
  }
}

/** A Python exception: its message is what str() of it gives, which ERROR prints. */
export class PyError extends Error {
  type: string
  constructor(message: string, type = 'RuntimeError') {
    super(message)
    this.type = type
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isDict(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Float) && !(value instanceof Map)
}

function dict(entries: Dict): Dict {
  return Object.assign(Object.create(null) as Dict, entries)
}

function typeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return 'int'
  if (value instanceof Float) return 'float'
  if (typeof value === 'string') return 'str'
  if (Array.isArray(value)) return 'list'
  return 'dict'
}

/** value[key] for a string key. */
function item(value: unknown, key: string): unknown {
  if (isDict(value)) {
    if (!Object.hasOwn(value, key)) throw new PyError(repr(key), 'KeyError')
    return value[key]
  }
  if (Array.isArray(value)) throw new PyError('list indices must be integers or slices, not str', 'TypeError')
  if (typeof value === 'string') throw new PyError("string indices must be integers, not 'str'", 'TypeError')
  throw new PyError(`'${typeName(value)}' object is not subscriptable`, 'TypeError')
}

/** value.get(key, fallback). */
function get(value: unknown, key: string, fallback: unknown = null): unknown {
  if (!isDict(value)) throw new PyError(`'${typeName(value)}' object has no attribute 'get'`, 'AttributeError')
  return Object.hasOwn(value, key) ? value[key] : fallback
}

/** `value or other`; a function for other is only called when needed, as Python evaluates it. */
function or(value: unknown, other: unknown): unknown {
  if (truthy(value)) return value
  return typeof other === 'function' ? (other as () => unknown)() : other
}

function truthy(value: unknown): boolean {
  if (value instanceof Float) return value.value !== 0
  if (Array.isArray(value)) return value.length > 0
  if (value instanceof Map) return value.size > 0
  if (isDict(value)) return Object.keys(value).length > 0
  return Boolean(value)
}

/** Python's ==. */
function eq(a: unknown, b: unknown): boolean {
  if (isNumber(a) && isNumber(b)) return number(a) === number(b)
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]))
  if (isDict(a) && isDict(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && eq(a[k], b[k]))
  }
  return a === b || (a === undefined && b === null) || (a === null && b === undefined)
}

function isNumber(value: unknown): boolean {
  return typeof value === 'number' || typeof value === 'boolean' || value instanceof Float
}

function number(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return Number(value)
  if (value instanceof Float) return value.value
  throw new PyError(`unsupported operand type(s) for numbers: '${typeName(value)}'`, 'TypeError')
}

/** A dict key or set member: a list or a dict is unhashable. Equal numbers are one key, as 1, 1.0, and True are. */
function hashKey(value: unknown): unknown {
  if (Array.isArray(value) || isDict(value)) throw new PyError(`unhashable type: '${typeName(value)}'`, 'TypeError')
  return isNumber(value) ? number(value) : value
}

function inSet(value: unknown, set: Set<string>): boolean {
  hashKey(value)
  return typeof value === 'string' && set.has(value)
}

/** `60 * value`: a float stays a float, and a string or list repeats, as in Python; the comparison that follows raises. */
function times60(value: unknown): unknown {
  if (typeof value === 'number' || typeof value === 'boolean') return 60 * Number(value)
  if (value instanceof Float) return new Float(60 * value.value)
  if (typeof value === 'string') return value.repeat(60)
  if (Array.isArray(value)) return Array.from({ length: 60 }, () => value).flat()
  throw new PyError(`unsupported operand type(s) for *: 'int' and '${typeName(value)}'`, 'TypeError')
}

/** `value // 60`. */
function floor60(value: unknown): unknown {
  if (value instanceof Float) return new Float(Math.floor(value.value / 60))
  return Math.floor(number(value) / 60)
}

function subtract(a: unknown, b: unknown): number {
  return number(a) - number(b)
}

/** `a > b` for numbers or for strings; other pairs raise, as Python's TypeError. */
function greater(a: unknown, b: unknown): boolean {
  if (isNumber(a) && isNumber(b)) return number(a) > number(b)
  if (typeof a === 'string' && typeof b === 'string') return a > b
  throw new PyError(`'>' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`, 'TypeError')
}

/** max(a, b): the first of the largest. */
function max(a: unknown, b: unknown): unknown {
  return greater(b, a) ? b : a
}

/** max(values, key=key): the first of the largest. */
function maxBy(values: unknown[], key: (value: unknown) => unknown): unknown {
  let best = values[0]
  let bestKey = key(best)
  for (const value of values.slice(1)) {
    const k = key(value)
    if (greater(k, bestKey)) {
      best = value
      bestKey = k
    }
  }
  return best
}

function add1(value: unknown): unknown {
  return value instanceof Float ? new Float(value.value + 1) : number(value) + 1
}

function len(value: unknown): number {
  if (typeof value === 'string') return [...value].length
  if (Array.isArray(value)) return value.length
  if (value instanceof Map) return value.size
  if (isDict(value)) return Object.keys(value).length
  throw new PyError(`object of type '${typeName(value)}' has no len()`, 'TypeError')
}

/** The items a for loop takes from value: a string gives its characters, a dict its keys. */
function iterate(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return [...value]
  if (value instanceof Map) return [...value.keys()]
  if (isDict(value)) return Object.keys(value)
  throw new PyError(`'${typeName(value)}' object is not iterable`, 'TypeError')
}

/** Arguments for a subprocess: each must be a string. */
function strings(values: unknown[]): string[] {
  for (const value of values) {
    if (typeof value !== 'string') throw new PyError(`expected str, bytes or os.PathLike object, not ${typeName(value)}`, 'TypeError')
  }
  return values as string[]
}

/** separator.join(values): each must be a string. */
function join_(separator: string, values: unknown[]): string {
  values.forEach((value, i) => {
    if (typeof value !== 'string') throw new PyError(`sequence item ${i}: expected str instance, ${typeName(value)} found`, 'TypeError')
  })
  return values.join(separator)
}

/** str(value), as an f-string shows it. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : repr(value)
}

function repr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value).toString() : floatRepr(value)
  if (value instanceof Float) return floatRepr(value.value)
  if (typeof value === 'string') return reprString(value)
  if (Array.isArray(value)) return `[${value.map(repr).join(', ')}]`
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as Dict)
  return `{${entries.map(([k, v]) => `${repr(k)}: ${repr(v)}`).join(', ')}}`
}

function reprString(text: string): string {
  const mark = text.includes("'") && !text.includes('"') ? '"' : "'"
  let result = mark
  for (const c of text) {
    const code = c.codePointAt(0) as number
    if (c === mark || c === '\\') result += `\\${c}`
    else if (c === '\t') result += '\\t'
    else if (c === '\n') result += '\\n'
    else if (c === '\r') result += '\\r'
    else if (code < 0x20 || code === 0x7f) result += `\\x${code.toString(16).padStart(2, '0')}`
    else if (code > 0x7f && /[\p{C}\p{Z}]/u.test(c)) {
      result += code < 0x100 ? `\\x${code.toString(16).padStart(2, '0')}` : code < 0x10000 ? `\\u${code.toString(16).padStart(4, '0')}` : `\\U${code.toString(16).padStart(8, '0')}`
    } else result += c
  }
  return result + mark
}

/** repr() of a float: the shortest digits that read back, in positional form from 1e-4 up to 1e16. */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0'
  const [mantissa, exponent] = x.toExponential().split('e')
  const sign = mantissa.startsWith('-') ? '-' : ''
  const digits = mantissa.replace(/^-/, '').replace('.', '')
  const exp = Number(exponent)
  if (exp >= -4 && exp < 16) {
    if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`
    const whole = digits.slice(0, exp + 1).padEnd(exp + 1, '0')
    return `${sign}${whole}.${digits.slice(exp + 1) || '0'}`
  }
  const lead = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits
  return `${sign}${lead}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
}

// str.strip(): Python's whitespace, which differs from String.prototype.trim's at \x1c-\x1f, \x85, and \ufeff.
const SPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const EDGES = new RegExp(`^${SPACE}+|${SPACE}+$`, 'g')
const END = new RegExp(`${SPACE}+$`)
function strip(text: string): string {
  return text.replace(EDGES, '')
}
function rstrip(text: string): string {
  return text.replace(END, '')
}

// str.splitlines(), which also breaks at \v, \f, \x1c-\x1e, \x85, \u2028, and \u2029.
function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

// int(text): Python takes surrounding whitespace, a sign, leading zeros, and _ between digits.
function pyInt(text: string): number | null {
  const digits = strip(text)
  return /^[+-]?\d+(?:_\d+)*$/.test(digits) ? Number(digits.replace(/_/g, '')) : null
}

// JSON as Python's json module reads and writes it

class Stop {
  index: number
  constructor(index: number) {
    this.index = index
  }
}

function decodeError(message: string, text: string, index: number): PyError {
  // Python counts characters, where a JavaScript index counts UTF-16 units.
  const head = text.slice(0, index)
  const pos = [...head].length
  const newline = head.lastIndexOf('\n')
  const line = head.split('\n').length
  const column = newline < 0 ? pos + 1 : pos - [...head.slice(0, newline)].length
  return new PyError(`${message}: line ${line} column ${column} (char ${pos})`, 'JSONDecodeError')
}

const WS = new Set([' ', '\t', '\n', '\r'])
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y
const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

/** json.loads, as CPython's C scanner reads: the same values, and the same error at the same place. */
export function loads(text: string): unknown {
  if (text.startsWith('\ufeff')) throw decodeError('Unexpected UTF-8 BOM (decode using utf-8-sig)', text, 0)
  const skip = (i: number) => {
    while (i < text.length && WS.has(text[i])) i++
    return i
  }
  let depth = 0

  const scanString = (end: number): [string, number] => {
    const begin = end - 1
    let result = ''
    for (;;) {
      let next = end
      let c = ''
      for (; next < text.length; next++) {
        c = text[next]
        if (c === '"' || c === '\\') break
        if (c.charCodeAt(0) <= 0x1f) throw decodeError('Invalid control character at', text, next)
      }
      if (c !== '"' && c !== '\\') throw decodeError('Unterminated string starting at', text, begin)
      result += text.slice(end, next)
      next++
      if (c === '"') return [result, next]
      if (next === text.length) throw decodeError('Unterminated string starting at', text, begin)
      c = text[next]
      if (c !== 'u') {
        if (!Object.hasOwn(SIMPLE_ESCAPES, c)) throw decodeError('Invalid \\escape', text, next - 1)
        result += SIMPLE_ESCAPES[c]
        end = next + 1
      } else {
        // A surrogate pair is two escapes, and two UTF-16 units are what JavaScript keeps for it.
        end = next + 5
        if (end >= text.length) throw decodeError('Invalid \\uXXXX escape', text, next)
        const hex = text.slice(next + 1, end)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw decodeError('Invalid \\uXXXX escape', text, next)
        result += String.fromCharCode(parseInt(hex, 16))
      }
    }
  }

  const scan = (i: number): [unknown, number] => {
    if (i >= text.length) throw new Stop(i)
    const c = text[i]
    if (c === '"') return scanString(i + 1)
    if (c === '{' || c === '[') {
      // Python's recursion limit, near 1000 levels, raises RecursionError: load lets it through, and a poll counts it as failed.
      if (++depth > 1000) throw new PyError(`maximum recursion depth exceeded while decoding a JSON ${c === '{' ? 'object' : 'array'} from a unicode string`, 'RecursionError')
      try {
        return c === '{' ? scanObject(i + 1) : scanArray(i + 1)
      } finally {
        depth--
      }
    }
    if (text.startsWith('null', i)) return [null, i + 4]
    if (text.startsWith('true', i)) return [true, i + 4]
    if (text.startsWith('false', i)) return [false, i + 5]
    if (text.startsWith('NaN', i)) return [new Float(NaN), i + 3]
    if (text.startsWith('Infinity', i)) return [new Float(Infinity), i + 8]
    if (text.startsWith('-Infinity', i)) return [new Float(-Infinity), i + 9]
    NUMBER.lastIndex = i
    const match = NUMBER.exec(text)
    if (!match) throw new Stop(i)
    const value = Number(match[0])
    return [match[1] || match[2] ? new Float(value) : value === 0 ? 0 : value, i + match[0].length]
  }

  const scanObject = (i: number): [unknown, number] => {
    const result = dict({})
    i = skip(i)
    if (i >= text.length || text[i] !== '}') {
      for (;;) {
        if (i >= text.length || text[i] !== '"') throw decodeError('Expecting property name enclosed in double quotes', text, i)
        const [key, afterKey] = scanString(i + 1)
        i = skip(afterKey)
        if (i >= text.length || text[i] !== ':') throw decodeError("Expecting ':' delimiter", text, i)
        const [value, afterValue] = scan(skip(i + 1))
        result[key] = value
        i = skip(afterValue)
        if (i < text.length && text[i] === '}') break
        if (i >= text.length || text[i] !== ',') throw decodeError("Expecting ',' delimiter", text, i)
        i = skip(i + 1)
      }
    }
    return [result, i + 1]
  }

  const scanArray = (i: number): [unknown, number] => {
    const result: unknown[] = []
    i = skip(i)
    if (i >= text.length || text[i] !== ']') {
      for (;;) {
        const [value, after] = scan(i)
        result.push(value)
        i = skip(after)
        if (i < text.length && text[i] === ']') break
        if (i >= text.length || text[i] !== ',') throw decodeError("Expecting ',' delimiter", text, i)
        i = skip(i + 1)
      }
    }
    return [result, i + 1]
  }

  try {
    const [value, end] = scan(skip(0))
    const rest = skip(end)
    if (rest !== text.length) throw decodeError('Extra data', text, rest)
    return value
  } catch (error) {
    if (error instanceof Stop) throw decodeError('Expecting value', text, error.index)
    throw error
  }
}

/** json.dumps(value, indent=indent): ASCII only, a float as repr() shows it, and a dict key as a string. */
export function dumps(value: unknown, indent?: number, depth = 0): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value).toString() : floatJson(value)
  if (value instanceof Float) return floatJson(value.value)
  if (typeof value === 'string') return encode(value)
  const items = Array.isArray(value)
    ? value.map((v) => dumps(v, indent, depth + 1))
    : (value instanceof Map ? [...value.entries()] : Object.entries(value as Dict)).map(([k, v]) => `${encode(keyText(k))}: ${dumps(v, indent, depth + 1)}`)
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
  if (!items.length) return open + close
  if (indent === undefined) return open + items.join(', ') + close
  const inner = `\n${' '.repeat(indent * (depth + 1))}`
  return `${open}${inner}${items.join(`,${inner}`)}\n${' '.repeat(indent * depth)}${close}`
}

function floatJson(x: number): string {
  if (Number.isNaN(x)) return 'NaN'
  if (!Number.isFinite(x)) return x > 0 ? 'Infinity' : '-Infinity'
  return floatRepr(x)
}

function keyText(key: unknown): string {
  if (typeof key === 'string') return key
  if (key === null || key === undefined) return 'null'
  return typeof key === 'number' && !Number.isInteger(key) ? floatRepr(key) : String(key)
}

const ESCAPES: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' }
function encode(text: string): string {
  return `"${text.replace(/["\\]|[^\x20-\x7e]/g, (c) => ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
