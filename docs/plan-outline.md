# Plan outline

The plan outline keeps the path from a goal to the step Claude is on, so you can see where work stands after a detour, a `/clear`, a compaction, or a restart. It is not Claude Code's plan mode.

A goal is the root of one tree. Its steps are units of work with their own outcome. Each step has a state and a kind.

| Mark | State |
| --- | --- |
| `○` | Open |
| `▶` | Active |
| `⏸` | Parked: it was started, then focus moved away |
| `◐` | Waiting for review: a background subagent finished it |
| `✔` | Done |
| `✗` | Dropped |
| `↗` | Deferred: moved to `.backlog/` |

Detours carry a kind mark: `⤷` for work that changes something, `?` for research. Step IDs are dotted numbers (`3`, `3.2`, `3.2.1`). They never renumber and are never reused.

## Where it is stored

| What | Where |
| --- | --- |
| The plan outline's store | `<git dir>/waffles/plan/`, inside the checkout's git dir (`.git/waffles/plan/` in a plain clone). It holds the goal files, `<goal>.md`, one per goal. |
| Locks and session records | `waffles/` inside the checkout's git dir (`.git/waffles/` in a plain clone) |
| The copy on the remote | The ref `refs/waffles/plan/<branch>` |

The plan outline is not in the working tree and is never committed: git never commits its own git dir. It does not show in `git status`, in a diff, or in a pull request's files. Each worktree and each submodule has its own git dir, so its own outline. `git rev-parse --git-dir` prints the git dir of a checkout.

The plan document can sit beside the goal files. A Markdown file in the plan outline's store that is not a goal file stays out of the pane and out of the lists of open goals.

Outside a git repository, and in a bare repository, the plan outline's store and the locks are in the working directory: `.waffles/plan/` and `.waffles/`, with a `.gitignore` of `*` in `.waffles/`, so a repository made there later does not pick them up. When git does not answer inside a repository (a timeout), the tool refuses the change and writes nothing, so no lock lands in the working tree.

### The copy on the remote

A push does not carry the git dir, so the plugin keeps a copy of the plan outline's store on the remote for each branch, for another machine, a teammate, or a fresh clone.

```
git push / gh pr create ─► worked? ─► plan outline's store changed since the last copy? ─► push refs/waffles/plan/<branch>
first plan outline poll or call of a session ─► plan outline's store empty? ─► copy on the remote? ─► fetch it, write its files
gh pr merge ─► worked, and gh reports it merged or closed? ─► delete refs/waffles/plan/<head branch>
```

- **The ref.** One per branch, `refs/waffles/plan/<branch>`, with the branch name as it is: `feat/x` has `refs/waffles/plan/feat/x`. A detached HEAD has no branch, so nothing is copied or restored there.
- **What it holds.** A commit whose files are the Markdown files in the plan outline's store: the goal files and `assumed-for-you.md`. The plugin makes it with git's plumbing, so the index, the working tree, and the branches stay as they are. The commit is never signed and names `waffles` as its author, so it needs neither your key nor your identity.
- **The remote.** The one the branch's upstream names, else `origin`. With neither, nothing is copied.
- **When it is written.** After a `git push` or a `gh pr create` that worked, in the folder the command ran in. When the plan outline's store is the same as the last copy, nothing is pushed. A push of the copy skips the repository's pre-push hooks, which are for its branches. When the copy fails, the model reads one line, and the command's result stays as it was.
- **Restore.** At a session's first plan outline poll or call, once per session: when the plan outline's store holds no Markdown file and the branch has a copy on the remote, the plugin fetches it and writes its files. It never writes over a file.
- **Both sides changed.** Local wins. When the plan outline's store holds a file, nothing is restored, and the next push writes the local files over the copy.
- **After the merge.** After a `gh pr merge` that worked, when `gh` reports the pull request merged or closed, the plugin deletes its head branch's copy on the remote and in the local repository. A pull request merged another way, such as on GitHub's site or by a merge queue, keeps its copy. This command removes it:

  ```sh
  git push origin --delete refs/waffles/plan/<branch>
  ```

