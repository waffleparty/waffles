---
name: design
description: Design and plan an item before waffles builds it. Runs superpowers' brainstorming in a subagent with the item, its brief, its requirement rows, and their scenarios; answers each stop as the approver (the person while present, the run reviewer during a run) with the findings of the repo's spec check; attaches the approved spec to the item; runs writing-plans told that waffles builds; then makes the plan outline from the plan document, and waffles builds. Use when an item needs design before it is built (an epic, or a story that its epic's spec does not cover), when asked to design, spec, or plan an item, and during a run when the item to build needs design. Use it in place of starting brainstorming or writing-plans directly for such an item.
---

# Design

superpowers writes the spec and the plan, unchanged. This skill is waffles' layer
around it: it hands the item over, answers each stop as the approver, and takes
over after each approval. It is written for superpowers 7.0.2; the `init-check`
skill says when another version is installed.

```
you, the calling agent                         the writer: a subagent, superpowers unchanged
──────────────────────                         ─────────────────────────────────────────────
1 hand over the item, brief, rows, scenarios ──► brainstorming
2 the approver answers each stop  ◄───────────── a question, the approaches, its reviewer's questions
  spec check, then the approver  ◄───────────── approve the design doc   (.tmp/plan/spec.md)
3 attach the spec to the item                    (override: not writing-plans yet)
4 "waffles builds this plan"  ──────────────────────► writing-plans
  spec check, then the approver  ◄───────────── review the plan           (.tmp/plan/plan.md)
5 plan outline from the plan document; waffles builds (override: not superpowers' build skills)
```

Expect up to 5 stops for a full design (a question, the approaches, the
questions of brainstorming's own reviewer, the approval, and the hand-back,
which you take without the approver), then 1 for the plan. A small change has
fewer.

## The approver

| Who is there | The approver | How each stop reaches it |
| --- | --- | --- |
| The person (any waffles mode but non-interactive) | The person, alone | Relay the stop in chat: the writer's message as it is, and at an approval the document's path and the spec check's findings. End the turn. Send their reply to the writer as it is. |
| Nobody: a run (waffles mode non-interactive) | The run reviewer, `waffles:run-reviewer` | Its report gives the answer, the approval, and what it assumed for the person. |

Start the run reviewer once, before the first stop, in the foreground. It
names no model: pass as `model` the most capable model in the Agent tool's
options. When the spawn fails on the model, try the next most capable, then
leave `model` unset; keep its own effort. Without the `waffles:*` types, use
`general-purpose` with the same model and `effort: "high"`, tell it not to edit anything, and give
it the text of `agents/run-reviewer.md` (`<skill-dir>/../../agents/`). Its
first message holds the item, the brief and its watchpoints, the requirement
rows and their scenarios, and the lines of the repo's `AGENTS.md` that name its
architecture standards. Bring each later stop with SendMessage, so it keeps its
context.

**No answer in advance.** Answer each stop when it comes, never before: not
"treat the design as approved", not "take your recommendation". An answer given
in advance turns the approver into a blanket approval of documents nobody read.

## The spec check

A repo names its spec check with 1 line in its `AGENTS.md`, or in `CLAUDE.md`
when it has no `AGENTS.md`, beside its backlog adapter:

```markdown
Spec check: `team-spec-check`
```

```sh
f=AGENTS.md; [ -f "$f" ] || f=CLAUDE.md; grep -m1 -E '^Spec check:' "$f"
```

The line follows the rules of the `Backlog adapter:` line (`adapter.md` in the
`backlog` skill's base directory). The skill it names checks a spec or a plan
written for an item, and returns findings, 1 line each, that name what to fix;
none means the document passes. waffles ships no spec check of its own: the
template, the script, and the inputs of the check belong to that skill.

- Run it at the spec approval and at the plan review, before the approver sees
  the document. Give it the kind (`spec` or `plan`), the path, and the item;
  it reads its other inputs where it says.
- Take its findings only. Where the skill says to edit the document, give the
  findings to the writer instead, who revises it: 1 agent writes the document.
- Run it again after each revision. The approver never approves a document
  that has a finding.
- No line: say once "This repo names no spec check; the approver reads the
  documents alone." A skill that the session cannot load: say "The spec check
  `<name>` is not installed; the approver reads the documents alone." In a run,
  put that sentence in the design step's note.

## 1. Hand over

Collect the item and what it is built from:

- **The item**: from the adapter's `pull` (state `ready`, or `not ready` for an
  item in grooming), or its `.backlog/` file. Use its `id`, `title`, `kind`,
  `request`, `answers`, and `requirements`.
- **Product work** (the item cites requirements): the brief with its
  watchpoints, the rows of the requirements it cites, and their scenarios. Read
  them where the spec check says its inputs are, or where the repo's
  `AGENTS.md` says.
- **Technical work** (no requirements): no brief. The request states the need.

Start the writer with the Agent tool: `general-purpose` (it loads skills and
writes files), in the foreground, with no `model`. Fill this prompt, leaving
out the lines that do not apply, and add no answer to a stop:

```text
Use the superpowers:brainstorming skill (load it with the Skill tool) to design <id>: <title>. I am asking for brainstorming and want the conversation; do not offer to skip it.

The project is <checkout path>: <1 line on what the repo is>.

What is asked, in the words of the person who asked:
<request>

The brief, <its title and link>, holds the purpose, the goals, the success criteria, and the metrics. Do not ask about them again, and do not restate them in the spec. Its watchpoints, each of which the spec answers:
<watchpoints>

The requirements this item builds, and their scenarios:
<rows and scenarios>

The need, as the spec's opening `## Purpose` states it in 1 to 3 sentences: <need>

Answers from grooming:
<answers>

Before I approve the spec, the spec check `<skill>` checks it. Write the spec in the shape of its template: <path of the template>.

My preferences, which override the skill's defaults:
- Write the design doc to <checkout path>/.tmp/plan/spec.md. Write nothing under docs/superpowers/. Do not commit: waffles commits the working files.
- Write the design doc before you ask me to approve it, also a short one: I approve the document, not a message.
- Stop at each point where the skill wants me, and end your turn there. I answer each one when it comes.
- After I approve the design doc, stop and say so. Do not invoke writing-plans or any other skill yet: waffles attaches the spec to the item first, then tells you to go on.
```

## 2. Each stop

The writer ends its turn at each stop, and its message comes back from the
Agent tool (later from SendMessage). For each:

1. **Name the stop**: a question, the approaches, the reviewer's questions, an
   offer (the visual companion), the spec approval, or the plan review. The
   hand-back after an approval is not a stop for the approver: go on to step
   3 (after the spec) or step 5 (after the plan).
2. **At an approval**, check the place: the document is in `.tmp/plan/`, and
   `git status --porcelain docs/superpowers` lists nothing new. Where the
   writer wrote under `docs/superpowers/`, tell it to move the file to
   `.tmp/plan/`, and delete what it wrote there. Then run the spec check.
3. **Give the approver the stop**: the writer's message as it is, and at an
   approval the document's path and the findings.
4. **Questions for the writer.** When the run reviewer replies with
   `Ask the writer:`, send those questions to the writer, headed "A question
   from the reviewer, not the answer to your stop:", and bring the reply back
   to the reviewer. Repeat until it answers the stop.
5. **Send the answer** to the writer as it is. In a run, add the reviewer's
   `Assumed for you` entries to `.tmp/plan/assumed-for-you.md`, under the
   heading `# Assumed for you` (see The record of a run).

A declined document comes back revised, as a new stop: run the spec check again.
Never answer a stop in the approver's place.

## 3. After the spec is approved: attach it

This overrides brainstorming's next step ("invoke writing-plans and no other
skill"): waffles attaches the spec first.

- **A repo with an adapter**: `note` the item with the text "Spec approved by
  <the person | the run reviewer, for the person>, before the plan was written."
  and `files: [.tmp/plan/spec.md]`. When the adapter says that it cannot
  attach a file, say so in 1 line, "The adapter cannot attach files; the item
  links the spec instead.", and after the push of the commit that holds
  `.tmp/plan/spec.md`, `note` the item with the spec's link at that commit:
  `https://github.com/<owner>/<repo>/blob/<commit>/.tmp/plan/spec.md`. When the
  tracker cannot be reached, fall back as `adapter.md` says.
- **No adapter**: copy the spec to `.backlog/<slug>/spec.md`, the item's files.
- **In a run**, rename the design step (op `rename`): its title, then
  `· Note: spec approved by the run reviewer for you; <n> answers assumed for you, listed in the pull request`.

## 4. writing-plans, told that waffles builds

Send this to the same writer, which keeps the design's context:

```text
The spec is attached to the item. Now use the superpowers:writing-plans skill (load it with the Skill tool) to write the implementation plan for .tmp/plan/spec.md.

My preferences, which override the skill's defaults:
- Write the plan to <checkout path>/.tmp/plan/plan.md. Write nothing under docs/superpowers/. Do not commit.
- The execution method is supplied now: waffles builds this plan, task by task, one commit per task. Do not ask me how to carry it out, and name no other way in the plan.
- Keep each task a heading of the form `### Task N: <name>`.
- After I approve the plan, stop. Invoke no other skill, and write no code: waffles builds it.
```

Its stop ("Please review the plan. Does it capture what you want?") is the plan
review (step 2). When it asks for an execution method anyway, the answer
starts with "waffles builds it."

## 5. After the plan is approved: the plan outline, then waffles builds

This overrides writing-plans' next step (carry the plan out with its own
build skills): waffles makes the plan outline and builds.

1. **The plan outline.** Run
   `python3 -I <skill-dir>/../../scripts/outline_from_plan.py .tmp/plan/plan.md --spec .tmp/plan/spec.md --title "<id>: <title>"`.
   It prints the goal's title and steps as JSON: 1 step per `### Task N:`
   heading, then "Remove the working files". The title is the plan's, else the
   spec's, else the item's. It reads the headings only, never
   the plan's header line, which writing-plans rewrites. With exit code 1 (no
   task heading), make 1 step per task of the plan by hand.
   - With no active goal, start one (op `goal`, the title and steps).
   - With a goal active, as in a run, add the steps (op `add`) under the step
     that builds the item, else under the current step, and keep 1 "Remove
     the working files", last in the goal. Never start a second goal.
   - In a run, rename the plan step:
     `· Note: plan approved by the run reviewer for you; <n> answers assumed for you, listed in the pull request`.
