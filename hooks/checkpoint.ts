import type { EngineInterface, On } from 'claude-code'

// A cheap first look at a Bash command; the scripts read it properly. A `git push` or `gh pr merge`
// inside quoted text only costs a script run that finds nothing.
const PUSH = /\bgit\s+(?:-C\s+\S+\s+)?push\b/
// Opening the pull request renders the checklist too: the first push found no pull request to update.
const CREATE = /\bgh\s+pr\s+create\b/
const MERGE = /\bgh\s+pr\s+merge\b/
// A command that starts `cd <dir> &&`, or a `git -C <dir> push`, runs the push in that folder.
const CD = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*&&/
const DASH_C = /\bgit\s+-C\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s+push\b/

const SCRIPT_MS = 60_000
const REFUSED = 3

/**
 * The folder a Bash command runs its push or merge in: the one its leading `cd` or `git -C` names, else
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
 * the pull request's description. Before a `gh pr merge`, the merge guard refuses it while the head branch still holds
 * `.tmp/`: in a repo with no CI check that fails on `.tmp/`, this hook is what stops working files from
 * reaching the default branch. When gh can't tell, the merge goes on, with the reason in its context.
 */
export function registerCheckpoint(on: On) {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    const command = e.command
    const isCheckpoint = PUSH.test(command) || CREATE.test(command)
    const isMerge = MERGE.test(command)
    if (!isCheckpoint && !isMerge) return next(e)
    const cwd = await $.session.cwd()
    const home = await $.env.get('HOME').catch(() => undefined)
    const notes: string[] = []
    if (isMerge) {
      // gh finds a pull request named by number or URL from any folder: one that can't be told is the hook's.
      const guard = await script($, 'merge_guard.py', [command], folderOf(command, cwd, false, home) ?? cwd).catch((error: unknown) => ({
        exitCode: 1,
        stdout: `the merge guard did not run: ${error instanceof Error ? error.message : String(error)}`,
      }))
      if (guard.exitCode === REFUSED) return { deny: guard.stdout.trim() }
      if (guard.exitCode !== 0) notes.push(`waffles did not check the head branch for .tmp/ before this merge: ${guard.stdout.trim()}`)
    }
    const r = await next(e)
    // A push to a folder that can't be told gets no checkpoint: a checkpoint of the wrong checkout could change another pull request.
    const folder = isCheckpoint ? folderOf(command, cwd, true, home) : null
    if (folder !== null && 'result' in r && r.result !== undefined && !r.isError) {
      const done = await script($, 'checkpoint.py', [], folder).catch((error: unknown) => ({
        stdout: `did not run: ${error instanceof Error ? error.message : String(error)}`,
      }))
      const line = done.stdout.trim()
      if (line) notes.push(`waffles checkpoint: ${line}`)
    }
    if (!notes.length || !('result' in r) || r.result === undefined) return r
    return { ...r, context: [...(r.context ?? []), ...notes] }
    // A hook that fails lets the call go on as it would without waffles.
  }).catch(($, e, next) => next(e))
}
