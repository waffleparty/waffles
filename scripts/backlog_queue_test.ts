// Tests for backlog_queue.ts, with a fake adapter. Run: node --test "scripts/*_test.ts"

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'backlog_queue.ts')

const ITEM = `---
status: new
type: background
kind: task
title: Fix the CORS header
summary: The API refuses the preview origin
depends: []
groomed:
worktree:
dev:
finished:
---

## Request

Fix the CORS header for the preview origin.

## Clarifications

## Progress
`

class Unreachable extends Error {}

class Refused extends Error {}

type Issue = { text: string; actor: unknown; state: string; notes: string[] }
type Data = Record<string, string>
type Call = (step: string, item: string, data: Data, backlog: string) => string

/** A tracker behind an adapter: off, every call is unreachable; on, it keeps issues in memory. */
class FakeAdapter {
  online = false
  issues: Record<string, Issue> = {}
  calls: [string, string][] = []
  call: Call = (step, item, data, backlog) => this.fakeCall(step, item, data, backlog)

  fakeCall(step: string, item: string, data: Data, backlog: string): string {
    if (!this.online) throw new Unreachable('no network')
    this.calls.push([step, item])
    if (step === 'raise') {
      const text = readFileSync(join(backlog, item), 'utf8')
      const key = `ITEM-${Object.keys(this.issues).length + 1}`
      this.issues[key] = { text, actor: data['actor'], state: 'not ready', notes: [] }
      return key
    }
    const issue = this.issues[item]
    if (issue === undefined) throw new Refused(`no issue ${item}`)
    if (step === 'claim') {
      if (issue.state !== 'ready') throw new Refused(`${item} is ${issue.state}, not ready`)
      issue.state = 'in work'
    } else if (step === 'note') {
      issue.notes.push(data['text']!)
    }
    return item
  }
}

type Entry = { seq: number; step: string; item: string; data: Data; why: string; at: string }

function runScript(backlog: string, ...args: string[]) {
  const done = spawnSync(process.execPath, [SCRIPT, ...args, '--backlog', backlog], { encoding: 'utf8' })
  return { returncode: done.status, stdout: done.stdout, stderr: done.stderr }
}

/** What the backlog skills do with an adapter call: replay the queue first, then make the call; queue on unreachable. */
class Waffles {
  backlog: string
  adapter: FakeAdapter
  said: string[] = []

  constructor(backlog: string, adapter: FakeAdapter) {
    this.backlog = backlog
    this.adapter = adapter
  }

  run(...args: string[]) {
    return runScript(this.backlog, ...args)
  }

  queued(): Entry[] {
    const r = this.run('list')
    assert.equal(r.returncode, 0, r.stderr)
    return JSON.parse(r.stdout) as Entry[]
  }

  call(step: string, item: string, data: Data = {}): string | null {
    // The first queued call each time: a replayed raise renames the item in the calls after it.
    for (let queued = this.queued(); queued.length > 0; queued = this.queued()) {
      const entry = queued[0]!
      let answer: string | null
      try {
        answer = this.adapter.call(entry.step, entry.item, entry.data, this.backlog)
      } catch (error) {
        if (error instanceof Unreachable) return this.fallBack(step, item, data, error.message)
        if (!(error instanceof Refused)) throw error
        this.said.push(`refused: ${entry.step} ${entry.item}: ${error.message}`)
        answer = null
      }
      const args = ['done', String(entry.seq)]
      if (entry.step === 'raise' && answer !== null) args.push('--id', answer)
      const r = this.run(...args)
      assert.equal(r.returncode, 0, r.stderr)
      this.said.push(r.stdout.trim())
    }
    try {
      return this.adapter.call(step, item, data, this.backlog)
    } catch (error) {
      if (error instanceof Unreachable) return this.fallBack(step, item, data, error.message)
      throw error
    }
  }

