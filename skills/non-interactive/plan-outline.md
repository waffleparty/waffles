# The plan outline: entries

Read this file before you add or rename a step in the plan outline (see The plan
outline in SKILL.md).

- **A step left for the user** stays open (unchecked). Add it, or rename the
  step it replaces (op `rename`), with a title in this form:

  `Yours: <the action, in plain words> · Run: <exact command or steps> · Why: <reason>`

  The reason says why the run did not do it and what stays broken or blocked
  if the user skips it. When the step is a stop, the reason is its cause: the
  quoted sentence and its file (`"deploys to production" in
  .github/workflows/release.yml`), or the text of the denial. Leave the steps
  that depend on it open too.
- **A decision worth checking** (see Deciding) is a note on the step it
  belongs to. Rename that step: its title, then
  `· Note: <the decision>; chose <option> over <option>, because <why>; to switch: <how>`.
- **Nothing else.** What the run did for the user is not recorded (see Ground
  rules). Notable decisions go in the pull request body.
- **Plain words.** A person who was away reads these titles. Name the repo and
  the thing: "Merge pull request 14 in infra, which applies Terraform to
  production accounts", not "infra apply: held". Write commands, paths, and
  links exactly.
- **The count.** "Steps left for you" in the final message counts only the
  open `Yours:` steps. Other open steps are not counted.
- **Not on the branch.** The plan outline is not in the working tree and is
  never committed. The pull request's `## Plan outline` section shows it.
