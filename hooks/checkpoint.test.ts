import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { folderOf } from './checkpoint'

const RAN = { result: { stdout: 'pushed', stderr: '' } }

// Stands in for Bash and for the scripts: each script's answer by its file name, and every run
// recorded as `[script, args, cwd]`. Bash records each command it ran.
function world(on: On, answers: Record<string, { exitCode: number; stdout: string }>, bash: object = RAN) {
  const runs: [string, string[], string | undefined][] = []
  const commands: string[] = []
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', ($, e) => {
    const name = (e.argv[2] ?? '').split('/').at(-1) ?? ''
    runs.push([name, e.argv.slice(3), e.init?.cwd])
    const answer = answers[name] ?? { exitCode: 0, stdout: '' }
    return { value: { ...answer, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    if (e.tool === 'Bash') commands.push(e.command)
    return bash as never
  })
  return { runs, commands }
}

const bash = (command: string) => ({ tool: 'Bash', command }) as const

test('a push that worked runs the checkpoint script and tells the model what it did', async ($, on) => {
  const { runs } = world(on, { 'checkpoint.py': { exitCode: 0, stdout: 'Updated the plan outline in #7: https://github.com/o/r/pull/7\n' } })

  const r = await $.tool.call(bash('git push -u origin feat'))

  expect(runs).toEqual([['checkpoint.py', [], '/repo']])
  expect(r).toEqual({ ...RAN, context: ['waffles checkpoint: Updated the plan outline in #7: https://github.com/o/r/pull/7'] })
})

test('opening a pull request runs the checkpoint script', async ($, on) => {
  const { runs } = world(on, {})

  await $.tool.call(bash('gh pr create --draft --title "Fix it" --body-file /tmp/body.md'))

  expect(runs).toEqual([['checkpoint.py', [], '/repo']])
})

test('a push that failed, and a command with no push, run no script', async ($, on) => {
  const { runs } = world(on, {}, { ...RAN, isError: true })

  await $.tool.call(bash('git push'))
  await $.tool.call(bash('git status'))

  expect(runs).toEqual([])
})

test('a push in another folder runs the checkpoint there', async ($, on) => {
  const { runs } = world(on, {})

  await $.tool.call(bash('cd ../other && git push'))
  await $.tool.call(bash('git -C "/abs/repo" push'))

  expect(runs.map(r => r[2])).toEqual(['/repo/../other', '/abs/repo'])
})

test('a merge is refused with the reason while the head branch holds .tmp/', async ($, on) => {
  const reason = 'Refused: the head branch feat of #7 still holds .tmp/, the working files.'
  const { runs, commands } = world(on, { 'merge_guard.py': { exitCode: 3, stdout: `${reason}\n` } })

  const r = await $.tool.call(bash('gh pr merge 7 --squash'))

  expect(runs).toEqual([['merge_guard.py', ['gh pr merge 7 --squash'], '/repo']])
  expect(commands).toEqual([])
  expect(r).toEqual({ deny: reason })
})

test('a merge goes on when the branch has no .tmp/, and with a note when gh could not tell', async ($, on) => {
  const answers = { 'merge_guard.py': { exitCode: 0, stdout: '' } }
  const { commands } = world(on, answers)

  const clean = await $.tool.call(bash('gh pr merge 7 --squash'))
  answers['merge_guard.py'] = { exitCode: 1, stdout: 'gh pr view failed, so waffles could not check the head branch for .tmp/: offline' }
  const unknown = await $.tool.call(bash('gh pr merge 8 --squash'))

  expect(commands).toEqual(['gh pr merge 7 --squash', 'gh pr merge 8 --squash'])
  expect(clean).toEqual(RAN)
  expect(unknown).toEqual({
    ...RAN,
    context: ['waffles did not check the head branch for .tmp/ before this merge: gh pr view failed, so waffles could not check the head branch for .tmp/: offline'],
  })
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
  const { runs, commands } = world(on, {})

  const r = await $.tool.call(bash('cd $WORK && git push'))

  expect(commands).toEqual(['cd $WORK && git push'])
  expect(runs).toEqual([])
  expect(r).toEqual(RAN)
})

test('a push in a folder under ~ runs the checkpoint in the home folder', async ($, on) => {
  const { runs } = world(on, {})
  on('env.get', () => ({ value: '/Users/me' }))

  await $.tool.call(bash('cd ~/Code/r && git push'))

  expect(runs.map(r => r[2])).toEqual(['/Users/me/Code/r'])
})
