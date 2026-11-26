"""Tests for builders.py, on a local origin. Run: python3 -m unittest discover -s scripts -p '*_test.py'"""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import builders  # noqa: E402

GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}


def sh(cwd, *args):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True, env={**os.environ, **GIT_ENV}).stdout.strip()


def commit(cwd, name, text):
    with open(os.path.join(cwd, name), "w") as f:
        f.write(text)
    sh(cwd, "git", "add", name)
    sh(cwd, "git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", f"Add {name}")


class BuildersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = os.path.realpath(self.tmp.name)
        self.origin = os.path.join(base, "remote", "example", "widget.git")
        os.makedirs(self.origin)
        sh(self.origin, "git", "init", "-q", "--bare", "-b", "main")
        self.main = os.path.join(base, "widget")
        sh(base, "git", "clone", "-q", self.origin, self.main)
        sh(self.main, "git", "switch", "-q", "-c", "main")
        commit(self.main, "README.md", "widget\n")
        sh(self.main, "git", "push", "-q", "-u", "origin", "main")
        sh(self.main, "git", "remote", "set-head", "origin", "main")
        self.root = os.path.join(base, "builders")
        self.saved = os.environ.get("WAFFLES_BUILDERS_ROOT")
        os.environ["WAFFLES_BUILDERS_ROOT"] = self.root

    def tearDown(self):
        if self.saved is None:
            os.environ.pop("WAFFLES_BUILDERS_ROOT", None)
        else:
            os.environ["WAFFLES_BUILDERS_ROOT"] = self.saved
        self.tmp.cleanup()

    def run_script(self, *args):
        out = io.StringIO()
        code = builders.main(list(args), out=out)
        text = out.getvalue()
        return code, (json.loads(text) if code == 0 else text)

    def clone(self, item, branch, *more):
        code, result = self.run_script("clone", "--repo", self.main, "--item", item, "--branch", branch, *more)
        self.assertEqual(code, 0, result)
        return result

    def test_two_builders_in_one_repo_never_touch_the_same_checkout(self):
        a = self.clone("ITEM-1", "feat/ITEM-1")
        b = self.clone("ITEM-2", "feat/ITEM-2-other")
        self.assertEqual(a["path"], os.path.join(self.root, "example", "widget", "ITEM-1"))
        self.assertEqual(b["path"], os.path.join(self.root, "example", "widget", "ITEM-2"))
        checkouts = {self.main, a["path"], b["path"]}
        git_dirs = {sh(p, "git", "rev-parse", "--absolute-git-dir") for p in checkouts}
        self.assertEqual(len(checkouts), 3)
        self.assertEqual(len(git_dirs), 3)
        # Full clones, not worktrees: each has its own object store and no link to the main checkout's.
        for path in (a["path"], b["path"]):
            self.assertTrue(os.path.isdir(os.path.join(path, ".git", "objects")))
            self.assertFalse(os.path.exists(os.path.join(path, ".git", "objects", "info", "alternates")))
            self.assertEqual(sh(path, "git", "remote", "get-url", "origin"), self.origin)
        self.assertEqual(sh(a["path"], "git", "branch", "--show-current"), "feat/ITEM-1")
        self.assertEqual(sh(b["path"], "git", "branch", "--show-current"), "feat/ITEM-2-other")
        # Work in one clone shows in neither the other clone nor the main checkout.
        commit(a["path"], "a.txt", "a\n")
        with open(os.path.join(b["path"], "b.txt"), "w") as f:
            f.write("b\n")
        self.assertFalse(os.path.exists(os.path.join(b["path"], "a.txt")))
        self.assertFalse(os.path.exists(os.path.join(self.main, "a.txt")))
        self.assertEqual(sh(self.main, "git", "status", "--porcelain"), "")
        self.assertEqual(sh(self.main, "git", "branch", "--list", "feat/*"), "")
        self.assertEqual(sh(a["path"], "git", "status", "--porcelain"), "")

    def test_an_item_that_depends_on_an_unmerged_one_stacks_on_its_branch(self):
        a = self.clone("ITEM-1", "feat/ITEM-1")
        commit(a["path"], "a.txt", "a\n")
        sh(a["path"], "git", "push", "-q", "-u", "origin", "feat/ITEM-1")
        b = self.clone("ITEM-2", "feat/ITEM-2", "--base", "feat/ITEM-1")
        self.assertEqual(b["base"], "feat/ITEM-1")
        self.assertTrue(os.path.isfile(os.path.join(b["path"], "a.txt")))
        # The branch has no upstream yet: its first push sets it.
        self.assertEqual(subprocess.run(["git", "-C", b["path"], "rev-parse", "--abbrev-ref", "@{upstream}"], capture_output=True).returncode, 128)

    def test_a_base_that_is_not_pushed_is_refused_and_leaves_no_clone(self):
        code, text = self.run_script("clone", "--repo", self.main, "--item", "ITEM-3", "--branch", "feat/ITEM-3", "--base", "feat/ITEM-9")
        self.assertEqual(code, 3)
        self.assertIn("origin has no branch feat/ITEM-9", text)
        self.assertFalse(os.path.exists(os.path.join(self.root, "example", "widget", "ITEM-3")))

    def test_a_branch_on_origin_is_checked_out_as_it_is(self):
        a = self.clone("ITEM-1", "feat/ITEM-1")
        commit(a["path"], "a.txt", "a\n")
        sh(a["path"], "git", "push", "-q", "-u", "origin", "feat/ITEM-1")
        self.assertEqual(self.run_script("remove", "--path", a["path"])[0], 0)
        again = self.clone("ITEM-1", "feat/ITEM-1")
        self.assertFalse(again["reused"])
        self.assertTrue(os.path.isfile(os.path.join(again["path"], "a.txt")))

    def test_the_clone_of_an_item_is_reused_on_its_branch_and_refused_on_another(self):
        first = self.clone("ITEM-1", "feat/ITEM-1")
        again = self.clone("ITEM-1", "feat/ITEM-1")
        self.assertEqual((again["path"], again["reused"], again["base"]), (first["path"], True, "main"))
        code, text = self.run_script("clone", "--repo", self.main, "--item", "ITEM-1", "--branch", "feat/ITEM-1-new")
        self.assertEqual(code, 3)
        self.assertIn("on branch feat/ITEM-1, not feat/ITEM-1-new", text)

    def test_remove_keeps_a_clone_with_work_that_origin_lacks(self):
        a = self.clone("ITEM-1", "feat/ITEM-1")
        with open(os.path.join(a["path"], "a.txt"), "w") as f:
            f.write("a\n")
        code, text = self.run_script("remove", "--path", a["path"])
        self.assertEqual(code, 3)
        self.assertIn("not committed", text)
        commit(a["path"], "a.txt", "a\n")
        code, text = self.run_script("remove", "--path", a["path"])
        self.assertEqual(code, 3)
        self.assertIn("commits that origin lacks", text)
        sh(a["path"], "git", "push", "-q", "-u", "origin", "feat/ITEM-1")
        with open(os.path.join(a["path"], "a.txt"), "w") as f:
            f.write("stashed\n")
        sh(a["path"], "git", "stash", "-q")
        code, text = self.run_script("remove", "--path", a["path"])
        self.assertEqual(code, 3)
        self.assertIn("stashed changes", text)
        sh(a["path"], "git", "stash", "drop", "-q")
        sh(a["path"], "git", "switch", "-q", "--detach")
        commit(a["path"], "d.txt", "detached\n")
        code, text = self.run_script("remove", "--path", a["path"])
        self.assertEqual(code, 3)
        self.assertIn("Add d.txt", text)
        sh(a["path"], "git", "switch", "-q", "feat/ITEM-1")
        self.assertEqual(self.run_script("remove", "--path", a["path"])[0], 0)
        self.assertFalse(os.path.exists(os.path.join(self.root, "example")))

    def test_clone_uses_root_when_no_variable_is_set_and_refuses_with_neither(self):
        os.environ.pop("WAFFLES_BUILDERS_ROOT", None)
        other = os.path.join(os.path.dirname(self.root), "scratch")
        out = io.StringIO()
        self.assertEqual(builders.main(["clone", "--root", other, "--repo", self.main, "--item", "ITEM-9", "--branch", "feat/ITEM-9"], out=out), 0)
        self.assertEqual(json.loads(out.getvalue())["path"], os.path.join(os.path.realpath(other), "example", "widget", "ITEM-9"))
        out = io.StringIO()
        self.assertEqual(builders.main(["clone", "--repo", self.main, "--item", "ITEM-8", "--branch", "feat/ITEM-8"], out=out), 3)
        self.assertIn("--root", out.getvalue())

    def test_remove_refuses_a_folder_outside_the_builders_root(self):
        code, text = self.run_script("remove", "--path", self.main)
        self.assertEqual(code, 3)
        self.assertIn("is not a builder's clone", text)
        self.assertTrue(os.path.isdir(self.main))

    def test_owner_and_repo_come_from_any_form_of_url(self):
        for url in ("git@github.com:example/widget.git", "https://github.com/example/widget", "ssh://git@github.com/example/widget.git", "/srv/example/widget.git/"):
            self.assertEqual(builders.owner_repo(url), ("example", "widget"), url)



