---
name: commit-prep
description: Get pending changes ready to commit — surface prerequisites (linked packages, unpublished versions, cross-repo dependencies), flag unfinished work and spec/doc drift, check the commit and push rules of plan outline work, run the repo's CI checks locally and fix what fails, then hand the user a summary and a paste-ready commit command. Run only when explicitly invoked.
disable-model-invocation: true
---

# Commit prep

The user is about to commit. Get the pending changes to the point where the commit
is complete and CI will pass on the first push, so they don't wait on CI to
find out. Fix what you can, escalate what's their call, and finish with
a commit command they can paste.

This skill commits and pushes nothing itself. Its last step is a command for the
user to run. The commits and pushes made during work follow the rules below,
and the review checks the pending changes against them.

## Commit and push rules

These rules hold for work that has a plan outline (the goal files in
`.tmp/plan/` on the feature branch), in production mode and during a run.
Where the user's own rules or the repo's say more, follow those too.

```
outline ─► commit 1: the outline alone ─► push ─► draft pull request
   │
   ▼
step ─► checks pass ─► commit (the step, and its box ticked) ─► milestone? ─► push
   │                                                             stop?    ─► push
   ▼
last step: "Remove the working files" ─► git rm -r .tmp ─► commit ─► push ─► gh pr ready
```

1. **Start.** On the feature branch, write the plan outline. The first
   commit holds the outline alone. Push the branch, then open the pull request
   as a draft: `gh pr create --draft`. Its body has the sections of the repo's
   pull request template. The waffles hook renders the outline into the body as a
   checklist after each push and after `gh pr create`. Those are the only
   checkpoints today: at the end of a run or a session nothing renders it, so
   push before you stop (rule 5).
2. **Every outline ends with the step "Remove the working files".** Add it
   when you write the outline.
3. **One commit per step.** A commit holds one step of the outline: its change,
   and the step closed with the plan tool (op `done`), so the ticked box is in
   the same commit. Run the repo's checks (tests, linters, type checks) first,
   and commit only when they pass. Make no commit only to save state.
4. **Push at a milestone.** A milestone is a top-level step done with all its
   child steps, and the last commit before review. Between milestones, commits
   stay local.
5. **Push at a stop.** Push also when work stops short of a milestone: at the
   end of a session, at the end of a run that does not finish the item, and at
   a handoff to another machine, person, or agent. The push carries finished
   commits only. Work that is not committed stays in the checkout, and the
   checklist in the pull request says "Ahead of the branch".
6. **No skip tag.** No commit message holds `[skip ci]`, `[ci skip]`,
   `[no ci]`, `[skip actions]`, or `skip-checks:`. CI runs on every push.
7. **Finish.** The last step is `git rm -r .tmp` in its own commit, "Remove
   the working files". Push, then mark the pull request ready:
   `gh pr ready`. Nothing stops a merge while `.tmp/` is on the head branch:
   check that this commit is pushed before you merge.

### Squash digest

A pull request merges by squash, and its squash commit is the record of the
change on the default branch. Write its message yourself; don't take GitHub's
default, which lists every commit of the branch.

- **Subject:** the pull request's title, in the repo's commit style, then
  ` (#<number>)`.
- **Body:** the essence of the change in about 10 lines: what changed, why,
  and the decisions a later reader needs. Not the list of commits, not the
  checklist, and no skip tag. Then a blank line and the pull request's URL.
- **Trailers:** last, the `Co-Authored-By` lines of the branch's commits.

```sh
gh pr merge <number> --squash --subject "<title> (#<number>)" --body-file - <<'EOF'
<about 10 lines: what changed, why, the decisions that matter>

https://github.com/<owner>/<repo>/pull/<number>

Co-Authored-By: <as in the branch's commits>
EOF
```

## 1. Scope

1. Read `git status`, `git diff --cached`, and `git diff`.
   - If anything is staged, the commit is the staged changes. Flag unstaged edits
     to staged files, and unstaged files that look like they belong with it.
   - If nothing is staged, the commit is everything pending, untracked files
     included.
2. Flag files that shouldn't be committed: `.env` and other secrets, keys, large
   binaries, logs, scratch or debug output, editor files. For each untracked
   file, decide whether it belongs in the commit or in `.gitignore`.
3. If the changes hold unrelated work, propose splitting them into separate
   commits, and carry that split through to the end.
4. Note the branch: committing straight to the default branch, branch behind its
   upstream (`git fetch` first), unpushed commits already ahead, conflict
   markers in any file.
5. Where the work has a plan outline, check it against the commit and push
   rules: the changes hold one step, and that step's box is ticked in them; no
   message of the commits ahead of the upstream holds a skip tag; the outline
   ends with "Remove the working files".

## 2. Prerequisites

Look for anything that must happen elsewhere before this code can be committed
or pushed. Label each one **blocks commit** or **blocks push**. Most block the
push: the commit is fine locally, but CI or another environment would fail.

- **Local or linked dependencies:** symlinks under `node_modules`
  (`find node_modules -maxdepth 2 -type l`), `file:`/`link:`/`portal:` specs in
  manifests, Go `replace` directives to local paths, Cargo `path =` deps and
  `[patch]` sections, editable or path Python installs (`-e ../`, uv `path`
  sources), Gemfile `path:`, Terraform module sources pointing outside the repo.
  `workspace:` dependencies within the same monorepo are fine.
