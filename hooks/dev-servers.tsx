import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderInput } from 'claude-code'

const POLL_MS = 5000
// Claude Code itself listens on a port from the project dir; lsof names its
// binary by version (`2.1.310`), ps by `claude`.
const SELF = /^(claude|\d+\.\d+\.\d+)$/
const LOOPBACK = new Set(['*', '0.0.0.0', '127.0.0.1', '[::]', '[::1]'])
const SERVERS = 'dev-servers'

const urls = atom({ plugin: 'waffles', key: 'urls' } as const, [])

function openServers($: EngineInterface, count: number) {
  return $.ui.open({ id: SERVERS, title: 'Dev servers', focus: true, closeOnEscape: true, rows: count + 2 })
}

type Listener = { pid: string; command: string; host: string; port: number }

// `lsof -F` prints one field per line, each led by its letter: p(id),
// c(ommand), f(d), n(ame).
function parseListeners(out: string): Listener[] {
  const found: Listener[] = []
  let pid = ''
  let command = ''
  for (const line of out.split('\n')) {
    const field = line.slice(1)
    if (line[0] === 'p') pid = field
    else if (line[0] === 'c') command = field
    else if (line[0] === 'n') {
      const at = field.lastIndexOf(':')
      const port = Number(field.slice(at + 1))
      if (at > 0 && Number.isInteger(port)) {
        found.push({ pid, command, host: field.slice(0, at), port })
      }
    }
  }
  return found
}

function parseCwds(out: string): Map<string, string> {
  const cwds = new Map<string, string>()
  let pid = ''
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = line.slice(1)
    else if (line[0] === 'n') cwds.set(pid, line.slice(1))
  }
  return cwds
}

async function projectRoot($: EngineInterface): Promise<string> {
  const git = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
  const root = git.exitCode === 0 ? git.stdout.trim() : await $.session.cwd()
  const { realPath } = await $.fs.stat(root, { resolve: true })
  return realPath ?? root
}

async function findDevServers($: EngineInterface, root: string): Promise<string[]> {
  const listening = await $.process.run(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'])
  const listeners = parseListeners(listening.stdout).filter(l => !SELF.test(l.command))
  const pids = [...new Set(listeners.map(l => l.pid))]
  if (pids.length === 0) return []

  const open = await $.process.run(['lsof', '-a', '-d', 'cwd', '-p', pids.join(','), '-Fn'])
  const cwds = parseCwds(open.stdout)
  const inProject = (pid: string) => {
    const cwd = cwds.get(pid)
    return cwd !== undefined && (cwd === root || cwd.startsWith(`${root}/`))
  }

  const found = new Set<string>()
  for (const l of listeners.filter(l => inProject(l.pid)).sort((a, b) => a.port - b.port)) {
    const host = LOOPBACK.has(l.host) ? 'localhost' : l.host
    found.add(`http://${host}:${l.port}`)
  }
  return [...found]
}

// The module's one session.start hook calls this: the poll for servers listening from the project.
export async function startDevServers($: EngineInterface) {
  const root = await projectRoot($)
  let isPolling = false
  const poll = async () => {
    if (isPolling) return
    isPolling = true
    try {
      const found = await findDevServers($, root)
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
              // macOS opens a URL with `open`, Linux desktops with `xdg-open`.
              const os = await $.process.run(['uname', '-s'])
              await $.process.run([os.stdout.trim() === 'Darwin' ? 'open' : 'xdg-open', url])
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
