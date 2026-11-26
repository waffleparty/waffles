// Tests for lock.ts. Run: node --test "scripts/*.spec.ts"

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { alive, lock, tryLock } from './lock.ts'

const LOCK = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'lock.ts')).href

/** Runs a module in another Node process, with lock.ts imported as `lock` and `tryLock`. */
function child(code: string, ...args: string[]) {
  return spawn(process.execPath, ['--input-type=module', '-e', `import { lock, tryLock } from ${JSON.stringify(LOCK)}\n${code}`, ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
}

/** The first line a child process prints. */
function firstLine(process: ReturnType<typeof child>): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    process.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk
      if (out.includes('\n')) resolve(out.split('\n')[0]!)
    })
  })
}

function exited(process: ReturnType<typeof child>): Promise<number | null> {
  return new Promise((resolve) => process.on('close', (code) => resolve(code)))
}

/** A pid that no process has now: one of a process that ended. */
function deadPid(): number {
  const done = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  const pid = Number(done.stdout)
  assert.ok(!alive(pid))
  return pid
}

describe('lock', () => {
  let tmp: string
  let path: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lock-'))
    path = join(tmp, 'x.lock')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('a lock is exclusive until it is released', () => {
    const held = tryLock(path)
    assert.ok(held !== null)
    assert.equal(readFileSync(path, 'utf8'), `${process.pid}\n`)
    assert.equal(tryLock(path), null)
    held.release()
    assert.ok(!existsSync(path))
    const again = tryLock(path)
    assert.ok(again !== null)
    again.release()
  })

  test('a lock that another process holds is not free', async () => {
    const holder = child("const held = tryLock(process.argv[1]); console.log(held ? 'held' : 'free'); setTimeout(() => held.release(), 60_000)", path)
    assert.equal(await firstLine(holder), 'held')
    try {
      assert.equal(tryLock(path), null)
    } finally {
      holder.kill()
      await exited(holder)
    }
  })

  test('the lock of a holder that was killed is taken over', async () => {
    const holder = child("tryLock(process.argv[1]); console.log('held'); setTimeout(() => {}, 60_000)", path)
    assert.equal(await firstLine(holder), 'held')
    holder.kill('SIGKILL')
    await exited(holder)
    assert.ok(existsSync(path))

    const held = tryLock(path)
    assert.ok(held !== null)
    assert.equal(readFileSync(path, 'utf8'), `${process.pid}\n`)
    held.release()
  })

  test('a lock file whose pid no longer runs is stale', () => {
    writeFileSync(path, `${deadPid()}\n`)
    const held = tryLock(path)
    assert.ok(held !== null)
    held.release()
  })

  test('a lock file with no pid is held for a while, then stale', () => {
    writeFileSync(path, '')
    assert.equal(tryLock(path), null)
    const old = Date.now() / 1000 - 60
    utimesSync(path, old, old)
    const held = tryLock(path)
    assert.ok(held !== null)
    held.release()
  })

  test('a running holder is stale past the age the caller names, and only then', () => {
    writeFileSync(path, `${process.ppid}\n`)
    assert.equal(tryLock(path, { staleMs: 30_000 }), null)
    assert.equal(tryLock(path), null)
    const old = Date.now() / 1000 - 60
    utimesSync(path, old, old)
    assert.equal(tryLock(path), null)
    const held = tryLock(path, { staleMs: 30_000 })
    assert.ok(held !== null)
    held.release()
  })

  test('release leaves the lock of a process that took it over', () => {
    const held = tryLock(path)
    assert.ok(held !== null)
    rmSync(path)
    writeFileSync(path, `${process.ppid}\n`)
    held.release()
    assert.equal(readFileSync(path, 'utf8'), `${process.ppid}\n`)
  })

  test('a guard left by a process that died while taking over is cleared', () => {
    writeFileSync(path, `${deadPid()}\n`)
    writeFileSync(`${path}.break`, '')
    assert.equal(tryLock(path), null)
    const old = Date.now() / 1000 - 60
    utimesSync(`${path}.break`, old, old)
    const held = tryLock(path)
    assert.ok(held !== null)
    assert.ok(!existsSync(`${path}.break`))
    held.release()
  })

  test('lock waits for the holder to release it', async () => {
    const holder = child("const held = tryLock(process.argv[1]); console.log('held'); setTimeout(() => held.release(), 400)", path)
    assert.equal(await firstLine(holder), 'held')
    const start = Date.now()
    const held = lock(path)
    assert.ok(Date.now() - start >= 200)
    held.release()
    await exited(holder)
  })

  test('processes that count under the lock never lose a count', async () => {
    const counter = join(tmp, 'count')
    writeFileSync(counter, '0')
    const code = `
      import { readFileSync, writeFileSync } from 'node:fs'
      for (let i = 0; i < 25; i++) {
        const held = lock(process.argv[1])
        const n = Number(readFileSync(process.argv[2], 'utf8'))
        writeFileSync(process.argv[2], String(n + 1))
        held.release()
      }
      console.log('done')`
    const runs = Array.from({ length: 6 }, () => child(code, path, counter))
    assert.deepEqual(await Promise.all(runs.map(exited)), [0, 0, 0, 0, 0, 0])
    assert.equal(readFileSync(counter, 'utf8'), '150')
  })
})
