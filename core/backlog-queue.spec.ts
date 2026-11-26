import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { nodeHost } from '../adapters/node/host.ts'
import { BACKLOG_QUEUE_TOOL, type Entry } from './backlog-queue.ts'
import { fakeHost } from './testing.ts'
import { TOOLS } from './tools.ts'

const NAMES = { assistant: 'Agent', product: 'Test', planTool: 'plan', ask: 'question', planMode: null }
const ITEM = '---\nstatus: new\ntitle: Fix the CORS header\ndepends: []\n---\n\n## Request\n'

// A session in the main checkout /repo, whose git lists it as the first worktree; the clock at 1 Jan 2026.
const repo = (init: Parameters<typeof fakeHost>[0] = {}) =>
  fakeHost({
    cwd: '/repo/src',
    now: Date.UTC(2026, 0, 1),
    run: argv => {
      if (argv.join(' ') === 'git worktree list --porcelain') return { stdout: 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n' }
      if (argv.join(' ') === 'git rev-parse --git-common-dir') return { stdout: '.git\n' }
      return undefined
    },
    ...init,
  })

const call = async ($: ReturnType<typeof fakeHost>, input: Record<string, unknown>) => BACKLOG_QUEUE_TOOL.call($, input)

test('the backlog queue is one of the core tools', () => {
  assert.ok(TOOLS.includes(BACKLOG_QUEUE_TOOL))
  assert.deepEqual(BACKLOG_QUEUE_TOOL.inputSchema.required, ['op'])
})

test('an input the tool cannot use is refused, and nothing runs', async () => {
  const $ = repo()
  for (const [input, refusal] of [
    [{ op: 'add', step: 'note', item: 'ITEM-1', why: 'x', text: 'hi' }, 'The backlog_queue tool takes op, step, item, why, data, seq, id, backlog, not text.'],
    [{ op: 'pop' }, 'op must be one of add, list, done.'],
    [{ op: 'list', seq: 1 }, 'op list takes op, backlog, not seq.'],
    [{ op: 'done' }, 'seq must be the seq of a queued call.'],
    [{ op: 'add', step: 'note' }, 'add takes the step and the item.'],
    [{ op: 'add', step: 'note', item: 'ITEM-1', why: 'x', data: [1] }, 'data must be a JSON object'],
  ] as const) {
    assert.deepEqual(await call($, input), { refusal }, JSON.stringify(input))
  }
  assert.deepEqual($.ran, [])
  // A refusal by the queue's rules says so.
  assert.deepEqual(await call($, { op: 'add', step: 'note', item: 'ITEM-1' }), { refusal: 'Refused: why must say why the tracker could not be reached' })
})

test('add, list, and done work on the main checkout’s .backlog/, and keep the queue out of git', async () => {
  const $ = repo({ files: { '/repo/.backlog/fix-cors.md': ITEM, '/repo/.backlog/later.md': ITEM.replace('depends: []', 'depends: [fix-cors.md]') } })

  const raise = await call($, { op: 'add', step: 'raise', item: 'fix-cors.md', why: 'no network', data: { actor: 'agent' } })
  const note = await call($, { op: 'add', step: 'note', item: 'fix-cors.md', why: 'no network', data: { text: 'x' } })
  assert.deepEqual(raise, { value: { seq: Date.UTC(2026, 0, 1), step: 'raise', item: 'fix-cors.md', data: { actor: 'agent' }, why: 'no network', at: '2026-01-01T00:00:00Z' } })
  assert.ok('value' in note && (note.value as Entry).seq === Date.UTC(2026, 0, 1) + 1)
  assert.equal($.files.get('/repo/.git/info/exclude'), '/.backlog/queue.json\n/.backlog/.queue-*\n')
  const listed = await call($, { op: 'list' })
  assert.ok('value' in listed)
  assert.deepEqual((listed.value as { entries: Entry[] }).entries.map(e => [e.step, e.item]), [['raise', 'fix-cors.md'], ['note', 'fix-cors.md']])

  const done = await call($, { op: 'done', seq: String(Date.UTC(2026, 0, 1)), id: 'ITEM-2' })
  assert.deepEqual(done, {
    value: {
      removed: [Date.UTC(2026, 0, 1)],
      lines: [`Removed queued call ${Date.UTC(2026, 0, 1)}: raise fix-cors.md.`, 'later.md now depends on ITEM-2.', 'fix-cors.md is ITEM-2 in the tracker; deleted /repo/.backlog/fix-cors.md.'],
    },
  })
  assert.ok(!$.files.has('/repo/.backlog/fix-cors.md'))
  const left = await call($, { op: 'list' })
  assert.deepEqual('value' in left && (left.value as { entries: Entry[] }).entries.map(e => e.item), ['ITEM-2'])
  // A done for a call already replayed removes nothing.
  assert.deepEqual(await call($, { op: 'done', seq: Date.UTC(2026, 0, 1) }), { refusal: `Refused: no queued call ${Date.UTC(2026, 0, 1)}: another session may have replayed it` })
  assert.ok(![...$.files.keys()].some(path => path.includes('.queue-lock')))
})

test('a stale lock is taken over', async () => {
  const $ = repo({ files: { '/repo/.backlog/.queue-lock': '4242\n' } })
  $.advance(16_000)
  const added = await call($, { op: 'add', step: 'claim', item: 'ITEM-9', why: 'no network' })
  assert.ok('value' in added, JSON.stringify(added))
  assert.ok(!$.files.has('/repo/.backlog/.queue-lock'))
})

test('a read works when the folder cannot be written, and a change fails there', async () => {
  const queue = JSON.stringify([{ seq: 1, step: 'note', item: 'ITEM-1', data: {}, why: 'no network', at: '2026-01-01T00:00:00Z' }])
  const $ = repo({ files: { '/repo/.backlog/queue.json': queue }, readOnly: ['/repo/.backlog'] })
  const listed = await call($, { op: 'list', backlog: '/repo/.backlog' })
  assert.deepEqual('value' in listed && (listed.value as { entries: Entry[] }).entries.map(e => e.seq), [1])
  const added = await call($, { op: 'add', step: 'note', item: 'ITEM-1', why: 'x' })
  assert.ok('refusal' in added && added.refusal.startsWith('cannot lock /repo/.backlog: EACCES'), JSON.stringify(added))
  assert.equal($.files.get('/repo/.backlog/queue.json'), queue)
})

test('on Node.js: 2 sessions that add at once lose nothing, and a folder that cannot be written still lists', async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'waffles-queue-')))
  try {
    const backlog = join(root, '.backlog')
    const hosts = ['s1', 's2'].map(sessionId => nodeHost({ sessionId, cwd: root, names: NAMES, stateFolder: join(root, 'state') }))
    const added = await Promise.all(
      Array.from({ length: 10 }, (_, i) => BACKLOG_QUEUE_TOOL.call(hosts[i % 2]!, { op: 'add', step: 'note', item: `ITEM-${i}`, why: 'no network', backlog })),
    )
    assert.ok(added.every(answer => 'value' in answer), JSON.stringify(added))
    const entries = JSON.parse(await fs.readFile(join(backlog, 'queue.json'), 'utf8')) as Entry[]
    assert.deepEqual(entries.map(e => e.item).sort(), Array.from({ length: 10 }, (_, i) => `ITEM-${i}`).sort())
    assert.equal(new Set(entries.map(e => e.seq)).size, 10)
    assert.deepEqual((await fs.readdir(backlog)).sort(), ['queue.json'])

    await fs.chmod(backlog, 0o555)
    try {
      const listed = await BACKLOG_QUEUE_TOOL.call(hosts[0]!, { op: 'list', backlog: '.backlog' })
      assert.equal('value' in listed && (listed.value as { entries: Entry[] }).entries.length, 10)
      const refused = await BACKLOG_QUEUE_TOOL.call(hosts[0]!, { op: 'done', seq: entries[0]!.seq, backlog })
      assert.ok('refusal' in refused && refused.refusal.startsWith(`cannot lock ${backlog}: EACCES`), JSON.stringify(refused))
    } finally {
      await fs.chmod(backlog, 0o755)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
