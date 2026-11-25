"""Tests for merge_queue.py, with a stub gh. Run: python3 -m unittest discover -s scripts -p '*_test.py'"""

import io
import json
import os
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import merge_queue  # noqa: E402

# `gh pr view` answers pull request 12 of o/r on base "main", with the state's "review" as its review decision; `gh api repos/…/rules/branches/main` the state's
# "rules" (or the free plan's 403 with "no_rulesets"); `gh api graphql` the state's "pr".
GH = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json, os, sys
    with open(os.environ["GH_STUB_STATE"]) as f:
        state = json.load(f)
    args = sys.argv[1:]
    with open(os.environ["GH_STUB_STATE"] + ".calls", "a") as f:
        f.write(json.dumps(args) + "\\n")
    if args[:2] == ["pr", "view"]:
        print(json.dumps({"number": 12, "url": "https://github.com/o/r/pull/12", "baseRefName": state.get("base", "main"), "reviewDecision": state.get("review", "")}))
    elif args[:2] == ["api", "graphql"]:
        print(json.dumps({"data": {"repository": {"pullRequest": state["pr"]}}}))
    elif args[0] == "api" and "/rules/branches/" in args[1]:
        if state.get("no_rulesets"):
            print('{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.","status":"403"}')
            print("gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)", file=sys.stderr)
            sys.exit(1)
        if state.get("down"):
            print("gh: HTTP 502", file=sys.stderr)
            sys.exit(1)
        print(json.dumps(state["rules"]))
    else:
        sys.exit(2)
    """
)


def pr(merged=False, queued=None, auto=False, last=None, closed=False):
    return {
        "state": "MERGED" if merged else ("CLOSED" if closed else "OPEN"),
        "merged": merged,
        "isInMergeQueue": queued is not None,
        "mergeQueueEntry": queued,
        "autoMergeRequest": {"enabledAt": "2026-11-23T04:00:00Z"} if auto else None,
        "timelineItems": {"nodes": [last] if last else []},
    }


REMOVED = {"__typename": "RemovedFromMergeQueueEvent", "createdAt": "2026-11-23T05:00:00Z", "reason": "The merge commit failed the required check test"}


class MergeQueueTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        bin_dir = os.path.join(self.tmp.name, "bin")
        os.makedirs(bin_dir)
        with open(os.path.join(bin_dir, "gh"), "w") as f:
            f.write(GH)
        os.chmod(os.path.join(bin_dir, "gh"), 0o755)
        self.state = os.path.join(self.tmp.name, "gh.json")
        self.saved = {k: os.environ.get(k) for k in ("PATH", "GH_STUB_STATE")}
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ["PATH"]
        os.environ["GH_STUB_STATE"] = self.state

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def write(self, **state):
        with open(self.state, "w") as f:
            json.dump(state, f)

    def run_script(self, *args):
        out = io.StringIO()
        code = merge_queue.main(list(args), out=out)
        text = out.getvalue()
        return code, (json.loads(text) if code == 0 else text)

    def test_with_a_merge_queue_an_approved_pull_request_is_added_to_the_queue(self):
        self.write(rules=[{"type": "pull_request"}, {"type": "merge_queue", "parameters": {"merge_method": "SQUASH"}}], base="release/1.0", review="APPROVED")
        code, result = self.run_script("mode", "12")
        self.assertEqual(code, 0)
        # No merge method and no --auto: the queue's own method applies, and the repo may not allow auto-merge.
        self.assertEqual((result["queue"], result["approved"], result["command"]), (True, True, "gh pr merge 12"))
        with open(self.state + ".calls") as f:
            calls = [json.loads(line) for line in f]
        self.assertIn("reviewDecision", calls[0][calls[0].index("--json") + 1])
        self.assertEqual(calls[1], ["api", "repos/o/r/rules/branches/release%2F1.0"])
        # No review required: GitHub adds it too.
        self.write(rules=[{"type": "merge_queue", "parameters": {"merge_method": "SQUASH"}}], review="")
        self.assertEqual(self.run_script("mode", "12")[1]["command"], "gh pr merge 12")

    def test_with_a_merge_queue_a_pull_request_without_an_approval_gets_the_admin_bypass(self):
        cases = [
            ("REVIEW_REQUIRED", "SQUASH", "gh pr merge 12 --squash --admin --subject <subject> --body <digest>"),
            ("CHANGES_REQUESTED", "MERGE", "gh pr merge 12 --merge --admin --subject <subject> --body <digest>"),
            ("REVIEW_REQUIRED", "REBASE", "gh pr merge 12 --rebase --admin"),
            ("REVIEW_REQUIRED", None, "gh pr merge 12 --squash --admin --subject <subject> --body <digest>"),
        ]
        for review, method, command in cases:
            self.write(rules=[{"type": "merge_queue", "parameters": {"merge_method": method} if method else {}}], review=review)
            code, result = self.run_script("mode", "12")
            self.assertEqual(code, 0)
            self.assertEqual((result["queue"], result["approved"], result["review"], result["command"]), (True, False, review, command))
            self.assertIn("leave it for a reviewer", result["why"])

    def test_without_a_queue_merge_is_a_squash_now(self):
        self.write(rules=[{"type": "pull_request"}])
        code, result = self.run_script("mode", "https://github.com/o/r/pull/12")
        self.assertEqual((code, result["queue"]), (0, False))
        self.assertEqual(result["command"], "gh pr merge 12 --squash --subject <subject> --body <digest>")
        self.write(no_rulesets=True)
        code, result = self.run_script("mode", "12")
        self.assertEqual((code, result["queue"]), (0, False))
        self.assertIn("no rulesets", result["why"])

    def test_when_gh_cannot_read_the_rules_the_reason_says_so(self):
        self.write(down=True)
        code, text = self.run_script("mode", "12")
        self.assertEqual(code, 1)
        self.assertIn("HTTP 502", text)

    def test_a_pull_request_the_queue_removed_is_removed_with_github_s_reason(self):
        self.write(pr=pr(last=REMOVED))
        code, result = self.run_script("state", "12")
        self.assertEqual(code, 0)
        self.assertEqual(result, {"state": "removed", "number": 12, "reason": "The merge commit failed the required check test", "at": "2026-11-23T05:00:00Z"})

    def test_merged_queued_waiting_closed_and_open(self):
        cases = [
            (pr(merged=True, last={"__typename": "AddedToMergeQueueEvent", "createdAt": "x"}), "merged"),
            (pr(queued={"state": "AWAITING_CHECKS", "position": 2}), "queued"),
            (pr(auto=True), "waiting"),
            # Added again after a removal: auto-merge is on, so it waits again.
            (pr(auto=True, last=REMOVED), "waiting"),
            (pr(closed=True, last=REMOVED), "closed"),
            (pr(), "open"),
        ]
        for data, expected in cases:
            self.write(pr=data)
            code, result = self.run_script("state", "12")
            self.assertEqual((code, result["state"]), (0, expected), data)
        self.write(pr=pr(queued={"state": "QUEUED", "position": 3}))
        self.assertEqual(self.run_script("state", "12")[1], {"state": "queued", "number": 12, "position": 3, "entry": "QUEUED"})
        with open(self.state + ".calls") as f:
            graphql = [json.loads(line) for line in f if '"graphql"' in line][-1]
        # Owner and name go as strings (-f), so an all-digit name is not sent as a number; the number as -F.
        self.assertEqual(graphql[2:8], ["-f", "owner=o", "-f", "name=r", "-F", "number=12"])


if __name__ == "__main__":
    unittest.main()
