import type { Host } from './host.ts'

/** How often an adapter with a timer looks for dev servers. */
export const POLL_MS = 5000
const LOOPBACK = new Set(['*', '0.0.0.0', '127.0.0.1', '[::]', '[::1]'])

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

/** The project's folder, with links followed: the checkout's top level, else the working directory. */
export async function projectRoot($: Host): Promise<string> {
  const git = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
  const root = git.exitCode === 0 ? git.stdout.trim() : await $.session.cwd()
  return $.fs.realPath(root)
}

/**
 * The URLs of the servers that listen on a TCP port from a folder in the project, by port. `isSelf` names
 * the commands of the platform's own processes, which listen from the project too.
 */
export async function findDevServers($: Host, root: string, isSelf: (command: string) => boolean): Promise<string[]> {
  const listening = await $.process.run(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'])
  const listeners = parseListeners(listening.stdout).filter(l => !isSelf(l.command))
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

/** Opens a URL in the person's browser: macOS opens one with `open`, Linux desktops with `xdg-open`. */
export async function openUrl($: Host, url: string): Promise<void> {
  const os = await $.process.run(['uname', '-s'])
  await $.process.run([os.stdout.trim() === 'Darwin' ? 'open' : 'xdg-open', url])
}