SKILLS = os.path.join(os.path.dirname(HERE), "skills")

class NoPatchRecipes(unittest.TestCase):
    def test_neither_work_loop_nor_the_run_skill_hands_work_back_as_a_patch(self):
        skills = SKILLS
        files = [os.path.join(skills, "work-loop", "SKILL.md")]
        run = os.path.join(skills, "non-interactive")
        files += [os.path.join(run, name) for name in sorted(os.listdir(run)) if name.endswith(".md")]
        for path in files:
            with open(path, encoding="utf-8") as f:
                text = f.read()
            self.assertNotRegex(text, r"(?i)\bpatch|git apply|isolation: \"worktree\"", path)

    def test_the_limits_in_work_loop_are_the_script_s(self):
        with open(os.path.join(SKILLS, "work-loop", "SKILL.md"), encoding="utf-8") as f:
            text = " ".join(f.read().split())
        self.assertIn(f"At most {builders.REVIEW_CAP} open pull requests per repo that wait for human review", text)
        self.assertIn(f"{builders.TEST_SLOTS} builders running tests at once on this machine", text)
        self.assertIn("builders.py limits --repo <main>", text)


# `gh pr list` answers the pull requests in the state file, or fails when "down" is set.
GH = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ["GH_STUB_STATE"]) as f:
    state = json.load(f)
