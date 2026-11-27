# Pull requests

Read this file before you open the first pull request of a run, before each
merge (it holds the merge queue), and before you change CI. "The plan outline" and "Finishing" are sections
of SKILL.md.

During a run, commits reach a repo's default branch only through a pull
request, merged by squash or by the method the repo's merge queue requires. The pull request's checks are the outside
check on the work. Don't push to the default branch directly.

```
outline ─► first step ─► commit ─► push ─► draft pull request
   │
step ─► commit ─► push at a milestone or a stop
   │
last step: commit ────────────────────► push ─► gh pr ready
                                          │
                         wait for its checks (watch-ci skill)
                           │ pass              │ fail ─► fix, push again
                           ▼
        finished, reviewed, and nothing that stays with the user?
           │ yes                              │ no ─► step left for the user
           ▼
   merge_queue tool, op mode
     │
     ├─ no queue ─────────────► gh pr merge --squash ──────────────────────────► merged
     │                            │ refused by a rule ─► … --admin ────────────► merged
     │                                                     │ refused too: a step left for the user
     ├─ a queue, no approval ─► gh pr merge <n> --<method> --admin ────────────► merged
     │
     └─ a queue, approved ────► gh pr merge <n>: adds it to the queue
                                  │ merge-queue.ts state, until it ends:
                                  ├─ merged ───────────────────────────────────► merged
                                  └─ removed ─► ship removed (back to in work, note:
                                                GitHub's reason); fix, push, add it again

   merged ─► watch-ci skill on the default branch ── fail ─► fix through a new pull request
```

- **One pull request per piece**, on the piece's branch, from its builder's
  clone (see `pieces.md`). Follow the commit and push rules of
  the waffles commit-prep skill, which the waffles modes section states in short. The
  plan outline is not in the working tree and is never committed. After the
  first commit, push the branch, and open the pull request as a draft
  (`gh pr create --draft`). Each outline step is one commit; push at a
  milestone and at a stop. The last steps are a push and `gh pr ready`. The
  body says what changed and why, how it was verified, and
  the decisions a reviewer should know. The waffles hook renders the outline into
  its `## Plan outline` section after each push and after `gh pr create`;
  where no hook did, update the section with
  `gh pr edit <number> --body-file <file>`. When a feature branch already has
  an open pull request, update that one. The whole feature branch merges,
  including work the task did not cover.
- **Checks.** Watch the pull request's checks with the waffles watch-ci skill;
  where it says to ask, decide instead. Fix a failure and push again.
- **When to merge.** All 3 must hold: the piece is finished and verified, and
  the pieces below it in a stack are merged; the review by the reviewer agent
  (`waffles:reviewer` on Claude Code; see Finishing in SKILL.md) has no open
  **must fix** finding; the pull request's checks pass. Then run the
  production check below, and find how the pull request merges: call the
  waffles merge queue tool (`merge_queue`; each platform adds its own prefix
  to the name, such as `mcp__waffles__merge_queue`) with
  `{"op": "mode", "pr": "<number>"}`, and add `"repo": "<owner>/<name>"` when
  the session's folder is not a checkout of the repo. Where that tool is
  missing, run `node <skill-dir>/../../scripts/merge-queue.ts mode <number>`,
  which prints the same answer as JSON. Merge as the answer says.
  Without a merge queue, merge with `gh pr merge <number> --squash`,
  passing the commit's subject and body yourself (`--subject`, `--body`) so
  that the `Co-Authored-By` trailer is kept. With one, see The merge queue. Don't pass `--delete-branch`: it
  makes `gh` switch branches in the checkout, and it deletes a feature branch
  that is the user's. When one of the 3 doesn't hold, or the user answered
  "Leave them out" at the start, leave the pull request open and leave the
  merge to the user, with what is open as the reason.
