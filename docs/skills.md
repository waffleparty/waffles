# Skills

Skills that are not part of the backlog or unattended-run workflows. Each runs as `/waffles:<name>` on Claude Code; the other platforms' pages say how they run a skill.

A skill's text is the same on every platform, so it names things in a form true on all of them:

| Thing | How a skill names it |
| --- | --- |
| A tool of the plugin | Its core name, such as `builders`, with the note that each platform adds its own prefix (`mcp__waffles__builders`) |
| The question tool | "ask the user a multiple-choice question (`AskUserQuestion` on Claude Code)" at its first use in a file, then "the question tool" |
| Another skill of the plugin | By its name, such as "the waffles backlog skill"; `/waffles:backlog` on Claude Code only where the person types it |
| A capability only some platforms have | What is needed in plain words, then Claude Code's tool as the example (the Agent tool with `model` and `effort`, SendMessage, Monitor, auto mode), and what to do where the platform lacks it |
| An agent in `agents/` | Its Claude Code name, such as `waffles:implementer`, with the role it stands for, so another platform starts its own agent for the role |

The texts the hooks write, such as the modes' rules and a run's refusals, take the platform's own forms from the adapter's names (`Names` in `core/host.ts`).

## Commit prep

**`/waffles:commit-prep`** gets pending changes ready to commit. It runs only when you type it.

1. It lists prerequisites: symlinked or `file:` packages, versions that are not published yet, cross-repo changes, and new environment variables or migrations. It marks each as blocking the commit or the push, and lets you resolve them or continue.
2. It reviews the diff for unfinished work (TODOs, debug output, skipped tests, stale generated files) and for drift between code and specs or docs. At the same time it runs the repo's CI steps locally. It finds them in the repo's CI configuration, whichever system it is (GitHub Actions, GitLab CI, CircleCI, Jenkins, Azure Pipelines, Bitbucket Pipelines, Buildkite, and others), and in local hooks such as `pre-commit`, husky, and lefthook. A step that needs CI secrets or that deploys is not run, and the report says so.
3. It fixes what it can, and asks you about fixes that are your call, such as whether to change a failing test or the code.
4. It ends with a report, a summary of the changes, and a paste-ready `git commit` command written in the repo's own commit convention. Nothing is committed.

The skill also holds the commit and push rules for work with a plan outline. The modes' system prompt section states them, so they hold in production mode and during a run:

```
step ─► checks pass ─► commit ─► first commit? ─► push ─► draft pull request
                                 milestone or stop? ─► push
last commit ─► push ─► gh pr ready
```

- The plan outline is not in the working tree and is never committed.
- The push of the first commit opens a draft pull request.
- Each outline step is one commit, made once the checks pass.
- The branch is pushed at each milestone (a top-level step done with all its children, or the last commit before review), and whenever work stops short of one.
- No commit message holds a skip tag such as `[skip ci]`.
- Once the last commit is pushed, `gh pr ready` marks the pull request ready.
- The squash commit's body is a digest: the essence of the change in about 10 lines, then the pull request's link.

## Dev server

**`/waffles:dev-server [app]`** starts the current project's dev server as a background task. It takes the command from the repo's docs, then from its task runners, then from the stack's default (`package.json` scripts, `bin/dev`, `manage.py runserver`, `mix phx.server`, `go run`, `cargo run`, `docker compose up`, a static site generator's serve command, and others). If several candidates remain, it asks you.

- If the server is already running, it reuses it. A running server counts as the project's only if its working directory is the project root or inside it. A sibling worktree or a builder's clone is another project.
- If dependencies are missing, it installs them from the lockfile without changing it.
- If the port is taken by something else, it picks a free one.
- It waits until the server answers, then reports the URL.

Claude can also run it on its own when you ask to start the app. It needs `lsof` for the ownership check.

### Dev servers pane

While a dev server runs from the project, the footer shows `⎔ 2`, the count of listening servers whose working directory is inside the project. Pressing it opens a list of their URLs. Pressing a URL, or its number key, opens it in the browser: with `open` on macOS and `xdg-open` on Linux. The plugin finds the servers with `lsof`, and polls every 5 seconds. With a server up, `/waffles:dev-server` with no argument lists the running servers instead of starting one.

