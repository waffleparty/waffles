"""Tests for merge_guard.py, with a stub gh. Run: python3 -m unittest discover -s scripts -p '*_test.py'"""

import io
import json
import os
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import merge_guard  # noqa: E402

# `gh pr view [selector]` answers the state file's "prs" entry for the selector ("" for none);
# `gh api …/contents/.tmp?ref=<branch>` succeeds when "tmp" lists the branch, else answers 404.
GH = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json, os, sys, urllib.parse
    with open(os.environ["GH_STUB_STATE"]) as f:
        state = json.load(f)
    args = sys.argv[1:]
    with open(os.environ["GH_STUB_STATE"] + ".calls", "a") as f:
        f.write(json.dumps(args) + "\\n")
    if args[:2] == ["pr", "view"]:
        rest = args[2:args.index("--json")]
        selector = next((a for a in rest if not a.startswith("-") and a != state.get("repo")), "")
        pr = state["prs"].get(selector)
        if pr is None:
            print("no pull requests found", file=sys.stderr)
            sys.exit(1)
        print(json.dumps(pr))
    elif args[:2] == ["api", "--silent"]:
        ref = urllib.parse.unquote(args[2].split("?ref=")[1])
        if state.get("down"):
            print("gh: HTTP 502", file=sys.stderr)
            sys.exit(1)
        if ref not in state["tmp"]:
            print("gh: Not Found (HTTP 404)", file=sys.stderr)
            sys.exit(1)
    else:
        sys.exit(2)
    """
)


def pr(number, branch):
    return {"number": number, "headRefName": branch, "baseRefName": "main", "headRepository": {"name": "r"}, "headRepositoryOwner": {"login": "o"}, "url": f"https://github.com/o/r/pull/{number}"}


class MergeGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        bin_dir = os.path.join(self.tmp.name, "bin")
        os.makedirs(bin_dir)
        with open(os.path.join(bin_dir, "gh"), "w") as f:
            f.write(GH)
        os.chmod(os.path.join(bin_dir, "gh"), 0o755)
        self.state = os.path.join(self.tmp.name, "gh.json")
        self.env = {"PATH": os.environ["PATH"], "GH_STUB_STATE": os.environ.get("GH_STUB_STATE", "")}
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ["PATH"]
        os.environ["GH_STUB_STATE"] = self.state
        self.write({"prs": {"": pr(5, "feat"), "12": pr(12, "run/x"), "https://github.com/o/r/pull/9": pr(9, "done")}, "tmp": ["feat", "run/x"], "repo": "o/r"})

    def tearDown(self):
        os.environ.update(self.env)
        self.tmp.cleanup()

    def write(self, state):
        with open(self.state, "w") as f:
            json.dump(state, f)

    def guard(self, command):
        out = io.StringIO()
        return merge_guard.main([command], out=out), out.getvalue()

    def calls(self):
        with open(self.state + ".calls") as f:
            return [json.loads(line) for line in f]

    def test_a_merge_is_refused_while_tmp_is_on_the_head_branch(self):
        code, out = self.guard("gh pr merge 12 --squash --subject 'Fix it' --body \"a && gh pr merge 9\"")
        self.assertEqual(code, 3)
        self.assertIn("Refused: the head branch run/x of #12 still holds .tmp/", out)
        self.assertIn("git rm -r .tmp", out)
        self.assertEqual(self.calls()[1], ["api", "--silent", "repos/o/r/contents/.tmp?ref=run%2Fx"])

    def test_the_checked_out_branch_s_pull_request_and_a_repo_flag(self):
        code, _ = self.guard("cd repo && gh pr merge --squash")
        self.assertEqual(code, 3)
        self.assertEqual(self.calls()[0], ["pr", "view", "--json", "number,headRefName,headRepository,headRepositoryOwner,baseRefName,url"])
        self.guard("gh pr merge -R o/r 12 --auto --squash")
        self.assertEqual(self.calls()[3][:5], ["pr", "view", "12", "-R", "o/r"])

    def test_a_heredoc_body_is_no_selector(self):
        code, _ = self.guard("gh pr merge --squash --body-file - <<'EOF'\nThe digest.\n\nhttps://github.com/o/r/pull/5\nEOF")
        self.assertEqual(code, 3)
        self.assertEqual(self.calls()[0][:3], ["pr", "view", "--json"])

    def test_a_heredoc_body_with_an_apostrophe_is_not_read_as_shell(self):
        command = "gh pr merge 12 --squash --body-file - <<'EOF'\nIt doesn't add files.\nEOF\necho done"
        code, out = self.guard(command)
        self.assertEqual(code, 3)
        self.assertEqual(merge_guard.drop_heredocs(command), "gh pr merge 12 --squash --body-file - <<'EOF'\necho done")
        # <<- ends at a line that has tabs ahead of the word.
        self.assertEqual(merge_guard.drop_heredocs("cat <<-END\n\tx\n\tEND\nls"), "cat <<-END\nls")

    def test_a_command_shlex_cannot_split_is_reported_not_passed(self):
        code, out = self.guard("gh pr merge 12 --squash --subject \"unclosed")
        self.assertEqual(code, 1)
        self.assertIn("could not split the command into words", out)

    def test_a_tmp_that_the_base_branch_holds_too_is_not_refused(self):
        self.write({"prs": {"12": pr(12, "run/x")}, "tmp": ["run/x", "main"], "repo": "o/r"})
        code, out = self.guard("gh pr merge 12 --squash")
        self.assertEqual((code, out), (0, ""))
        self.assertEqual(self.calls()[2], ["api", "--silent", "repos/o/r/contents/.tmp?ref=main"])

    def test_a_branch_without_tmp_is_not_refused(self):
        code, out = self.guard("gh pr merge https://github.com/o/r/pull/9 --squash")
        self.assertEqual((code, out), (0, ""))

    def test_a_command_with_no_merge_checks_nothing(self):
        code, out = self.guard('git commit -m "then gh pr merge 12"')
        self.assertEqual((code, out), (0, ""))
        self.assertFalse(os.path.exists(self.state + ".calls"))

    def test_when_gh_cannot_tell_the_code_is_1_with_the_reason(self):
        code, out = self.guard("gh pr merge 404 --squash")
        self.assertEqual(code, 1)
        self.assertIn("gh pr view failed", out)
        self.write({"prs": {"": pr(5, "feat")}, "tmp": [], "down": True})
        code, out = self.guard("gh pr merge --squash")
        self.assertEqual(code, 1)
        self.assertIn("HTTP 502", out)

    def test_two_merges_in_one_command_are_both_checked(self):
        code, out = self.guard("gh pr merge 9 --squash; gh pr merge 12 --squash")
        self.assertEqual(code, 3)
        self.assertIn("#12", out)


if __name__ == "__main__":
    unittest.main()
