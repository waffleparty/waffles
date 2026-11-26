import assert from 'node:assert/strict'
import { test } from 'node:test'

import { absolute, basename, dirname, inside, join, normalize } from './paths.ts'

test('a relative path is made absolute from the folder, without . and .. parts', () => {
  assert.equal(absolute('/work', 'app'), '/work/app')
  assert.equal(absolute('/work/', './app/../lib/'), '/work/lib')
  assert.equal(absolute('/work', '/srv/app'), '/srv/app')
  assert.equal(absolute('/work', '.'), '/work')
  assert.equal(absolute('/', '../..'), '/')
  assert.equal(absolute('C:\\work', 'app'), 'C:\\work\\app')
  assert.equal(absolute('C:\\work', 'D:/app'), 'D:/app')
  assert.equal(normalize('a/../../b'), '../b')
})

test('join, dirname, and basename keep the separator the path has', () => {
  assert.equal(join('/', 'a', 'b/'), '/a/b')
  assert.equal(join('/root/', '/o/', 'r'), '/root/o/r')
  assert.equal(join('C:\\root', 'o'), 'C:\\root\\o')
  assert.equal(dirname('/root/o/r'), '/root/o')
  assert.equal(dirname('/root'), '/')
  assert.equal(dirname('C:\\root'), 'C:\\')
  assert.equal(basename('/root/widget/'), 'widget')
})

test('a path is inside a folder only at a separator', () => {
  assert.ok(inside('/root/a', '/root'))
  assert.ok(inside('/root', '/root/'))
  assert.ok(!inside('/rooted', '/root'))
  assert.ok(inside('/anything', '/'))
  assert.ok(inside('C:\\root\\a', 'C:\\root'))
})
