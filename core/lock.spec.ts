import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { nodeHost } from '../adapters/node/host.ts'
import { CREATE_SCRIPT } from '../hooks/create.ts'
import { Busy, withLock } from './lock.ts'
import { fakeHost } from './testing.ts'

const NAMES = { assistant: 'Agent', product: 'Test', planTool: 'plan', ask: 'question', planMode: null }
const OPTIONS = { staleMs: 15_000, waitMs: 20_000 }

async function temp(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(join(tmpdir(), 'waffles-lock-')))
}

test('the fake host creates a file once: of 2 creators, 1 wins', async () => {
  const $ = fakeHost()
  assert.deepEqual(await Promise.all([$.fs.create('/a/x.lock', '1'), $.fs.create('/a/x.lock', '2')]), [true, false])
  assert.equal($.files.get('/a/x.lock'), '1')
  // A folder at the path is something there too.
  assert.equal(await $.fs.create('/a', 'x'), false)
})

/** Runs the Claude Code host's create script with the system's sh: its exit code and stderr. */
function create(path: string, text: string): Promise<[number | null, string]> {
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', CREATE_SCRIPT, 'sh', path], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('close', code => resolve([code, stderr]))
    child.stdin.end(text)
  })
}

test('the shell create of the Claude Code host: of 20 at once, 1 writes the file and the rest find it there', async () => {
  const root = await temp()
  try {
    const path = join(root, 'a', 'b', 'x.lock')
    const done = await Promise.all(Array.from({ length: 20 }, (_, i) => create(path, `token ${i}\n`)))
    const codes = done.map(([code]) => code)
    assert.equal(codes.filter(code => code === 0).length, 1, JSON.stringify(done))
    assert.equal(codes.filter(code => code === 3).length, 19, JSON.stringify(done))
    assert.equal(await fs.readFile(path, 'utf8'), `token ${codes.indexOf(0)}\n`)
    // A folder that can't be written: exit 1, with the shell's message.
    await fs.chmod(join(root, 'a', 'b'), 0o555)
    const [code, stderr] = await create(join(root, 'a', 'b', 'y.lock'), 'y')
    await fs.chmod(join(root, 'a', 'b'), 0o755)
    assert.equal(code, 1)
    assert.match(stderr, /denied/i)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('2 writers at once lose nothing', async () => {
  const root = await temp()
  try {
    const hosts = ['s1', 's2'].map(sessionId => nodeHost({ sessionId, cwd: root, names: NAMES, stateFolder: join(root, 'state') }))
    const counter = join(root, 'count')
    await fs.writeFile(counter, '0')
    // Each body reads, waits, and writes back: without the lock, writes would be lost.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        withLock(hosts[i % 2]!, join(root, '.lock'), OPTIONS, async () => {
          const n = Number(await fs.readFile(counter, 'utf8'))
          await new Promise(resolve => setTimeout(resolve, 5))
          await fs.writeFile(counter, String(n + 1))
        }),
      ),
    )
    assert.equal(await fs.readFile(counter, 'utf8'), '12')
    assert.deepEqual(await fs.readdir(root).then(names => names.filter(name => name.startsWith('.lock'))), [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a lock last written more than 15 s ago is taken over at once; a newer one is waited for until it is stale', async () => {
  const $ = fakeHost({ files: { '/b/.lock': '12345\n' }, now: 16_000 })
  let ran = false
  await withLock($, '/b/.lock', OPTIONS, async () => {
    ran = true
    assert.match($.files.get('/b/.lock')!, /^waffles test [a-z0-9]+\n$/)
  })
  assert.ok(ran)
  assert.equal(await $.clock.now(), 16_000)
  assert.ok(!$.files.has('/b/.lock') && !$.files.has('/b/.lock.break'))

  // Held since 16 s: the caller sleeps until it is stale, then takes it.
  await $.fs.write('/b/.lock', 'waffles other x\n')
  await withLock($, '/b/.lock', OPTIONS, async () => undefined)
  assert.ok((await $.clock.now()) > 16_000 + 15_000)
  assert.ok(!$.files.has('/b/.lock'))
})

test('a wait shorter than the stale age ends in Busy, and leaves the lock to its holder', async () => {
  const $ = fakeHost({ files: { '/b/.lock': 'waffles other x\n' } })
  await assert.rejects(withLock($, '/b/.lock', { staleMs: 15_000, waitMs: 1_000 }, async () => assert.fail('ran')), Busy)
  assert.equal($.files.get('/b/.lock'), 'waffles other x\n')
})

test('2 callers that find the same stale lock both run, one after the other, and leave no guard', async () => {
  const $ = fakeHost({ files: { '/b/.lock': 'old\n' }, now: 60_000 })
  const order: string[] = []
  await Promise.all(
    ['a', 'b'].map(name =>
      withLock($, '/b/.lock', OPTIONS, async () => {
        order.push(`${name} in`)
        await $.clock.sleep(10)
        order.push(`${name} out`)
      }),
    ),
  )
  // Either goes first; the second goes in only once the first is out.
  const [first, second] = [order[0]!.at(0), order[2]!.at(0)]
  assert.deepEqual(order, [`${first} in`, `${first} out`, `${second} in`, `${second} out`])
  assert.notEqual(first, second)
  assert.ok(![...$.files.keys()].some(path => path.startsWith('/b/.lock')))
})

test('release leaves a lock that another caller took over', async () => {
  const $ = fakeHost()
  await withLock($, '/b/.lock', OPTIONS, async () => {
    await $.fs.write('/b/.lock', 'waffles other x\n')
  })
  assert.equal($.files.get('/b/.lock'), 'waffles other x\n')
})

test('a lock file that cannot be created rejects with the host’s error, and the body does not run', async () => {
  const $ = fakeHost({ readOnly: ['/b'] })
  await assert.rejects(withLock($, '/b/.lock', OPTIONS, async () => assert.fail('ran')), { code: 'EACCES' })
})
