# Waffles

Skills, agents, and hooks for coding agents. Waffles gives a coding session a backlog and a loop that builds it, a plan outline that survives `/clear` and compaction, modes for careful and for rapid work, and unattended runs that finish a task through pull requests while you are away. One `skills/` folder serves every supported agent; each agent reads its own small manifest.

## Install

| Agent | Command |
| --- | --- |
| Claude Code | `/plugin marketplace add waffleparty/marketplace`, then `/plugin install waffles@waffleparty` |
| OpenCode 2 | `opencode plugin add @waffleparty/waffles`, the npm package. See [OpenCode](docs/opencode.md). |
| Codex | Not in a marketplace yet. Skills, the modes, the plan outline tool, and the checkpoint: see [docs/codex.md](docs/codex.md). |
| Cursor | Not in a marketplace yet. Skills, the modes, the plan outline tool, and the checkpoint: see [docs/cursor.md](docs/cursor.md). For local use, put this repo at `~/.cursor/plugins/local/waffles` and reload the window. |
| Antigravity | Not in a marketplace yet. `agy plugin install https://github.com/waffleparty/waffles`. Skills, the modes, unattended runs, the plan outline tool, and the checkpoint: see [docs/antigravity.md](docs/antigravity.md). |

Skills follow the open Agent Skills format, so they load on any agent that reads it. The logic behind the hooks lives in `core/`, which knows no platform; each platform reaches it through an adapter.

### Features by platform

| Feature | Claude Code | OpenCode 2 | Codex | Cursor | Antigravity |
| --- | --- | --- | --- | --- | --- |
| Skills | Yes | Yes, except `plan` | Yes | Yes | Yes |
| Modes (`/prod`, `/rapid`, `/backlog-entry`) | Yes | Yes | Yes | Yes | Yes |
| Plan outline tool | Yes | Yes | Yes, through the MCP server | Yes, through the MCP server | Yes, through the MCP server |
| Plan outline view | Pane and footer | Panel and footer | No | No | No |
| Pull request checklist after a push | Yes | Yes | Yes | Yes | Yes |
| Unattended runs | Yes | Yes | Where its plugin hooks run | No: a hook can't refuse a permission prompt or a question | Yes |
| Auto effort | Yes | Yes | No | No | No |
| Dev servers menu | Yes | No | No | No | No |
| `waffles:*` agents | Yes | No: its own agents take their place | No | No | No |

Each platform's page states its limits: [OpenCode](docs/opencode.md), [Codex](docs/codex.md), [Cursor](docs/cursor.md), [Antigravity](docs/antigravity.md). The Codex CLI runs a plugin's hooks only from your own hooks file; its page says how. Cursor and Antigravity are built from their documentation and not yet run on a real install. On any other platform only the skills load, and a platform that speaks MCP can add the [MCP server](docs/mcp.md) by hand.

## Requirements

| Requirement | Needed for |
| --- | --- |
| Claude Code 2.1.332 or later, or OpenCode 2 | Claude Code 2.1.332 is the version the hooks are tested with in CI; an earlier one may not load hook modules. The hooks: modes, the plan outline, the checkpoint, unattended runs, and auto effort. The agents and the dev servers pane need Claude Code. |
| `git` | Everything that touches a repo: the plan outline, builders' clones, commit prep. |
| Node.js 22.18 or later, on the model's shell path | What skills still run from the shell: each builder's test runs (`scripts/builders.ts test-slot`, which wraps the test command and holds a test slot while it runs), the wait for a merge queue (a shell loop over `scripts/merge-queue.ts`), and the CI watcher of `/waffles:watch-ci`. Builders, the merge queue, the review branch, the backlog queue, and the checkpoint are tools; their scripts in `scripts/` are the fallback where a platform has no tools, and a person can run them by hand. The MCP server needs Node.js too. All use Node.js built-ins only and run with no build step. |
| `gh`, signed in, and a GitHub remote | The pull request features: the checklist in the pull request description, builders' draft pull requests, the open pull request limit, the review branch, the merge queue check, and `/waffles:watch-ci` for GitHub-hosted CI. |
| `lsof` | The dev servers pane and the ownership check of `/waffles:dev-server`. |

Run `/waffles:init-check` to check the session for these.

## Settings