GitHub accepts the ref and shows it nowhere on its site. A clone or a fetch of the branches does not fetch it; `git ls-remote origin 'refs/waffles/*'` lists the copies.

The plan outline's store follows the shell's working directory. After a `cd` into a submodule or another repo, the active goal's file is not there. The pane says so, and a call on the goal changes nothing and returns a plain result that tells Claude to `cd` back. The pane draws it as one dim row, not as a failed call.

## What Claude does

You do not maintain the plan outline. Claude changes the tree only through the `plan` tool (`mcp__waffles__plan`), and the tool's code enforces these rules:

- A question, or one change finished in the same reply, starts no goal. A prompt that makes 2 or more steps starts a goal, with all top-level steps added before the work starts.
- A session has 1 goal at a time. With no active goal, work that matches an open goal continues it at its stored current step. While a goal is active, new work goes into its tree, even when it seems unrelated, so the way back stays in 1 tree. Several open goals mean several sessions.
- A detour is added under the current step and made current in the same change, for example `+ 3.2.1 ⤷ Fix CORS on dev proxy under 3.2 → current`. When the current step is not clearly the right place, Claude asks you where it goes: the current step (recommended), a new top-level step, or a step ID you type.
- A step with 2 or more parts gets a child step for each part. A title never lists parts.
- Several steps can be in progress at once: the main thread's, and one for each background subagent. Claude starts a background Agent call's description with the step's ID and a colon (`8.1: Merge the API fixes`), and the plugin marks that step while the subagent works. Focus moving on does not park it. When the subagent finishes, the step shows `◐` until Claude reads the report and closes the step, or focuses it to take the work over. A goal continued or resumed later ends the marks of subagents that no longer run.
- Closing a step makes its parent the current step. A parent never closes by itself. When a step has parked work under it, focus resumes where that work stopped.
- Closing a step that has open children is refused, unless you ask to close the whole subtree.
- A step moved under another parent gets a new ID. Its old ID still works as an alias.

### Steer by ID

Refer to steps by ID in plain language:

| You say | Claude does |
| --- | --- |
| "drop 1.1" | Drops 1.1 and its whole subtree. |
| "close out 1.1.1–1.1.3" | Marks those 3 steps done. |
| "move on to 2" | Makes 2 the current step. |
| "skip ahead to 2.1.3" | Makes 2.1.3 the current step. |
| "that's a detour under 4, not a new goal" | Moves the goal's steps under 4. |
| "backlog 3.4" | Adds a backlog item with `/waffles:backlog`, then marks 3.4 deferred. |

## Pane, footer item, and change rows

