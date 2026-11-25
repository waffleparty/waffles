---
name: watch-ci
description: Watch the CI/CD pipelines for the work in this context (the commits, PR, merge, or tag just pushed) from the background with live progress, report success, and debug and fix failures. Works out the CI/CD toolchain itself and watches every related run, CI and CD alike, but no unrelated ones. Use after pushing changes, opening or updating a PR, or merging, and when the user asks to watch, check, or babysit CI, builds, checks, or deploys.
argument-hint: "[commit, branch, PR number, or run URL]"
---

# Watch CI

Watch every CI/CD run that this context's work started, from the background, and
act on the result: report success and stop, or debug and fix a failure. You can
be invoked by the user or by another agent, usually right after a push.

The order matters: **map the whole pipeline first, then start one watcher.** The
watcher (`watch.py` in this skill's base directory) only polls the targets in the
map. It never decides what to watch next.

```
1 Anchors ─► 2 Toolchain ─► 3 Map ─► 4 Snapshot ─┬─ all settled ─► 6 Act
                                                 └─ in flight ──► 5 Watch ─► 6 Act
```

## 1. Anchors

An anchor is one thing this context pushed: `(repo, sha, ref, event)`. Collect
them in this order:

1. **Arguments:** a commit, branch, PR number, or run URL names the anchor.
2. **This conversation:** every push, PR opened or updated, PR merged (its merge
   commit on the base branch), and tag pushed. For several pushes to the same
   ref, keep only the latest SHA: earlier runs are superseded.
3. **Fallback:** `HEAD` of the current branch, if it's pushed
   (`git rev-parse HEAD` equals `git rev-parse @{u}`), plus its open PR if any
   (`gh pr view --json number,headRefOid,url`).

If `HEAD` isn't pushed and nothing else names an anchor, say there's nothing to
watch and stop.

**Scope rule:** a run belongs to this context only if its SHA *and* its event
match an anchor. Never select runs by branch alone: on a shared branch other
people's pushes run there too. Never select by SHA alone either: `issues`,
`schedule`, `workflow_dispatch` and similar events report the default branch's
`HEAD` as their SHA. Downstream runs (`workflow_run`, `deployment`, `release`) count
when the map says an anchored run triggers them.

## 2. Toolchain

Find every system that runs CI or CD for these anchors. More than one is common
(e.g. GitHub Actions for CI and Vercel or Argo CD for CD).

| Signal | System | Read with |
| --- | --- | --- |
| `.github/workflows/*.yml` | GitHub Actions | `gh` |
| `.gitlab-ci.yml` | GitLab CI | `glab ci`, or the API |
| `.circleci/config.yml` | CircleCI | API v2, or its status on the forge |
| `.buildkite/` | Buildkite | `bk`, or the API |
| `azure-pipelines.yml` | Azure Pipelines | `az pipelines runs` |
| `bitbucket-pipelines.yml` | Bitbucket Pipelines | API |
| `Jenkinsfile` | Jenkins | its status on the forge, or the Jenkins API |
| `.drone.yml`, `.woodpecker.yml`, `.travis.yml`, `cloudbuild.yaml` | Drone, Woodpecker, Travis, Cloud Build | their CLI or status on the forge |
| `vercel.json`, `netlify.toml`, `render.yaml`, `fly.toml`, Argo CD / Flux manifests | CD platforms | their check run or commit status on the forge |

Also look at the check runs and commit statuses already on each anchor's SHA
(`gh api repos/{o}/{r}/commits/{sha}/check-runs` and `…/statuses`). Almost every
external system reports there, which makes it the fallback when a native CLI is
missing or not authenticated. Prefer a native CLI or MCP tool when it is available
and authenticated (`gh auth status`, `glab auth status`, …). Don't install CLIs
or ask for tokens: fall back to the forge status, and say which system you could
only watch at that level.

Leave out checks that aren't CI/CD: review bots, coverage comments, and labelers,
unless the base branch requires them
(`gh api repos/{o}/{r}/branches/{base}/protection/required_status_checks`).

## 3. Map

Build the complete pipeline for every anchor before you start the watcher: the
runs that exist now *and* the runs that will start later.

For GitHub Actions:

1. **Triggered now:** for each workflow, check its `on:` against the anchor:
   event, branch or tag filters, `paths`/`paths-ignore` against the pushed diff.
   Match those workflows to the existing runs:
   `gh run list --commit <sha> --json databaseId,workflowName,event,status,conclusion,url`.
2. **Triggered later:** follow `workflow_run` chains (`workflows:` + `types:`),
   `deployment` / `deployment_status`, `release`, and tag pushes that a job
   makes. Each becomes a target with `after:` naming the target that triggers it.
3. **Jobs:** count each run's jobs from the YAML, with each `matrix` expanded and
   jobs whose `if:` can't run on this event left out. That's `expected_jobs`.
   Reusable workflows (`uses: ./.github/workflows/…`) run inside their caller's
   run: don't add a separate target for them. Note environments with required
   reviewers: those jobs will wait for approval.

For other systems, do the same from their config and API: one target per
pipeline that will run for the anchor, with `after:` for pipelines that start
when another one finishes.

### Map file

Write it to `$(git rev-parse --git-dir)/watch-ci/<short-sha>.json` (create the
directory). List targets in dependency order: upstream before downstream.

```json
{
  "context": "abc1234 pushed to feature/x (PR #12)",
  "poll_seconds": 30,
  "targets": [
    {"id": "ci", "label": "CI", "kind": "gh-run", "repo": "o/r", "run_id": 123, "expected_jobs": 5},
    {"id": "deploy", "label": "Deploy preview", "kind": "gh-workflow", "repo": "o/r",
     "workflow": "deploy.yml", "sha": "abc1234…", "event": "workflow_run", "after": ["ci"]},
    {"id": "vercel", "label": "Vercel", "kind": "gh-check", "repo": "o/r", "sha": "abc1234…", "name": "Vercel"},
    {"id": "circle", "label": "CircleCI build", "kind": "gh-status", "repo": "o/r", "sha": "abc1234…", "context": "ci/circleci: build"},
    {"id": "gl", "label": "GitLab pipeline", "kind": "command", "command": "glab api projects/:id/pipelines/456 | jq -c '…'"}
  ]
}
```

| Kind | Watches | Required fields |
| --- | --- | --- |
| `gh-run` | an Actions run that already exists | `repo`, `run_id` |
| `gh-workflow` | an Actions run that may not exist yet | `repo`, `workflow` (file or name), `sha`; `event` to filter |
| `gh-check` | a check run on a SHA | `repo`, `sha`, `name` |
| `gh-status` | a commit status on a SHA | `repo`, `sha`, `context` |
| `command` | anything else | `command` printing one JSON object (below) |

Optional on any target: `after` (target ids this one starts after),
`needs_success` (default `true`: if an `after` target fails, mark this one
skipped instead of waiting), `expected_jobs`, `appear_minutes` (default 10: how
long a target may stay absent before it's reported missing). Optional at the top
level: `poll_seconds` (30), `stall_minutes` (30: queued that long is reported as
stalled), `max_minutes` (180).

A `command` prints
`{"state": "...", "url": "...", "detail": "...", "jobs": [{"name": "...", "state": "...", "steps_done": 2, "steps_total": 9, "current_step": "...", "failed_step": "..."}]}`.
`state` is one of `absent`, `queued`, `running`, `waiting` (for approval),
`success`, `failure`, `cancelled`, `skipped`. Only `state` is required. Test the
command once by hand before you add it.

Show the user the map as a tree before you start watching:

```
abc1234 → feature/x (PR #12)
├─ CI (run 123) ─ lint · test ×3 · build
│  └─ Deploy preview (after CI) ─ deploy-preview
├─ Vercel (check)
└─ CircleCI build (status)
```

## 4. Snapshot

Run `python3 -I <skill-dir>/watch.py <map> --once`. It polls each target one
time and prints its state.

- Ends with `ALL_DONE`: everything already finished. Don't start a watcher. Report
  (step 6), and fix if anything failed.
- Ends with `PENDING`: start the watcher (step 5). If the snapshot already shows
  a `FAIL`, start on that failure (step 6) at the same time.

## 5. Watch

Start the `waffles:ci-watcher` agent in the background (Agent tool,
`run_in_background: true`, `description`: `Watch CI/CD for <short-sha>`), with
this brief:

```
Run: python3 -I <skill-dir>/watch.py <map> --until-actionable
```

Don't use the Monitor tool, and don't poll the runs yourself. Every Monitor event
wakes you for a turn, and every turn pings the user. The watcher agent blocks on
the script and returns only when you must act, so you wake once per decision. It
also keeps the session marked as busy while CI runs. Its current Bash
description shows the live progress (`CI 3/5 jobs · now "Run tests"`) in the
background-task panel, so you don't need to report progress.

Then go on with other work, or end the turn. When the agent returns, its report
is the event lines since it started, then `RETURN` or `ALL_DONE <result>`:

| Event | Meaning | Do |
| --- | --- | --- |
| `DONE` | a target succeeded | nothing |
| `FAIL` | a target failed (job, step, URL) | start the watcher again, then start step 6 |
| `WAITING` | a job waits for a manual approval | tell the user; never approve it yourself |
| `SKIPPED` | upstream failed, so this never ran | nothing; the upstream `FAIL` covers it |
| `MISSING` | an expected run never appeared | check the map (trigger, paths filter); report it |
| `STALLED` | queued too long | report it (no runner, concurrency group, quota) |
| `CANCELLED` | run cancelled | if a newer push superseded it, ignore; otherwise report |
| `ERROR` | 3 polls in a row failed | check auth or network; fix the map if a field is wrong |
| `TIMEOUT` | `max_minutes` passed | report what didn't settle |
| `ALL_DONE <result>` | every target settled | step 6 |

After `RETURN`, start the watcher again with the same brief if targets are still
in flight. The watcher keeps its state in `<map>.state.json`, so it never
repeats an event. If the user asks for status while it runs, run
`watch.py <map> --once`.

## 6. Act

### Success

Report it in one line and stop: `CI/CD green for abc1234: CI ✓ · Deploy preview ✓ · Vercel ✓`.
Stop any watcher agent still running (TaskStop).

### Failure

Work each failure as soon as its `FAIL` arrives.

1. **Read the failure:** `gh run view <run> --log-failed`, or
   `gh run view --job <job-id> --log` for one job. For other systems, use their
   log command or the URL in the event.
2. **Classify:**

| Cause | Do |
| --- | --- |
| This context's change (test, type, lint, build, config, deploy manifest) | fix it |
| Transient (runner lost, network timeout, registry or API 5xx, rate limit) | rerun the failed jobs once (`gh run rerun <run> --failed`), add the run to the watch, and treat a second failure as real |
| Already failing on the base branch before this change (check its latest run) | report it; fix only if it's small and in scope |
| Secrets, permissions, quotas, external outage, approval needed | report it; it needs the user |

3. **Fix the root cause.** Reproduce it locally with the same command and tool
   versions CI uses, fix it, and confirm the fix locally before you push.
   Never make CI pass by weakening it: no skipped or deleted tests,
   `continue-on-error`, looser lint rules, longer timeouts without a cause, or
   `[skip ci]`.
4. **Push the fix** following the repo's and the user's commit rules. Push only
   when this context already pushed to that branch, or the user asked you to push.
   Otherwise, commit and ask. Always ask before you push to the default branch,
   force-push, re-run or trigger a deploy, or approve an environment.
5. **Watch again:** the fix is a new anchor. Go back to step 1, map it fresh, and
   stop the old watcher agent. After 3 fix rounds for the same failure, stop and
   report what you tried.

### Report

When everything is settled, or you've stopped:

```markdown
## CI/CD: abc1234 → feature/x

| Target | Result | Link |
| --- | --- | --- |
| CI | ✓ success (5 jobs) | <url> |
| Deploy preview | ✗ failed in `deploy`: "Apply manifests" | <url> |

**Fixed:** <one line per fix, with its commit>
**Needs you:** <approvals, secrets, base-branch failures, stalls>
```

Leave out sections that have no entries.
