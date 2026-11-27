# The start of a run, in the user's session

Read this file first in the user's session (see Start of the run in SKILL.md). The
user is still at the computer for the first minute. Do steps 1 and 2 here in
this order, before any other work.

1. **Test-sign.** In a setup that signs commits with GPG
   (`git config commit.gpgsign` prints `true`, and `git config gpg.format`
   prints nothing or `openpgp`), run `echo ok | gpg --clearsign >/dev/null` with a
   60-second time limit (the Bash tool's `timeout: 60000` on Claude Code). The
   gpg-agent then keeps the passphrase for the first hours of the run, or shows its prompt while the user is still there.
   If the command doesn't finish in those 60 seconds, nobody answered: commit
   unsigned.
2. **Ask about commits that aren't on the remote.** In each repo the task
   involves, list them with `git log --oneline @{upstream}..HEAD` (with no
   upstream, `git log --oneline origin/<default branch>..HEAD`). They are the
   user's own work, or unsigned commits from an earlier run. When any repo has
   some, ask the user once with a multiple-choice question (`AskUserQuestion`
   on Claude Code), in 1 call with 1 question, whether
   they belong to this run. The question stands alone: it names each repo and
   branch, lists the commits' subjects, and says what each answer leads to.

   | Option | What it leads to |
   | --- | --- |
   | Include them (Recommended) | They go into the run's branch. The squash merge puts them on the default branch together with the run's changes. |
   | Leave them out | The run still opens its pull request, does not merge it, and leaves the merge to you as a step in the plan outline. |

   Give each option a `preview` that states its outcome in full sentences. A
   waffles hook ends the question after 60 seconds. "Include them", no answer
   ("No answer in 60 seconds"), a dismissed dialog, and a question that the
   hooks refuse all mean: include them. When no repo has such commits, ask
   nothing.

   This is the only question of a run. The hooks refuse every other call to
   the question tool at once. If the hooks aren't loaded (on Claude Code, a
   cloud session loads this skill without its plugin, so the `waffles:*` agent
   types are missing from the Agent tool's list), don't ask: include the
   commits.
