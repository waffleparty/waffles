# Unattended runs

**`/waffles:non-interactive [task]`** finishes the current task, or the one given, while you are away. It makes decisions for you instead of asking, and carries the work all the way: it commits, merges through a pull request, and releases and publishes what the task calls for. The run lasts until you type your next prompt.

The main thread runs at Extra high effort (see [Auto effort](modes.md#auto-effort)). It splits the task into pieces and maps which depend on which. A piece is one item: a builder in its own full clone, on its own branch, with its own draft pull request, stacked on the branch of a piece it depends on. Pieces with no outstanding dependencies are built in parallel. Each piece goes to the plugin agent that fits it:

| Agent | Model, effort | Used for |
| --- | --- | --- |
| `waffles:test-runner` | Haiku, low | Running tests, linters, and type checks; reporting failures. |
| `waffles:ci-watcher` | Haiku, low | Waiting on CI/CD runs for watch-ci; never fixes or approves. |
| `waffles:implementer` | Sonnet, medium | Building a fully specified piece. |
| `waffles:implementer-hard` | Opus, high | Unknown bugs, multi-file refactors, risky areas. |
| `waffles:reviewer` | Opus, high | A fresh-eyes review of the finished change (read-only). |
| `waffles:decider` | The most capable model available, high | Hard decisions (read-only). |

Code searches go to the built-in `Explore` agent on Haiku. The main thread makes small edits itself, since delegating those costs more. The agents load with the plugin and are also available outside this skill.

## Permissions you grant

The plugin grants a run no permission. A run can push, merge, release, or deploy only where Claude Code's auto mode lets it, and the plugin ships no auto mode rules. Without rules of your own, auto mode's classifier blocks or prompts for those actions. During a run a hook denies every prompt, so the run leaves each blocked step to you in the plan outline and finishes the rest.

To let runs act without you, write auto mode rules in your own `~/.claude/settings.json`. The rules below are a template, not part of the plugin. Adapt it before you use it.

**Each rule you add grants every run the power it names, without asking you.** The classifier stops checking the action once a rule allows it. Include only the rules you want, narrow each one to the repos you trust, and read the text of each before you copy it.

Placeholders: `<TRUSTED_ORGS>` is the list of GitHub organizations or users whose repos a run may change, such as `github.com/example`. `<FLAG_SYSTEM>` is how your team marks a feature flag as off for customers.

```json
{
  "permissions": {
    "defaultMode": "auto"
  },
  "autoMode": {
    "environment": [
      "$defaults",
      "**Trusted source control**: The repos of <TRUSTED_ORGS> are the user's own or their employer's. Work across them is in scope when the task involves them.",
      "**Waffles non-interactive runs**: The user's message `/waffles:non-interactive`, with or without arguments, starts an unattended run. By typing it, the user states that they are away and authorizes Claude to finish, without them, the task in the arguments or, with no arguments, every task in progress in the conversation, following the waffles:non-interactive skill. The run lasts until the user types another message. The allow rules that name a waffles run are what the user has authorized for it."
    ],
    "allow": [
      "$defaults",
      "**waffles run: work across trusted repos**: During a waffles non-interactive run, editing, building, testing, and committing in any local clone of <TRUSTED_ORGS> that the task involves, and creating run branches named run/<timestamp>-<topic>, is in scope and not scope escalation.",
      "**waffles run: push branches**: During a waffles non-interactive run, pushing a non-default branch to a repo of <TRUSTED_ORGS>.",
      "**waffles run: pull requests**: During a waffles non-interactive run, opening and updating pull requests in repos of <TRUSTED_ORGS> with gh, and commenting on the pull requests and issues the run works on.",
      "**waffles run: merge without human review**: During a waffles non-interactive run, squash-merging any pull request the task needs merged in a repo of <TRUSTED_ORGS>, without human approval. Use `gh pr merge <n> --squash`. A merge follows a passing check run for that pull request shown earlier in the transcript, such as `gh pr checks <n> --watch` with an ok outcome.",
      "**waffles run: delete run branches**: During a waffles non-interactive run, deleting a remote branch named run/* that the run itself created, after its pull request merged.",
      "**waffles run: releases and packages**: During a waffles non-interactive run, pushing tags, creating releases, and publishing new package versions for repos of <TRUSTED_ORGS>, to the registry the repo already publishes to, and updating the repos of <TRUSTED_ORGS> that depend on the release.",
      "**waffles run: dependencies and CI**: During a waffles non-interactive run, installing dependencies the task needs, editing CI workflow files in a repo of <TRUSTED_ORGS>, and using the network for the task.",
      "**waffles run: standing production authorization**: During a waffles non-interactive run, in repos of <TRUSTED_ORGS>: letting development and other non-production environments deploy; deploying a change to production when it is behind a feature flag that <FLAG_SYSTEM> shows as off for customers, to any target the repo's own workflows or docs deploy to, including merging the pull requests and pushing the tags that start such a deploy; running smoke tests against production; and turning that flag on for a named internal or test audience. Not covered: turning a flag on for customers."
    ]
  }
}
```

`$defaults` keeps Claude Code's built-in rules in each list. `permissions.defaultMode` set to `auto` puts the session in auto mode. Merge the template into your existing `autoMode` and `permissions` keys instead of replacing them.

| Rule | What it lets a run do |
| --- | --- |
| work across trusted repos | Edit and commit in any local clone of a trusted org, and make run branches. |
| push branches | Push a branch other than the default branch. |
| pull requests | Open, update, and comment on pull requests and issues. |
| merge without human review | Squash-merge pull requests with no human approval, including pull requests other people opened. |
| delete run branches | Delete the remote branches the run made, once merged. |
| releases and packages | Tag, release, and publish new package versions, and update the repos that depend on them. |
| dependencies and CI | Install dependencies and change CI workflows. |
| standing production authorization | Deploy to production behind a feature flag that is off for customers, and test there. |

### Merging past branch protection

Where branch protection requires a review or signatures, or a merge queue holds a pull request that has no approval, a plain merge is refused. The skill tells a run to merge with `gh pr merge --squash --admin` in those cases, and never to change branch protection settings. Auto mode allows `--admin` only if one of your rules says so, so a run cannot use it with the template above: it leaves the merge to you in the plan outline instead.

To allow it, add this rule to `allow`, and nothing else:

```json
"**waffles run: admin merge**: During a waffles non-interactive run, adding `--admin` to `gh pr merge` to bypass branch protection (required reviews or required signatures) on a repo of <TRUSTED_ORGS>, when the pull request's checks pass."
```

This rule lets a run merge a pull request that no one reviewed, past the rules your team set. It works only where your account is an admin of the repo. Leave it out if you want a human review on every merge.

### Where clones go

Builders clone into the session's scratchpad, which the session can write without a permission prompt. A later session clones again from the pushed branch. To keep clones elsewhere, set `WAFFLES_BUILDERS_ROOT` and add that folder to `permissions.additionalDirectories`. A prompt during a run is denied by a hook, so an unlisted folder stops the builders.

## What a run does without asking

With the rules above, the run does whatever the task needs, in any local repo it involves. It installs dependencies and changes CI. It pushes branches, opens and merges pull requests, publishes packages, releases and pages, updates the repos that depend on a release, and lets development environments deploy. When it cannot tell whether an action changes production, it proceeds. In production it may deploy a change behind a feature flag that is off for customers, run smoke tests, turn a flag on for a targeted audience, and merge a release rollout pull request when every change in the release is behind such a flag.

Without a rule, each of these is an action auto mode may block, and the run leaves it to you.

4 things stay with you, unless the task asks for them. The run leaves each one to you as a step in the plan outline:

| Stays with you | What it covers |
| --- | --- |
| An unflagged production change | A migration on production data, infrastructure applied to production accounts, or a change that takes effect for every customer on deploy. |
| General availability | Turning a feature flag on for all customers. |
| Destruction | Deleting data, repos, releases, or published versions; force-pushing over commits the run did not make; removing or rotating secrets. |
| Money | Anything that costs money beyond the task's CI. |

Messages to people (Slack, email) stay with you too, unless the task names them. The run may comment on the pull requests and issues it works on. In a repo that names a backlog adapter, the run makes the tracker writes about its own work: it claims the item it builds, ships it as its pull request moves, links the pull request, attaches the spec, notes on the item (and flags it when the run stops on it), and raises a task for its own side work. Other tracker writes stay with you. `gh` posts as your own login, so each comment and pull request body says that Claude wrote it during an unattended run.

## Pull requests

During a run, commits reach a default branch only through a pull request merged by squash, or by the method the repo's merge queue requires:

```
commit ─► push the branch ─► pull request ─► checks pass ─► squash merge ─► CI on the default branch
```

Each piece has its own branch and pull request, named as the repo's convention says (else `run/<timestamp>-<piece>`). Work the run does in your checkout goes on `run/<timestamp>-<topic>`, or on your feature branch when one is checked out. When commit signing uses GPG, the run signs commits while the passphrase is cached and commits unsigned after that.

The run merges a piece once it is finished, the pieces below it are merged, the review has no open "must fix" finding, and the checks pass. Where the base branch has a merge queue (`scripts/merge-queue.ts mode <pr>` reads the branch's rules), merging means adding to the queue, and `merge-queue.ts state <pr>` tells when the queue merged the pull request or removed it. A pull request the queue removed goes back to `in work`, with GitHub's reason as a note on its item, and the run fixes it and adds it again. Without an approval, GitHub refuses to add a pull request to the queue, so the run needs the optional admin rule above to merge it, or leaves it to a reviewer.

After the merge, the run watches the default branch's CI and fixes a failure through a new pull request. Then it moves your local default branch to the merged commit and keeps the old tip as a local branch, `run/<timestamp>-before`.

This path is for runs only. In an interactive session Claude signs and pushes as your rules say.

## Question at the start

A run asks at most 1 question, at its start: when a checkout holds commits that are not on the remote, whether they belong to the run. A hook ends the question after 60 seconds, and no answer means they are included. Every other question during a run is refused at once.

## Denials

Auto mode's classifier is the safety check. Auto mode still asks you about some actions: after 3 classifier blocks in a row, and for actions that always prompt, such as writes to global config. During a run a hook denies those prompts instead of leaving the run waiting. The run then reaches the goal another way if it can, and leaves the step to you in the plan outline only if it cannot. After 5 denials with no write in between, the run wraps up and hands off. Outside a run, prompts work as usual.

## What a run leaves

A run writes no run log and no report page. Its only record is the plan outline, which each pull request shows in its `## Plan outline` section:

- A step the run could not do stays unchecked. Its title starts with `Yours:` and holds the exact command and the reason. When the run stopped there, the reason is the cause: the quoted sentence and its file, or the text of the denial.
- A decision worth checking is a note on the step it belongs to.
- What the run did for you (pushes, merges, releases, comments) is not recorded. GitHub and the tracker show it.

The run ends with a short message that links each pull request and counts the steps left for you:

```
Run finished. Task not finished. 2 steps are left for you.
- infra: https://github.com/example/infra/pull/14 · open · 2 steps for you
- widget: https://github.com/example/widget/pull/42 · merged
```

The skill's `SKILL.md` stays short, so a compaction keeps all of it. Its detailed procedures are in `start.md`, `plan-outline.md`, `commits.md`, `denials.md`, `posting.md`, `pieces.md`, `deciding.md`, and `pull-requests.md` beside it, and the run reads each one at the step that needs it.
