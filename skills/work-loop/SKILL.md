---
name: work-loop
description: Work the repo's backlog — the ready items from its tracker through the repo's backlog adapter, or its .backlog/ files — delegate items that can be built autonomously to builders, each in its own full clone with its own branch and draft pull request, and work the rest with the user on the main thread. Run only when explicitly invoked.
disable-model-invocation: true
---

# Work loop

You run the user's backlog for this repo. Items that need nothing from them are built
by builders: background agents, each in its own full clone of the repo, on its own
branch, with its own draft pull request. Items that need their input,
decisions, or authorization — plus finished work awaiting review — are worked on
the main thread with them, one at a time.

The loop is event-driven. Never use timers, `/loop`, or scheduled wakeups, and
never poll.

## Setup

1. The main checkout is `git rev-parse --show-toplevel`. Find the repo's
   backlog adapter, as `adapter.md` in the `backlog` skill's base directory
   says. With an adapter named, read `adapter.md`, load the adapter skill, and
   apply Through the adapter below as well. With none named, the backlog is the
   `.backlog/` files, and the rest of this skill applies as written. Either way,
   the files live in `<main>/.backlog/`; create it if missing.
2. The backlog is committed to source control: if `.gitignore` has a
   `.backlog/` entry, remove it and tell the user in one line.
3. Any item with `status: running` at this point is stale — its agent belonged
   to an earlier session. Mark it `status: stale`.

## Items

Each item is one `.md` file in `.backlog/`. The waffles backlog skill writes items already in
this format; the user may also drop in free-form text. The first time you see a file
without frontmatter, normalize it:

```markdown
---
status: new
type: background | interactive
kind: story | task | bug
title: <short imperative title>
summary: <one line>
depends:
groomed:
clone:
branch:
pr:
dev:
finished:
---

## Request

<The user's original text, verbatim>

## Clarifications

## Progress
```