Nothing needs to be set. Each of these is an environment variable of the agent's process.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WAFFLES_REMOTE` | `origin` | The git remote of your checkout that holds the project's pull requests. Builders clone from it, the review branch fetches from it, and the plan outline is copied to it when the branch names no remote of its own. |
| `WAFFLES_REVIEW_CAP` | Unset: no cap | The open pull requests per repo that may wait for human review. At this count no builder starts. |
| `WAFFLES_MAX_CONCURRENT_TEST_SUITES` | `3` | The builders that may run their test suites at once on this machine. |
| `WAFFLES_TEST_SLOTS` | `/tmp/waffles-test-slots-<uid>` | The folder of the test slots' lock files. |
| `WAFFLES_BUILDERS_ROOT` | `<session scratchpad>/builders` | The folder that holds builders' clones. |

## Skills

Run a skill as `/waffles:<name>`. Claude also runs some of them on its own when your request matches. The ones marked "explicit" run only when you type them.

| Command | Purpose |
| --- | --- |
| `/waffles:backlog <text>` | Split text into backlog items, or adopt a tracker item by ID. |
| `/waffles:backlog-review` | Groom items that are not ready by asking you questions one at a time. Explicit. |
| `/waffles:work-loop` | Build the backlog: background items to builders, the rest with you. Explicit. |
| `/waffles:non-interactive [task]` | Finish a task while you are away, through pull requests. Explicit. |
| `/waffles:commit-prep` | Get pending changes ready to commit and hand you a paste-ready commit command. Explicit. |
| `/waffles:dev-server [app]` | Start the project's dev server as a background task. |
| `/waffles:watch-ci [target]` | Watch the CI/CD runs for the work just pushed, and fix failures. |
| `/waffles:debate [question]` | Argue a decision from several viewpoints and give a verdict. |
| `/waffles:ask [topic or file]` | Put the open items of the conversation to you as multiple-choice questions. |
| `/waffles:ux-review [pages or link]` | Review a web app's UI with before and after mockups you pick from. |
| `/waffles:init-check` | Check that the session has what waffles needs. |
| `/waffles:plan` | Open or close the plan outline pane. Explicit. |
| `/waffles:hello <name>` | Test skill that greets its argument. |

Three commands come from hooks and have no prefix: `/prod`, `/rapid`, and `/backlog-entry` switch modes, and `/auto-effort` turns auto effort on or off.

## Agents

The agents load with the plugin and are available outside the skills that start them. A subagent follows the brief of the agent that started it, and the modes and the plan outline do not apply to it.

| Agent | Model, effort | Purpose |
| --- | --- | --- |
| `waffles:test-runner` | Haiku, low | Run tests, linters, and type checks; report failures. Read-only. |
| `waffles:ci-watcher` | Haiku, low | Wait on CI/CD runs for `watch-ci`; never fixes or approves. |
| `waffles:implementer` | Sonnet, medium | Build a fully specified piece of work. |
| `waffles:implementer-hard` | Opus, high | Build a piece that needs judgment: unknown bugs, multi-file refactors, risky areas. |
| `waffles:reviewer` | Opus, high | Review finished work with fresh eyes. Read-only. |
| `waffles:decider` | Not set, high | Make one hard decision on someone's behalf. Read-only. Started with the most capable model available. |

## Hooks

