# Commits

Read this file before the first commit of a run (see Commits in SKILL.md).

Commit finished work as you go, in each repo you change.

- Follow the user's commit rules (CLAUDE.md, memory) and the repo's message
  convention (`git log`), except for where the commits go: during a run they
  reach the default branch through a pull request (below), also where the
  user's rules say to push directly.
- Make one commit per plan outline step, once its checks pass. Stage only
  that step's paths. A builder commits a piece in its own clone (see
  `pieces.md`).
- **The run's branch**, for work you do in the session's checkout. When the
  default branch is checked out, create
  `run/<timestamp>-<topic>` from the checkout's tip and commit there;
  `<timestamp>` is the start of the run, as `YYYY-MM-DDTHHMM`. When a feature
  branch is checked out, commit on that branch. Branch further when it helps
  the work: to try something you may throw away, or to keep unrelated work
  apart. Before you finish, bring what you're keeping back onto the run's
  branch as a straight line of commits and delete the other branches you made.
- **Sign while the passphrase is kept.** Nothing may prompt. Before a commit
  in a setup that signs with GPG (see `start.md`), run
  `echo ok | gpg --batch --pinentry-mode error --clearsign >/dev/null 2>&1`.
  Exit code 0 means the passphrase is kept: commit as usual. Otherwise commit
  with `--no-gpg-sign`. The squash merge makes a commit that GitHub signs.
- Fix what a pre-commit hook reports. Use `--no-verify` only when the hook
  fails on something the run didn't cause and can't fix, and note that on the
  step.
- Of the changes that were uncommitted when the run began, commit the ones
  that belong to the task and leave the rest as they are.
- Never rewrite a commit on the remote that the run did not make.
