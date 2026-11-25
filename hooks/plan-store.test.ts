import { expect, test } from 'claude-code/testing'

import { claim, findPlanRoot, holder, listGoals, loadGoal, planRoot, recordActive, release, removeGoal, saveGoal, STALE_MS } from './plan-store'
import { fakeStoreDisk } from './plan-testing'
import { newGoal, serializeGoal, PlanError } from './plan-tree'

const NOW = Date.parse('2026-11-15T12:00:00Z')
const lock = (session: string, ageMs: number) => JSON.stringify({ session, heartbeat: new Date(NOW - ageMs).toISOString() })
const ROOT = '/repo/.tmp/plan'
const STATE = '/repo/.git/waffles'
const LOCK = `${STATE}/locks/g.json`
const goal = () => newGoal('G', [{ title: 'A' }], '2026-11-15T10:00:00Z')
// What git answers in a checkout to `--show-toplevel --git-dir`: the top level, then the git dir.
const gitAt = (top: string, dir: string) => (argv: readonly string[]) =>
  argv.includes('--git-dir') ? { exitCode: 0, stdout: `${top}\n${dir}\n` } : { exitCode: 1, stdout: '' }
const failure = (pending: Promise<unknown>) => pending.then(() => null, (error: unknown) => error)

test('the plan outline is in .tmp/plan at the top level of the checkout, its locks in the git dir', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  disk.cwd = '/repo/src'

  expect(await planRoot($$)).toEqual({ outline: ROOT, state: STATE })
  expect(disk.ran).toEqual([['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir']])
})

test('a worktree keeps its own plan outline on its branch, and its own locks', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  // The working directory, inside the worktree, decides neither.
  disk.cwd = '/repo/.claude/worktrees/w/src'
  disk.git = gitAt('/repo/.claude/worktrees/w', '/repo/.git/worktrees/w/')

  expect(await planRoot($$)).toEqual({ outline: '/repo/.claude/worktrees/w/.tmp/plan', state: '/repo/.git/worktrees/w/waffles' })
})

test('a submodule keeps its plan outline at its own top level, and its locks in its own git dir', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  disk.cwd = '/super/sub/src'
  disk.git = gitAt('/super/sub', '/super/.git/modules/sub')

  expect(await planRoot($$)).toEqual({ outline: '/super/sub/.tmp/plan', state: '/super/.git/modules/sub/waffles' })
})

test('a bare repository with no checkout keeps the plan outline in the working directory', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  // `--show-toplevel` fails outside a work tree, and with it the whole run.
  disk.git = { exitCode: 128, stdout: '' }

  expect(await findPlanRoot($$)).toEqual({ outline: '/cwd/.tmp/plan', state: '/cwd/.tmp/waffles', isFromGit: false, isGitDown: false })
})

test('outside git the plan outline and its locks are in the working directory', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  disk.git = { exitCode: 128, stdout: '' }

  expect(await findPlanRoot($$)).toEqual({ outline: '/cwd/.tmp/plan', state: '/cwd/.tmp/waffles', isFromGit: false, isGitDown: false })
  expect(disk.ran).toHaveLength(1)
})

test('a .tmp/plan that is a file lists no goals and refuses a save; a state folder that is a file refuses a claim', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  disk.files.set(ROOT, 'x')
  disk.files.set(STATE, 'x')

  expect(await listGoals($$)).toEqual([])
  for (const [pending, path] of [
    [saveGoal($$, 'g', goal()), ROOT],
    [claim($$, 'g', 'me', NOW), STATE],
  ] as const) {
    const error = await failure(pending)
    expect(error).toBeInstanceOf(PlanError)
    expect((error as Error).message).toBe(`Not a folder: ${path}`)
  }
  expect(disk.writes).toEqual([])
})

test('listing a checkout without .tmp/plan returns nothing and writes nothing', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$

  expect(await listGoals($$)).toEqual([])
  expect(disk.writes).toEqual([])
})

test('a save writes the goal file with no .gitignore beside it: it is committed on the branch', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  await saveGoal($$, 'g', goal())
  expect(await claim($$, 'g', 'me', NOW)).toBe(true)
  await recordActive($$, 'me', 'g')

  expect(disk.writes).toEqual([`${ROOT}/g.md`, `${STATE}/.gitignore`, LOCK, `${STATE}/sessions/me.json`])
})

