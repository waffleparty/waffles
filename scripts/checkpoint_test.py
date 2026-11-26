"""Tests for checkpoint.py, with a stub gh. Run: python3 -m unittest discover -s scripts -p '*_test.py'"""

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "checkpoint.py")
sys.path.insert(0, HERE)

import checkpoint  # noqa: E402

# Answers `gh pr view` from the state file's "pr" (none: no pull request), and stores the body
# `gh pr edit --body-file -` reads from stdin. Every call is recorded.
GH = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json, os, sys
    path = os.environ["GH_STUB_STATE"]
    with open(path) as f:
        state = json.load(f)
    args = sys.argv[1:]
    state["calls"].append(args)
    code = 0
    if args[:2] == ["pr", "view"]:
        if state["pr"] is None:
            print("no pull requests found for branch", file=sys.stderr)
            code = 1
        else:
            print(json.dumps(state["pr"]))
    elif args[:2] == ["pr", "edit"] and args[3:] == ["--body-file", "-"]:
        state["pr"]["body"] = sys.stdin.read()
    else:
        print("unexpected: " + " ".join(args), file=sys.stderr)
        code = 2
    with open(path, "w") as f:
        json.dump(state, f)
    sys.exit(code)
    """
)

GOAL = textwrap.dedent(
    """\
    ---
    goal: Show the parent ID
    status: open
    current: 2
    created: 2026-11-23T10:00:00.000Z
    updated: 2026-11-23T10:00:00.000Z
    ---
    - [x] 1 Add the parent ID to the resource detail query
    - [ ] 2 Show the parent ID on the resource detail screen
      - [x] 2.1 ? Check the empty state <!-- aliases=3.1 -->
    - [ ] 3 Remove the working files
    """
)

BODY = textwrap.dedent(
    """\
    ## Summary
    Display the parent resource ID (PRJ-42).

    ## Prerequisites
    None"""
)

# The record of decisions made for the person.
ASSUMED_FILE = textwrap.dedent(
    """\
    # Assumed for you

    - **Spec, approved** for you: every part of the request has a section.
    - **Design question**: "Should a new member vote mid-round?" Answered: no, from the next round on.
      Why: the request says nothing; this keeps the tally fixed once a round starts.
    """
)

ASSUMED_LIST = [
    "- **Spec, approved** for you: every part of the request has a section.",
    '- **Design question**: "Should a new member vote mid-round?" Answered: no, from the next round on.',
    "  Why: the request says nothing; this keeps the tally fixed once a round starts.",
]

CHECKLIST = [
    "- [x] 1. Add the parent ID to the resource detail query",
    "- [ ] 2. Show the parent ID on the resource detail screen",
    "  - [x] 2.1. Check the empty state",
    "- [ ] 3. Remove the working files",
]


class Checkout:
    """A clone of a bare remote, on branch feat with the outline committed and pushed, and a stub gh."""

    def __init__(self, root):
        self.root = root
        self.work = os.path.join(root, "work")
        self.state_path = os.path.join(root, "gh.json")
        bin_dir = os.path.join(root, "bin")
        os.makedirs(bin_dir)
        with open(os.path.join(bin_dir, "gh"), "w") as f:
            f.write(GH)
        os.chmod(os.path.join(bin_dir, "gh"), 0o755)
        config = os.path.join(root, "gitconfig")
        with open(config, "w") as f:
            f.write("[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n")
        self.env = {
            **os.environ,
            "PATH": bin_dir + os.pathsep + os.environ["PATH"],
            "GH_STUB_STATE": self.state_path,
            "GIT_CONFIG_GLOBAL": config,
            "GIT_CONFIG_NOSYSTEM": "1",
        }
        self.git_at(root, "init", "-q", "--bare", "remote.git")
        self.git_at(root, "clone", "-q", "remote.git", "work")
        self.write("README.md", "readme\n")
        self.git("add", "README.md")
        self.git("commit", "-q", "-m", "Start")
        self.git("push", "-q", "origin", "main")
        self.git("switch", "-q", "-c", "feat")
        self.write(".tmp/plan/show-the-parent-id.md", GOAL)
        self.git("add", ".tmp")
        self.git("commit", "-q", "-m", "Add the plan outline")
        self.git("push", "-q", "-u", "origin", "feat")
        self.set_pr({"number": 7, "url": "https://github.com/o/r/pull/7", "body": BODY, "headRefName": "feat", "baseRefName": "main", "state": "OPEN"})

    def git_at(self, cwd, *args):
        return subprocess.run(["git", *args], cwd=cwd, env=self.env, check=True, capture_output=True, text=True).stdout

    def git(self, *args):
        return self.git_at(self.work, *args)

    def write(self, rel, text):
        path = os.path.join(self.work, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def set_pr(self, pr):
        with open(self.state_path, "w") as f:
            json.dump({"pr": pr, "calls": []}, f)

    def gh(self):
        with open(self.state_path) as f:
            return json.load(f)

    def checkpoint(self, *args):
        done = subprocess.run([sys.executable, "-I", SCRIPT, *args], cwd=self.work, env=self.env, capture_output=True, text=True)
        return done.returncode, done.stdout

    def edits(self):
        return [call for call in self.gh()["calls"] if call[:2] == ["pr", "edit"]]


def section(*items, note=None):
    return "\n".join([checkpoint.START, "## Plan outline", "", *([note, ""] if note else []), *items, checkpoint.END])


class CheckpointTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.co = Checkout(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_outline_goes_after_the_sections_and_a_second_run_changes_nothing(self):
        code, out = self.co.checkpoint()
        body = self.co.gh()["pr"]["body"]
        again, out_again = self.co.checkpoint()

        self.assertEqual(code, 0, out)
        self.assertEqual(out.strip(), "Updated the plan outline in #7: https://github.com/o/r/pull/7")
        self.assertEqual(body, f"{BODY}\n\n{section(*CHECKLIST)}")
        self.assertEqual(again, 0)
        self.assertEqual(out_again.strip(), "The plan outline in #7 is up to date.")
        self.assertEqual(len(self.co.edits()), 1)
        self.assertEqual(self.co.gh()["pr"]["body"], body)

    def test_a_changed_outline_replaces_only_the_marked_section(self):
        self.co.checkpoint()
        pr = self.co.gh()["pr"]
        pr["body"] = f"Intro text\n\n{pr['body']}\n\n## Notes\nKept as written."
        self.co.set_pr(pr)
        self.co.write(".tmp/plan/show-the-parent-id.md", GOAL.replace("- [ ] 2 Show", "- [x] 2 Show"))
        self.co.git("commit", "-q", "-am", "Show the parent ID")
        self.co.git("push", "-q")

        code, _ = self.co.checkpoint()

        ticked = [CHECKLIST[0], CHECKLIST[1].replace("[ ]", "[x]"), *CHECKLIST[2:]]
        self.assertEqual(code, 0)
        self.assertEqual(self.co.gh()["pr"]["body"], f"Intro text\n\n{BODY}\n\n{section(*ticked)}\n\n## Notes\nKept as written.")

    def test_a_plan_outline_section_written_by_hand_is_taken_over_and_the_attribution_stays_last(self):
        footer = "Written by Claude during an unattended run for someone.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"
        pr = self.co.gh()["pr"]
        pr["body"] = f"{BODY}\n\n## Plan outline\n\n- [ ] 1. Old step\n- [ ] 2. Other\n\n{footer}"
        self.co.set_pr(pr)

        self.co.checkpoint()

        self.assertEqual(self.co.gh()["pr"]["body"], f"{BODY}\n\n{section(*CHECKLIST)}\n\n{footer}")

    def test_a_new_section_goes_ahead_of_the_attribution_lines(self):
        footer = "🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_x"
        pr = self.co.gh()["pr"]
        pr["body"] = f"{BODY}\n\n{footer}\n"
        self.co.set_pr(pr)

        self.co.checkpoint()

        self.assertEqual(self.co.gh()["pr"]["body"], f"{BODY}\n\n{section(*CHECKLIST)}\n\n{footer}\n")

    def test_uncommitted_and_unpushed_work_marks_the_checklist_ahead_of_the_branch(self):
        self.co.write("a.txt", "a\n")
        self.co.git("add", "a.txt")
        self.co.git("commit", "-q", "-m", "A")
        self.co.write("README.md", "changed\n")
        head = self.co.git("rev-parse", "HEAD")

        code, out = self.co.checkpoint()

        note = "> **Ahead of the branch:** this checklist includes work that is not on the branch yet (1 commit not pushed; changes not committed)."
        self.assertEqual(code, 0)
        self.assertIn("(ahead of the branch)", out)
        self.assertEqual(self.co.gh()["pr"]["body"], f"{BODY}\n\n{section(*CHECKLIST, note=note)}")
        # It never commits.
        self.assertEqual(self.co.git("rev-parse", "HEAD"), head)
        self.assertEqual(self.co.git("status", "--porcelain"), " M README.md\n")

        self.co.git("commit", "-q", "-am", "B")
        self.co.git("push", "-q")
        self.co.checkpoint()
        self.assertEqual(self.co.gh()["pr"]["body"], f"{BODY}\n\n{section(*CHECKLIST)}")

    def test_after_the_working_files_are_removed_the_checklist_ends_with_that_step_ticked(self):
        self.co.git("rm", "-q", "-r", ".tmp")
        self.co.git("commit", "-q", "-m", "Remove the working files")
        self.co.git("push", "-q")

        self.co.checkpoint()
        body = self.co.gh()["pr"]["body"]
        self.co.checkpoint()

        self.assertEqual(body, f"{BODY}\n\n{section(*CHECKLIST[:3], '- [x] 3. Remove the working files')}")
        self.assertEqual(len(self.co.edits()), 1)

    def test_the_record_of_decisions_is_the_assumed_for_you_list_and_stays_after_the_working_files_go(self):
        self.co.write(".tmp/plan/assumed-for-you.md", ASSUMED_FILE)
        self.co.git("add", ".tmp")
        self.co.git("commit", "-q", "-m", "Approve the spec")
        self.co.git("push", "-q")

        self.co.checkpoint()
        body = self.co.gh()["pr"]["body"]
        self.co.git("rm", "-q", "-r", ".tmp")
        self.co.git("commit", "-q", "-m", "Remove the working files")
        self.co.git("push", "-q")
        self.co.checkpoint()

        self.assertEqual(body, f"{BODY}\n\n{section(*CHECKLIST, '', '### Assumed for you', '', *ASSUMED_LIST)}")
        self.assertEqual(
            self.co.gh()["pr"]["body"],
            f"{BODY}\n\n{section(*CHECKLIST[:3], '- [x] 3. Remove the working files', '', '### Assumed for you', '', *ASSUMED_LIST)}",
        )

    def test_an_outline_removed_before_the_branch_started_is_not_rendered(self):
        # The working files went in a commit on main; a new branch from there has none of its own.
        self.co.git("rm", "-q", "-r", ".tmp")
        self.co.git("commit", "-q", "-m", "Remove the working files")
        self.co.git("switch", "-q", "main")
        self.co.git("merge", "-q", "--ff-only", "feat")
        self.co.git("push", "-q", "origin", "main")
        self.co.git("switch", "-q", "-c", "next")
        self.co.write("b.txt", "b\n")
        self.co.git("add", "b.txt")
        self.co.git("commit", "-q", "-m", "B")
        self.co.git("push", "-q", "-u", "origin", "next")
        self.co.set_pr({"number": 9, "url": "u", "body": BODY, "headRefName": "next", "baseRefName": "main", "state": "OPEN"})

        code, out = self.co.checkpoint()

        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "No plan outline in .tmp/plan/: #9 stays as it is.")
        self.assertEqual(self.co.edits(), [])

    def test_no_pull_request_or_a_merged_one_is_left_alone(self):
        self.co.set_pr(None)
        code, out = self.co.checkpoint()
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "No pull request for the branch feat: nothing to update.")

        self.co.set_pr({"number": 7, "url": "u", "body": BODY, "headRefName": "feat", "state": "MERGED"})
        code, out = self.co.checkpoint()
        self.assertEqual(code, 0)
        self.assertIn("is merged", out)
        self.assertEqual(self.co.edits(), [])

    def test_a_pull_request_for_another_branch_is_left_alone(self):
        code, out = self.co.checkpoint("--pr", "7")
        self.assertIn("Updated", out)
        self.co.set_pr({"number": 8, "url": "u", "body": BODY, "headRefName": "other", "state": "OPEN"})
        code, out = self.co.checkpoint("--pr", "8")
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "Pull request #8 is for other, not feat: nothing to update.")
        self.assertEqual(self.co.gh()["calls"][-1], ["pr", "view", "8", "--json", "number,url,body,headRefName,baseRefName,state"])

    def test_dry_run_prints_the_description_and_writes_nothing(self):
        code, out = self.co.checkpoint("--dry-run")
        self.assertEqual(code, 0)
        self.assertEqual(out, f"{BODY}\n\n{section(*CHECKLIST)}\n")
        self.assertEqual(self.co.edits(), [])


class RenderTest(unittest.TestCase):
    def test_dropped_deferred_parked_review_and_subagent_steps(self):
        goal = GOAL.replace(
            "- [ ] 3 Remove the working files",
            "- [-] 3 Try the old query\n- [>] 4 Add caching → .backlog/cache.md\n- [~] 5 ⤷ Fix the build <!-- parked=2.1 -->\n- [ ] 6 \\? Odd title\n- [r] 7 Merge the fixes\n- [ ] 8 Archive <!-- agent=a1 -->",
        )
        self.assertEqual(
            checkpoint.render([("g.md", goal)], False)[3:],
            [
                "- [x] 3. ~~Try the old query~~ (dropped)",
                "- [x] 4. Add caching (moved to the backlog: .backlog/cache.md)",
                "- [ ] 5. Fix the build",
                "- [ ] 6. ? Odd title",
                "- [ ] 7. Merge the fixes",
                "- [ ] 8. Archive",
            ],
        )

    def test_a_plain_checklist_is_rendered_and_a_plan_document_is_not(self):
        plain = "# Work\n\n- [x] 1. First\n- [ ] 2 Second\n- [ ] Remove the working files\n"
        document = "# Plan\n\nSome prose.\n\n- [ ] not a step list\n"
        self.assertEqual(
            checkpoint.render([("outline.md", plain), ("plan.md", document)], True),
            ["- [x] 1. First", "- [ ] 2. Second", "- [x] Remove the working files"],
        )
        self.assertIsNone(checkpoint.render([("plan.md", document)], False))
        # Goal files come before a plain checklist.
        self.assertEqual(checkpoint.render([("a.md", GOAL), ("outline.md", plain)], False), CHECKLIST)

    def test_the_assumed_for_you_list_follows_the_checklist_and_is_never_a_checklist_itself(self):
        task_like = "# Assumed for you\n\n- [ ] 1. A line that looks like a task\n"
        self.assertEqual(
            checkpoint.render([("a.md", GOAL), ("assumed-for-you.md", ASSUMED_FILE)], False),
            [*CHECKLIST, "", "### Assumed for you", "", *ASSUMED_LIST],
        )
        # With no outline beside it, there is nothing to render.
        self.assertIsNone(checkpoint.render([("assumed-for-you.md", task_like)], False))
        # An empty record adds nothing.
        self.assertEqual(checkpoint.render([("a.md", GOAL), ("assumed-for-you.md", "# Assumed for you\n\n")], False), CHECKLIST)

    def test_several_goals_each_get_a_heading(self):
        other = GOAL.replace("goal: Show the parent ID", "goal: Fix the date").replace("\n  - [x] 2.1 ? Check the empty state <!-- aliases=3.1 -->", "")
        lines = checkpoint.render([("a.md", GOAL), ("b.md", other)], False)
        self.assertEqual(lines[:2], ["### Show the parent ID", ""])
        self.assertEqual(lines[6:9], ["", "### Fix the date", ""])

    def test_a_body_with_crlf_line_ends_keeps_them(self):
        body = "## Summary\r\nText\r\n"
        block = [checkpoint.START, "A", checkpoint.END]
        placed = checkpoint.place(body, block)
        self.assertEqual(placed, f"## Summary\r\nText\r\n\r\n{checkpoint.START}\r\nA\r\n{checkpoint.END}\r\n")
        self.assertEqual(checkpoint.place(placed, block), placed)


if __name__ == "__main__":
    unittest.main()
