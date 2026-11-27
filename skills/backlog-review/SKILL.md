---
name: backlog-review
description: Groom the repo's backlog — ask the user questions, one at a time, to fill the information gaps in items that are not ready, recording each answer as it's given, in the tracker through the repo's backlog adapter or in .backlog/ files. Run only when explicitly invoked.
disable-model-invocation: true
---

# Backlog review

Go through the backlog items that need the user's input and ask them, preemptively,
what an agent would otherwise have to stop and ask. This usually runs in its own
session while the waffles work-loop skill builds the backlog in another, so other sessions may
be changing these files as you go.

## Setup

Find the repo's backlog adapter, as `adapter.md` in the `backlog` skill's base
directory says. With an adapter named, read `adapter.md`, load the adapter
skill, and follow Through the adapter below. With none named, the backlog is
`<main>/.backlog/`, where `<main>` is `git rev-parse --show-toplevel` of the
main checkout, and the rest of this skill applies as written. If it's missing
or has no candidates, say so in one line and stop.

## Candidates

Items with `status: new`, `type: interactive`, and `groomed:` not `true`. Skip
everything else — escalated, stale, review, running, and active items belong to
the work-loop skill or its agents. Review items that others list in `depends:` first,
then the rest, oldest first.

## Each item

Read its `## Request` and `## Clarifications`. Work out the gaps: what would an
agent need to know to build this correctly without asking? Intent, scope and
what's out of scope, how to verify it, design or UX choices, names, data,
credentials. Never re-ask anything already under `## Clarifications`, including
skipped questions.

Ask about each gap in turn. Each question is atomic — ask it, then record the
answer, before asking the next:

1. Ask the user a multiple-choice question (`AskUserQuestion` on Claude Code),
   **one question per call**. Name the item in the
   question text; the header is a short form of its title. Offer 2–3 likely
   answers, your recommendation first with ` (Recommended)`, and a final
   **Skip** option ("Don't ask this again"). The user can always type their own
   answer.
2. Re-read the item file. If its status is no longer `new`, another session has
   picked it up: discard the answer, drop the item, and go to the next one. Say
   nothing about it.
3. Otherwise append to `## Clarifications`:

   ```markdown
   **Q:** <question>
   **A:** <answer, or "(skipped)">
   ```

Let each answer shape the next question, and drop questions it made moot.

When no gaps are left, re-read the item. If it's still `new`:

- Set `groomed: true`.
- If an agent could now finish it without asking the user anything — intent
  unambiguous, scope contained, an obvious way to verify it, and nothing risky
  needing their authorization — set `type: background` so the work-loop skill offers it
  to an agent.
- Update `title:` and `summary:` if the answers changed them. Never edit
  `## Request`.

## Through the adapter

In a repo that names an adapter, the steps above change in 4 places:

- **Candidates.** Call `pull` with the state `not ready`. Every item it lists
  is a candidate, in the order `pull` gives. The answers so far are the item's
  `answers`; never re-ask what they hold.
- **Each answer.** Write it with `note` on the item, in the same `**Q:**` and
  `**A:**` form, right after the user answers. There is no file to re-read: an
  answer on an item that someone started does no harm.
- **No gaps left.** Only a person makes an item ready. Write a last `note` that
  says the item has no gaps left and proposes it as ready, with the `actor` you
  would give it (`agent` when an agent could now finish it without asking).
  Never change the `request` text, the `title`, or the state.
- **An item with no `actor`** was not adopted yet. Ask which actor it gets, as
  a question like the others, then call `raise` with its ID and that actor to
  adopt it.

When `pull` ends **unreachable**, say in 1 line that waffles fell back to the
`.backlog/` files, and why, and groom the files as above. When a `note` ends
**unreachable**, queue it as `adapter.md` says, say so in 1 line, and go on:
the answer reaches the tracker at the next call that succeeds.

## Cancelling

If the user dismisses or declines a question, stop immediately. Write nothing more
and produce no further output. Every answer before it is already recorded.

## Finishing

When every candidate is done, list the items you groomed, one per line, marking
the ones you promoted to background, or, through the adapter, the ones you
proposed as ready.
