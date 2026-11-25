---
name: init-check
description: Check that a session has what waffles needs — the superpowers plugin at the version waffles' layer was written for, gh signed in, the backlog adapter skill the repo names, and its spec check skill — then run the repo's own check list when it has one, and say which waffles steps fall back to .backlog/ files and why. Use at the start of a session in a repo whose AGENTS.md or CLAUDE.md names a backlog adapter (the first message says so), and when asked to check that waffles' tools are set up.
---

# Initialization check

Check what waffles needs in this session, then run the repo's own check list, and
report each result. waffles ships none of those checks: the repo's or team's own
checks live in a skill of their own, which this skill runs.

Run every check, in the order below. Each check reports exactly 1 result:

- **pass**: what was checked and what was found.
- **fail**: what is wrong, the fix, and what it affects.
- **could not check**: why, such as a command that cannot reach the network,
  or a check that depends on one that failed.

A failure never stops the session. Report it, and go on with the task. The
check changes nothing: it reads, and names a fix for the person to run.

## 1. superpowers

waffles' spec and plan layer is written for superpowers **7.0.2**. Run
`claude plugin list --json` and find the entries whose `id` starts with
`superpowers@`.

- **pass**: an entry is `enabled` at version `7.0.2`.
- **fail**, when no entry is there or none is enabled: superpowers is not
  installed in this session. Fix: `claude plugin install superpowers@claude-plugins-official`,
  then start a new session.
- **fail**, when the enabled entry has another version: say "superpowers
  `<version>` is installed; waffles' layer was written for 7.0.2". An update can
  move an approval point or a next-step sentence that waffles' layer answers. Fix:
  check that layer against the new version, then update the version in this
  check; or install 7.0.2.
- **could not check** when `claude` is not on the `PATH`.
- **Affects**: the design and plan stages, which waffles layers over superpowers.
  The backlog steps do not depend on it.

## 2. gh

Run `gh auth status`.

- **pass**: it exits 0, and names the account that is signed in.
- **fail**, when `gh` is not installed: fix: install the GitHub CLI.
- **fail**, when it says no account is signed in, or the token is not valid:
  fix: `gh auth login`.
- **could not check** when it cannot reach GitHub.
- **Affects**: pushing, the checklist in the pull request, and opening and
  merging pull requests; `ship` has no pull request URL to give.

## 3. The backlog adapter

Find the adapter that the repo names, as `adapter.md` in the `backlog` skill's
base directory says (a `Backlog adapter:` line in `AGENTS.md` or `CLAUDE.md`).

- **pass**, with "this repo names no adapter; the backlog is `.backlog/`",
  when there is no such line. Skip check 5.
- **pass**: the skill it names is in this session's list of skills.
- **fail**, when the skill is not in the list: say "the adapter skill `<name>`
  is not installed". Fix: install the plugin or the project skill that
  provides it (for a project skill, it must be under `.claude/skills/`), then
  start a new session.
- **Affects**: every adapter step. While it fails, `pull`, `raise`, `claim`,
  `ship`, and `note` all fall back to `.backlog/` files.

## 4. The spec check

Find the spec check that the repo names, as the `design` skill says (a
`Spec check:` line in `AGENTS.md` or `CLAUDE.md`).

- **pass**, with "this repo names no spec check", when there is no such line.
- **pass**: the skill it names is in this session's list of skills.
- **fail**, when the skill is not in the list: say "the spec check skill
  `<name>` is not installed". Fix: as for the adapter in check 3.
- **Affects**: the approval of a spec and of a plan in the `design` skill.
  While it fails, the approver reads each document with no findings.

## 5. The repo's own list

When the session's list of skills holds a skill named `initialization-check`
(the repo's, not this one), run it, and take its results as they are: its
checks, results, fixes, and what each affects. When there is none, report
**pass** with "this repo has no check list of its own".

**could not check** when check 3 failed: the repo's own list usually tests what its
adapter needs, and without the adapter it tells nothing.

## Report

A table with 1 row per check, the repo's own checks after waffles', then 1 line per
failure with its fix, then the steps that fall back:

```markdown
| Check                    | Result | Detail                                            |
|--------------------------|--------|---------------------------------------------------|
| 1. superpowers           | fail   | 7.1.0 is installed; waffles' layer was written for 7.0.2 |
| 2. gh                    | pass   | signed in as octocat                              |
| 3. Backlog adapter       | pass   | `tracker-adapter`, named in AGENTS.md             |
| 4. Spec check            | pass   | `team-spec-check`, named in AGENTS.md             |
| 5. Repo's own list       | …      | the rows of the repo's own check                  |

- superpowers 7.1.0 is installed. Fix: check waffles' layer against 7.1.0, or install 7.0.2.

Falls back to .backlog/: none.
```

The last line names each waffles step that will fall back to `.backlog/` files, and
why. A step falls back only when it cannot reach the tracker: all 5 steps when
check 3 fails, or when one of the repo's own checks fails that its list says affects
every adapter step (such as the connection to the tracker). One of those checks
that fails on 1 field or 1 feature does not make a step fall back: name the
steps it affects, and what they will lack, on its own line. Write
`Falls back to .backlog/: none.` when nothing does. Each later fallback is
still said where it happens, as `adapter.md` says.
