---
name: dev-server
description: Start the current project's dev server as a background task — work out the right command for whatever stack the repo uses, reuse a server that's already running, wait until it's ready, and report the URL. Use when the user asks to start, run, or spin up the dev server or local app.
argument-hint: "[app or package name, or extra args]"
---

# Dev server

Start the dev server for the project in the current working directory as a
background task, confirm it's actually serving, and tell the user where it is.
Arguments, if given, name which app to start (in a monorepo) or extra flags to
pass through.

## Ownership check

A port that answers proves nothing: another project's server may hold it.
Never report a server as this project's unless it passes this check.

1. Find the listener: `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`.
2. Get its working directory: `lsof -a -p <pid> -d cwd -Fn` (the line
   starting with `n`).
3. Compare real paths, not strings: resolve both sides with `pwd -P` (the
   same repo can be reached through symlinks or other mounts). The listener's
   directory must be the project root (`git rev-parse --show-toplevel`, then
   `pwd -P`) or inside it. A sibling worktree or a builder's clone of the same
   repo is a different project.
4. Docker: the listener is Docker's own process, so steps 1–3 can't match.
   Instead, confirm the port appears in `docker compose ps` run from this
   project.

If the check fails, the port belongs to something else. Say what it is
(`ps -o pid=,command= -p <pid>` plus its directory), and treat the port as
taken (step 3).

A review branch (`waffles-review`, which the waffles work-loop skill builds in the
main checkout to show several pull requests at once) is the main checkout's
project: one server serves it. When that branch is rebuilt, the running
server stays, if it reloads changed files; otherwise restart it once.

## 1. Already running?

Check before starting anything:

- Background tasks from this session that are still running a dev server.
- Each listening port (`lsof -nP -iTCP -sTCP:LISTEN`) whose process passes the
  ownership check.

If it's already up, report its URL and stop. Don't start a second copy.

## 2. Find the command

Use the first source that answers it:

1. **Project docs:** CLAUDE.md, AGENTS.md, README, CONTRIBUTING, `docs/`
   ("development", "running locally", "getting started").
2. **Project runners:** `bin/dev`, `Procfile.dev`, a `dev`/`serve`/`run` target in
   a Makefile, justfile, Taskfile, or mise tasks.
3. **Stack defaults:**

| Signal | Command |
| --- | --- |
| `package.json` | the `dev` script, else `serve`/`start:dev`/`start`; run with the package manager from `packageManager` or the lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock*`, `package-lock.json`) |
| Turborepo / Nx / workspaces | the root `dev` script, or the one app named in the arguments or containing the cwd |
| Rails | `bin/dev`, else `bin/rails server` |
| Django | `python manage.py runserver` (via `uv run`/`poetry run` if the project uses them) |
| FastAPI / Flask | `uvicorn <module>:app --reload` / `flask --app <module> run --debug` |
| Phoenix | `mix phx.server` |
| Go | `air` if `.air.toml` exists, else `go run .` (or the `cmd/<name>` that is the server) |
| Rust | `cargo watch -x run` if cargo-watch is installed, else `cargo run` |
| Hugo / Jekyll / Astro / etc. | the generator's serve command (`hugo server`, `bundle exec jekyll serve`, …) |
| Only `compose.yaml` / `docker-compose.yml` | `docker compose up` |

If several candidates remain and the docs don't settle it (e.g. separate
frontend and backend with no combined script), ask the user a multiple-choice
question (`AskUserQuestion` on Claude Code), with your recommendation first. If
there's no server at all (a library or CLI), say so and stop.

## 3. Prerequisites

- **Dependencies missing** (no `node_modules`, no `.venv`, `bundle check`
  fails): install from the lockfile without changing it (`npm ci`,
  `pnpm install --frozen-lockfile`, `uv sync --frozen`, `bundle install`, …).
  Don't add or upgrade packages.
- **Env file:** if `.env.example` (or similar) exists and `.env` doesn't, don't
  invent values. Say what's missing and start anyway if the server can boot
  without it.
- **Backing services** (database, Redis, queues): if the docs say to start them
  first (e.g. `docker compose up -d db`), do it. Otherwise note them and
  continue.
- **Port taken by something else:** don't kill it. Use the tool's port flag or
  env var (`--port`, `PORT=`) to pick a free port.

## 4. Start it

Run the command as a background task of the platform (on Claude Code, Bash
with `run_in_background: true`) from the directory it belongs in. Don't add
`&`, `nohup`, or `disown`; the harness tracks the task and captures its output.
Where the platform has no background task, start it with
`nohup <command> > <log> 2>&1 &` instead, and read `<log>` as the task's
output. Leave out flags that open a browser.

Wait until it's ready: use a background watch (Claude Code's Monitor tool)
with an until-loop that watches the task's output for a ready line ("Local:",
"ready", "listening on", "started server") or an error, and give up after
~2 minutes. Where the platform has no background watch, run the until-loop as
a shell command. It's up only when all of these hold:

- The background task is still running. "Address already in use" or
  `EADDRINUSE` in the output means it failed, even if the port answers.
- The port comes from this task's own output, not from config or defaults.
  Many tools quietly move to the next free port.
- That port passes the ownership check.
- `curl -sI` against that URL responds.

If it exits or errors, read the output, fix what's clearly fixable
(missing install, port clash), and retry once. Otherwise report the error.

## 5. Report

Keep it short:

- Command and directory
- URL(s) it's serving on
- Background task ID, and that you can stop it on request (it also stops when
  the session ends)
- Anything skipped or missing (env vars, services not started)