`kind:` is a field of waffles' item standard (see `adapter.md` in
the `backlog` skill's base directory); a file without it is a `task`. `depends:` lists the item filenames it builds on. An item is blocked while
one of them is not built yet: its file exists and is not `review`. An item whose
dependency is `review` (its pull request is ready but not merged) is stacked on
that item's branch (see Background agents). `clone:`, `branch:`, and `pr:` are
the builder's checkout, its branch, and its pull request's URL. When `clone:` names a folder that is gone (it was in an earlier session's scratchpad), clone again with the same branch (see Clone, below): the new clone checks out the branch as origin has it. `## Clarifications` holds the user's answers
to questions asked ahead of time by the waffles backlog-review skill, which may write to `new`
items from another session.

Statuses:

| Status | Meaning | Owner |
| --- | --- | --- |
| `new` | Triaged, not started | main thread (the backlog-review skill may add clarifications) |
| `running` | A builder is building it in its clone | that builder |
| `review` | Built; its pull request is marked ready and waits for review | main thread |
| `escalated` | Agent stopped and needs the user; question is in Progress | main thread |
| `stale` | Was `running` when a previous session ended | main thread |
| `active` | Being worked on the main thread now | main thread |

Only an item's owner writes its file. Re-read an item right before changing
it. Delete the file only after its work is
merged (or the user drops the item), and not while a queued tracker call names
it (see `adapter.md`, Fallback).

### Classifying

`type: background` only if an agent could finish it correctly without asking
the user anything: intent is unambiguous, scope is contained, and there's an obvious
way to verify it. Anything needing a decision, a judgment call on design or UX,
credentials, or authorization for something risky is `interactive`. When in
doubt, `interactive`.

## The pass

Run a pass when invoked, when an `active` item finishes, and when a background
agent finishes while nothing is `active`.

If agents finish while an item is `active`, don't interrupt the user: note the
finished items and their new statuses in one line at the end of your next reply
and run the pass once the active item is done.

Each pass:

1. Normalize and classify any new files. Leave blocked items (see `depends:`)
   out of the rest of the pass.
2. Order the candidates. Choose recommendations that keep concurrent builders
   from touching the same areas — hold back a background item that overlaps one
   already `running` or the interactive item you're recommending.
3. Ask the user multiple-choice questions (`AskUserQuestion` on Claude Code,
   which can't preselect, and allows 4 options per question):
   - **Q1, multiSelect: "Run in background?"** — `new` background items. Label
     `[bg] <title>`, description `<summary>`. Append ` (Recommended)` to each one
     you'd run now, up to the target (see Background agents). A question
     holds 4 options, so when more than 4 fit, split them across up to 3 questions ("Run in background? (1 of
     2)"), leaving the fourth for Q2.
   - **Q2, single-select: "Work on now?"** — `review` items first, then
     `escalated`, then `stale`, then interactive items in recommended order.
     Label `[review]`, `[escalated]`, `[stale]` or `[interactive]` + title;
     description is the summary (for `escalated`, the question). Put your
     recommendation first with ` (Recommended)`. Each `[review]` option's
     preview is its review links block (see Review links), minus the dev
     URLs — servers start only once the user picks the item. When 2 or more
     `[review]` items change a UI (their `Pages:` line names pages), add the
     option `[review] UI items together`, described with their titles (see
     Reviewing several UI items).
   - If a group has more items than its questions can show, show the top ones
     and say "N more pending" in the last question's text. Omit a question
     whose group is empty.
4. Dispatch each background item the user picked (see Background agents).
5. Start the item the user picked in Q2 (see Main thread). If they picked nothing,
   say what's running and stop until an agent finishes or they re-invoke.

When nothing is `new`, `review`, `escalated`, or `stale`, and no agents are
running, report briefly and stop. The user runs this skill again
(`/waffles:work-loop` on Claude Code) after adding items.

## Background agents

Each background item gets a builder: a background agent with its own full
clone of the repo, its own branch, and its own draft pull request. Builders
never share a checkout, not even with the main checkout, and nothing comes back
from a clone: the work reaches the repo as a pull request, and is reviewed and
merged there. Where the platform has no background agents, leave out Q1: every
item is worked on the main thread.

### Limits

3 limits decide how many builders run. Check them before each dispatch, also
for an item the user picked in Q1. When one holds, start no builder for that
item, leave it `new`, and say in 1 line which limit held and why.

The clones and the pull request limit go through the waffles builders tool
(`builders`; each platform adds its own prefix to the name, such as
`mcp__waffles__builders`). Where that tool is missing, run
`node <skill-dir>/../../scripts/builders.ts` with the same op and its inputs
as flags; each step below gives the command. The script prints the tool's
answer as JSON, and exits 3 where the tool refuses and 1 where it fails.

| Limit | What it guards | How it is counted |
| --- | --- | --- |
| A cap on the open pull requests per repo that wait for human review, when the person set one in `WAFFLES_REVIEW_CAP` (unset, the tool only counts, and never refuses) | The pile of work that waits for people | From GitHub, across every developer: the builders tool with `{"op": "limits", "repo": "<main>"}`, or where it is missing `node <skill-dir>/../../scripts/builders.ts limits --repo <main>`. A pull request waits for review when it is marked ready and a review is requested; one that an agent merges itself has none requested. At the cap it refuses (its reason starts `Refused:`), and the reason lists them: start no builder in this repo. When it cannot count (any other failure), start none either, and say why. |
| One item at a time per component | Overlap in the code | An item holds its component from its claim until its pull request merges: `running`, `escalated`, `stale`, `active`, or `review`. Start no item whose component has another one, unless it depends on that one: it is then stacked on it, and the stack counts as 1. The component is the item's `component` through the adapter; a `.backlog/` file's is the repo, so one item at a time per repo. |
| 3 builders running tests at once on this machine | The machine | Each builder runs its tests, linters, and type checks through the shell command `node <scripts>/builders.ts test-slot -- <command>` (`<scripts>` is `<skill-dir>/../../scripts`, as an absolute path), which waits for 1 of 3 slots, shared by every session. It stays a shell command, not a tool: it wraps the builder's own command and holds the slot for as long as that runs. On a typical workstation, test runs at once stop adding throughput at about 3: past that, each one only slows the others. |

Within them, recommend up to 5 in Q1. One item may fan out into its own
subagents (e.g. repetitive work split across files) in its builder's clone;
that still counts as one.

### Dispatch

1. **Branch.** Name it as the repo's branch convention says (its `AGENTS.md`,
   `CONTRIBUTING`, or the standards they name, such as
   `<type>/<ID>[-<description>]`); with none, `<type>/<item filename stem>`.
2. **Base.** The default branch. Where `depends:` names an item that is not
   merged (status `review`), its `branch:` instead: the item is stacked on it,
   and its pull request's base is that branch.
3. **Clone.** Call the builders tool with
   `{"op": "clone", "root": "<scratchpad>/builders", "repo": "<main>", "item": "<item filename stem>", "branch": "<branch>"}`,
   and `"base": "<base>"` for a stacked item; where the tool is missing, run
   `node <skill-dir>/../../scripts/builders.ts clone --root <scratchpad>/builders --repo <main> --item <item filename stem> --branch <branch> [--base <base>]`.
   It answers with the clone's `path` (under `<scratchpad>/builders/<owner>/<repo>/`, or `$WAFFLES_BUILDERS_ROOT` when it is set; `<scratchpad>` is this session's scratchpad directory, as an absolute path). A clone takes minutes for a large repo: a call that the platform ends before the answer can be made again, and a finished clone on its branch is reused. It
   refuses an existing clone of the item that is on another branch, and a base
   that is not on origin; say why in 1 line and leave the item `new`. Record
   `clone:` and `branch:` in the item's frontmatter.