test('git failing inside a repository is told apart from no repository, by a .git above the working directory', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  disk.git = { exitCode: 128, stdout: '' }
  disk.cwd = '/repo/src/app'
  disk.files.set('/repo/.git/HEAD', 'ref: refs/heads/main\n')
  expect(await findPlanRoot($$)).toEqual({ outline: '/repo/src/app/.tmp/plan', state: '/repo/src/app/.tmp/waffles', isFromGit: false, isGitDown: true })

  // A worktree's or a submodule's .git is a file.
  disk.files.delete('/repo/.git/HEAD')
  disk.files.set('/repo/src/.git', 'gitdir: /repo/.git/worktrees/src\n')
  expect((await findPlanRoot($$)).isGitDown).toBe(true)

  disk.files.delete('/repo/src/.git')
  expect((await findPlanRoot($$)).isGitDown).toBe(false)
})

test('listing runs git once however many goal files there are', async () => {
  const disk = fakeStoreDisk()
  for (const name of ['a', 'b', 'c']) disk.files.set(`${ROOT}/${name}.md`, serializeGoal(goal()))

  expect(await listGoals(disk.$)).toEqual(['a', 'b', 'c'].map(slug => ({ slug, goal: goal() })))
  expect(disk.ran.filter(argv => argv[1] === 'rev-parse')).toHaveLength(1)
})

test('a folder passed in saves every git run', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  await saveGoal($$, 'g', goal(), ROOT)
  expect(await loadGoal($$, 'g', ROOT)).toEqual(goal())
  expect(await claim($$, 'g', 'me', NOW, STATE)).toBe(true)
  expect(await holder($$, 'g', NOW, STATE)).toBe('me')
  await release($$, 'g', 'me', STATE)
  await removeGoal($$, 'g', ROOT)
  expect(await listGoals($$, ROOT)).toEqual([])

  expect(disk.ran).toEqual([])
  expect(disk.removed).toEqual([LOCK, `${ROOT}/g.md`])
})

test('a missing goal file and one that cannot be read fail with their own messages', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  const missing = await failure(loadGoal($$, 'g'))
  expect(missing).toBeInstanceOf(PlanError)
  expect((missing as Error).message).toBe('No goal file .tmp/plan/g.md')

  disk.files.set(`${ROOT}/g.md`, serializeGoal(goal()))
  disk.isReadBroken = true
  const broken = await failure(loadGoal($$, 'g'))
  expect(broken).toBeInstanceOf(PlanError)
  expect((broken as Error).message).toBe("Can't read .tmp/plan/g.md: EIO /repo/.tmp/plan/g.md")
})

test('a goal file a listing could not read is read again by the next', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  disk.files.set(`${ROOT}/g.md`, serializeGoal(goal()))
  disk.isReadBroken = true
  expect(await listGoals($$)).toEqual([{ slug: 'g', error: "Can't read .tmp/plan/g.md: EIO /repo/.tmp/plan/g.md" }])

  disk.isReadBroken = false
  expect(await listGoals($$)).toEqual([{ slug: 'g', goal: goal() }])
})

test('a listing that read a goal file before a save does not keep what it read', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  const path = `${ROOT}/g.md`
  disk.files.set(path, serializeGoal(goal()))
  // The same size and, on a disk with coarse times, the same modification time: only the save tells.
  const renamed = newGoal('H', [{ title: 'A' }], '2026-11-15T10:00:00Z')
  const stamp = disk.files.stamps.get(path)!
  disk.duringRead = async () => {
    disk.duringRead = null
    await saveGoal($$, 'g', renamed)
    disk.files.stamps.set(path, stamp)
  }
  expect(await listGoals($$)).toEqual([{ slug: 'g', goal: goal() }])

  expect(await listGoals($$)).toEqual([{ slug: 'g', goal: renamed }])
})

test('a second listing reads only the goal files that changed since the last', async () => {
  const disk = fakeStoreDisk()
  for (const name of ['a', 'b', 'c']) disk.files.set(`${ROOT}/${name}.md`, serializeGoal(goal()))
  disk.files.set(`${ROOT}/c.md`, 'nonsense\n')
  await listGoals(disk.$)
  disk.reads.length = 0

  const again = await listGoals(disk.$)
  const unread = [...disk.reads]
  // The same size: only the modification time tells the change.
  const renamed = newGoal('H', [{ title: 'A' }], '2026-11-15T10:00:00Z')
  disk.files.set(`${ROOT}/b.md`, serializeGoal(renamed))
  const changed = await listGoals(disk.$)

  expect(again).toEqual([{ slug: 'a', goal: goal() }, { slug: 'b', goal: goal() }, { slug: 'c', error: "Can't read .tmp/plan/c.md: line 1" }])
  expect(unread).toEqual([])
  expect(changed).toEqual([{ slug: 'a', goal: goal() }, { slug: 'b', goal: renamed }, { slug: 'c', error: "Can't read .tmp/plan/c.md: line 1" }])
  expect(disk.reads).toEqual([`${ROOT}/b.md`])
})

