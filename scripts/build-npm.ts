// Build the npm package @waffleparty/waffles in dist/. Node.js refuses to run TypeScript under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and an npm install puts the plugin there, so the package holds
// JavaScript: tsc compiles the core, the adapters, and the scripts, and the skills' text names the .js files.
// dist/ is not in git; the release workflow runs this at the release tag, then publishes dist/.
//
// Usage:
//   node scripts/build-npm.ts
//
// The version is the one in .claude-plugin/plugin.json, which semantic-release writes at each release.

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

// Every file under a folder, as paths relative to it.
function files(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
}

// A skill's text with each `name.ts` that tsc compiled renamed to `name.js`, so a model runs the compiled file.
export function renameScripts(text: string, compiled: ReadonlySet<string>): string {
  return text.replace(/\b([\w-]+)\.ts\b/g, (match, name: string) => (compiled.has(name) ? `${name}.js` : match))
}

function build(): void {
  rmSync(DIST, { recursive: true, force: true })
  execFileSync(join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', join(ROOT, 'tsconfig.build.json')], { stdio: 'inherit' })

  const compiled = new Set(files(DIST).filter((path) => path.endsWith('.js')).map((path) => basename(path, '.js')))

  // The skills' text and their other files; their .ts files are compiled already.
  for (const path of files(join(ROOT, 'skills'))) {
    if (path.endsWith('.ts')) continue
    const target = join(DIST, 'skills', path)
    mkdirSync(dirname(target), { recursive: true })
    if (path.endsWith('.md')) writeFileSync(target, renameScripts(readFileSync(join(ROOT, 'skills', path), 'utf8'), compiled))
    else cpSync(join(ROOT, 'skills', path), target)
  }

  // OpenCode compiles the terminal UI part itself, as it does from a clone; it imports the compiled view.
  const tui = readFileSync(join(ROOT, 'adapters', 'opencode', 'tui.tsx'), 'utf8')
  if (!tui.includes("from './view.ts'")) throw new Error("adapters/opencode/tui.tsx no longer imports './view.ts'")
  writeFileSync(join(DIST, 'adapters', 'opencode', 'tui.tsx'), tui.replace("from './view.ts'", "from './view.js'"))

  // The MCP server reads its version from the Claude Code manifest.
  const manifest = join('.claude-plugin', 'plugin.json')
  mkdirSync(join(DIST, '.claude-plugin'))
  cpSync(join(ROOT, manifest), join(DIST, manifest))
  for (const file of ['LICENSE', 'README.md']) cpSync(join(ROOT, file), join(DIST, file))

  const { version, description } = JSON.parse(readFileSync(join(ROOT, manifest), 'utf8')) as { version: string; description: string }
  const pkg = {
    name: '@waffleparty/waffles',
    version,
    description,
    license: 'MIT',
    type: 'module',
    repository: { type: 'git', url: 'git+https://github.com/waffleparty/waffles.git' },
    homepage: 'https://github.com/waffleparty/waffles#readme',
    exports: {
      '.': './adapters/opencode/server.js',
      './tui': './adapters/opencode/tui.tsx',
    },
    engines: { node: '>=22.18' },
  }
  writeFileSync(join(DIST, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

  for (const entry of Object.values(pkg.exports)) {
    if (!existsSync(join(DIST, entry))) throw new Error(`dist/${entry} is missing`)
  }
}

if (import.meta.main) build()
