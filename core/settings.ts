import type { Host } from './host.ts'

/*
 * What a person sets for every session through the environment the platform runs in. Nothing needs to be set.
 *
 *   WAFFLES_REMOTE      the git remote of the main checkout that holds the project's pull requests: `origin`.
 *   WAFFLES_REVIEW_CAP  the open pull requests per repo that may wait for human review before no builder starts:
 *                       unset, so there is no cap.
 *
 * WAFFLES_BUILDERS_ROOT (core/builders.ts) and the test slots' variables (scripts/builders.ts) are read where they
 * are used.
 */

export const DEFAULT_REMOTE = 'origin'

// A remote's name goes into git's arguments and into ref names: one that starts with `-` would read as an option.
const REMOTE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

/** The remote of the main checkout: $WAFFLES_REMOTE, else origin. A value that is no remote's name is not used, and logged. */
export async function remoteName($: Pick<Host, 'env' | 'log'>): Promise<string> {
  const set = (await $.env('WAFFLES_REMOTE'))?.trim()
  if (!set) return DEFAULT_REMOTE
  if (REMOTE_NAME.test(set)) return set
  $.log(`WAFFLES_REMOTE is ${JSON.stringify(set)}, which names no git remote: ${DEFAULT_REMOTE} is used.`)
  return DEFAULT_REMOTE
}

/** The cap on pull requests that wait for review: $WAFFLES_REVIEW_CAP; null, for no cap, when it is unset. A value that is no count from 1 up is not used, and logged. */
export async function reviewCap($: Pick<Host, 'env' | 'log'>): Promise<number | null> {
  const set = (await $.env('WAFFLES_REVIEW_CAP'))?.trim()
  if (!set) return null
  if (/^[1-9][0-9]*$/.test(set)) return Number(set)
  $.log(`WAFFLES_REVIEW_CAP is ${JSON.stringify(set)}, which is no count from 1 up: no cap is used.`)
  return null
}