4. Set `status: running`, then start a background agent (on Claude Code, the
   Agent tool in the background, with no `isolation`) with a prompt with the
   item file's absolute path, the clone, the branch, the base, `<scripts>`
   (`<skill-dir>/../../scripts`, as an absolute path), and these instructions:

> You're the builder of one backlog item. Work only in your clone,
> `<clone path>`, on branch `<branch>`: a full clone of the repo that no other
> agent uses. The item file is `<absolute path>` — it lives in the main
> checkout. It's yours to edit while you work; touch no other file under
> `.backlog/` and nothing else in the main checkout.
>
> 1. Commit and push as the waffles commit-prep skill's rules for work with a
>    plan outline say. Write the item's plan outline in your clone's plan
>    folder, `<git dir>/waffles/plan/` (`git rev-parse --git-dir` prints the
>    git dir): it is not in the working tree and is never committed. Make one
>    commit per outline step, with its checks passing. After the first, push
>    with `git push -u origin <branch>`, open a draft pull request with
>    `gh pr create --draft --base <base>`, titled as the repo's convention
>    says, and record its URL in `pr:`. Then push at each milestone.
>    Nothing may wait for a passphrase. When git signs commits with GPG
>    (`git config commit.gpgsign` prints `true`, and `git config gpg.format`
>    prints nothing or `openpgp`), run, before each commit,
>    `echo ok | gpg --batch --pinentry-mode error --clearsign >/dev/null 2>&1`:
>    exit code 0, commit as usual; otherwise commit with `--no-gpg-sign`.
> 2. Implement the Request, following the answers under `## Clarifications`.
>    Run the repo's tests, linters, and type checks in your clone, each through
>    the shell command `node <scripts>/builders.ts test-slot -- <command>`,
>    which waits while 3 test runs already run on this machine. It is a shell
>    command, not a tool, since it wraps your command and holds its slot for as
>    long as that runs.
> 3. If the change has a dev server or stack, pick a free port, start it in
>    your clone, and record the exact start command (including port and
>    folder) in `dev:`. It may not outlive you, so the command must be enough
>    to restart it.
> 4. Do not install new dependencies, change CI config, or merge. Never touch
>    another checkout of the repo.
> 5. If you need a decision, find the item is bigger than described, or can't
>    get verification passing: stop. Push your finished commits, write what you
>    did, what's left, and the specific question under `## Progress`, set
>    `status: escalated` and `finished:` to the current UTC time (ISO 8601),
>    and finish. The pull request stays a draft. Don't guess.
> 6. When done and verified, write a short summary of the change and how you
>    verified it under `## Progress`, plus a `Pages:` line listing the URL
>    paths (e.g. `/settings/billing`) where the change can be seen, if any.
>    Push, and mark the pull request ready with `gh pr ready`. Set `status: review` and `finished:` to the current
>    UTC time (ISO 8601), and finish.
>
> You may split repetitive work across your own subagents, in your clone. Your
> final message is one line, `<item filename>: <status>`; everything else goes
> in the item file and the pull request.

### The finish queue

Finished agents' notifications can arrive together: Claude Code, for one,
delivers each between turns, never in the middle of one, so agents that finish
close together arrive together. The item files are the queue, not the
notifications:

- Handle every notification that has arrived in one pass, not a pass each.
  Read all statuses with one command
  (`grep -H -E '^(status|finished):' <main>/.backlog/*.md`), then open only
  the files that changed.
- For each finished agent, if its item is still `running` (the agent failed or
  ended early), record what the agent reported under Progress, set
  `status: escalated`, and set `finished:`.
- Q2 lists `review` items oldest `finished:` first, except that an item others
  list in `depends:` goes first, since merging it unblocks them.

## Main thread

Set the item `status: active` and work it with the user. Read its
`## Clarifications` first and don't re-ask what's answered there.

- **interactive** — work in the main checkout. When they agree it's done, delete
  the item file.
- **escalated** / **stale** — read Progress, then continue in the recorded
  clone, on its branch (answer the question with the user first). For
  `stale`, offer to restart from scratch instead if the clone is missing or the
  work looks wrong. When done, mark its pull request ready and review it as
  below.
