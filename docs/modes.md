# Modes

A session runs in one of 4 modes. Claude always knows which one, and the footer under the prompt shows it.

| Mode | Command | Footer | Who is there |
| --- | --- | --- | --- |
| Production | `/prod` | cornflower blue `● production` | You. Work meets the usual standards. |
| Rapid | `/rapid` | chartreuse `● rapid` | You, trying a change to judge it. |
| Backlog | `/backlog-entry` | purple `● backlog` | You, dumping ideas. |
| Non-interactive | `/waffles:non-interactive` | orange `▶ non-interactive` | Nobody. See [Unattended runs](unattended-runs.md). |

`/prod`, `/rapid`, and `/backlog-entry` are commands of the plugin's hooks and have no `waffles:` prefix. `/clear` returns the session to production mode. Starting a run takes over from any other mode. `/prod`, `/rapid`, `/backlog-entry`, and `/clear` end a run.

## Production mode

`/prod` is the default mode. You are present, and work meets the usual standards: tests, checks, reviews, and docs.

## Rapid mode

`/rapid` switches to rapid iteration, to try a change and judge it. Claude makes each change directly, without writing or running tests, linters, type checks, or reviews, without docs or polish, and without committing. The changes stay in the working tree for you to keep or discard. Replies are brief. Starting rapid mode ends a run.

On entering rapid mode, the plugin records the base of the rapid work: `HEAD`, and the paths `git status` already lists, which the rapid work excludes. Outside a git repository, or before its first commit, it records none, and says so. The base stays pending through backlog mode, a run, and `/rapid` again, until production mode starts.

- `/prod` notes the rapid work and its base, then submits a short prompt from the plugin, so Claude starts at once. Claude assesses the diff against the base, estimates the work, and lists what would bring it to spec (tests, checks, cleanup, docs). Then it asks which to do:
  - **Bring up to standards** now.
  - **Defer (stash)**: stash only the rapid changes, and add a backlog item that names the stash.
  - **Defer (unstaged)**: leave them uncommitted, and add a backlog item that lists them.

  There is no option to discard the rapid work. Do that yourself with git if you want it gone. While rapid work is pending, nothing is committed in any mode. Any of the 3 picks lifts that, and commits then follow the new mode's usual rules.
- The first prompt you type after a run that started in rapid mode carries the same note.
- After `/clear`, the first message of the new conversation names the pending rapid work.

The base is cleared once that note, or that first message, has been sent. Claude owns the rapid work from there.

## Backlog mode

`/backlog-entry` switches the session to backlog mode. Every prompt you type, including ones typed while a turn runs, goes verbatim to `/waffles:backlog` instead of being worked on, and the reply is only that skill's report. Slash commands run as usual. Auto effort picks each turn's level from the prompt as usual. `/prod` or `/clear` returns to production mode, and so does starting `/waffles:non-interactive`.

Run `/waffles:work-loop` in one session, and use backlog mode in another as ideas come up. See [Backlog](backlog.md).

## Mode statements

Rules from an earlier mode, such as the non-interactive skill's, must stop applying once the mode changes. Claude therefore reads the current mode from the conversation:

- A fixed system prompt section, `waffles:modes`, defines each mode. It says the most recent `waffles mode: <mode>` statement in the conversation is the current one, and that it overrides instructions from any earlier mode, including a skill loaded in that mode.
- The first message of each conversation states the mode: at the start, after `/clear`, and after a compaction.
- Each change adds one note to the conversation, for example `waffles mode: production. The non-interactive run has ended…`. Changes are `/prod`, `/rapid`, `/backlog-entry`, starting a run, and the first prompt you type after a run.
- In backlog mode each typed prompt carries `waffles mode: backlog`.
- Compaction leaves the notes out of the summary, since the next first message restates the mode.

The section holds the same text in every request, so the prompt cache stays valid. The mode describes the main conversation with you. A subagent follows the brief of the agent that started it, in every mode.

The same section states the commit and push rules for work with a plan outline, so they hold in production mode and during a run. See [Plan outline](plan-outline.md) and [Skills](skills.md#commit-prep).

## Auto effort

A hook picks the effort level for each prompt you type. Before the turn's first request, a short Haiku call reads the prompt and Claude's last reply and picks one level:

| Level | When |
| --- | --- |
| Low | Questions, lookups, small edits the prompt spells out. |
| Medium | Everything else. |
| High | Debugging an unknown cause, multi-file changes, reviews, and anything touching auth, migrations, money, or concurrency. |
| Extra high | A long job you hand off. |

Approvals such as "yes" or "go on" keep the last turn's level. The pick applies to that turn's main-chat requests only: your `/effort` setting and the menu do not move, and subagents are untouched. Slash commands, notifications, and scheduled triggers keep your setting, as does a pick that fails or takes more than 8 seconds. Changing the setting mid-turn wins.

`/waffles:non-interactive` is the exception. It holds every main-chat turn at Extra high, including the turns background agents start when they finish, until you type your next prompt.

**`/auto-effort [on|off]`** shows or changes the state, which is kept across sessions. On (the default) picks a level before each turn. Off runs every turn at your effort setting: the default, or the level you last set with `/effort`. Running `/effort <level>` also turns auto effort off. The rubric is the prompt in `hooks/effort.tsx`.

### The footer row

The footer's right end holds, from the left, separated by `·`:

| Item | Shows |
| --- | --- |
| Mode | An orange `▶ non-interactive` during a run, else a purple `● backlog`, a chartreuse `● rapid`, or a cornflower blue `● production`. |
| Dev servers | `⎔ 2` with the count of dev servers running from the project. See [Skills](skills.md#dev-server). Left out with none. |
| Effort | `effort: auto` while waiting for a prompt, `effort: auto (high)` once a turn's level is decided, `effort: auto (picking…)` during the pick, and the setting alone (`effort: high`) when auto effort is off. |
| Plan outline | `▶ Callback route`, the current step. See [Plan outline](plan-outline.md). |