2. **The writer is done.** Send it nothing more.
3. **waffles builds.** Each outline step is 1 commit, as the `commit-prep` skill's
   rules say. Commit the spec, the plan document, and the record with the
   outline: in the first commit when the branch has none yet, else in the
   commit that adds the plan's steps. In a run, build as the `non-interactive`
   skill's Splitting the work says; while the person is present, build step by
   step in this session.
   - A plan task's "Commit" step is its outline step's commit: make it once the
     checks pass, with the box ticked, in the repo's message style, not with
     the plan's `git commit -m` line.
   - waffles' steps do these jobs for this build. Do not invoke the superpowers
     skills for them:

     | Job | Not used | waffles' step |
     | --- | --- | --- |
     | Carry out the tasks | executing-plans, subagent-driven-development, dispatching-parallel-agents | In a run, the pieces of `non-interactive`; while present, this session |
     | Isolate the work | using-git-worktrees | The item's branch, and a builder's own clone or worktree |
     | Review | requesting-code-review | `waffles:reviewer` |
     | Finish the branch and merge | finishing-a-development-branch | The pull request path and waffles' merge rule |

     superpowers' discipline skills (test-driven-development,
     systematic-debugging, verification-before-completion) stay in use.

## The record of a run

The person reads the run reviewer's approvals and answers when they return,
and can overrule each one.

- **`.tmp/plan/assumed-for-you.md`** holds each `Assumed for you` entry of the
  reviewer's reports, in the order given, under `# Assumed for you`. The
  checkpoint script renders it into the pull request's `## Plan outline`
  section, under `### Assumed for you`, after each push; the list stays there
  after the working files are removed.
- **The notes** on the design step and the plan step say who approved, and
  how many answers are assumed.
- **The pull request body** says, among the decisions a reviewer should know:
  "The run reviewer approved the spec and the plan for you. What it assumed is
  listed under Assumed for you."
