import type { EngineInterface, On } from 'claude-code'

// A cheap first look at a Bash command; the script reads the checkout properly. A `git push`
// inside quoted text only costs a script run that finds nothing.
const PUSH = /\bgit\s+(?:-C\s+\S+\s+)?push\b/
// Opening the pull request renders the checklist too: the first push found no pull request to update.
const CREATE = /\bgh\s+pr\s+create\b/
// A command that starts `cd <dir> &&`, or a `git -C <dir> push`, runs the push in that folder.
const CD = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*&&/
const DASH_C = /\bgit\s+-C\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s+push\b/

const SCRIPT_MS = 60_000

/**
 * The folder a Bash command runs its push in: the one its leading `cd` or `git -C` names, else
 * the hook's. `~` is the home folder. Null when that can't be told: a path that holds `$`, or `~` with no
 * home folder known.
 */
export function folderOf(command: string, cwd: string, isPush: boolean, home: string | undefined): string | null {
  const named = (isPush ? DASH_C.exec(command) : null) ?? CD.exec(command)
  const dir = named?.[1]?.replace(/^(["'])(.*)\1$/, '$2')
  if (!dir) return cwd
  if (dir.includes('$')) return null
  if (dir === '~' || dir.startsWith('~/')) return home ? `${home.replace(/\/+$/, '')}${dir.slice(1)}` : null
  if (dir.startsWith('/')) return dir
  return `${cwd.replace(/\/+$/, '')}/${dir}`
}

async function script($: EngineInterface, name: string, args: string[], cwd: string) {
  return $.process.run(['python3', '-I', `${$.plugin.root}/scripts/${name}`, ...args], { cwd, timeoutMs: SCRIPT_MS })
}

/**
 * After a `git push` or a `gh pr create` that worked, the checkpoint script renders the plan outline into
 * the pull request's description.
 */
export function registerCheckpoint(on: On) {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    const command = e.command
    if (!PUSH.test(command) && !CREATE.test(command)) return next(e)
    const r = await next(e)
    if (!('result' in r) || r.result === undefined || r.isError) return r
    const cwd = await $.session.cwd()
    const home = await $.env.get('HOME').catch(() => undefined)
    // A push to a folder that can't be told gets no checkpoint: a checkpoint of the wrong checkout could change another pull request.
    const folder = folderOf(command, cwd, true, home)
    if (folder === null) return r
    const done = await script($, 'checkpoint.py', [], folder).catch((error: unknown) => ({
      stdout: `did not run: ${error instanceof Error ? error.message : String(error)}`,
    }))
    const line = done.stdout.trim()
    if (!line) return r
    return { ...r, context: [...(r.context ?? []), `waffles checkpoint: ${line}`] }
    // A hook that fails lets the call go on as it would without waffles.
  }).catch(($, e, next) => next(e))
}
