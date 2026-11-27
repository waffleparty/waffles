# Pieces, builders, and their pull requests

Read this file before you split the task and launch the first builder.

A piece is one item: one builder, one full clone of the repo, one branch, and
one draft pull request. Builders never share a checkout, and nothing is copied
back from a clone: each piece reaches the repo as its own pull request, and is
reviewed and merged there.

```
builder: clone ─► branch ─► outline ─► first commit ─► push ─► draft pull request
         one commit per outline step ─► push at milestones ─► push the last commit ─► gh pr ready
you:     review the pull request ─► merge it (pull-requests.md) ─► restack the pieces on it ─► remove the clone
```

## Pieces and dependencies

Before building, split the task into pieces and work out which depend on which.
A piece depends on another when it needs that piece's code to exist or its
interface to be settled. Add the pieces to the plan outline as steps, each
title with its agent type and the steps it depends on, and close each step
when its pull request is merged, or left to the user.

- Make a piece a change that is worth its own pull request. Fold a change too
  small for one into the piece it belongs to.
- Launch every piece whose dependencies are all finished, in parallel, each in
  the background (on Claude Code, the Agent tool with `run_in_background`;
  where the platform has no background subagents, build the pieces one at a
  time in the main conversation). Start each subagent's description with its step's ID and
  a colon (`3.2: Build the export endpoint`), so the plan outline shows the
  step as the builder's while it works. Wait for their notifications; never
  poll. Ending your turn while they run is fine: each notification starts the
  next one.
- A piece is finished when its builder marked its pull request ready. A piece
  that depends on one finished and not merged is stacked: its branch starts
  from that piece's branch, and its pull request's base is that branch.
- Pieces that will edit the same files go one after another, even when neither
  depends on the other.

## Limits

Before each builder, check the 3 limits that the waffles work-loop skill's
Limits section sets; they hold in a run too. The clones and the pull request
limit go through the waffles builders tool (`builders`; each platform adds its
own prefix to the name, such as `mcp__waffles__builders`). Where that tool is
missing, run `node <skill-dir>/../../scripts/builders.ts` with the same op and
its inputs as flags, as each step below gives it; the script prints the same
answer as JSON.

- **A cap on the open pull requests per repo that wait for human review**,
  when the person set one in `WAFFLES_REVIEW_CAP` (unset, the tool only
  counts, and never refuses). Call the
  builders tool with `{"op": "limits", "repo": "<main checkout>"}`; where it
  is missing, run
  `node <skill-dir>/../../scripts/builders.ts limits --repo <main checkout>`.
  When it refuses (its reason starts `Refused:`; the script's exit code 3), or
  cannot count (any other failure; exit code 1), start no builder in that
  repo. Leave each piece there open, with a note that names the limit and the
  pull requests the refusal listed, and go on with the other repos.
- **One item at a time per component** (per repo where the repo has no
  component): a piece holds it until its pull request merges. A stacked piece
  counts with the one below it.
- **3 builders running tests at once** on this machine: brief each builder to
  run its tests, linters, and type checks through the shell command
  `node <scripts>/builders.ts test-slot -- <command>`. It stays a shell
  command, not a tool: it wraps the builder's command and holds the slot for
  as long as that runs.

## Giving a builder its clone

For each piece, in the main checkout of its repo:

1. Name the branch as the repo's convention says (its `AGENTS.md` or the
   standards it names, such as `<type>/<ID>[-<description>]`); with none,
   `run/<timestamp>-<piece>`.
2. Call the builders tool with
   `{"op": "clone", "root": "<scratchpad>/builders", "repo": "<main checkout>", "item": "<piece ID>", "branch": "<branch>"}`,
   and `"base": "<branch of the piece below>"` for a stacked piece; where it is
   missing, run
   `node <skill-dir>/../../scripts/builders.ts clone --root <scratchpad>/builders --repo <main checkout> --item <piece ID> --branch <branch> [--base <branch of the piece below>]`.
   A call that the platform ends before the clone is done can be made again:
   a finished clone on its branch is reused.
   It answers with the clone's `path`, under `<scratchpad>/builders/<owner>/<repo>/` (`<scratchpad>` is this session's scratchpad directory, as an absolute path), or under `$WAFFLES_BUILDERS_ROOT` when it is set. When
   it refuses, the reason says why; settle it as any other decision.

## Briefing a builder

Launch `waffles:implementer` or `waffles:implementer-hard` with no `isolation`.
They are Claude Code's agents for a builder of specified work and a builder of
work that needs judgment; on another platform, launch its own agent for the
role. The brief names the piece, the clone, the branch, the base, and these rules:

- You are the piece's builder: work only in the clone. Commit and push as the
  waffles commit-prep skill's rules for work with a plan outline say: the plan
  outline in the clone's plan folder, `<git dir>/waffles/plan/`, which is not
  in the working tree and is never committed; one commit per outline step with
  its checks passing; after the first, `git push -u origin <branch>` and
  `gh pr create --draft --base <base>`; and a push at each milestone. A step
  left for the user goes in that outline (see The plan outline in SKILL.md).
- Run the tests, linters, and type checks through the shell command
  `node <scripts>/builders.ts test-slot -- <command>` (`<scripts>` is
  `<skill-dir>/../../scripts`, as an absolute path). It is a shell command,
  not a tool: it wraps your command and holds a test slot for as long as that
  runs.
- Nothing may wait for a passphrase. When git signs commits with GPG (as
  `start.md` tests), run, before each commit,
  `echo ok | gpg --batch --pinentry-mode error --clearsign >/dev/null 2>&1`:
  exit code 0, commit as usual; otherwise commit with `--no-gpg-sign`.
- When it is finished and verified: push, `gh pr ready`, and report the pull
  request's URL.
- Don't merge. Add no dependency and change no CI unless the brief says so
  (say so when the piece needs it).

When a builder reports a gap or a decision, settle
it as you would any other decision (see Deciding in SKILL.md), then send the
running builder the answer as a message (SendMessage on Claude Code), or start
a new builder in the same clone with the full brief if the first one has
finished or the platform can't send a running agent a message.

## After a piece merges

1. Restack the pieces stacked on it. The squash replaced its commits, so in
   each one's clone run `git fetch origin`, then
   `git rebase --onto origin/<default branch> <merged branch tip> <branch>`,
   push with `--force-with-lease`, and `gh pr edit <number> --base <default branch>`.
   Where that builder still runs, send it these steps as a message (SendMessage
   on Claude Code); where the platform can't, do them once it has finished.
2. Remove the merged piece's clone: call the builders tool with
   `{"op": "remove", "root": "<scratchpad>/builders", "path": "<clone>"}`;
   where it is missing, run
   `node <skill-dir>/../../scripts/builders.ts remove --root <scratchpad>/builders --path <clone>`.
   It refuses a clone that holds work origin lacks; then find out why before
   you go on.
3. Close the piece's step in the plan outline.

## Briefing agents

An agent knows only what its prompt says. Brief it with the goal (quoting
the user's words where you have them), the exact scope and files, how to
verify, and that nobody can answer questions: it reports a gap instead of
asking.

Read-only agents (`Explore`, test runners, reviewers, deciders) can run in
parallel at any time.
