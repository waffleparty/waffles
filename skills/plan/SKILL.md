---
name: plan
description: Open or close the plan outline pane, the tree of goals and steps beside the chat. Not Claude Code's plan mode.
disable-model-invocation: true
---

# Plan outline pane

The plan outline pane is Claude Code's: no other platform has it. The waffles plugin's hook answers
`/waffles:plan` itself: it opens or closes the plan outline pane, and this text does not run.

If this text runs, the hook did not answer. Tell the person in 1 sentence that the plan outline
pane could not be opened or closed, because the waffles plugin's hooks did not answer `/waffles:plan`, or,
on a platform other than Claude Code, because the pane exists only there. Do nothing else.
