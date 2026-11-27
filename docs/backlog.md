# Backlog

Three skills share a per-repo backlog. The backlog is the repo's issue tracker, when the repo names a backlog adapter, or else a `.backlog/` directory: one `.md` file per item, committed to source control. You can also drop free-form `.md` files into `.backlog/` by hand.

| Skill | Purpose |
| --- | --- |
| `/waffles:backlog <text>` | Add items. |
| `/waffles:backlog-review` | Groom items that are not ready. |
| `/waffles:work-loop` | Build the backlog. |

Typical use: run `/waffles:work-loop` in one session, and `/waffles:backlog` and `/waffles:backlog-review` in another as ideas come up. In that second session, `/backlog-entry` sends every prompt you type to `/waffles:backlog` (see [Modes](modes.md#backlog-mode)).

## Add items

**`/waffles:backlog <text>`** adds items. Paste one request or a brain dump. It splits the text into independent items and marks each one `background` (an agent can build it alone) or `interactive` (it needs your input). Given a tracker item's ID, it adopts that item instead. Claude also uses it when you ask to add something to the backlog.

It splits by independence, not size: parts that could be reviewed and merged separately, or that need different people, become separate items. Parts that touch the same code or must happen in order stay together. An item that cannot start until another merges lists that item in `depends:`.

A `.backlog/` item file holds this frontmatter, then `## Request`, `## Clarifications`, and `## Progress` sections:

```markdown
---
status: new
type: background | interactive
kind: story | task | bug
title: <short imperative title>
summary: <one line>
depends: [<filename>, ...]
groomed:
clone:
branch:
pr:
dev:
finished:
---
```

## Groom items

**`/waffles:backlog-review`** grooms items that are not ready by asking you questions one at a time, saving each answer as you give it. In `.backlog/`, items with no gaps left become `background`. In a tracker, it proposes them as ready and leaves the move to the team. Press Esc to stop. The answers so far are kept.

## Build the backlog

**`/waffles:work-loop`** works the backlog. Each pass asks which background items to hand to builders (it recommends up to 5 at once) and which item to work on with you now. Finished work awaiting review comes first, oldest first.

Each builder works in its own full clone of the repo, on its own branch, with its own draft pull request. The clone is at `<session scratchpad>/builders/<owner>/<repo>/<item>`, or under `$WAFFLES_BUILDERS_ROOT` when you set it. An item that depends on one not merged yet starts from that item's branch, as a stacked pull request.

You review the pull request. **Merge** squash-merges it, restacks the items stacked on it, and removes the clone with the builders tool (`builders`, or `scripts/builders.ts` where the tool is missing), which refuses a clone that holds work origin lacks. **Revise** sends your changes to the builder's clone. **Drop** closes the pull request and deletes the clone and the item. A clone borrows the main checkout's objects while it clones, then lets go of them, so the clone is fast and needs nothing of the main checkout afterwards.

```
backlog item ─► builder: clone, branch, draft pull request ─► checks ─► ready for review
                                                                           │
                          you: Merge (squash) / Revise / Drop ◄────────────┘
```

### Limits

3 limits decide how many builders run. The loop checks them before each dispatch. When one holds, it starts no builder for that item, leaves it `new`, and says which limit held.

| Limit | How it is counted |
| --- | --- |
| A cap on the open pull requests per repo that wait for human review, when `WAFFLES_REVIEW_CAP` sets one (unset, there is no cap) | From GitHub, across every developer (the builders tool's `limits`, or `builders.ts limits`): marked ready, with a review requested. At the cap it says why and lists them. |
| One item at a time per component | From an item's claim until its pull request merges. A stacked item counts with the one below it. The component comes from the adapter; a repo with no adapter has one component, the repo. |
| At most 3 builders running tests at once on this machine | Each builder runs its tests through the shell command `builders.ts test-slot -- <command>`, which waits for a free slot and holds it while the tests run; it is no tool, since a tool call may not last that long. The slots are lock files in `$WAFFLES_TEST_SLOTS`, or in `/tmp/waffles-test-slots-<uid>` when it is unset, shared by every session of your user. `--slots`, or `WAFFLES_MAX_CONCURRENT_TEST_SUITES` for every run, sets another count. |

### Several UI items at once

The review branch tool (`review_branch` with `{"op": "build", "repo": "<main checkout>", "waiting": true}`, or `scripts/review-branch.ts build --waiting` where the tool is missing) makes a local branch, `waffles-review`, in your main checkout. It holds the default branch with every pull request that asks you for a review merged into it. A pull request that conflicts is left out and named. One dev server serves the branch. It is never pushed, it is rebuilt when a waiting pull request changes, and `done` switches your checkout back and deletes it. The build refuses a checkout with changes to tracked files.

## Backlog adapter

A repo keeps its backlog in a tracker with 1 line in its `AGENTS.md` (or its `CLAUDE.md` when it has no `AGENTS.md`):

```markdown
Backlog adapter: `tracker-adapter`
```

The line names a skill that implements waffles' 5 adapter steps:

| Step | Purpose |
| --- | --- |
| `pull` | List the items in a state, such as `ready`. |
| `raise` | Create an item, or adopt one that came into the tracker another way. |
| `claim` | Start an item. It is the lock across machines and people. |
| `ship` | Move an item after a pull request event. |
| `note` | Comment on an item, or flag that it waits for a person. |

waffles names no tracker. The adapter maps the tracker's fields to waffles' item standard of 15 fields. `skills/backlog/adapter.md` holds the item standard, the states, and the contract of each step. With no adapter named, the skills work on `.backlog/` files.

## Initialization check

**`/waffles:init-check`** checks what waffles needs in the session:

1. `gh` signed in.
2. The adapter skill the repo names.
3. The repo's own `initialization-check` skill, when there is one, for the repo's or team's own checks.

Each check reports pass, fail with the fix, or could not check. A failure never stops the session. The report ends with the waffles steps that fall back to `.backlog/`, and why. In a repo that names an adapter, the first message asks Claude to run the check before the first task.

## Tracker fallback

When a repo's tracker cannot be reached, the backlog queue tool (`backlog_queue`) holds the tracker writes in `.backlog/queue.json` until the next call that succeeds replays them, oldest first. Where the tool is missing, `scripts/backlog-queue.ts` does the same, with the op as its command. The queue stays out of git, through `.git/info/exclude`. It never calls the tracker. Its lock is `.backlog/.queue-lock`, there only while a session holds it; a lock left more than 15 seconds is taken over.

| `op` | Script | Purpose |
| --- | --- | --- |
| `add` | `add <step> <item> --why <cause> [--data JSON]` | Queue one call. |
| `list` | `list` | The queued calls, oldest first. |
| `done` | `done <seq> [--id <new id>]` | Remove one call once the tracker answered it. |

For a queued `raise`, `id` (the script's `--id`) puts the new ID in the calls after it and in other items' `depends:`, and deletes the item file, or renames it to `<id>.md` when its work already started. Each call that falls back gets 1 line saying so, with the cause. `skills/backlog/adapter.md` says when the skills use the queue.
