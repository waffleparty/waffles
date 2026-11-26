import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderInput } from 'claude-code'

import { findDevServers, openUrl, POLL_MS, projectRoot } from '../core/dev-servers.ts'
import { hostOf } from './host'

// Claude Code itself listens on a port from the project dir; lsof names its
// binary by version (`2.1.310`), ps by `claude`.
const SELF = /^(claude|\d+\.\d+\.\d+)$/
const SERVERS = 'dev-servers'

const urls = atom({ plugin: 'waffles', key: 'urls' } as const, [])

function openServers($: EngineInterface, count: number) {
  return $.ui.open({ id: SERVERS, title: 'Dev servers', focus: true, closeOnEscape: true, rows: count + 2 })
}

// The module's one session.start hook calls this: the poll for servers listening from the project.
export async function startDevServers($: EngineInterface) {
  const root = await projectRoot(hostOf($))
  let isPolling = false
  const poll = async () => {
    if (isPolling) return
    isPolling = true
    try {
      const found = await findDevServers(hostOf($), root, command => SELF.test(command))
      const prev = await read($, urls)
      if (found.join() !== prev.join()) await update($, urls, () => found)
    } finally {
      isPolling = false
    }
  }

  void poll()
  $.clock.every(POLL_MS, () => void poll())
}

/** The footer's dev servers' menu, with its text for the plan outline item to measure; null with none running. */
export async function devServersItem($: EngineInterface, e: RenderInput<'SessionMode'>) {
  const list = await read($, urls)
  if (list.length === 0) return null
  const { Button, Text } = $.ui.resolve(e)
  return {
    text: `⎔ ${list.length}`,
    part: (
      <Button key="servers" label={`Dev servers: ${list.length}`} plain onPress={() => openServers($, list.length)}>
        <Text color="success">⎔</Text>
        <Text dimColor> {list.length}</Text>
      </Button>
    ),
  }
}

export function registerDevServers(on: On) {
  // The dev servers' menu: pressing one opens it in the browser.
  on('ui.render', { component: 'Pane', requestId: SERVERS }, async ($, e) => {
    const list = await read($, urls)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {list.length === 0 ? <Text dimColor>No dev servers are running.</Text> : null}
        {list.map((url, i) => (
          <Button
            key={url}
            label={url}
            plain
            hotkey={i < 9 ? String(i + 1) : undefined}
            autoFocus={i === 0 ? true : undefined}
            onPress={async () => {
              await openUrl(hostOf($), url)
              await $.ui.close({ id: SERVERS })
            }}
          />
        ))}
      </Box>
    )
  })

  // /waffles:dev-server answers from the poll while a server is up; with none, or an app named, the skill runs.
  on('command.run', { command: /(^|:)dev-server$/ }, async ($, e, next) => {
    const list = await read($, urls)
    if (list.length === 0 || e.args.trim()) return next(e)
    return { text: `Dev servers running for this project:\n${list.join('\n')}` }
  })
}
