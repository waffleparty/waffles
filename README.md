# Waffles

Skills, agents, and hooks for coding agents. One `skills/` folder serves every supported agent; each agent reads its own small manifest.

## Install

| Agent | Command |
| --- | --- |
| Claude Code | `/plugin marketplace add waffleparty/marketplace`, then `/plugin install waffles@waffleparty` |
| Codex | Not in a marketplace yet. |
| Cursor | Not in a marketplace yet. For local use, link this repo to `~/.cursor/plugins/local/waffles` and reload the window. |

## Layout

```text
waffles/
├── .claude-plugin/plugin.json   Claude Code manifest
├── .codex-plugin/plugin.json    Codex manifest
├── .cursor-plugin/plugin.json   Cursor manifest
├── skills/<name>/SKILL.md       Agent Skills (https://agentskills.io/specification)
├── agents/                      Claude Code subagents
├── scripts/bump-version.sh      Writes or checks the version in every manifest
└── .version-bump.json           The files and fields that hold the version
```

Skills follow the open Agent Skills format, so they work in any agent that reads it. Agents and hooks are specific to each agent.

## Versions and releases

Releases are automatic. On each push to `main`, [semantic-release](https://semantic-release.gitbook.io/) reads the [conventional commit](https://www.conventionalcommits.org/) messages since the last release:

| Commit type | Release |
| --- | --- |
| `fix:`, `perf:`, `revert:` | Patch |
| `feat:` | Minor |
| `!` after the type, or a `BREAKING CHANGE:` footer | Major |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:`, `style:`, `build:` | None |

When a release is due, `scripts/bump-version.sh` writes the version into every file in `.version-bump.json`. semantic-release then commits those files to `main` as `chore(release): X.Y.Z`, tags that commit `X.Y.Z` (no `v` prefix), and creates the GitHub release. A pull request on [waffleparty/marketplace](https://github.com/waffleparty/marketplace) then moves the `waffles` entry to the new tag.

Do not edit `version` fields by hand. To add a file that holds the version, add it to `.version-bump.json` and to the `@semantic-release/git` `assets` in `.releaserc.json`; `scripts/bump-version.sh --check` fails until both lists agree.

## Development

Requirements: Node.js 26.13 or later, `jq`, and [pre-commit](https://pre-commit.com/).

```sh
npm ci
pre-commit install    # installs the pre-commit and commit-msg hooks
```

The hooks check JSON and YAML, run ShellCheck, require conventional commit messages, and run `scripts/bump-version.sh --check`.

## License

MIT
