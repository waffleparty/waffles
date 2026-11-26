import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { delimiter, join } from 'node:path'
import { after, test } from 'node:test'

import { MERGE_QUEUE_TOOL } from '../../core/merge-queue.ts'
import { TOOLS } from '../../core/tools.ts'
import { folders, LIMIT, META, server, stopAll, text } from './testing.ts'

after(stopAll)

// A gh that answers pull request 12 of o/r as merged, and fails every other call.
const GH = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'pr' && args[1] === 'view') {
  console.log(JSON.stringify({ number: 12, url: 'https://github.com/o/r/pull/12', baseRefName: 'main', reviewDecision: '' }))
} else if (args[0] === 'api' && args[1] === 'graphql') {
  console.log(JSON.stringify({ data: { repository: { pullRequest: { state: 'MERGED', merged: true, isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null, timelineItems: { nodes: [] } } } } }))
} else {
  console.error('gh: HTTP 502')
  process.exit(1)
}
`

async function withGh() {
  const { root, work, state } = await folders()
  const bin = join(root, 'bin')
  await fs.mkdir(bin)
  await fs.writeFile(join(bin, 'gh'), GH, { mode: 0o755 })
  return server(work, state, { PATH: `${bin}${delimiter}${process.env.PATH}` })
}

test('every core tool is listed with its schemas and hints', LIMIT, async () => {
  const s = await withGh()
  const list = await s.request('tools/list', { _meta: META })
  for (const tool of TOOLS) {
    const listed = list.result.tools.find((t: { name: string }) => t.name === tool.name)
    // A tool with no output schema is listed without one.
    const output = tool.outputSchema ? { outputSchema: tool.outputSchema } : {}
    assert.deepEqual(listed, { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, ...output, annotations: tool.annotations })
  }
  assert.ok(list.result.tools.some((t: { name: string }) => t.name === MERGE_QUEUE_TOOL.name))
  await s.close()
})

test('the merge queue answers with a structured value, and a failure of gh is a tool error with its message', LIMIT, async () => {
  const s = await withGh()
  const merged = await s.request('tools/call', { _meta: META, name: 'merge_queue', arguments: { op: 'state', pr: '12' } })
  assert.equal(merged.result.isError, false)
  assert.deepEqual(merged.result.structuredContent, { state: 'merged', number: 12 })
  assert.deepEqual(JSON.parse(text(merged)), { state: 'merged', number: 12 })

  const down = await s.request('tools/call', { _meta: META, name: 'merge_queue', arguments: { op: 'mode', pr: '12' } })
  assert.equal(down.result.isError, true)
  assert.equal(text(down), 'gh api rules/branches/main failed: gh: HTTP 502')

  const wrong = await s.request('tools/call', { _meta: META, name: 'merge_queue', arguments: { op: 'merge', pr: '12' } })
  assert.equal(wrong.result.isError, true)
  assert.equal(text(wrong), 'op must be one of mode, state.')
  assert.equal(merged.result.resultType, 'complete')
  await s.close()
})

test('the backlog queue adds and lists in the folder it is given, from the session’s folder', LIMIT, async () => {
  const { work, state } = await folders()
  const s = server(work, state)
  const added = await s.request('tools/call', { _meta: META, name: 'backlog_queue', arguments: { op: 'add', step: 'note', item: 'ITEM-1', why: 'no network', backlog: '.backlog' } })
  assert.equal(added.result.isError, false, text(added))
  assert.equal(added.result.structuredContent.item, 'ITEM-1')
  const listed = await s.request('tools/call', { _meta: META, name: 'backlog_queue', arguments: { op: 'list', backlog: join(work, '.backlog') } })
  assert.deepEqual(listed.result.structuredContent.entries.map((e: { item: string }) => e.item), ['ITEM-1'])
  assert.deepEqual(await fs.readdir(join(work, '.backlog')), ['queue.json'])
  await s.close()
})