  fallBack(step: string, item: string, data: Data, cause: string): null {
    const r = this.run('add', step, item, '--why', cause, '--data', JSON.stringify(data))
    assert.equal(r.returncode, 0, r.stderr)
    this.said.push(`fell back: ${step} ${item}: ${cause}`)
    return null
  }
}

function git(...args: string[]) {
  const done = spawnSync('git', args, { encoding: 'utf8' })
  assert.equal(done.status, 0, done.stderr)
  return done.stdout
}

describe('the queue', () => {
  let tmp: string
  let backlog: string
  let adapter: FakeAdapter
  let waffles: Waffles

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'backlog-queue-'))
    backlog = join(tmp, '.backlog')
    adapter = new FakeAdapter()
    waffles = new Waffles(backlog, adapter)
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function writeItem(name = 'fix-cors.md'): string {
    mkdirSync(backlog, { recursive: true })
    writeFileSync(join(backlog, name), ITEM)
    return name
  }

  test('with the tracker off an item queues, and with it on it replays and the file is gone', () => {
    const name = writeItem()

    assert.equal(waffles.call('raise', name, { actor: 'agent' }), null)
    assert.equal(waffles.call('note', name, { text: 'Started the spec' }), null)

    assert.deepEqual(adapter.issues, {})
    assert.ok(statSync(join(backlog, name)).isFile())
    const queued = waffles.queued()
    assert.deepEqual(queued.map((e) => [e.step, e.item, e.why]), [['raise', name, 'no network'], ['note', name, 'no network']])
    assert.deepEqual(waffles.said, [`fell back: raise ${name}: no network`, `fell back: note ${name}: no network`])

    adapter.online = true
    adapter.issues['ITEM-100'] = { text: '', actor: 'agent', state: 'ready', notes: [] }
    assert.equal(waffles.call('claim', 'ITEM-100'), 'ITEM-100')

    assert.deepEqual(adapter.calls, [['raise', name], ['note', 'ITEM-2'], ['claim', 'ITEM-100']])
    assert.equal(adapter.issues['ITEM-2']!.text, ITEM)
    assert.equal(adapter.issues['ITEM-2']!.actor, 'agent')
    assert.deepEqual(adapter.issues['ITEM-2']!.notes, ['Started the spec'])
    assert.ok(!existsSync(join(backlog, name)))
    assert.ok(!existsSync(join(backlog, 'queue.json')))
    assert.ok(waffles.said[2]!.includes(`${name} is ITEM-2 in the tracker`))
  })

  test('a call made while the queue waits goes after it, in order', () => {
    waffles.call('note', 'ITEM-7', { text: 'first' })
    waffles.call('note', 'ITEM-7', { text: 'second' })

    const seqs = waffles.queued().map((e) => e.seq)
    assert.ok(seqs[0]! < seqs[1]!)
    assert.deepEqual(waffles.queued().map((e) => e.data['text']), ['first', 'second'])
  })

  test('the replay stops at the first unreachable call and keeps the rest', () => {
    adapter.issues['ITEM-7'] = { text: '', actor: 'agent', state: 'ready', notes: [] }
    waffles.call('note', 'ITEM-7', { text: 'first' })
    waffles.call('note', 'ITEM-7', { text: 'second' })
    adapter.online = true
    const original = adapter.call

    adapter.call = (step, item, data, folder) => {
      adapter.call = () => {
        throw new Unreachable('expired credentials')
      }
      return original(step, item, data, folder)
    }
    waffles.call('note', 'ITEM-7', { text: 'third' })

    assert.deepEqual(adapter.issues['ITEM-7']!.notes, ['first'])
    assert.deepEqual(waffles.queued().map((e) => [e.data['text'], e.why]), [['second', 'no network'], ['third', 'expired credentials']])
  })

  test('a refused call in the replay is reported and not queued again', () => {
    waffles.call('claim', 'ITEM-9')
    adapter.online = true
    adapter.issues['ITEM-9'] = { text: '', actor: 'agent', state: 'in work', notes: [] }

    waffles.call('note', 'ITEM-9', { text: 'hi' })

    assert.deepEqual(waffles.queued(), [])
    assert.ok(waffles.said.includes('refused: claim ITEM-9: ITEM-9 is in work, not ready'))
    assert.deepEqual(adapter.issues['ITEM-9']!.notes, ['hi'])
  })

  test('the folder of a raised item stays, with a note', () => {
    const name = writeItem()
    mkdirSync(join(backlog, 'fix-cors'))
    waffles.call('raise', name, { actor: 'human' })
    adapter.online = true

    waffles.call('note', 'ITEM-1', { text: 'x' })

    assert.ok(statSync(join(backlog, 'fix-cors')).isDirectory())
    assert.ok(waffles.said.some((line) => line.includes('Kept ') && line.includes('fix-cors/')))
  })

  test('a refused raise takes the later calls for its file with it', () => {
    const name = writeItem()
    waffles.call('raise', name, { actor: 'agent' })
    waffles.call('note', name, { text: 'x' })
    waffles.call('note', 'ITEM-50', { text: 'other' })
    adapter.online = true
    adapter.issues['ITEM-50'] = { text: '', actor: 'agent', state: 'ready', notes: [] }
    adapter.call = (step, item, data, folder) => {
      if (step === 'raise') throw new Refused('no project')
      return adapter.fakeCall(step, item, data, folder)
    }

    waffles.call('note', 'ITEM-50', { text: 'now' })

    assert.deepEqual(waffles.queued(), [])
    assert.deepEqual(adapter.issues['ITEM-50']!.notes, ['other', 'now'])
    assert.ok(waffles.said.some((line) => line.includes(`note ${name}, since ${name} was not raised`)))
    assert.ok(statSync(join(backlog, name)).isFile())
  })

  test('a raised item that work started on becomes its record, and dependents name its ID', () => {
    const name = writeItem()
    const path = join(backlog, name)
    writeFileSync(path, readFileSync(path, 'utf8').replace('status: new', 'status: running'))
    const later = join(backlog, 'later.md')
    writeFileSync(later, ITEM.replace('depends: []', `depends: [${name}, other.md]`))
    waffles.call('raise', name, { actor: 'agent' })
    adapter.online = true

    waffles.call('note', 'ITEM-1', { text: 'x' })

    assert.ok(!existsSync(path))
    const record = readFileSync(join(backlog, 'ITEM-1.md'), 'utf8')
    assert.ok(record.startsWith('---\nid: ITEM-1\nstatus: running\n'))
    assert.ok(readFileSync(later, 'utf8').includes('depends: [ITEM-1, other.md]'))
  })

  test('a seq is never used twice, so a stale done removes nothing', () => {
    const first = (JSON.parse(waffles.run('add', 'note', 'ITEM-1', '--why', 'no network', '--data', '{}').stdout) as Entry).seq
    assert.equal(waffles.run('done', String(first)).returncode, 0)
    const second = (JSON.parse(waffles.run('add', 'note', 'ITEM-1', '--why', 'no network', '--data', '{}').stdout) as Entry).seq

    const r = waffles.run('done', String(first))

    assert.ok(second > first)
    assert.equal(r.returncode, 2)
    assert.ok(r.stderr.includes('another session may have replayed it'))
    assert.deepEqual(waffles.queued().map((e) => e.seq), [second])
  })

  test('the queue is kept out of git', () => {
    git('init', '-q', tmp)

    waffles.call('note', 'ITEM-1', { text: 'x' })
    waffles.call('note', 'ITEM-1', { text: 'y' })

    const lines = readFileSync(join(tmp, '.git', 'info', 'exclude'), 'utf8').split('\n')
    assert.equal(lines.filter((line) => line === '/.backlog/queue.json').length, 1)
    assert.equal(git('-C', tmp, 'status', '--porcelain'), '')
  })

  test('the exclude line goes on its own line, and only once', () => {
    git('init', '-q', tmp)
    const exclude = join(tmp, '.git', 'info', 'exclude')
    mkdirSync(dirname(exclude), { recursive: true })
    writeFileSync(exclude, '*.log')

    waffles.call('note', 'ITEM-1', { text: 'x' })
    waffles.call('note', 'ITEM-1', { text: 'y' })

    assert.equal(readFileSync(exclude, 'utf8'), '*.log\n/.backlog/queue.json\n/.backlog/.queue-*\n')
  })

  test('a raised file that cannot be updated says the raise is no longer queued', () => {
    const name = writeItem()
    const later = join(backlog, 'later.md')
    writeFileSync(later, ITEM.replace('depends: []', `depends: [${name}]`))
    chmodSync(later, 0o444)
    const seq = (JSON.parse(waffles.run('add', 'raise', name, '--why', 'no network').stdout) as Entry).seq

    const r = waffles.run('done', String(seq), '--id', 'ITEM-3')
    chmodSync(later, 0o644)

    assert.equal(r.returncode, 1)
    assert.ok(r.stderr.includes(`${name} is ITEM-3 in the tracker, and the queue no longer holds its raise`))
    assert.ok(r.stderr.includes('check the tracker for a duplicate of ITEM-3'))
    assert.deepEqual(waffles.queued(), [])
  })

  test('list with no backlog folder is empty, and makes none', () => {
    assert.deepEqual(waffles.queued(), [])
    assert.ok(!existsSync(backlog))
  })
})