- **Colors.** The main thread's step is cyan, a step a background subagent works on is magenta, and a step waiting for review is yellow, each with a bold marker. A step with work in progress under it is bold. A step changed since your last prompt is in italics.
- **Change rows** appear in the transcript for each change, for example `plan outline  ✔ 3.2.1 Fix CORS on dev proxy → back to 3.2 Callback route`.
- **The footer item** is last in the footer's right end, after the effort, while a goal is active, whether or not the pane is open. It shows `▶ Callback route` (`▶` in cyan), the current step's title, cut with `…` to the room the footer has left. With under 36 columns for the title, or no current step, it shows `▶ 5 of 8 steps` instead (the done, dropped, and deferred steps of all the goal's steps). Where that does not fit either, the footer leaves it out. Clicking it opens or closes the pane, as `/waffles:plan` does.
- **The pane** shows the whole tree. In the fullscreen layout it opens by itself and docks beside the transcript, also when the plugin reloads with a goal active. On the main screen layout it does not open by itself: the footer item shows the current step, and `/waffles:plan` opens the pane above the prompt. When a goal ends, or `/clear` leaves no active goal, the pane keeps that goal's tree under a dim `done` or `not active` row until a goal becomes active. A session that has shown no goal shows `No active goal.`

**`/waffles:plan`** opens or closes the pane. Typed during a turn, it runs when the turn ends. The plugin's hook answers it. The skill `skills/plan` only gives the command its name: a plugin cannot register a command named `waffles:plan`, and `/plan` alone is Claude Code's plan mode. When the pane is a tab behind another pane, `/waffles:plan` brings it to the front instead. It takes the keyboard only while the prompt has it and the prompt is empty. Closing the pane with `ctrl+x x` or its close mark counts the same as `/waffles:plan`. The choice is kept across sessions.

## Sessions and locks

Each session has its own active goal. A goal that another live session holds is listed as `in use: other session`, and you cannot continue it until that session ends or its lock goes stale. A lock goes stale 120 s after its last heartbeat (sent every 30 s), so a crashed session does not hold a goal for long.

After compaction, the first message carries the active goal's tree. After `/clear`, the new conversation has no active goal: the first message lists the open goals, and Claude continues the one that matches the work.

A resumed conversation (`--continue`, `--resume`, or `/resume`) gets its active goal back, and the pane shows it as before. Each session records its active goal in `.git/waffles/sessions/<session ID>.json`. The record stays when the session ends and goes when the goal ends or another session takes it. A record that names a goal that is done, deleted, or in use by another live session restores nothing. Then Claude's first plan outline change is refused with the open goals listed, and Claude continues the one that matches. A record not written for 30 days is removed. `--fork-session` starts a new session ID, so it restores nothing.

## The checklist in the pull request

The checkpoint renders the plan outline into the description of the open pull request for the checked-out branch. The result is a Markdown task list between `<!-- waffles:plan-outline:start -->` and `<!-- waffles:plan-outline:end -->` under `## Plan outline`. The rest of the description stays as it is. Where it has no markers yet, the section replaces a `## Plan outline` section, or goes after the other sections, ahead of the attribution lines at the end. It needs `gh`, signed in. The hooks run it after a push (below). To run it yourself, call the waffles checkpoint tool (`checkpoint`, with `{"pr": "<number>", "dryRun": true, "folder": "<checkout>"}`, each optional), or run the script in the checkout, where `<plugin root>` is the plugin's folder:

```sh
node <plugin root>/scripts/checkpoint.ts [--pr <number>] [--dry-run]
```

- It reads the goal files in the plan outline's store. Where there are none, it reads a plain checklist file there. A plan document is not a checklist and stays out. Several goals each get a `###` heading.
- A done step is ticked. A dropped step is ticked and struck through, and a step moved to the backlog is ticked and names its backlog file. Notes and kind markers are left out.
- When `assumed-for-you.md` is in the plan outline's store, the section ends with its list under `### Assumed for you`: a record of the decisions an agent made in your place.
- A branch that is not pushed, or commits that are not pushed, put an "Ahead of the branch" line above the checklist.
- A merged or closed pull request is left as it ended.
- It never commits or pushes, and a second run with nothing changed changes nothing.
- The script exits 0 when the description is up to date or there is nothing to do, 1 when git or `gh` fails, and 2 for bad arguments. What it did goes to stdout, and why it failed goes to stderr. The tool answers with the same line, and refuses with the failure's.
- A description that the platform passed on only in part (Claude Code passes on 4 MiB of a command's output) is a failure: the checkpoint never writes back a part.

Checkpoints run after each `git push` and `gh pr create`, through the hooks below. A checkpoint at the end of a run or at the end of a session is not made: the push at a stop is what brings the checklist up to date.

A hook on the Bash tool runs the script after `git push` and `gh pr create`, for Claude and for subagents alike. When the command worked, the hook runs the checkpoint script in the folder the command ran in, then updates [the copy on the remote](#the-copy-on-the-remote), and the model reads the checkpoint's one-line outcome, or its failure line. After a `gh pr merge` that worked, the hook runs no checkpoint: it only removes the merged branch's copy. A leading `cd <dir> &&`, or `git -C <dir>` for a push, names that folder, and `~` is the home folder. A folder named with `$` cannot be told from the command, so that push gets no checkpoint.

## Runs

The plan outline is kept during `/waffles:non-interactive` runs, so you can see where a run stands when you return. See [Unattended runs](unattended-runs.md). It is off for subagents.
