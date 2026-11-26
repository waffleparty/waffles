import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { folderOf } from './checkpoint'

const RAN = { result: { stdout: 'pushed', stderr: '' } }

const GOAL = '---\ngoal: Ship it\nstatus: open\n---\n- [ ] 1 Ship it\n'
const PR = { number: 7, url: 'https://github.com/o/r/pull/7', body: '## Summary\nShip it.', headRefName: 'feat', baseRefName: 'main', state: 'OPEN' }

// What git and gh answer in a checkout at /repo on the branch feat, pushed, with the outline committed
// and pull request #7 open for it.
function repo(command: string): { exitCode: number; stdout: string } {
  if (command === 'git rev-parse --show-toplevel') return { exitCode: 0, stdout: '/repo\n' }
  if (command === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'feat\n' }
  if (command.startsWith('gh pr view ')) return { exitCode: 0, stdout: `${JSON.stringify(PR)}\n` }
  if (command.startsWith('git rev-parse --verify -q ')) return { exitCode: 0, stdout: 'abc\n' }
  if (command === 'git ls-tree --name-only HEAD:.tmp/plan') return { exitCode: 0, stdout: 'g.md\n' }
  if (command === 'git show HEAD:.tmp/plan/g.md') return { exitCode: 0, stdout: GOAL }
  if (command === 'git rev-list --count abc..HEAD') return { exitCode: 0, stdout: '0\n' }
  return { exitCode: 0, stdout: '' }
}

// Stands in for Bash and for the checkout: `repo` answers each command the checkpoint runs, every run
// is recorded as `[command, cwd]` and its time limit in `limits`, the working tree has no .tmp/plan/,
// and the clock stands still. Bash records each command it ran.
function world(on: On, bash: object = RAN) {
  const runs: [string, string | undefined][] = []
  const limits: (number | undefined)[] = []
  const commands: string[] = []
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', () => ({ value: false }))
  on('clock.now', () => ({ value: 1000 }))
  on('process.run', ($, e) => {
    const command = e.argv.join(' ')
    runs.push([command, e.init?.cwd])
    limits.push(e.init?.timeoutMs)
    return { value: { ...repo(command), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    if (e.tool === 'Bash') commands.push(e.command)
    return bash as never
  })
  return { runs, limits, commands }
}

// The folder of each checkpoint: its first command asks git for the checkout's top level there.
const folders = (runs: [string, string | undefined][]) => runs.filter(r => r[0] === 'git rev-parse --show-toplevel').map(r => r[1])

const bash = (command: string) => ({ tool: 'Bash', command }) as const

test('a push that worked runs the checkpoint, then the copy, and tells the model what it did', async ($, on) => {
  const { runs, limits } = world(on)

  const r = await $.tool.call(bash('git push -u origin feat'))

  const edit = runs.findIndex(run => run[0] === 'gh pr edit 7 --body-file -')
  expect(runs[0]).toEqual(['git rev-parse --show-toplevel', '/repo'])
  expect(edit).toBeGreaterThan(0)
  // Then the copy on the remote: git gives it no git dir here, so it stops there.
  expect(runs.slice(edit + 1)).toEqual([['git rev-parse --path-format=absolute --git-dir', '/repo']])
  expect(runs.every(run => run[1] === '/repo')).toBe(true)
  // With the clock standing still, each command may take all of the checkpoint's 60 seconds, and of the copy's 30.
  expect(limits).toEqual(runs.map((run, i) => (i <= edit ? 60_000 : 30_000)))
  expect(r).toEqual({ ...RAN, context: ['waffles checkpoint: Updated the plan outline in #7: https://github.com/o/r/pull/7'] })
})

test('opening a pull request runs the checkpoint', async ($, on) => {
  const { runs } = world(on)

  await $.tool.call(bash('gh pr create --draft --title "Fix it" --body-file /tmp/body.md'))

  expect(folders(runs)).toEqual(['/repo'])
})

test('a push that failed, and a command with no push, run no checkpoint', async ($, on) => {
  const { runs } = world(on, { ...RAN, isError: true })

  await $.tool.call(bash('git push'))
  await $.tool.call(bash('git status'))

  expect(runs).toEqual([])
})

test('a push in another folder runs the checkpoint there', async ($, on) => {
  const { runs } = world(on)

  await $.tool.call(bash('cd ../other && git push'))
  await $.tool.call(bash('git -C "/abs/repo" push'))

  expect(folders(runs)).toEqual(['/repo/../other', '/abs/repo'])
})

test('a merge runs no checkpoint; it only asks gh whether the pull request it names is merged', async ($, on) => {
  const { runs, commands } = world(on)

  // The fake gh reports #7 open, as a merge queue leaves it: its copy stays.
  const r = await $.tool.call(bash('gh pr merge 7 --squash'))

  expect(runs).toEqual([['gh pr view 7 --json state,headRefName,isCrossRepository', '/repo']])
  expect(commands).toEqual(['gh pr merge 7 --squash'])
  expect(r).toEqual(RAN)
})

test('the folder of a command is the one its leading cd or git -C names', () => {
  const home = '/Users/me'
  expect(folderOf('git push', '/repo', true, home)).toBe('/repo')
  expect(folderOf('cd /a/b && git push', '/repo', true, home)).toBe('/a/b')
  expect(folderOf("cd 'sub dir' && gh pr merge 3", '/repo/', false, home)).toBe('/repo/sub dir')
  expect(folderOf('git -C ../x push', '/repo', true, home)).toBe('/repo/../x')
  expect(folderOf('git -C ../x push', '/repo', false, home)).toBe('/repo')
  expect(folderOf('cd ~/Code/r && git push', '/repo', true, home)).toBe('/Users/me/Code/r')
  expect(folderOf('cd ~ && git push', '/repo', true, home)).toBe('/Users/me')
  expect(folderOf('cd ~/Code/r && git push', '/repo', true, undefined)).toBe(null)
  expect(folderOf('cd "$REPO" && git push', '/repo', true, home)).toBe(null)
})

test('a push in a folder named with $ gets no checkpoint and no note', async ($, on) => {
  const { runs, commands } = world(on)

  const r = await $.tool.call(bash('cd $WORK && git push'))

  expect(commands).toEqual(['cd $WORK && git push'])
  expect(runs).toEqual([])
  expect(r).toEqual(RAN)
})

test('a push in a folder under ~ runs the checkpoint in the home folder', async ($, on) => {
  const { runs } = world(on)
  on('env.get', () => ({ value: '/Users/me' }))

  await $.tool.call(bash('cd ~/Code/r && git push'))

  expect(folders(runs)).toEqual(['/Users/me/Code/r'])
})
