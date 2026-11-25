---
name: plan
description: Open or close the plan outline pane, the tree of goals and steps beside the chat. Not Claude Code's plan mode.
disable-model-invocation: true
---

# Plan outline pane

The waffles plugin's hook answers `/waffles:plan` itself: it opens or closes the plan outline pane, and this
text does not run.

If this text runs, the hook did not answer. Tell the person in 1 sentence that the plan outline
pane could not be opened or closed, because the waffles plugin's hooks did not answer `/waffles:plan`. Do
nothing else.
