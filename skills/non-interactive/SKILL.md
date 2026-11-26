---
name: non-interactive
description: Work unattended while the user is away — make decisions on their behalf, carry the current task (or the task given as arguments) through to completion, merge the work through pull requests, keep the steps left for the user and the decisions worth checking in the plan outline, and finish with a short message that links each pull request. Run only when explicitly invoked.
disable-model-invocation: true
---

# Non-interactive

These rules apply only while the waffles mode is non-interactive. Once a later waffles
mode statement ("waffles mode: …") names another mode, the run has ended and none
of these rules apply. In particular, the pull request path below is for runs
only: outside a run, commits are signed and pushed as the user's own rules say.

The user is away from the computer. Finish the work without them: the task given as
arguments, or else every task in progress in this conversation. Make the
decisions they would make and carry the work all the way: commit it, merge it
through a pull request, and release and publish what the task calls for. Then
end with a short message that links each pull request.

Nobody will answer questions or approve plans until you're finished, apart
from one question at the start. The user wants to be hands-off: they come back
to read the pull requests and their plan outlines, not to finish the work. A
step you leave for them costs them as much as a run that stalled, so aim for
the most finished, verified work you can produce.

This skill keeps its procedures in other files of its directory. Read each one at
the step that names it: `start.md` (before anything else), `plan-outline.md` (entries in
the plan outline), `commits.md` (commit rules), `denials.md` (when an action
is refused), `posting.md` (tracker writes, and posting where others read),
`pieces.md` (split the work, builders' clones and pull requests), `deciding.md`
(delegate a hard decision), and `pull-requests.md` (from push to merge,
attribution, the checkout after a merge, and changes to CI).

## Ground rules

- After the start of the run (below), don't use AskUserQuestion, and don't end
  a turn with a question or a plan waiting for approval. Make the decision,
  note it if it is worth checking (see Deciding), and keep going.
- **Do the work.** When the task needs an action, take it: edit any local repo
  the task involves, run the commands it needs, install a dependency, change
  CI, use the network. Auto mode's classifier is the safety check. Don't add
  your own by skipping work it might block: when you're unsure whether an
  action is allowed, try it.
- **Act without asking.** Do what the task needs, including what other people will see: push
  branches, open and merge pull requests (see Pull requests), publish packages, releases and
  pages, update the repositories that depend on a release, and let development environments
  deploy.
- **When unsure, proceed.** If you cannot tell whether an action changes production, take it.
  Stop only when what you read (a workflow, the repository's documentation) says that the
  action does something the list below keeps for the user.
- **In production, limit exposure.** You may deploy a change that is behind a feature flag
  which is off for customers, run smoke tests there, and turn a flag on for a targeted audience
  to verify. You may merge a release rollout pull request when every change in the release is
  behind such a flag; list each change with its flag and the flag's state in the pull request.
- **4 things stay with the user**, unless the task asks for them in so many words:
  - **Unflagged production changes.** Deploying a change that cannot be behind a feature flag:
    a migration on production data, infrastructure applied to production accounts, or a change
    that takes effect for every customer on deploy. Merging a release rollout pull request
    that holds such a change.
  - **General availability.** Turning a feature flag on for all customers.
  - **Destruction.** Deleting data, repositories, releases, or published package versions that
    the run did not create; force-pushing over commits the run did not make; removing or
    rotating secrets.
  - **Money.** Anything that costs money beyond what the task's CI already costs.

  Do everything up to that step (write the migration, open the pull request and leave it
  unmerged), and leave the step itself to the user with the exact command (see The plan
  outline).
- **Record the run's own work in the tracker.** Read `posting.md` before the run's first
  tracker write, and before it first posts where other people read. It also says how to
  mark text as written by Claude.
- **Don't record what you did for the user.** A push, a merge, a release, a publication, a
  comment, a deploy, or a flag change shows in GitHub and the tracker already.
- **A step left for the user is the last resort.** It is for the things above, for what only
  the user can supply (a login, a secret, a preference nothing records), and for an action
  that was refused and has no other route. Don't leave a step for work that is risky, large,
  or unfamiliar: decide, do it, and note the decision if it is worth checking.
- The work is done when every task is finished, verified (tests, linters,
  type checks, a real run where it makes sense), committed, and merged (see
  Pull requests), or when the only steps left are the user's.


## Start of the run

The run goes on in the user's session, so the user sees its work in the
transcript when they return. This thread orchestrates: it splits the work and
hands it to sub-agents (see Splitting the work), and the sub-agents do the
reading and building.

Read `start.md` and do its 2 steps first, in order, before any other work:
test-sign, then ask once about commits that aren't on the remote (this is the
only question of a run; the hooks refuse every other AskUserQuestion call).

Then start the plan outline (see The plan outline): a goal for the run's work,
and its steps.

## The plan outline

The plan outline is the run's only record. The user reads it when they return,
in the pull request's `## Plan outline` section. Change it only with the
`mcp__waffles__plan` tool, as in production mode: start a goal, add its steps, and
close each step (op `done`) when its commit is made. After a context
compaction, show it (op `show`) before you continue.

Read `plan-outline.md` before you add or rename a step. A step left for the user
stays open, and its title has this form:

  `Yours: <the action, in plain words> · Run: <exact command or steps> · Why: <reason>`

A decision worth checking (see Deciding) is a note on its step. Nothing else
goes in the outline: what the run did for the user is not recorded (see Ground
rules). "Steps left for you" in the final message counts only the open `Yours:`
steps.

## Commits

Commit finished work as you go, one commit per plan outline step, once its
checks pass. Work goes on the run's branch, and reaches the default branch
through a pull request. Read `commits.md` before the first commit: branch
names, signing, hooks, and uncommitted changes. Never rewrite a commit on the
remote that the run did not make.

## Pull requests

During a run, commits reach a repo's default branch only through a pull
request, merged by squash or by the method the repo's merge queue requires: one pull request per piece. Don't
push to the default branch directly. Read `pull-requests.md` before you open
the first pull request, before each merge, and before you change CI. It holds
the path from push to merge with the merge queue, the production check,
attribution, the checkout after a merge, and the rules for CI changes.

When to add `--admin` to `gh pr merge` is in `pull-requests.md`.

## Denials

Two things can refuse an action: auto mode's classifier, and waffles' hooks, which
answer no where Claude Code would ask the user, with a message that starts
"Denied: The user is away". A denial stops one action, not the goal. Read
`denials.md` at the first denial: it says how to find another way, when to
leave the step to the user, and the limits (3 classifier blocks in a row, 5
denials in a row, writes that are always denied).

## Splitting the work

You plan, split, delegate, merge, and verify. Sub-agents do most of the
reading and building, on the cheapest model and effort that fits each piece.
Keep your own context small: everything you read stays in it, and is paid for
again, on every later step of the run.

Make a change yourself when it's small and you already have what you need to
make it: delegating costs a brief and a round trip. Delegate the reading and
the building.

Route everything else by this table. The `waffles:*` agent types carry their
own model and effort, so pass neither, except to `waffles:decider`: it names
no model, so pass its `model` as `deciding.md` says. If they aren't in the Agent tool's list
(a cloud session loads this skill but not its plugin), use the fallback.

| Task | Agent type | Fallback |
| --- | --- | --- |
| Find code, read and report | `Explore`, `model: "haiku"`, `effort: "low"` | same |
| Run tests, linters, type checks; report failures | `waffles:test-runner` | `general-purpose`, haiku, low |
| Build a fully specified piece | `waffles:implementer` | `general-purpose`, sonnet, medium |
| Build a piece that needs judgment: an unknown cause, a multi-file refactor, or anything touching auth, security, migrations, money, or concurrency | `waffles:implementer-hard` | `general-purpose`, opus, high |
| Review finished work | `waffles:reviewer` | `general-purpose`, opus, high |
| Make a hard decision | `waffles:decider`, with `model` the most capable in the Agent tool's options (see `deciding.md`) | see `deciding.md` |

If a spawn fails because its model isn't available, retry with `model: "opus"`,
then with `model` unset. Once a model has failed, don't try it again this run.

Read `pieces.md` before you brief the first agent: it says how to brief one, and
which can run in parallel.

Before you split the task and launch the first builder, read `pieces.md`: how
to order the pieces, give each builder its clone, branch, and pull request,
and stack the pieces that depend on others. Read it again after each merge if
it is no longer in context.

## Deciding

Sort every decision into one of three tiers:

| Tier | What it covers | What you do |
| --- | --- | --- |
| Routine | Settled by repo conventions, the request, or an obvious best practice | Decide |
| Notable | A real choice the user might have made differently, but cheap to revisit | Decide yourself; name it in the pull request body |
| Hard | High impact, hard to reverse, unclear intent, conflicting evidence, or something you'd normally have asked the user about | Delegate it (read `deciding.md`); note it on its step |

When you're unsure between two tiers, take the higher one.

A decision is **worth checking**, and gets a note on its step in the plan
outline, when it is hard, or when it is questionable: the delegated agent's
confidence was medium or low, you disagreed with it, evidence pointed both
ways, or you're guessing at the user's intent.

## Finishing

1. **Review.** As each piece's pull request is marked ready, have
   `waffles:reviewer` review its whole diff against the task. Fix each **must fix** finding through the routing
   table, commit and push the fix, and run the review again, at most twice. A
   **must fix** finding still open after that stays in the plan outline as a
   step for the user, with the finding as the reason, and its pull request
   stays open. Note each **should fix** finding you leave on the step it
   belongs to.
2. **Merge and release** as Pull requests says: checks, merge, the default
   branch's CI, then the releases and the repos that depend on them.
3. **Check.** Read the task and the plan outline again (op `show`), and check
   that nothing else can move forward.
4. **Final message.** End the run with this message and nothing else. There
   is no report page.

   ```
   Run finished. Task not finished. 2 steps are left for you.
   - infra: https://github.com/acme/infra/pull/14 · open · 2 steps for you
   - widget: https://github.com/acme/widget/pull/42 · merged
   ```

   - Line 1: `Run finished.`, then `Task finished.` or `Task not finished.`,
     then the count of the steps left for the user in all pull requests:
     `No steps are left for you.`, `1 step is left for you.`, or
     `<n> steps are left for you.`
   - Then 1 line per pull request the run opened or updated: the repo, the
     link, `merged` or `open`, and the count of its steps for the user when
     there are any.
   - Don't repeat the steps, their commands, or their reasons: they are in
     each pull request's `## Plan outline` section. When the run opened no
     pull request, name the repo and branch that hold the plan outline
     instead.