- **review** — the review is of the item's pull request. If the item has
  `dev:`, find the clone's dev server: usually the builder's is still running.
  Look for a listener that passes the waffles dev-server skill's ownership check against
  the clone and use it. Only if none is running, start one from `dev:` the way
  the dev-server skill does; if its port is taken, use a free one and update `dev:`.
  Never run two servers for one clone. Summarize the change, print the review
  links block in chat, then ask with the question tool:
  **Merge** ("Merge the pull request"), **Revise** ("Tell me what to
  change"), **Drop** ("Close the pull request and delete the clone and the
  item"). Every option's preview is the review links block. On Revise, make the
  changes in the clone, commit and push them, rebuild the block, and ask again.
  On Merge, merge (see Merging a pull request). On Drop, close the pull request
  with `gh pr close <number>`, remove the clone (see Merging a pull request,
  step 3), and delete the item file; the branch stays on the remote.

### Review links

Every question that asks the user to look at, approve, or merge a change carries a
links block so they can cmd+click (ctrl+click) straight to it from the prompt:

```
Dev:   http://localhost:5174/settings/billing
       http://localhost:5174/
PR:    https://github.com/example/app/pull/42
Diff:  https://github.com/example/app/pull/42/files
```

- **Dev** — the running server's base URL joined with each path from the
  item's `Pages:` line, then the base URL itself. Omit the line if there's no
  server.
- **PR** — the item's `pr:`; **Diff** — the same URL with `/files`.

Each link is a full URL — `http://` for the dev server, `https://` for the
pull request — on its own line with
nothing attached to it: no backticks, quotes, brackets, or trailing
punctuation. Never a bare path: terminals only detect links that carry a
scheme, especially inside a multiplexer.

### Reviewing several UI items

To look at several finished UI items at once, build 1 throwaway local branch
in the main checkout that merges every pull request waiting for the user, and
serve it with 1 dev server:

1. Call the waffles review branch tool (`review_branch`; each platform adds
   its own prefix to the name, such as `mcp__waffles__review_branch`) with
   `{"op": "build", "repo": "<main>", "waiting": true}`, or
   `{"op": "build", "repo": "<main>", "prs": [<number>, …]}` for the items the
   user named. Where that tool is missing, run
   `node <skill-dir>/../../scripts/review-branch.ts build --repo <main> --waiting`
   (or `--pr <number>…`), which prints the same answer as JSON. It refuses a main
   checkout with changes to tracked files: say so, and offer the items one by
   one instead. It switches the checkout to the local branch `waffles-review`:
   origin's default branch with each pull request merged into it. Its answer
   names each pull request that conflicted with the ones before it and was
   left out (`conflicts`): review those one by one.
2. Serve it with the waffles dev-server skill in the main checkout: one server for all the
   items. Stop the builders' own servers for those items first, if you
   started them.
3. Print one review links block: the server's URL joined with the `Pages:` of
   each item, under its title, and each pull request's link. Then ask per item,
   as for a single item: **Merge**, **Revise**, **Drop**. Revise is made in
   the item's clone and pushed; then build again, which rebuilds
   `waffles-review` from the new heads, and the server reloads or restarts.
4. Never push `waffles-review`, and never commit on it: it has no upstream, and it
   is rebuilt whenever a waiting pull request changes.
5. When the review ends, call the review branch tool with
   `{"op": "done", "repo": "<main>"}`; where it is missing, run
   `node <skill-dir>/../../scripts/review-branch.ts done --repo <main>`.
   It switches the checkout back to the branch it was on and deletes
   `waffles-review`. Merge the items the user picked as below.

### Merging a pull request

1. If you started the clone's dev server yourself, stop it.
2. Find how the pull request merges: call the waffles merge queue tool
   (`merge_queue`; each platform adds its own prefix to the name, such as
   `mcp__waffles__merge_queue`) with `{"op": "mode", "pr": "<number>"}`, and
   add `"repo": "<owner>/<name>"` when the session's folder is not a checkout
   of the repo. Where that tool is missing, run
   `node <skill-dir>/../../scripts/merge-queue.ts mode <number>`, which prints
   the same answer as JSON. Merge as the answer says. Without a merge queue:
   `gh pr merge <number> --squash --subject <subject> --body <digest>`, with
   the subject and digest that the waffles commit-prep skill describes. When it
   is refused (a check failed, a review is required), say why and leave the
   item in `review`. With a merge queue, merging is adding to the queue, and
   GitHub adds a pull request only when it has a valid approval (its
   `reviewDecision` is `APPROVED`, or empty when no review is required);
   `mode` reports it as `approved`. Without one (you push as the user, so the
   user cannot approve it; a teammate can), don't merge: say that it waits
   for a reviewer's approval, and leave the item in `review`. With one, put
   the digest in the pull request's body, run `gh pr merge <number>` (no
   merge method, no `--auto`), and write under `## Progress` that it is in
   the queue. Then start a background watch (Claude Code's Monitor tool) with
   an until-loop that runs
   `node <skill-dir>/../../scripts/merge-queue.ts state <number>` every 60
   seconds (a shell loop, so the script and not the tool) and ends at `merged`,
   `removed`, or `closed`; its notification starts the next pass, and the
   item stays `review` until then. Where the platform has no background watch,
   read the state with the merge queue tool (`{"op": "state", "pr": "<number>"}`)
   at the start of each pass instead. Go on with steps 3 to 5 once it is
   `merged`. When the queue removed it, set `status: escalated`, write
   GitHub's reason under `## Progress`, and offer it in Q2: its fix is made in
   the clone, pushed, and added to the queue again.
3. Remove the clone: call the builders tool with
   `{"op": "remove", "root": "<scratchpad>/builders", "path": "<clone>"}`;
   where it is missing, run
   `node <skill-dir>/../../scripts/builders.ts remove --root <scratchpad>/builders --path <clone>`.
   It refuses a clone that holds work origin lacks; then say what it holds and
   keep the clone.
4. Restack the items stacked on this one (their `depends:` names it). The squash
   replaced its commits, so in each one's clone run `git fetch origin`, then
   `git rebase --onto origin/<default branch> <this item's branch tip> <branch>`,
   push with `--force-with-lease`, and set its base with
   `gh pr edit <number> --base <default branch>`. Where that item's builder is
   still running, send it these steps as a message instead (SendMessage on
   Claude Code); where the platform can't, do them once it has finished.
5. Delete the item file. When the main checkout is on the default branch with
   no changes, `git pull --ff-only`; otherwise say in 1 line that it is behind.

Then run the next pass.

## Through the adapter

In a repo that names an adapter, the tracker holds the backlog, and the steps
above change as follows. The local files then hold only the items this loop
works on, and the items that fell back.

- **Items.** At the start of each pass, call `pull` (state `ready`) instead of
  reading files for new items. Leave out an item whose `blocked_by` holds an
  item that is neither `done`, `waiting for deploy`, nor `in review` (an item
  whose blocker is `in review` is stacked on the blocker's branch, its `work`);
  an item with no `actor`, which was not adopted yet (say how many in 1 line,
  and that the waffles backlog skill adopts one by its ID, `/waffles:backlog <id>`
  on Claude Code); and an item whose `component` holds
  another item of this loop (see Limits). Keep `pull`'s order: it is the order
  of `due`. `actor: agent` items are the background items; `actor: human` and
  `actor: assignee` items are interactive.
- **Work record.** When an item is claimed, write a file for it,
  `.backlog/<id>.md`, in the format above, with `id: <id>` in its frontmatter,
  the item's title and a summary, its `request` under `## Request`, and its
  `answers` under `## Clarifications`. It is the loop's record of the work, not
  a backlog item: the builder writes it as above, and the loop deletes it after
  the merge. `pull` does not list the item again, since it is `in work`.
- **claim** each item right before its status becomes `running` (a builder
  starts) or `active` (the main thread starts it). When `claim` is refused,
  leave the item out, write no file, and say why in 1 line.
- **ship** with `ready for review` and the pull request's URL when an item
  reaches `review`, and with `merged` once its pull request is merged. When a
  merge queue removed it, ship with `removed` and a `note` that gives GitHub's
  reason: the item goes back to `in work`. The
  deploy is not the loop's to see: the person ships `deployed`.
- **note** with `needs_person: set` when an item becomes `escalated`, with the
  question from `## Progress` as the text. When the main thread resumes it,
  note with `needs_person: clear` once the user answered.
- **Drop.** When the user drops a claimed item, write a `note` that says so.
  Moving it back to `ready` is a planning move: leave it to the user, and say
  so.
- **Fallback.** When `pull` ends **unreachable**, say in 1 line that waffles fell
  back to the `.backlog/` files, and why, and work the files as above. When
  `claim`, `ship`, or `note` ends **unreachable**, queue it as `adapter.md`
  says, say so in 1 line, and go on: the work does not wait for the tracker. A
  claim that fell back holds no lock, and its line says so. A file that fell
  back with a queued raise is a local item: work it as above. When its raise is
  replayed after its work started, the file becomes `.backlog/<id>.md`, the
  work record; go on with that file.
