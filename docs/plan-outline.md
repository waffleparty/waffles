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
| Goal files | `.tmp/plan/<goal>.md`, one file per goal, at the top level of the checkout |
| Locks and session records | `waffles/` inside the checkout's git dir (`.git/waffles/` in a plain clone), which git never commits |

The `.tmp/plan/` folder is committed on the feature branch, so a second machine or a teammate reads the plan outline after a pull. The last step of every outline, "Remove the working files", deletes `.tmp/` before the merge. Each worktree and each submodule has its own outline, on its own branch.

The plan document can sit beside the goal files in `.tmp/plan/`. A Markdown file there that is not a goal file stays out of the pane and out of the lists of open goals.

Outside a git repository, and in a bare repository, both folders are in the working directory: `.tmp/plan/` and `.tmp/waffles/`, with a `.gitignore` of `*` in `.tmp/waffles/`. When git does not answer inside a repository (a timeout), the tool refuses the change and writes nothing, so no lock lands in the working tree.

The folder follows the shell's working directory. After a `cd` into a submodule or another repo, the active goal's file is not there. The pane says so, and a call on the goal changes nothing and returns a plain result that tells Claude to `cd` back. The pane draws it as one dim row, not as a failed call.

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

`scripts/checkpoint.ts` renders the plan outline into the description of the open pull request for the checked-out branch. The result is a Markdown task list between `<!-- waffles:plan-outline:start -->` and `<!-- waffles:plan-outline:end -->` under `## Plan outline`. The rest of the description stays as it is. Where it has no markers yet, the section replaces a `## Plan outline` section, or goes after the other sections, ahead of the attribution lines at the end. It needs `gh`, signed in. Run it in the checkout, where `<plugin root>` is the plugin's folder:

```sh
node <plugin root>/scripts/checkpoint.ts [--pr <number>] [--dry-run]
```

- It reads the goal files in `.tmp/plan/`. Where there are none, it reads a plain checklist file there. A plan document is not a checklist and stays out. Several goals each get a `###` heading.
- A done step is ticked. A dropped step is ticked and struck through, and a step moved to the backlog is ticked and names its backlog file. Notes and kind markers are left out.
- When `.tmp/plan/assumed-for-you.md` is there, the section ends with its list under `### Assumed for you`: a record of the decisions an agent made in your place.
- Changes that are not committed, or commits that are not pushed, put an "Ahead of the branch" line above the checklist.
- After the commit that removes `.tmp/`, the checklist is the outline from before that commit, with "Remove the working files" ticked. A merged or closed pull request is left as it ended.
- It never commits or pushes, and a second run with nothing changed changes nothing.
- It exits 0 when the description is up to date or there is nothing to do, 1 when git or `gh` fails, and 2 for bad arguments.

Checkpoints run after each `git push` and `gh pr create`, through the hooks below. A checkpoint at the end of a run or at the end of a session is not made: the push at a stop is what brings the checklist up to date.

A hook on the Bash tool runs the script after `git push` and `gh pr create`, for Claude and for subagents alike. When the command worked, the hook runs the checkpoint script in the folder the command ran in, and the model reads its one-line outcome. A leading `cd <dir> &&`, or `git -C <dir>` for a push, names that folder, and `~` is the home folder. A folder named with `$` cannot be told from the command, so that push gets no checkpoint.

The plugin does not stop a merge while `.tmp/` is on the head branch. The "Remove the working files" step is what keeps the working files off the default branch. A repo can add a CI check that fails while `.tmp/` is on a branch.

## Runs

The plan outline is kept during `/waffles:non-interactive` runs, so you can see where a run stands when you return. See [Unattended runs](unattended-runs.md). It is off for subagents.
