"""Tests for review_branch.py, on a local origin and a stub gh. Run: python3 -m unittest discover -s scripts -p '*_test.py'"""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import review_branch  # noqa: E402

GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}

# `gh pr list` answers the pull requests in GH_STUB_PRS.
GH = """#!/usr/bin/env python3
import os, sys
if sys.argv[1:3] != ["pr", "list"] or "review-requested:@me" not in sys.argv:
    sys.exit(2)
print(os.environ["GH_STUB_PRS"])
"""


def sh(cwd, *args):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class ReviewBranchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = os.path.realpath(self.tmp.name)
        self.saved = {k: os.environ.get(k) for k in [*GIT_ENV, "PATH", "GH_STUB_PRS"]}
        os.environ.update(GIT_ENV)
        bin_dir = os.path.join(base, "bin")
        os.makedirs(bin_dir)
        with open(os.path.join(bin_dir, "gh"), "w") as f:
            f.write(GH)
        os.chmod(os.path.join(bin_dir, "gh"), 0o755)
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ["PATH"]
        self.origin = os.path.join(base, "origin.git")
        sh(base, "git", "init", "-q", "--bare", "-b", "main", self.origin)
        self.main = os.path.join(base, "app")
        sh(base, "git", "clone", "-q", self.origin, self.main)
        sh(self.main, "git", "switch", "-q", "-c", "main")
        self.commit("app.txt", "header\nbody\n")
        sh(self.main, "git", "push", "-q", "-u", "origin", "main")
        sh(self.main, "git", "remote", "set-head", "origin", "main")
        # 3 UI pull requests that touch separate files, and 1 that conflicts with #1.
        for n, (name, text) in {1: ("app.txt", "header\nbody, version 1\n"), 2: ("page2.txt", "2\n"), 3: ("page3.txt", "3\n"), 4: ("app.txt", "header\nbody, version 4\n")}.items():
            sh(self.main, "git", "switch", "-q", "-c", f"feat/PM-{n}", "main")
            self.commit(name, text)
            sh(self.main, "git", "push", "-q", "origin", f"HEAD:refs/pull/{n}/head")
        sh(self.main, "git", "switch", "-q", "main")
        sh(self.main, "git", "switch", "-q", "-c", "feat/mine")

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def commit(self, name, text):
        with open(os.path.join(self.main, name), "w") as f:
            f.write(text)
        sh(self.main, "git", "add", name)
        sh(self.main, "git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", f"Change {name}")

    def run_script(self, *args):
        out = io.StringIO()
        code = review_branch.main(list(args), out=out)
        text = out.getvalue()
        return code, (json.loads(text) if code == 0 else text)

    def test_3_ui_pull_requests_are_merged_into_one_local_branch_that_has_no_upstream(self):
        code, result = self.run_script("build", "--repo", self.main, "--pr", "1", "2", "3")
        self.assertEqual(code, 0, result)
        self.assertEqual((result["merged"], result["conflicts"], result["from"]), ([1, 2, 3], [], "feat/mine"))
        self.assertEqual(sh(self.main, "git", "branch", "--show-current"), "waffles-review")
        for name, text in (("app.txt", "header\nbody, version 1\n"), ("page2.txt", "2\n"), ("page3.txt", "3\n")):
            with open(os.path.join(self.main, name)) as f:
                self.assertEqual(f.read(), text)
        self.assertEqual(subprocess.run(["git", "-C", self.main, "rev-parse", "--abbrev-ref", "waffles-review@{upstream}"], capture_output=True).returncode, 128)
        self.assertNotIn("waffles-review", sh(self.main, "git", "ls-remote", "origin"))

    def test_a_pull_request_that_conflicts_is_left_out_and_named(self):
        code, result = self.run_script("build", "--repo", self.main, "--pr", "1", "4", "2")
        self.assertEqual(code, 0, result)
        self.assertEqual((result["merged"], result["conflicts"]), ([1, 2], [4]))
        self.assertEqual(sh(self.main, "git", "status", "--porcelain"), "")

    def test_a_rebuild_starts_over_and_done_switches_back_and_deletes_the_branch(self):
        self.run_script("build", "--repo", self.main, "--pr", "1")
        code, result = self.run_script("build", "--repo", self.main, "--pr", "2", "3")
        self.assertEqual((code, result["merged"], result["from"]), (0, [2, 3], "feat/mine"))
        with open(os.path.join(self.main, "app.txt")) as f:
            self.assertEqual(f.read(), "header\nbody\n")
        code, result = self.run_script("done", "--repo", self.main)
        self.assertEqual(code, 0, result)
        self.assertEqual(sh(self.main, "git", "branch", "--show-current"), "feat/mine")
        self.assertEqual(sh(self.main, "git", "branch", "--list", "waffles-review"), "")
        self.assertEqual(sh(self.main, "git", "for-each-ref", "refs/waffles-review"), "")

    def test_waiting_takes_the_ready_pull_requests_that_ask_for_a_review(self):
        os.environ["GH_STUB_PRS"] = json.dumps([{"number": 3, "isDraft": False}, {"number": 2, "isDraft": False}, {"number": 9, "isDraft": True}])
        code, result = self.run_script("build", "--repo", self.main, "--waiting")
        self.assertEqual((code, result["merged"]), (0, [2, 3]))

    def test_changes_to_tracked_files_are_refused(self):
        with open(os.path.join(self.main, "app.txt"), "a") as f:
            f.write("work in progress\n")
        code, text = self.run_script("build", "--repo", self.main, "--pr", "1")
        self.assertEqual(code, 3)
        self.assertIn("has changes to tracked files", text)
        self.assertEqual(sh(self.main, "git", "branch", "--show-current"), "feat/mine")


    def test_own_commits_on_waffles_review_are_never_lost(self):
        self.run_script("build", "--repo", self.main, "--pr", "1")
        self.commit("mine.txt", "my own work\n")
        for args in (("build", "--repo", self.main, "--pr", "2"), ("done", "--repo", self.main)):
            code, text = self.run_script(*args)
            self.assertEqual(code, 3, args)
            self.assertIn("holds commits that are not merges of the pull requests", text)
            self.assertIn("Change mine.txt", text)
        self.assertTrue(os.path.isfile(os.path.join(self.main, "mine.txt")))
        # A branch named waffles-review that the script did not make is refused the same way.
        sh(self.main, "git", "switch", "-q", "feat/mine")
        sh(self.main, "git", "branch", "-q", "-D", "waffles-review")
        sh(self.main, "git", "switch", "-q", "-c", "waffles-review")
        self.commit("other.txt", "other\n")
        sh(self.main, "git", "switch", "-q", "feat/mine")
        code, text = self.run_script("build", "--repo", self.main, "--pr", "1")
        self.assertEqual(code, 3)
        self.assertIn("Change other.txt", text)

if __name__ == "__main__":
    unittest.main()