test('goal files are listed in the order of their slugs', async () => {
  const disk = fakeStoreDisk()
  for (const name of ['a', 'a-b']) disk.files.set(`${ROOT}/${name}.md`, serializeGoal(goal()))

  expect((await listGoals(disk.$)).map(f => f.slug)).toEqual(['a', 'a-b'])
})

test('a goal file that does not parse is listed with its error', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  disk.files.set(`${ROOT}/b.md`, 'nonsense\n')
  disk.files.set(`${ROOT}/a.md`, serializeGoal(goal()))
  // A hidden file and a folder are no goal files.
  disk.files.set(`${ROOT}/.notes`, 'x\n')
  disk.files.set(`${ROOT}/docs/a.md`, serializeGoal(goal()))

  expect(await listGoals($$)).toEqual([
    { slug: 'a', goal: goal() },
    { slug: 'b', error: "Can't read .tmp/plan/b.md: line 1" },
  ])
})

test('a live lock from another session blocks a claim; a stale one does not', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  disk.files.set(LOCK, lock('other', 60_000))
  expect(await holder($$, 'g', NOW)).toBe('other')
  expect(await claim($$, 'g', 'me', NOW)).toBe(false)

  disk.files.set(LOCK, lock('other', STALE_MS + 1_000))
  expect(await holder($$, 'g', NOW)).toBe(null)
  expect(await claim($$, 'g', 'me', NOW)).toBe(true)
  expect(JSON.parse(disk.files.get(LOCK)!)).toEqual({ session: 'me', heartbeat: '2026-11-15T12:00:00.000Z' })
  expect(await claim($$, 'g', 'me', NOW + 1_000)).toBe(true)
})

test('a lock holds for 119,999 ms after its heartbeat and is stale at 120,000', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  disk.files.set(LOCK, lock('other', 0))

  expect(STALE_MS).toBe(120_000)
  expect(await holder($$, 'g', NOW + 119_999)).toBe('other')
  expect(await claim($$, 'g', 'me', NOW + 119_999)).toBe(false)
  expect(await holder($$, 'g', NOW + 120_000)).toBe(null)
  expect(await claim($$, 'g', 'me', NOW + 120_000)).toBe(true)
})

test('a missing, broken or unreadable lock file counts as no lock', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  expect(await holder($$, 'g', NOW)).toBe(null)
  disk.files.set(LOCK, '{nope')
  expect(await holder($$, 'g', NOW)).toBe(null)
  disk.files.set(LOCK, 'null')
  expect(await holder($$, 'g', NOW)).toBe(null)
  await release($$, 'g', 'me')
  expect(disk.removed).toEqual([])
  disk.files.set(LOCK, lock('other', 0))
  disk.isReadBroken = true
  expect(await holder($$, 'g', NOW)).toBe(null)
})

test('release does nothing without a lock and fails on a lock it cannot read', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  await release($$, 'g', 'me')
  expect(disk.removed).toEqual([])

  disk.files.set(LOCK, lock('me', 0))
  disk.isReadBroken = true
  expect(((await failure(release($$, 'g', 'me'))) as Error).message).toBe(`EIO ${LOCK}`)
  expect(disk.removed).toEqual([])
})

test('release leaves another session’s lock alone', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  disk.files.set(LOCK, lock('other', 0))
  await release($$, 'g', 'me')
  expect(disk.removed).toEqual([])

  disk.files.set(LOCK, lock('me', 0))
  await release($$, 'g', 'me')
  expect(disk.removed).toEqual([LOCK])
})

test('removing a goal deletes its file', async () => {
  const disk = fakeStoreDisk()
  const $$ = disk.$
  disk.files.set(`${ROOT}/g.md`, 'x')
  await removeGoal($$, 'g')
  expect(disk.removed).toEqual([`${ROOT}/g.md`])
})
