import type { EngineInterface } from 'claude-code'

// The line a repo names its backlog adapter with, in its AGENTS.md or, with none, its CLAUDE.md:
// `Backlog adapter: <skill>`, the name with or without backticks. skills/backlog/adapter.md defines it.
const LINE = /^Backlog adapter:[ \t]*`?([A-Za-z0-9][\w.:-]*)`?[ \t]*$/m
const FILES = ['AGENTS.md', 'CLAUDE.md']

/** The skill the checkout names as its backlog adapter, and the file that names it; null when none does. */
export async function namedAdapter($: EngineInterface): Promise<{ skill: string; file: string } | null> {
  const git = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
  const root = git.exitCode === 0 ? git.stdout.trim() : await $.session.cwd()
  for (const file of FILES) {
    const path = `${root}/${file}`
    if (!(await $.fs.exists(path))) continue
    const skill = LINE.exec(await $.fs.read(path))?.[1]
    // A repo with an AGENTS.md names its adapter there; CLAUDE.md counts only when there is none.
    return skill ? { skill, file } : null
  }
  return null
}

/**
 * The first message's block in a checkout that names a backlog adapter: it asks for the waffles initialization
 * check before the first task. Empty with no adapter named, and when the files can't be read: a repo with
 * no tracker starts as it did before.
 */
export async function adapterContext($: EngineInterface): Promise<string> {
  const named = await namedAdapter($).catch(() => null)
  if (!named) return ''
  return `backlog adapter: this repo names \`${named.skill}\` in ${named.file}. Before the first task in this conversation, run the waffles:init-check skill, unless it already ran in this conversation. Its failures never stop the work.`
}
