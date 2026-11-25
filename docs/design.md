# Design

**`/waffles:design <item>`** designs and plans an item that needs design before waffles builds it: an epic, or a story that its epic's spec does not cover. [superpowers](https://github.com/obra/superpowers) writes the spec and the plan, unchanged. waffles is the layer around it, written for superpowers 7.0.2. `/waffles:init-check` says when another version is installed.

```
waffles (the calling agent)                    the writer: a subagent, superpowers unchanged
hand over the item, brief, rows, scenarios ──► brainstorming
the approver answers each stop  ◄───────────── questions, the approaches, its reviewer's questions
spec check, then the approver   ◄───────────── approve the design doc   (.tmp/plan/spec.md)
attach the spec to the item
"waffles builds this plan" ────────────────────► writing-plans
spec check, then the approver   ◄───────────── review the plan           (.tmp/plan/plan.md)
plan outline from the plan document; waffles builds
```

## The handover

The handover gives brainstorming the item, the brief and its watchpoints, the requirement rows, and their scenarios. It states the preferences that superpowers' own text lets win: the spec and the plan go to `.tmp/plan/`, nothing goes under `docs/superpowers/`, and the execution method is supplied (waffles builds), so writing-plans asks only for a review.

## The approver

The approver answers each stop when it comes, never in advance:

| Who is there | The approver |
| --- | --- |
| You, in any mode but non-interactive | You. Claude relays each stop in chat. |
| Nobody, during a run | The run reviewer, `waffles:run-reviewer`, on the most capable model the Agent tool offers. |

The run reviewer can ask the writer for context, answers every question, and declines a document the spec check has not passed.

## The spec check

The spec check is the repo's own. 1 line in its `AGENTS.md`, beside `Backlog adapter:`, names a skill that checks a spec or a plan and returns findings:

```markdown
Spec check: `team-spec-check`
```

waffles ships no spec check. The findings go to the approver and back to the writer, who revises the document. The approver never approves a document that has a finding. With no line, the approver reads the documents alone.

## Two next steps are overridden

- After the design is approved, the spec is attached to the item before writing-plans runs. The adapter's `note` takes `files`; where the tracker cannot attach, the item links the spec.
- After the plan is approved, `scripts/outline_from_plan.py` makes the plan outline's steps from the plan's `### Task N:` headings, never from its header line, which writing-plans rewrites. waffles then builds with its own steps, not superpowers' build skills.

## Assumed for you

During a run, each answer that the sources do not settle, and each approval, goes into `.tmp/plan/assumed-for-you.md`. The checkpoint renders it into the pull request's `## Plan outline` section, under `### Assumed for you`, so you can overrule any of them. See [Plan outline](plan-outline.md#the-checklist-in-the-pull-request).
