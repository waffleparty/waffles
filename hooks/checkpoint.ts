import type { On } from 'claude-code'

import { afterShell, folderOf, isPushLike } from '../core/checkpoint.ts'
import { hostOf } from './host'

export { folderOf }

/**
 * After a `git push` or a `gh pr create` that worked, the checkpoint renders the plan outline into
 * the pull request's description.
 */
export function registerCheckpoint(on: On) {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    const command = e.command
    if (!isPushLike(command)) return next(e)
    const r = await next(e)
    if (!('result' in r) || r.result === undefined || r.isError) return r
    const line = await afterShell(hostOf($), command)
    return line === null ? r : { ...r, context: [...(r.context ?? []), line] }
    // A hook that fails lets the call go on as it would without waffles.
  }).catch(($, e, next) => next(e))
}
