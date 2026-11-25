# Delegating a hard decision

Read this file before you delegate a hard decision (see Deciding in SKILL.md).

Spawn `waffles:decider`, which runs at high effort (these calls get the
strongest reasoning) and can't edit files. It names no model:
pass as `model` the most capable model in the Agent tool's options. When the
spawn fails on the model, try the next most capable, then leave `model` unset
so the agent uses the session's model; keep its own effort. Without the
`waffles:*` types, use `general-purpose` with the same model and
`effort: "high"`, and tell it not to edit anything. Once a model has failed,
don't try it again during this run. Run the agent in the foreground, because
you need its answer before you continue. Its prompt contains:

1. **Goal**: the task in one or two sentences, quoting the user's words where you
   have them.
2. **Decision**: the exact question.
3. **Options**: each option you see, with its trade-offs and how reversible it
   is.
4. **Evidence**: the file paths, conventions, and constraints that bear on it.
   The agent may read the code but must not edit anything.
5. **Return format**: the chosen option, its rationale, a confidence level
   (high/medium/low), and what would make it the wrong call.

Use the agent's decision. If you think it's clearly wrong (it missed evidence
or misread the goal), send one follow-up with the missing context and use that
answer. Never override it silently: when you disagree, note both views on
the step the decision belongs to (see The plan outline in SKILL.md).