| Hook | What it adds | Documentation |
| --- | --- | --- |
| Modes | `/prod`, `/rapid`, and `/backlog-entry`, and a statement of the current mode in every conversation. | [Modes](docs/modes.md) |
| Plan outline | The `mcp__waffles__plan` tool, the pane, the footer item, and the pull request checklist. | [Plan outline](docs/plan-outline.md) |
| Tools | `mcp__waffles__merge_queue` (how a pull request merges, and where it stands in its base branch's merge queue), `mcp__waffles__checkpoint` (the plan outline into the pull request), `mcp__waffles__review_branch` (one local branch with every pull request that waits for your review), `mcp__waffles__backlog_queue` (tracker writes held while the tracker cannot be reached), and `mcp__waffles__builders` (builders' clones and the open pull request limit). | [MCP server](docs/mcp.md#what-it-offers) |
| Auto effort | A per-prompt effort pick, and the footer row. | [Modes](docs/modes.md#auto-effort) |
| Checkpoint | After `git push` and `gh pr create`, the plan outline is rendered into the pull request. | [Plan outline](docs/plan-outline.md#the-checklist-in-the-pull-request) |
| Dev servers | A footer item that lists the dev servers running from the project, and opens one in the browser. | [Skills](docs/skills.md#dev-server) |
| Unattended runs | Refuses permission prompts and questions during a run, and holds each turn at Extra high effort. | [Unattended runs](docs/unattended-runs.md) |

## Documentation

- [Backlog](docs/backlog.md): the backlog, grooming, the work loop, the adapter, the initialization check, and the tracker fallback.
- [Modes](docs/modes.md): production, rapid, and backlog mode, mode statements, and auto effort.
- [Plan outline](docs/plan-outline.md): the tree of goals and steps, the pane, and the pull request checklist.
- [Unattended runs](docs/unattended-runs.md): what a run does, what stays with you, and the permissions you grant it.
- [Skills](docs/skills.md): commit prep, dev server, watch CI, debate, ask, and UX review.
- [OpenCode](docs/opencode.md): installing waffles in OpenCode 2, and what works there.

## Layout

```text
waffles/
├── .claude-plugin/plugin.json   Claude Code manifest
├── plugin.json                  Codex manifest, with mcp.json for its MCP server
├── .cursor-plugin/plugin.json   Cursor manifest
├── .antigravity-plugin/plugin.json  Antigravity manifest, with hooks.json and mcp_config.json at the root
├── skills/<name>/SKILL.md       Agent Skills (https://agentskills.io/specification)
├── agents/                      Claude Code subagents
├── core/                        The logic, with no platform imports: plan outline, modes, runs, checkpoint
│   └── tools.ts                 The tools every adapter offers, defined once
├── hooks/                       The Claude Code adapter: hooks, pane, footer, auto effort, dev servers
│   ├── hooks.json               Names the module that registers the hooks
│   └── *.test.ts(x)             Its tests, run by `claude plugin test`
├── adapters/node/               The core's host on plain Node.js
├── adapters/opencode/           The OpenCode 2 adapter: server part and terminal UI part
├── adapters/command/            The adapter for platforms whose hooks run a command per event, with a table per platform
├── adapters/mcp/                The MCP server that offers the plan outline tool and the core's tools
├── scripts/                     Command-line wrappers over the core's tools, test-slot, and their tests (*.spec.ts)
│   ├── bump-version.sh          Writes or checks the version in every manifest
│   └── build-npm.ts             Compiles the npm package into dist/, which is not in git
├── types/                       Type declarations for the hooks
├── docs/                        User documentation
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

When a release is due, `scripts/bump-version.sh` writes the version into every file in `.version-bump.json`. semantic-release then commits those files to `main` as `chore(release): X.Y.Z`, tags that commit `X.Y.Z` (no `v` prefix), and creates the GitHub release. The release workflow then compiles the npm package `@waffleparty/waffles` at the new tag (`npm run build:npm`) and publishes it to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers), with no token secret. A pull request on [waffleparty/marketplace](https://github.com/waffleparty/marketplace) then moves the `waffles` entry to the new tag.

Do not edit `version` fields by hand. To add a file that holds the version, add it to `.version-bump.json` and to the `@semantic-release/git` `assets` in `.releaserc.json`; `scripts/bump-version.sh --check` fails until both lists agree.

## Development

Requirements: Node.js 26.13 or later, `jq`, [Claude Code](https://claude.com/claude-code), and [pre-commit](https://pre-commit.com/).

```sh
npm ci
pre-commit install    # installs the pre-commit and commit-msg hooks
```

The hooks check JSON and YAML, run ShellCheck, require conventional commit messages, and run `scripts/bump-version.sh --check`.

Check a change before you push it:

```sh
claude plugin validate .                                     # the manifests, skills, agents, and hooks
claude plugin test                                           # the Claude Code adapter's tests
npm run typecheck                                            # the core, the adapters, and the scripts
npm run test:node                                            # their tests, on Node.js
npm run build:npm                                            # the npm package, into dist/
claude --plugin-dir .                                        # try the plugin from this checkout
```

Inside a session, `/reload-plugins` picks up changes.

## License

MIT
