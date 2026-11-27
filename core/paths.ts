/*
 * Paths as the core handles them, with no platform's path module. Parts are joined with `/`, which every
 * platform takes; a Windows path that holds only `\` (`C:\work`, as Node.js gives it there) keeps `\`, so a
 * path made from it compares equal to the platform's own.
 */

const DRIVE = /^[A-Za-z]:[\\/]|^\\\\/

export const isAbsolute = (path: string) => path.startsWith('/') || DRIVE.test(path)

const sepOf = (path: string) => (DRIVE.test(path) && !path.includes('/') ? '\\' : '/')

// The path less its separators at the end, except the root's own.
const trim = (path: string) => path.replace(/(?<=[^\\/:])[\\/]+$/, '')

/** The parts after the first, each without the separators at its ends, joined to the first. */
export function join(base: string, ...parts: string[]): string {
  const sep = sepOf(base)
  const rest = parts.map(part => part.replace(/^[\\/]+|[\\/]+$/g, '')).filter(Boolean)
  const head = trim(base)
  return rest.length ? `${head}${/[\\/]$/.test(head) ? '' : sep}${rest.join(sep)}` : head
}

/** The path without `.` and `..` parts; `..` at the root stays at the root. */
export function normalize(path: string): string {
  const sep = sepOf(path)
  const [, root = ''] = /^([A-Za-z]:[\\/]|\\\\|\/)?/.exec(path) ?? []
  const parts: string[] = []
  for (const part of path.slice(root.length).split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop()
    else if (part !== '..' || !root) parts.push(part)
  }
  return `${root}${parts.join(sep)}` || '.'
}

/** The path, from `cwd` when it is relative, with no `.` or `..` parts. */
export const absolute = (cwd: string, path: string) => normalize(isAbsolute(path) ? path : join(cwd, path))

/** The folder that holds the path: the path itself for a root. */
export function dirname(path: string): string {
  const full = trim(path)
  const at = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'))
  if (at < 0) return '.'
  const parent = full.slice(0, at)
  return parent === '' || /^[A-Za-z]:$/.test(parent) ? full.slice(0, at + 1) : parent
}

/** The last part of the path. */
export const basename = (path: string) => trim(path).split(/[\\/]/).at(-1) ?? ''

/** Whether the path is the folder or inside it. Both are compared as they are spelled: pass real paths. */
export function inside(path: string, folder: string): boolean {
  const head = trim(folder)
  return path === head || path.startsWith(/[\\/]$/.test(head) ? head : `${head}${sepOf(head)}`)
}