- **The merge queue.** Where the base branch has one, "merge" means "add it
  to the queue", and GitHub adds a pull request only when it has a valid
  approval: its `reviewDecision` is `APPROVED` (or empty, when no review is
  required), which `mode` reports as `approved`. The run pushes as the user,
  so the user cannot approve its pull requests; a teammate can.
  - Without a valid approval, GitHub refuses to add it, also for an admin.
    Where the user allows `--admin` (below), merge it past the queue with the
    command `mode` gives,
    `gh pr merge <number> --<method> --admin` with the queue's merge method
    (see `--admin` below), and go on as After a merge says.
  - With one, run `gh pr merge <number>`, with no merge method and no
    `--auto` (a repo with a queue may not allow auto-merge). The queue tests
    the pull request on the newest base branch with the ones ahead of it,
    then merges it, or removes it. It writes the commit from the repo's
    settings for the queue's merge method, so put the digest in the pull request's body
    before you add it. Then wait for the result with a background watch
    (Claude Code's Monitor tool): an until-loop that runs
    `node <skill-dir>/../../scripts/merge-queue.ts state <number>` every
    60 seconds (a shell loop, so the script and not the tool) and ends at
    `merged`, `removed`, or `closed`, for at most 2 hours. Where the platform
    has no background watch, run the same loop as a shell command, and run it
    again each time the platform ends it, until the 2 hours are up. To read the state
    once, outside the loop, call the tool with `{"op": "state", "pr": "<number>"}`.
    - `merged`: go on as After a merge says.
    - `removed`: in a repo that names a backlog adapter, `ship` the item
      with `removed` and a `note` that gives GitHub's reason: the item goes
      back to `in work`. Find why with the waffles watch-ci skill on the queue's run (its
      event is `merge_group`), fix it, push, and add the pull request to the
      queue again.
    - Still `queued` or `waiting` after 2 hours: leave the merge to the
      user, with the state as the reason.
- **`--admin`.** It merges past branch protection (a required review or
  required signatures), so the user decides whether a run may use it, with
  a permission rule of their own that names it (on Claude Code, an auto mode
  rule). Add it only after a plain merge was refused by such a rule, and only
  when the pull request's checks pass: never to get past a failing check.
  When the platform's permission checks block the command, the user has not
  allowed it. Then leave the pull request open and
  leave the merge to the user, with the rule's name as the reason, and look
  for no other way to merge it. Merge with the merge method the repo or its
  merge queue requires. Never change branch protection settings. When
  GitHub refuses `--admin` too, the rules bind admins: leave the merge to
  the user the same way.
- **The production check.** Before you merge, push a tag, or publish a
  release, read what that action starts: the repo's workflows and its
  documentation. Stop only when they say that the action deploys to production
  a change that cannot be behind a feature flag. When they say nothing,
  proceed. A library release and a development deploy are not production. For
  a release rollout pull request, list each change in the release with the
  flag that covers it and that flag's state for customers, and write the list
  into the pull request's body before you merge.
- **After a merge.** Watch the default branch's CI and CD run with the
  waffles watch-ci skill. Fix a failure through a new pull request on this same path.
  Then restack the pieces on it and remove its clone (see After a piece merges
  in `pieces.md`), and bring the session's checkout to the merged state when
  the run committed there (see The local checkout).
- **Order.** A release, and an update of a repo that depends on it, happen
  only after the pull request they come from has merged. When a pull request
  depends on another repo's release, merge and release that repo first.

## Attribution

Check which login a tool posts as (`gh api user --jq .login`). Where only the
user's own login can post, the text itself says that Claude wrote it (on
another platform, its assistant's name in place of Claude):

| Text | Attribution |
| --- | --- |
| A comment or a review reply | First line: "Written by Claude during an unattended run for `<login>`." |
| A pull request's body | Last lines: the same sentence, then the platform's own attribution lines, where it gives any (on Claude Code, Claude Code's) |
| A commit, and the squashed commit on the default branch | The `Co-Authored-By` trailer |
| Release notes and changelogs that a release tool generates | Nothing added |
| Release notes that you write by hand | Last line: the same sentence |

## The local checkout

A builder's clone is removed after its merge. Where the run committed in the
session's checkout itself, you are still on that branch after its merge. Bring
the checkout to the merged state in this order:

1. `git fetch origin`.
2. When the local default branch holds commits that the squash replaced,
   keep its old tip: `git branch run/<timestamp>-before <default branch>`.
3. `git branch -f <default branch> origin/<default branch>`, then
   `git switch <default branch>`.
4. Delete a branch only if the run created it:
   `git push origin --delete run/<timestamp>-<topic>`, then
   `git branch -D run/<timestamp>-<topic>`. A feature branch of the user's
   stays, here and on the remote.

Never use `git reset --hard` or `git checkout -f`: changes that were
uncommitted when the run began and don't belong to the task stay as they
were. If `git switch` refuses because of them, stay on the run's branch,
skip step 4, and leave the switch to the user as a step in the plan outline
(see The plan outline in SKILL.md).

## CI

- You may change CI. Don't make tests or other quality or safety checks less
  effective on the branches that ship, in effect or in intent. Name each CI
  change in the pull request body, under the decisions a reviewer should know.
- To try a CI change, push to a test branch you created, once you've checked
  the workflow triggers and no pipeline run on that branch deploys anything.
  On that branch you may defeat checks to test (skip a step, force a
  failure). None of that goes into the run's pull request.
- Watch the runs the push starts (the waffles watch-ci skill does this; where it
  says to ask, decide instead). Delete the test branch when you're
  done with it. If one has to stay on the remote, say so in the pull request
  body.
