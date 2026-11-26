// Tests for watch.ts, with gh and the shell stubbed through io.exec and the clock through io.time and io.sleep.
// Run: node --test "skills/watch-ci/*.spec.ts"

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { execute, io, run, type Ran } from './watch.ts'

const WATCH = fileURLToPath(new URL('./watch.ts', import.meta.url))
const RUN_VIEW = ['--json', 'status,conclusion,url,jobs,attempt']

const ok = (value: unknown): Ran => ({ status: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' })
const job = (name: string, status: string, conclusion: string | null, steps: [string, string, string | null][] = [], url?: string) => ({
  name,
  status,
  conclusion,
  url,
  steps: steps.map(([step, s, c]) => ({ name: step, status: s, conclusion: c })),
})

describe('watch', () => {
  const original = { ...io }
  let tmp: string
  let map: string
  let calls: { argv: string[]; timeout: number }[]
  let lines: string[]
  let sleeps: number[]
  let clock: number
  // What a command answers, by its argv; each poll calls it again.
  let answer: (argv: string[]) => Ran | Promise<Ran>

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'watch-'))
    map = join(tmp, 'abc1234.json')
    calls = []
    lines = []
    sleeps = []
    clock = 1000
    answer = () => {
      throw new Error('no answer')
    }
    io.exec = async (argv, timeout) => {
      calls.push({ argv, timeout })
      return answer(argv)
    }
    io.time = () => clock
    io.sleep = async (seconds) => {
      sleeps.push(seconds)
      clock += seconds
    }
    io.emit = (line) => {
      lines.push(line)
    }
  })

  afterEach(() => {
    Object.assign(io, original)
    rmSync(tmp, { recursive: true, force: true })
  })

  const writeMap = (value: object | string) => writeFileSync(map, typeof value === 'string' ? value : JSON.stringify(value))
  const watch = async (once: boolean, budget = 540) => {
    lines = []
    calls = []
    sleeps = []
    const code = await run(map, once, budget)
    return { code, lines }
  }

  describe('the map file', () => {
    test('a missing map, one that is not JSON, and one with no targets print ERROR and exit 2', async () => {
      for (const text of [null, '{"targets": [', '{"targets": []}', '[]', '{}']) {
        rmSync(map, { force: true })
        if (text !== null) writeMap(text)
        assert.deepEqual(await watch(true), { code: 2, lines: [`ERROR map ${map} is missing or has no targets`] }, String(text))
      }
    })

    test('minutes in the map may be fractions of a minute', async () => {
      writeMap({ max_minutes: 1.5, targets: [{ id: 'd', label: 'Deploy', kind: 'gh-workflow', repo: 'o/r', workflow: 'deploy.yml', sha: 'abc', appear_minutes: 0.5 }] })
      answer = () => ok([])
      const missing = await watch(false)
      assert.equal(missing.lines.length, 2)
      assert.ok(missing.lines[0]?.startsWith('MISSING Deploy: missing (no run appeared within '))
      assert.equal(missing.lines[1], 'ALL_DONE failure')
      assert.deepEqual(sleeps, [30, 30])

      writeMap({ max_minutes: 1.5, poll_seconds: 30, targets: [{ id: 'ci', label: 'CI', kind: 'gh-run', repo: 'o/r', run_id: 1 }] })
      rmSync(`${map}.state.json`)
      answer = () => ok({ status: 'in_progress', conclusion: null, url: 'https://run/1', attempt: 1, jobs: [] })
      const timeout = await watch(false)
      assert.ok(timeout.lines[0]?.startsWith('TIMEOUT after 1'))
      assert.ok(timeout.lines[0]?.endsWith(' min; 0/1 targets settled'))
      assert.equal(timeout.lines[1], 'ALL_DONE incomplete')
      // 90 s is not past 1.5 minutes; the poll after it is.
      assert.deepEqual(sleeps, [30, 30, 30, 30])
    })

    test('a state file with its own spacing and key order still reads', async () => {
      writeMap({ targets: [{ id: 'ci', label: 'CI', kind: 'gh-run', repo: 'o/r', run_id: 1 }] })
      writeFileSync(`${map}.state.json`, '{"targets": {"ci": {"reported": "success", "last_state": "success", "attempt": 1, "errors": 0}}, "started": 1000}')
      answer = () => ok({ status: 'completed', conclusion: 'success', url: 'https://run/1', jobs: [] })
      assert.deepEqual((await watch(false)).lines, ['ALL_DONE success'])
    })
  })

  describe('targets', () => {
    test('gh-run: --once shows the running job, its step, and the jobs done against expected_jobs', async () => {
      writeMap({ context: 'abc1234 pushed to feature/x', targets: [{ id: 'ci', label: 'CI', kind: 'gh-run', repo: 'o/r', run_id: 123, expected_jobs: 3 }] })
      answer = () =>
        ok({
          status: 'in_progress',
          conclusion: null,
          url: 'https://run/123',
          attempt: 1,
          jobs: [
            job('lint', 'completed', 'success', [['Lint', 'completed', 'success']]),
            job('test', 'in_progress', null, [['Set up', 'completed', 'success'], ['Run tests', 'in_progress', null], ['Upload', 'queued', null]]),
          ],
        })
      assert.deepEqual(await watch(true), {
        code: 0,
        lines: [
          'SNAPSHOT 1 targets for abc1234 pushed to feature/x: CI',
          'PROGRESS CI: monitoring test (1/3 steps completed, now "Run tests") · 1/3 jobs done',
          'PENDING 0/1 targets settled',
        ],
      })
      assert.deepEqual(calls, [{ argv: ['gh', 'run', 'view', '123', '--repo', 'o/r', ...RUN_VIEW], timeout: 90 }])
    })

    test('gh-run: a failed job names its job, its failed step, and its URL, and returns', async () => {
      writeMap({ targets: [{ id: 'ci', label: 'CI', kind: 'gh-run', repo: 'o/r', run_id: 1 }, { id: 'v', label: 'Vercel', kind: 'gh-check', repo: 'o/r', sha: 'abc', name: 'Vercel' }] })
      answer = (argv) =>
        argv[1] === 'run'
          ? ok({ status: 'completed', conclusion: 'failure', url: 'https://run/1', attempt: 1, jobs: [job('test', 'completed', 'failure', [['Run tests', 'completed', 'failure']], 'https://job/2')] })
          : ok({ check_runs: [{ status: 'in_progress', conclusion: null, started_at: 'x', html_url: 'https://v' }] })
      assert.deepEqual(await watch(false), { code: 0, lines: ['FAIL CI: job test, step "Run tests" https://job/2', 'RETURN'] })
    })

    test('gh-workflow: it waits for its upstream, then takes the newest run of its event, and keeps that run', async () => {
      writeMap({
        targets: [
          { id: 'ci', label: 'CI', kind: 'gh-run', repo: 'o/r', run_id: 1 },
          { id: 'deploy', label: 'Deploy preview', kind: 'gh-workflow', repo: 'o/r', workflow: 'deploy.yml', sha: 'abc', event: 'workflow_run', after: ['ci'] },
        ],
      })
      let ci = 'in_progress'
      let runs: object[] = []
      answer = (argv) => {
        if (argv[2] === 'list') return ok(runs)
        if (argv[3] === '1') return ok({ status: ci, conclusion: ci === 'completed' ? 'success' : null, url: 'https://run/1', jobs: [] })
        return ok({ status: 'in_progress', conclusion: null, url: `https://run/${argv[3]}`, jobs: [] })
      }
      assert.deepEqual((await watch(true)).lines.slice(1, 3), ['PROGRESS CI: running', 'PROGRESS Deploy preview: starts after CI'])
      ci = 'completed'
      runs = [
        { databaseId: 7, createdAt: '2026-01-01T00:01:00Z', event: 'push' },
        { databaseId: 8, createdAt: '2026-01-01T00:00:30Z', event: 'workflow_run' },
        { databaseId: 9, createdAt: '2026-01-01T00:00:45Z', event: 'workflow_run' },
      ]
      assert.deepEqual((await watch(true)).lines.slice(1), ['DONE CI: success https://run/1', 'PROGRESS Deploy preview: running', 'PENDING 1/2 targets settled'])
      assert.deepEqual(calls[1]?.argv, ['gh', 'run', 'list', '--repo', 'o/r', '--workflow', 'deploy.yml', '--commit', 'abc', '-L', '20', '--json', 'databaseId,createdAt,event'])
      assert.deepEqual(calls[2]?.argv.slice(0, 4), ['gh', 'run', 'view', '9'])
      await watch(true)
      assert.deepEqual(calls.map((call) => call.argv[2]), ['view', 'view'])
    })

    test('gh-workflow: an upstream that failed skips it, and one that never appears goes missing', async () => {
      writeMap({
        targets: [
          { id: 'ci', label: 'CI', kind: 'gh-run', repo: 'o/r', run_id: 1 },
          { id: 'deploy', label: 'Deploy', kind: 'gh-workflow', repo: 'o/r', workflow: 'deploy.yml', sha: 'abc', after: ['ci'] },
        ],
      })
      answer = (argv) => (argv[2] === 'list' ? ok([]) : ok({ status: 'completed', conclusion: 'cancelled', url: 'https://run/1', jobs: [] }))
      assert.deepEqual((await watch(false)).lines, ['CANCELLED CI: cancelled https://run/1', 'SKIPPED Deploy: CI did not succeed', 'ALL_DONE cancelled'])

      writeMap({ targets: [{ id: 'deploy', label: 'Deploy', kind: 'gh-workflow', repo: 'o/r', workflow: 'deploy.yml', sha: 'abc' }] })
      rmSync(`${map}.state.json`)
      answer = () => ok([])
      // 10 minutes by default: the target is missing on the first poll after 600 s.
      assert.deepEqual(await watch(false, 10_000), { code: 0, lines: ['MISSING Deploy: missing (no run appeared within 10 min)', 'ALL_DONE failure'] })
      assert.equal(sleeps.length, 21)
    })

    test('gh-check: the newest check run, its title, and its details URL', async () => {
      writeMap({ targets: [{ id: 'v', label: 'Vercel', kind: 'gh-check', repo: 'o/r', sha: 'abc', name: 'Vercel' }] })
      answer = () => ok({ check_runs: [] })
      assert.deepEqual((await watch(true)).lines.slice(1), ['PROGRESS Vercel: not started yet', 'PENDING 0/1 targets settled'])
      assert.deepEqual(calls[0]?.argv, ['gh', 'api', '-X', 'GET', 'repos/o/r/commits/abc/check-runs', '-f', 'check_name=Vercel', '-f', 'per_page=100'])
      answer = () =>
        ok({
          check_runs: [
            { status: 'completed', conclusion: 'failure', started_at: '2026-01-01T00:00:00Z', html_url: null, details_url: 'https://vercel/1', output: { title: 'Old' } },
            { status: 'completed', conclusion: 'neutral', started_at: '2026-01-01T00:05:00Z', html_url: null, details_url: 'https://vercel/2', output: { title: 'Deployed' } },
          ],
        })
      assert.deepEqual((await watch(false)).lines, ['DONE Vercel: success (Deployed) https://vercel/2', 'ALL_DONE success'])
    })

    test('gh-status: pending is running, and any state but success fails', async () => {
      writeMap({ targets: [{ id: 'c', label: 'CircleCI build', kind: 'gh-status', repo: 'o/r', sha: 'abc', context: 'ci/circleci: build' }] })
      const status = (state: string, description: string) =>
        ok([
          { context: 'other', state: 'success' },
          { context: 'ci/circleci: build', state, target_url: 'https://circle/1', description },
        ])
      answer = () => status('pending', 'Running')
      assert.deepEqual((await watch(true)).lines.slice(1, 2), ['PROGRESS CircleCI build: running (Running)'])
      assert.deepEqual(calls[0]?.argv, ['gh', 'api', '-X', 'GET', 'repos/o/r/commits/abc/statuses', '-f', 'per_page=100'])
      answer = () => status('error', 'Build failed')
      assert.deepEqual((await watch(false)).lines, ['FAIL CircleCI build: failure (Build failed) https://circle/1', 'ALL_DONE failure'])
    })

    test('command: the shell runs it with a 120 s timeout, and its JSON is the state', async () => {
      const command = "glab api projects/:id/pipelines/456 | jq -c '.'"
      writeMap({ targets: [{ id: 'gl', label: 'GitLab pipeline', kind: 'command', command, expected_jobs: 2 }] })
      answer = () => ok({ state: 'running', jobs: [{ name: 'build', state: 'running', steps_done: 2, steps_total: 5, current_step: 'compile' }] })
      assert.deepEqual((await watch(true)).lines.slice(1, 2), ['PROGRESS GitLab pipeline: monitoring build (2/5 steps completed, now "compile") · 0/2 jobs done'])
      assert.deepEqual(calls, [{ argv: ['/bin/sh', '-c', command], timeout: 120 }])
    })
  })

  describe('failed polls', () => {
    const failing = async (target: object, result: Ran | (() => never)) => {
      writeMap({ targets: [{ id: 't', label: 'GL', ...target }] })
      answer = () => (typeof result === 'function' ? result() : result)
      return watch(false)
    }

    test('3 failed polls in a row print ERROR with the last line of stderr, and return', async () => {
      const { lines } = await failing({ kind: 'command', command: 'x' }, { status: 1, stdout: '', stderr: 'warning\nglab: 401 Unauthorized\n' })
      assert.deepEqual(lines, ['ERROR GL: glab: 401 Unauthorized', 'RETURN'])
      assert.equal(calls.length, 3)
    })

    test('output that is not JSON, a missing field, an empty stderr, gh printing nothing, a timeout, and an unknown kind fail the poll', async () => {
      const timedOut = () => {
        throw new Error('gh run view timed out after 90 s')
      }
      const cases: [object, Ran | (() => never), string][] = [
        [{ kind: 'command', command: 'x' }, { status: 0, stdout: 'not json', stderr: '' }, 'JSON'],
        [{ kind: 'gh-run', repo: 'o/r' }, ok({}), 'run_id'],
        [{ kind: 'command' }, ok({}), 'command'],
        [{ kind: 'command', command: 'x' }, { status: 4, stdout: '', stderr: '  \n' }, 'command exited 4'],
        [{ kind: 'gh-run', repo: 'o/r', run_id: 1 }, { status: 137, stdout: '', stderr: '' }, 'gh exited 137'],
        [{ kind: 'gh-run', repo: 'o/r', run_id: 1 }, ok(null), ''],
        [{ kind: 'gh-workflow', repo: 'o/r', workflow: 'w.yml', sha: 'abc', event: 'push' }, { status: 0, stdout: '', stderr: '' }, ''],
        [{ kind: 'gh-run', repo: 'o/r', run_id: 1 }, timedOut, 'timed out'],
        [{ kind: 'jenkins' }, ok({}), 'jenkins'],
      ]
      for (const [target, result, text] of cases) {
        rmSync(`${map}.state.json`, { force: true })
        const { lines } = await failing(target, result)
        assert.equal(lines.length, 2, JSON.stringify(target))
        assert.ok(lines[0]?.startsWith('ERROR GL: '), lines[0])
        assert.ok(lines[0]?.includes(text), lines[0])
        assert.equal(lines[1], 'RETURN')
      }
    })

    test('a poll that succeeds resets the count', async () => {
      writeMap({ targets: [{ id: 't', label: 'GL', kind: 'command', command: 'x' }] })
      const answers = [{ status: 1, stdout: '', stderr: 'down' }, { status: 1, stdout: '', stderr: 'down' }, ok({ state: 'running' })]
      answer = () => answers.shift() ?? { status: 1, stdout: '', stderr: 'down' }
      assert.deepEqual((await watch(false)).lines, ['ERROR GL: down', 'RETURN'])
      assert.equal(calls.length, 6)
    })
  })

  describe('exit conditions', () => {
    test('a job that finishes returns CONTINUE with the progress in one line', async () => {
      writeMap({ targets: [{ id: 'ci', label: 'CI', kind: 'gh-run', repo: 'o/r', run_id: 1 }] })
      answer = () => ok({ status: 'in_progress', url: 'u', jobs: [job('lint', 'completed', 'success'), job('test', 'in_progress', null, [['Run tests', 'in_progress', null]])] })
      assert.deepEqual((await watch(false)).lines, ['CONTINUE CI 1/2 jobs · now "Run tests"'])
      assert.deepEqual(sleeps, [])
    })

    test('the budget runs out: CONTINUE before a sleep would pass it', async () => {
      writeMap({ poll_seconds: 30, targets: [{ id: 'ci', label: 'CI', kind: 'gh-run', repo: 'o/r', run_id: 1 }] })
      answer = () => ok({ status: 'queued', url: 'u', jobs: [] })
      assert.deepEqual((await watch(false, 60)).lines, ['CONTINUE CI queued'])
      assert.deepEqual(sleeps, [30, 30])
      assert.equal(calls.length, 3)
    })

    test('a settled target is reported once, and again after a rerun', async () => {
      writeMap({ targets: [{ id: 'a', label: 'A', kind: 'gh-run', repo: 'o/r', run_id: 1 }, { id: 'b', label: 'B', kind: 'gh-run', repo: 'o/r', run_id: 2 }] })
      let attempt = 1
      answer = (argv) =>
        argv[3] === '1'
          ? ok({ status: 'completed', conclusion: 'success', url: 'https://run/1', attempt, jobs: [job('build', 'completed', 'success')] })
          : ok({ status: 'in_progress', url: 'https://run/2', jobs: [job('x', 'in_progress', null, [['Step', 'in_progress', null]])] })
      assert.deepEqual((await watch(false)).lines, ['DONE A: success (1 jobs) https://run/1', 'CONTINUE A done · B 0/1 jobs · now "Step"'])
      assert.deepEqual((await watch(false, 30)).lines, ['CONTINUE A done · B 0/1 jobs · now "Step"'])
      attempt = 2
      assert.deepEqual((await watch(false)).lines, ['DONE A: success (1 jobs) https://run/1', 'CONTINUE A done · B 0/1 jobs · now "Step"'])
    })

    test('queued past stall_minutes prints STALLED once and returns', async () => {
      writeMap({ stall_minutes: 1, targets: [{ id: 'ci', label: 'CI', kind: 'gh-run', repo: 'o/r', run_id: 1 }] })
      answer = () => ok({ status: 'queued', url: 'https://run/1', jobs: [] })
      assert.deepEqual((await watch(false)).lines, ['STALLED CI: queued for 1 min https://run/1', 'RETURN'])
      assert.deepEqual(sleeps, [30, 30, 30])
      assert.deepEqual((await watch(false, 60)).lines, ['CONTINUE CI queued'])
    })

    test('a job that waits for approval prints WAITING, and the result is waiting', async () => {
      writeMap({ targets: [{ id: 'd', label: 'Deploy', kind: 'gh-run', repo: 'o/r', run_id: 5 }] })
      answer = () => ok({ status: 'waiting', url: 'https://run/5', jobs: [job('build', 'completed', 'success'), job('deploy', 'waiting', null)] })
      assert.deepEqual((await watch(false)).lines, ['WAITING Deploy: job deploy waiting for approval https://run/5', 'ALL_DONE waiting'])
    })

    test('the state file keeps the per-target records between runs', async () => {
      writeMap({ targets: [{ id: 'ci', label: 'CI', kind: 'gh-run', repo: 'o/r', run_id: 1 }] })
      answer = () => ok({ status: 'completed', conclusion: 'success', url: 'https://run/1', jobs: [] })
      await watch(false)
      const state = JSON.parse(readFileSync(`${map}.state.json`, 'utf8'))
      assert.deepEqual(state, { started: 1000, targets: { ci: { errors: 0, attempt: 1, last_state: 'success', reported: 'success' } } })
    })
  })

  describe('running commands', () => {
    test('the exit status and the output are kept', async () => {
      assert.deepEqual(await execute(['/bin/sh', '-c', 'printf "a\\nb"; echo err >&2; exit 3'], 5), { status: 3, stdout: 'a\nb', stderr: 'err\n' })
    })

    test('a timeout kills the command and does not wait for what it started', async () => {
      const started = Date.now()
      await assert.rejects(execute(['/bin/sh', '-c', 'sleep 5 & sleep 5; echo late'], 0.3), /timed out/)
      assert.ok(Date.now() - started < 3000)
    })

    test('a program that is not there rejects', async () => {
      await assert.rejects(execute(['no-such-program-for-watch'], 5), /no-such-program-for-watch/)
    })
  })

  describe('the command line', () => {
    const cli = (...args: string[]) => spawnSync(process.execPath, [WATCH, ...args], { cwd: tmp, encoding: 'utf8' })

    test('wrong arguments print the usage and exit 2', () => {
      const wrong = [[], ['map.json'], ['map.json', '--once', '--until-actionable'], ['a', 'b', '--once'], ['map.json', '--once', '--budget'], ['map.json', '--once', '--budget', 'x'], ['map.json', '--once', '--nope']]
      for (const args of wrong) {
        const done = cli(...args)
        assert.equal(done.status, 2, args.join(' '))
        assert.equal(done.stdout, '')
        assert.ok(done.stderr.includes('usage: node watch.ts MAP.json --once'), done.stderr)
      }
    })

    test('a command target runs in the shell, and a relative map path prints as absolute', () => {
      writeMap({ targets: [{ id: 'gl', label: 'GL', kind: 'command', command: `printf '{"state": "success", "url": "https://ci/1"}'` }] })
      const done = cli('abc1234.json', '--once')
      assert.deepEqual([done.status, done.stdout], [0, 'SNAPSHOT 1 targets for this change: GL\nDONE GL: success https://ci/1\nALL_DONE success\n'])
      const missing = cli('nope.json', '--until-actionable', '--budget', '5')
      // The working folder as the process sees it: on macOS the temporary folder's real path starts /private.
      assert.deepEqual([missing.status, missing.stdout], [2, `ERROR map ${join(realpathSync(tmp), 'nope.json')} is missing or has no targets\n`])
    })
  })
})