## Watch CI

**`/waffles:watch-ci [commit | branch | PR | run URL]`** watches the CI/CD runs for the work in the current context: the commits, pull request, merge, or tag it pushed.

It finds the toolchain (GitHub Actions, GitLab CI, CircleCI, Buildkite, Azure Pipelines, Bitbucket Pipelines, Jenkins, CD platforms that report to the forge, and others), and maps the whole pipeline before it starts: the runs that exist and the ones that start later, such as a deploy that runs after CI. A run counts only if its commit and its trigger event match this context's work, so other people's runs on the same branch are left out.

The map then goes to a background `waffles:ci-watcher` agent that runs `skills/watch-ci/watch.ts`. The agent wakes the main agent only when it must act: a failure, an approval, a stall, or the end. Progress shows silently in the background-task panel, for example `CI 3/5 jobs · now "Run tests"`, and the session stays marked as busy while CI runs.

- On success it reports and stops.
- On a failure it reads the logs, reruns transient failures once, and fixes failures the change caused, without weakening CI. It pushes the fix only if the context already pushed to that branch, then watches the new run.
- It never approves deploys.
- If the runs already finished, it reports the result, and fixes failures, without starting a watcher.

Claude also runs it on its own after a push. It requires Node.js 22.18 or later in the 22 line, or 24.3 or later, and an authenticated `gh` for GitHub-hosted CI. The plugin does not install them.

## Debate

**`/waffles:debate [question]`** argues a decision from several viewpoints, using the question and the recent conversation for context. It gives each option its strongest case and rebuttal, then a comparison and a verdict.

Scope narrows the debate:

- Name the options (`A or B?`), and it compares only those. It adds another only when it is the established best practice.
- Name the criteria (`performance and scalability`), and it judges on those. It adds another only when it could decide an option's viability on its own, such as an unacceptable license, or a maintenance cost that cancels the gains.
- With no question, it debates the most recent open decision in the conversation.

## Ask

**`/waffles:ask [topic | file]`** collects the open items in the recent conversation (unanswered questions, options without a pick, flagged assumptions, TBDs in the spec being discussed) and asks you about them, up to 4 independent questions at a time.

Each question carries enough context to answer without scrolling back, 2 or 3 options with a recommendation and its rationale, and a final **Defer for further discussion** option. Every option has a preview, so you can press `n` to add a note. On Defer, the note sets the direction for the discussion.

Answers are written where the work lives: the spec, plan, or doc being discussed, or a backlog item's clarifications. With only code in play, the summary is the record. The skill ends with a summary of what was decided and what is still open, then starts the discussions your Defer notes asked for, and resumes any task that was waiting on the answers. Claude also uses it when you ask to go through the open questions.

## UX review

**`/waffles:ux-review [pages | review link]`** reviews the UI touched by pending changes, or the pages named, for visual clarity and polish, not just function.

1. It splits the scope into areas, one per job a person does on those screens, and asks you to confirm them.
2. Lightweight agents capture the screenshots in parallel, in the app's default light mode unless you name another.
3. One analyst looks at the screenshots, measures what it suspects in the running app, and draws options, leaning towards distinct directions. The default analyst is `fable` at `high` effort when the Agent tool offers it, else `opus` at `high`. A re-run with another model or effort is available on request.
4. It makes at most 10 suggestions, grouped by area on one review page, and says whether another pass is advisable. A later pass skips what earlier passes built or kept.
5. On that page each suggestion pairs a crop of today's UI with one or more high-fidelity "after" mockups drawn at true size in the app's own tokens. You pick an option, or keep the before, and add notes on the page, then press Submit.
6. The session notifies and builds your picks. Pass the review's link later to build from it in a new session.

The review page is published as a private artifact, so the skill needs a Claude Code session that can publish artifacts. The run's files are in `.ux-review/<run-id>/` at the repo root, which the skill adds to `.git/info/exclude`. Your design preferences are in `skills/ux-review/taste.md`, the judgment calls a design system leaves open. Edit it to match your taste. Claude also uses the skill when you ask for a UX or design review. Nothing is committed.
