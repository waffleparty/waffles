// Tests for pycompat.ts. Each expected value is what Python 3.12 gives for the same input. Run: node --test "scripts/*.spec.ts"

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { describe, test } from 'node:test'

import { commonpath, decodeUtf8, dumps, floatRepr, join, loads, osErrorText, pyInt, realpath, repr, splitlines, strip, type PyValue } from './pycompat.ts'

function error(run: () => unknown): string {
  try {
    run()
  } catch (e) {
    return (e as Error).message
  }
  return 'no error'
}

describe('json', () => {
  test('loads keeps ints exact, floats as floats, and the order of keys', () => {
    const value = loads('{"b": 1, "10": 1.0, "a": [123456789012345678901234567890, -0.0, 1e400, NaN]}')
    assert.equal(dumps(value), '{"b": 1, "10": 1.0, "a": [123456789012345678901234567890, -0.0, Infinity, NaN]}')
  })

  test('loads fails with the message and position json.loads gives', () => {
    const cases: [string, string][] = [
      ['', 'Expecting value: line 1 column 1 (char 0)'],
      ['[', 'Expecting value: line 1 column 2 (char 1)'],
      ['[1,]', 'Expecting value: line 1 column 4 (char 3)'],
      ['[1 2]', "Expecting ',' delimiter: line 1 column 4 (char 3)"],
      ['{', 'Expecting property name enclosed in double quotes: line 1 column 2 (char 1)'],
      ['{"a"', "Expecting ':' delimiter: line 1 column 5 (char 4)"],
      ['{"a":1,}', 'Expecting property name enclosed in double quotes: line 1 column 8 (char 7)'],
      ['"abc', 'Unterminated string starting at: line 1 column 1 (char 0)'],
      ['"a\\x"', 'Invalid \\escape: line 1 column 3 (char 2)'],
      ['"\\u12"', 'Invalid \\uXXXX escape: line 1 column 3 (char 2)'],
      ['"\\ud800\\u12"', 'Invalid \\uXXXX escape: line 1 column 9 (char 8)'],
      ['"a\x01"', 'Invalid control character at: line 1 column 3 (char 2)'],
      ['1 2', 'Extra data: line 1 column 3 (char 2)'],
      ['\n\n  x', 'Expecting value: line 3 column 3 (char 4)'],
      ['\ufeff1', 'Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)'],
      ['["😀", x]', 'Expecting value: line 1 column 7 (char 6)'],
    ]
    for (const [text, message] of cases) assert.equal(error(() => loads(text)), message, text)
  })

  test('dumps writes what json.dumps writes, on 1 line and indented', () => {
    const value = loads('{"a": [1, {}], "b": [], "c": "é\x7f😀\\u2028\\"\\\\/\\n"}')
    assert.equal(dumps(value), '{"a": [1, {}], "b": [], "c": "\\u00e9\\u007f\\ud83d\\ude00\\u2028\\"\\\\/\\n"}')
    assert.equal(dumps(value, 2), '{\n  "a": [\n    1,\n    {}\n  ],\n  "b": [],\n  "c": "\\u00e9\\u007f\\ud83d\\ude00\\u2028\\"\\\\/\\n"\n}')
  })

  test('floats read as Python writes them', () => {
    const cases: [number, string][] = [[1e16, '1e+16'], [1e15, '1000000000000000.0'], [0.0001, '0.0001'], [0.00001, '1e-05'], [100, '100.0'],
      [-0, '-0.0'], [1.5e-7, '1.5e-07'], [123.456, '123.456'], [1e22, '1e+22'], [Infinity, 'inf'], [NaN, 'nan']]
    for (const [x, text] of cases) assert.equal(floatRepr(x), text)
  })
})

describe('text', () => {
  test('repr quotes and escapes as Python does', () => {
    const cases: [PyValue, string][] = [
      ["it's", '"it\'s"'],
      ['a\'b"c', "'a\\'b\"c'"],
      ['tab\there\n\x00\x7f', "'tab\\there\\n\\x00\\x7f'"],
      ['é \u200b', "'é \\u200b'"],
      [null, 'None'],
      [true, 'True'],
      [loads('[1, 1.0, {"a": null}]'), "[1, 1.0, {'a': None}]"],
    ]
    for (const [value, text] of cases) assert.equal(repr(value), text)
  })

  test('a strict UTF-8 decode fails as Python names the bytes', () => {
    assert.equal(error(() => decodeUtf8(Buffer.from([0xff, 0x41]))), "'utf-8' codec can't decode byte 0xff in position 0: invalid start byte")
    assert.equal(error(() => decodeUtf8(Buffer.from([0x41, 0xe2, 0x82]))), "'utf-8' codec can't decode bytes in position 1-2: unexpected end of data")
    assert.equal(error(() => decodeUtf8(Buffer.from([0xe2, 0x82, 0x41]))), "'utf-8' codec can't decode bytes in position 0-1: invalid continuation byte")
    assert.equal(error(() => decodeUtf8(Buffer.from([0xed, 0xa0, 0x80]))), "'utf-8' codec can't decode byte 0xed in position 0: invalid continuation byte")
    assert.equal(decodeUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x31])), '\ufeff1')
  })

  test('int, strip, and splitlines take what Python takes', () => {
    assert.deepEqual(['1', ' +1 ', '1_0', '١٢', '-007', '1__0', '0x1', '', '\x1c5'].map(pyInt), [1n, 1n, 10n, 12n, -7n, null, null, null, null])
    assert.equal(strip('\x1c a \x85'), 'a')
    assert.equal(strip('-.a.-', '-.'), 'a')
    assert.deepEqual(splitlines('a\r\nb\rc\x0bd\n\n'), ['a', 'b', 'c', 'd', ''])
  })

  test('an OSError reads as Python prints it', () => {
    const missing = Object.assign(new Error('x'), { code: 'ENOENT', errno: -2, path: "/a/it's" })
    assert.equal(osErrorText(missing), '[Errno 2] No such file or directory: "/a/it\'s"')
    const renamed = Object.assign(new Error('x'), { code: 'EACCES', errno: -13, path: '/a', dest: '/b' })
    assert.equal(osErrorText(renamed), "[Errno 13] Permission denied: '/a' -> '/b'")
  })
})

describe('os.path', () => {
  test('join starts again at an absolute part, and normalizes nothing', () => {
    assert.equal(join('/a', 'b/', 'c'), '/a/b/c')
    assert.equal(join('/a', '/b', '..'), '/b/..')
  })

  test('realpath resolves each link in turn, and keeps the parts that do not exist', () => {
    const tmp = realpathSync(mkdtempSync(pathJoin(tmpdir(), 'pycompat-')))
    try {
      mkdirSync(pathJoin(tmp, 'real', 'deep'), { recursive: true })
      symlinkSync(pathJoin(tmp, 'real', 'deep'), pathJoin(tmp, 'link'))
      assert.equal(realpath(`${tmp}/link/../x/y`), pathJoin(tmp, 'real', 'x', 'y'))
      assert.equal(realpath(`${tmp}/./gone/../still/`), pathJoin(tmp, 'still'))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('commonpath compares whole parts', () => {
    assert.equal(commonpath('/a/bc', '/a/b'), '/a')
    assert.equal(commonpath('/a/b/c', '/a/b'), '/a/b')
    assert.equal(commonpath('/x', '/y'), '/')
  })
})
