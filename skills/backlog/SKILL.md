---
name: backlog
description: Add items to the repo's backlog — splits a body of text into individual backlog items, written to the repo's tracker through its backlog adapter or to .backlog/ files, and adopts an existing tracker item given its ID. Use when the user asks to add something to the backlog.
---

# Backlog

Turn the user's text into backlog items for `/waffles:work-loop` to build. Be quick:
write the items, list what you wrote, and stop. Don't start working on them.

## Setup

1. Find the repo's backlog adapter, as `adapter.md` in this skill's base
   directory says (a `Backlog adapter:` line in `AGENTS.md` or `CLAUDE.md`).
   With an adapter named, read `adapter.md` and load the adapter skill: each
   item goes to the tracker with `raise` (see Through the adapter). With none
   named, the backlog is the `.backlog/` files, and the rest of this skill
   applies as written.
2. The files' backlog is `<main>/.backlog/`, where `<main>` is
   `git rev-parse --show-toplevel` of the main checkout (not a worktree); create
   it if missing. The backlog is committed to source control: if `.gitignore` has
   a `.backlog/` entry, remove it and tell the user in one line.

## Splitting

The input may hold several items, and one item may have several parts. Split by
independence, not size. Make separate items when:

1. the parts could be reviewed and merged separately, in any order; or
2. one part could be built without the user and another needs their input; or
3. together they'd make a diff too big to review comfortably.

Keep parts together when they touch the same code or must happen in order — one
agent handles that better, and can fan out its own subagents for repetitive
work.

When a split leaves one item unable to start until another is merged (usually
the case in rule 2, when an item waits on a decision), list the blocking item's
filename in `depends:`. Otherwise leave it empty.

## Duplicates

Before writing, read the existing items. If one already covers a new item, add
the new text to that item's `## Request` under a dated line instead of creating
a new file, and clear its `groomed:`. Only do this for items with `status: new`;
if the existing item has been started, create a new item that `depends:` on it.

## Writing items

One file per item: `.backlog/<slug>.md`, the slug a few words from the title,
kebab-case. Add `-2`, `-3`, … if the name is taken.

```markdown
---
status: new
type: background | interactive
kind: story | task | bug
stop_at: surface | skeleton | solid, or empty
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

## Request

<The user's text for this item, verbatim. If it came from a larger request, add a
line naming the sibling items it was split from.>

## Clarifications

## Progress
```

`type: background` only if an agent could finish it correctly without asking
the user anything: intent is unambiguous, scope is contained, and there's an obvious
way to verify it. Anything needing a decision, a judgment call on design or UX,
credentials, or authorization for something risky is `interactive`. When in
doubt, `interactive` — `/waffles:backlog-review` can promote it later.

`kind: story` when the item builds behavior that a requirement or a scenario
states, and the text names it; `bug` when it fixes behavior that is wrong;
otherwise `task`. `stop_at:` only for a story whose text names a stage
(`surface`, `skeleton`, or `solid`); leave it empty otherwise. The item
standard in `adapter.md` (in this skill's base directory) defines each field.

## Through the adapter

In a repo that names an adapter, split and classify as above, then for each
item, in the order of the split:

1. Call `raise` with the item in the item standard: `title`, `kind`, `actor`
   (`background` is `agent`; `interactive` is `human`, or `assignee` when the
   text says the item's owner must take part), `stop_at`, `request` (the user's
   text, verbatim), and `blocked_by` (the IDs that `raise` returned for the
   items it depends on). `raise` looks for a duplicate in the tracker itself: when
   it adopts an existing item instead, say so in the report.
2. When the user gives an existing item's ID instead of text, call `raise` with
   that ID to adopt it, with the `actor` and `stop_at` the user names. Ask for
   them when the user names none.
3. When `raise` ends **unreachable**, fall back as `adapter.md` says: write the
   item as a `.backlog/` file (Duplicates and Writing items above), queue the
   raise with the file's name, and say in 1 line that waffles fell back, and why.
   Name a queued item's file in the `depends:` of the items that depend on it.
4. When `raise` is **refused**, write nothing for that item, and report the
   reason.

## Report

List each item written (or appended to) with its type and title, one per line.
Through the adapter, each line starts with the item's ID, or with its file name
and "queued" for an item that fell back. Nothing else.
