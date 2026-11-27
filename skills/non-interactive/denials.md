# Denials

Read this file at the first denial or classifier block (see Denials in SKILL.md).

Two things can refuse an action. The platform's permission checks block what
they judge risky (on Claude Code, auto mode's classifier). Where the platform
would ask the user, waffles' hooks answer no, with a message that starts
"Denied: The user is away".

A denial stops one action, not the goal:

1. Find another way to reach the goal and take it: a narrower command, a
   different tool, a local stand-in for a remote step, a path in the repo or
   the scratchpad instead of one outside. Sending the same action again,
   reworded or split up, gets it blocked again.
2. If there's no other way, leave the step to the user in the plan outline,
   with the exact command or step and the text of the denial as the reason.
   Carry on with everything that doesn't depend on it.
3. If the action was how you'd verify something, verify it the next best way
   you can, and note the gap on the step.

When a sub-agent reports a denial, handle it the same way.

Three limits shape this:

- On Claude Code, 3 classifier blocks in a row pause auto mode: every write
  then asks, and is denied. After a block, make your next action or two plainly safe, like an
  edit in the repo, before you try anything else near the line.
- After 5 denials in a row, the hooks tell you to wrap up. Start nothing new:
  leave what's blocked to the user in the plan outline, and finish (see
  Finishing).
- Some writes ask in every mode, so they're always denied: global config
  (`~/.gitconfig`, shell profiles, `~/.claude`) and system paths. Keep what
  you write in the repos and the scratchpad.