if state.get("down"):
    print("gh: HTTP 502", file=sys.stderr)
    sys.exit(1)
if sys.argv[1:3] != ["pr", "list"]:
    sys.exit(2)
print(json.dumps(state["prs"]))
"""


def pr(number, draft=False, requested=True):
    return {"number": number, "title": f"Item {number}", "url": f"https://github.com/example/widget/pull/{number}", "isDraft": draft, "reviewRequests": [{"login": "octocat"}] if requested else []}


class LimitsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = os.path.realpath(self.tmp.name)
        bin_dir = os.path.join(base, "bin")
        os.makedirs(bin_dir)
        with open(os.path.join(bin_dir, "gh"), "w") as f:
            f.write(GH)
        os.chmod(os.path.join(bin_dir, "gh"), 0o755)
        self.repo = os.path.join(base, "widget")
        os.makedirs(self.repo)
        sh(self.repo, "git", "init", "-q")
        self.state = os.path.join(base, "gh.json")
        self.saved = {k: os.environ.get(k) for k in ("PATH", "GH_STUB_STATE", "WAFFLES_TEST_SLOTS")}
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ["PATH"]
        os.environ["GH_STUB_STATE"] = self.state
        os.environ["WAFFLES_TEST_SLOTS"] = os.path.join(base, "slots")
        self.base = base

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def prs(self, prs, down=False):
        with open(self.state, "w") as f:
            json.dump({"prs": prs, "down": down}, f)

    def limits(self):
        out = io.StringIO()
        return builders.main(["limits", "--repo", self.repo], out=out), out.getvalue()

    def test_with_10_pull_requests_waiting_for_review_no_builder_starts_and_the_reason_lists_them(self):
        self.prs([pr(n) for n in range(1, 11)])
        code, out = self.limits()
        self.assertEqual(code, 3)
        self.assertIn("Refused: 10 open pull requests in widget wait for human review (ready, with a review requested), and the cap is 10.", out)
        self.assertIn("- #10 Item 10: https://github.com/example/widget/pull/10", out)

    def test_drafts_and_pull_requests_with_no_review_requested_do_not_count(self):
        self.prs([pr(n) for n in range(1, 10)] + [pr(20, draft=True), pr(21, requested=False)])
        code, out = self.limits()
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out), {"waiting": 9, "cap": 10, "numbers": list(range(1, 10))})

    def test_when_gh_cannot_count_the_reason_says_so(self):
        self.prs([], down=True)
        code, out = self.limits()
        self.assertEqual(code, 1)
        self.assertIn("the pull requests that wait for review are not counted: gh: HTTP 502", out)

    def slot_runs(self, slots):
        """2 commands at once, each sleeping 0.6 s: their start and end times."""
        script = os.path.join(HERE, "builders.py")
        logs = [os.path.join(self.base, f"log-{slots}-{n}") for n in range(2)]
        cmd = ["python3", "-c", "import sys, time; s = time.time(); time.sleep(0.6); open(sys.argv[1], 'w').write(f'{s} {time.time()}')"]
        runs = [subprocess.Popen([sys.executable, "-I", script, "test-slot", "--slots", str(slots), "--", *cmd, log], stdout=subprocess.PIPE, text=True) for log in logs]
        outs = [r.communicate()[0] for r in runs]
        self.assertEqual([r.returncode for r in runs], [0, 0])
        spans = []
        for log in logs:
            with open(log) as f:
                spans.append(tuple(map(float, f.read().split())))
        return sorted(spans), outs

    def test_test_runs_beyond_the_slots_wait_for_a_free_one(self):
        spans, outs = self.slot_runs(1)
        self.assertGreaterEqual(spans[1][0], spans[0][1])
        self.assertTrue(any("Waiting for a test slot: all 1 are in use on this machine." in o for o in outs))
        spans, _ = self.slot_runs(2)
        self.assertLess(spans[1][0], spans[0][1])

    def test_test_slot_passes_on_the_command_s_exit_code(self):
        out = io.StringIO()
        self.assertEqual(builders.main(["test-slot", "--", "python3", "-c", "raise SystemExit(5)"], out=out), 5)
        self.assertEqual(builders.main(["test-slot"], out=io.StringIO()), 2)

if __name__ == "__main__":
    unittest.main()