- **Unpublished versions:** a manifest pinned to a version the registry doesn't
  have yet. Check it (`npm view <pkg>@<ver> version`, `pip index versions`,
  `go list -m`, `cargo search`, …).
- **Cross-repo work:** code that relies on an endpoint, schema, proto, event, or
  shared config that only exists in another repo's unmerged or unpublished
  changes. Check sibling repos it references for dirty state or unpushed
  commits. Check submodules for commits that were never pushed.
- **Deploy-time needs:** new env vars, secrets, feature flags, infrastructure, or
  migrations that must exist before this code runs.
- **Lockfiles** out of sync with their manifests.

If there are any, list them in the order they must happen ("publish
`@scope/pkg@1.4.0`, then replace the link with `^1.4.0`, then push") and ask with
AskUserQuestion: **Resolve first** (stop here and help with them), **Continue**
(the user handles them before pushing), **Stop**. Recommend Resolve first when
anything blocks the commit. Don't publish, push, or touch other repos yourself.

## 3. Review and local CI

Run these at the same time: start the CI commands (background Bash) while you
review the diff.

### Completeness review

Check the changes against what they're meant to do:

- **Added in this diff:** `TODO`/`FIXME`/`XXX`/`HACK`, debug output
  (`console.log`, `print`, `debugger`, `dbg!`, …), commented-out code,
  focused or skipped tests (`.only`, `.skip`, `fit`, `xit`), stubs
  (`NotImplementedError`, "not implemented"), hardcoded localhost URLs or
  credentials.
- **Tests:** new behavior with no tests, and existing tests weakened, deleted,
  or skipped.
- **Specs and docs, both ways:** code that changed while the README, `docs/`,
  specs, API definitions, CLI help, config examples (`.env.example`), or
  CLAUDE.md/AGENTS.md describing it didn't; and docs or specs that promise
  behavior the code doesn't have.
- **Generated files** that are now stale: codegen output, snapshots, schema
  dumps, lockfiles.
- **Unfinished work:** tasks from this conversation left half-done, unchecked
  steps in a plan file, `active` items in `.backlog/`.
- **Secrets:** run `gitleaks protect --staged` (or `gitleaks detect` on the
  working tree) if gitleaks is installed.

### Local CI

1. Find what CI runs: the jobs in the repo's CI config (`.github/workflows/`,
   `.gitlab-ci.yml`, `.circleci/config.yml`, `Jenkinsfile`,
   `azure-pipelines.yml`, `bitbucket-pipelines.yml`, `.buildkite/`, …) that run
   on a push or a pull request for the target branch, plus local hooks
   (`.pre-commit-config.yaml`, husky, lefthook). Follow included or reusable
   pipelines (reusable workflows, composite actions, templates, orbs) to the
   commands they actually run.
2. Turn each step into its local command (`make lint`, `npm ci && npm test`,
   `pytest`, `go test ./...`, `pre-commit run --all-files`, …) and run them in
   CI's order. Use the same tool versions CI pins where you can tell
   (`.tool-versions`, `.nvmrc`, `.python-version`, `go.mod`, the versions of the
   pipeline's setup steps), and note any mismatch.
3. Don't fake coverage. Run matrix entries this machine supports and list the
   rest as not covered. Steps that need CI secrets or that deploy, publish, or
   upload are **not run locally**, with the reason.
4. If the commit is only the staged changes but unstaged changes exist, CI ran
   against the working tree, not the commit. Say so in the report.

### Fixing

Fix everything you can, then re-run the affected checks until they pass or
only escalations are left. This covers formatting, lint, type errors, stale
generated files, missing doc updates, debug leftovers, and failing tests whose
cause is clear.

Escalate a fix instead of making it when the right answer is the user's call:

- A test fails and it's unclear which side is wrong: should the test change to
  match the code, or the code to match the test?
- The code and a spec or doc disagree and either could be the intended behavior.
- The fix changes public interfaces, user-visible behavior, or data.
- The fix would delete code or tests, install or upgrade dependencies, or
  change CI config.

Batch escalations: give a short overview in chat, then ask each one with
AskUserQuestion, with your recommendation first and the evidence for it. Keep
fixing everything else while you wait.

## 4. Report

```markdown
## Commit prep

### Prerequisites
<ordered list, each marked blocks commit / blocks push>

### Still open
<anything not fixed: escalations the user deferred, failures you couldn't fix,
unfinished work. Each with file:line and what's needed.>

### Fixed
<one line per fix>

### Local CI
| Step | Command | Result |
| --- | --- | --- |
<passed / fixed / failed / not run locally (reason) / not covered (matrix)>

### Changes
<3–6 bullets summarizing what this commit does>

### Commit
<command block(s)>
```

Leave out any section that has no entries.

### Commit command

Write the message in the repo's own convention. Look in this order:
AGENTS.md, CLAUDE.md, CONTRIBUTING, and any docs or submodules those point to
for commit rules; then commitlint or similar config; then `git log` of the last
~20 commits. Follow what you find (Conventional Commits, ticket prefixes,
subject length, body style). Don't impose a format of your own.

Give one block per commit, ready to paste into the user's shell. Stage the exact paths, not
`git add -A`, so flagged files stay out:

```sh
git add -- path/one path/two
git rm -- path/removed
git commit -F - <<'EOF'
<subject>

<body: what changed and why, wrapped per repo convention>
EOF
```

If prerequisites block the push, finish with one line saying which ones must
be done before `git push`.