describe('usage', () => {
  let tmp: string
  let backlog: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'backlog-queue-'))
    backlog = join(tmp, '.backlog')
    mkdirSync(backlog)
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('bad arguments exit 2 with the reason', () => {
    const cases: [string[], string][] = [
      [['add', 'pull', 'ITEM-1', '--why', 'x'], 'not a step that writes'],
      [['add', 'raise', 'ITEM-1', '--why', 'x'], 'a raise names the .backlog/ file'],
      [['add', 'note', 'ITEM-1'], '--why must say why'],
      [['add', 'note', '../ITEM-1', '--why', 'x'], 'not an item ID'],
      [['add', 'note', 'ITEM-1', '--why', 'x', '--data', '[1]'], '--data must be a JSON object'],
      [['add', 'note', 'ITEM-1', '--why', 'x', '--data', '{'], '--data is not JSON'],
      [['done', '4'], 'no queued call 4'],
      [['done', '²'], 'done takes the <seq>'],
      [['list', 'extra'], 'list takes no arguments'],
      [['frob'], 'unknown command'],
    ]
    for (const [args, reason] of cases) {
      const r = runScript(backlog, ...args)
      assert.equal(r.returncode, 2, args.join(' '))
      assert.ok(r.stderr.includes(reason), args.join(' '))
    }
  })

  test('a raise of a missing file exits 1', () => {
    const r = runScript(backlog, 'add', 'raise', 'gone.md', '--why', 'no network')

    assert.equal(r.returncode, 1)
    assert.ok(r.stderr.includes('no item file'))
  })

  test('an ID goes with a raise only', () => {
    const added = JSON.parse(runScript(backlog, 'add', 'note', 'ITEM-1', '--why', 'no network', '--data', '{"text": "x"}').stdout) as Entry

    const r = runScript(backlog, 'done', String(added.seq), '--id', 'ITEM-2')

    assert.equal(r.returncode, 2)
    assert.ok(r.stderr.includes('--id goes with a raise'))
  })

  test('a queue file that does not parse exits 1', () => {
    for (const [text, reason] of [['{not json', 'cannot read'], ['[{"step": "note", "item": "ITEM-1"}]', 'does not hold a list']] as const) {
      writeFileSync(join(backlog, 'queue.json'), text)

      const r = runScript(backlog, 'list')

      assert.equal(r.returncode, 1)
      assert.ok(r.stderr.includes(reason))
    }
  })
})
