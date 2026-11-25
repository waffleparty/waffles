"""Tests for backlog_queue.py, with a fake adapter. Run: python3 -m unittest discover -s scripts -p '*_test.py'"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "backlog_queue.py")

ITEM = """---
status: new
type: background
kind: task
stop_at:
title: Fix the CORS header
summary: The API refuses the preview origin
depends: []
groomed:
worktree:
dev:
finished:
---

## Request

Fix the CORS header for the preview origin.

## Clarifications

## Progress
"""


class Unreachable(Exception):
    pass


class Refused(Exception):
    pass


class FakeAdapter:
    """A tracker behind an adapter: off, every call is unreachable; on, it keeps issues in memory."""

    def __init__(self):
        self.online = False
        self.issues = {}
        self.calls = []

    def call(self, step, item, data, backlog):
        if not self.online:
            raise Unreachable("no network")
        self.calls.append((step, item))
        if step == "raise":
            with open(os.path.join(backlog, item), encoding="utf-8") as f:
                text = f.read()
            key = f"AD-{len(self.issues) + 1}"
            self.issues[key] = {"text": text, "actor": data.get("actor"), "state": "not ready", "notes": []}
            return key
        issue = self.issues.get(item)
        if issue is None:
            raise Refused(f"no issue {item}")
        if step == "claim":
            if issue["state"] != "ready":
                raise Refused(f"{item} is {issue['state']}, not ready")
            issue["state"] = "in work"
        elif step == "note":
            issue["notes"].append(data["text"])
        return item


class Waffles:
    """What the backlog skills do with an adapter call: replay the queue first, then make the call; queue on unreachable."""

    def __init__(self, backlog, adapter):
        self.backlog = backlog
        self.adapter = adapter
        self.said = []

    def run(self, *args):
        return subprocess.run(
            [sys.executable, "-I", SCRIPT, *args, "--backlog", self.backlog], capture_output=True, text=True
        )

    def queued(self):
        r = self.run("list")
        assert r.returncode == 0, r.stderr
        return json.loads(r.stdout)

    def call(self, step, item, data=None):
        data = data or {}
        # The first queued call each time: a replayed raise renames the item in the calls after it.
        while queued := self.queued():
            entry = queued[0]
            try:
                answer = self.adapter.call(entry["step"], entry["item"], entry["data"], self.backlog)
            except Unreachable as e:
                return self.fall_back(step, item, data, str(e))
            except Refused as e:
                self.said.append(f"refused: {entry['step']} {entry['item']}: {e}")
                answer = None
            args = ["done", str(entry["seq"])]
            if entry["step"] == "raise" and answer is not None:
                args += ["--id", answer]
            r = self.run(*args)
            assert r.returncode == 0, r.stderr
            self.said.append(r.stdout.strip())
        try:
            return self.adapter.call(step, item, data, self.backlog)
        except Unreachable as e:
            return self.fall_back(step, item, data, str(e))

    def fall_back(self, step, item, data, cause):
        r = self.run("add", step, item, "--why", cause, "--data", json.dumps(data))
        assert r.returncode == 0, r.stderr
        self.said.append(f"fell back: {step} {item}: {cause}")
        return None


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.backlog = os.path.join(self.tmp.name, ".backlog")
        self.adapter = FakeAdapter()
        self.waffles = Waffles(self.backlog, self.adapter)

    def tearDown(self):
        self.tmp.cleanup()

    def write_item(self, name="fix-cors.md"):
        os.makedirs(self.backlog, exist_ok=True)
        with open(os.path.join(self.backlog, name), "w", encoding="utf-8") as f:
            f.write(ITEM)
        return name

    def test_with_the_tracker_off_an_item_queues_and_with_it_on_it_replays_and_the_file_is_gone(self):
        name = self.write_item()

        self.assertIsNone(self.waffles.call("raise", name, {"actor": "agent"}))
        self.assertIsNone(self.waffles.call("note", name, {"text": "Started the spec"}))

        self.assertEqual(self.adapter.issues, {})
        self.assertTrue(os.path.isfile(os.path.join(self.backlog, name)))
        queued = self.waffles.queued()
        self.assertEqual([(e["step"], e["item"], e["why"]) for e in queued], [("raise", name, "no network"), ("note", name, "no network")])
        self.assertEqual(self.waffles.said, [f"fell back: raise {name}: no network", f"fell back: note {name}: no network"])

        self.adapter.online = True
        self.adapter.issues["AD-100"] = {"text": "", "actor": "agent", "state": "ready", "notes": []}
        self.assertEqual(self.waffles.call("claim", "AD-100"), "AD-100")

        self.assertEqual(self.adapter.calls, [("raise", name), ("note", "AD-2"), ("claim", "AD-100")])
        self.assertEqual(self.adapter.issues["AD-2"]["text"], ITEM)
        self.assertEqual(self.adapter.issues["AD-2"]["actor"], "agent")
        self.assertEqual(self.adapter.issues["AD-2"]["notes"], ["Started the spec"])
        self.assertFalse(os.path.exists(os.path.join(self.backlog, name)))
        self.assertFalse(os.path.exists(os.path.join(self.backlog, "queue.json")))
        self.assertIn(f"{name} is AD-2 in the tracker", self.waffles.said[2])

    def test_a_call_made_while_the_queue_waits_goes_after_it_in_order(self):
        self.waffles.call("note", "AD-7", {"text": "first"})
        self.waffles.call("note", "AD-7", {"text": "second"})

        seqs = [e["seq"] for e in self.waffles.queued()]
        self.assertLess(seqs[0], seqs[1])
        self.assertEqual([e["data"]["text"] for e in self.waffles.queued()], ["first", "second"])

    def test_the_replay_stops_at_the_first_unreachable_call_and_keeps_the_rest(self):
        self.adapter.issues["AD-7"] = {"text": "", "actor": "agent", "state": "ready", "notes": []}
        self.waffles.call("note", "AD-7", {"text": "first"})
        self.waffles.call("note", "AD-7", {"text": "second"})
        self.adapter.online = True
        original = self.adapter.call

        def once_then_down(step, item, data, backlog):
            self.adapter.call = lambda *a: (_ for _ in ()).throw(Unreachable("expired credentials"))
            return original(step, item, data, backlog)

        self.adapter.call = once_then_down
        self.waffles.call("note", "AD-7", {"text": "third"})

        self.assertEqual(self.adapter.issues["AD-7"]["notes"], ["first"])
        self.assertEqual([(e["data"]["text"], e["why"]) for e in self.waffles.queued()], [("second", "no network"), ("third", "expired credentials")])

    def test_a_refused_call_in_the_replay_is_reported_and_not_queued_again(self):
        self.waffles.call("claim", "AD-9")
        self.adapter.online = True
        self.adapter.issues["AD-9"] = {"text": "", "actor": "agent", "state": "in work", "notes": []}

        self.waffles.call("note", "AD-9", {"text": "hi"})

        self.assertEqual(self.waffles.queued(), [])
        self.assertIn("refused: claim AD-9: AD-9 is in work, not ready", self.waffles.said)
        self.assertEqual(self.adapter.issues["AD-9"]["notes"], ["hi"])

    def test_the_folder_of_a_raised_item_stays_with_a_note(self):
        name = self.write_item()
        os.makedirs(os.path.join(self.backlog, "fix-cors"))
        self.waffles.call("raise", name, {"actor": "human"})
        self.adapter.online = True

        self.waffles.call("note", "AD-1", {"text": "x"})

        self.assertTrue(os.path.isdir(os.path.join(self.backlog, "fix-cors")))
        self.assertTrue(any("Kept " in line and "fix-cors/" in line for line in self.waffles.said))

    def test_a_refused_raise_takes_the_later_calls_for_its_file_with_it(self):
        name = self.write_item()
        self.waffles.call("raise", name, {"actor": "agent"})
        self.waffles.call("note", name, {"text": "x"})
        self.waffles.call("note", "AD-50", {"text": "other"})
        self.adapter.online = True
        self.adapter.issues["AD-50"] = {"text": "", "actor": "agent", "state": "ready", "notes": []}
        self.adapter.call = lambda step, item, data, backlog: (_ for _ in ()).throw(Refused("no project")) if step == "raise" else FakeAdapter.call(self.adapter, step, item, data, backlog)

        self.waffles.call("note", "AD-50", {"text": "now"})

        self.assertEqual(self.waffles.queued(), [])
        self.assertEqual(self.adapter.issues["AD-50"]["notes"], ["other", "now"])
        self.assertTrue(any(f"note {name}, since {name} was not raised" in line for line in self.waffles.said))
        self.assertTrue(os.path.isfile(os.path.join(self.backlog, name)))

    def test_a_raised_item_that_work_started_on_becomes_its_record_and_dependents_name_its_id(self):
        name = self.write_item()
        path = os.path.join(self.backlog, name)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        with open(path, "w", encoding="utf-8") as f:
            f.write(text.replace("status: new", "status: running"))
        later = os.path.join(self.backlog, "later.md")
        with open(later, "w", encoding="utf-8") as f:
            f.write(ITEM.replace("depends: []", f"depends: [{name}, other.md]"))
        self.waffles.call("raise", name, {"actor": "agent"})
        self.adapter.online = True

        self.waffles.call("note", "AD-1", {"text": "x"})

        self.assertFalse(os.path.exists(path))
        with open(os.path.join(self.backlog, "AD-1.md"), encoding="utf-8") as f:
            record = f.read()
        self.assertTrue(record.startswith("---\nid: AD-1\nstatus: running\n"))
        with open(later, encoding="utf-8") as f:
            self.assertIn("depends: [AD-1, other.md]", f.read())

    def test_a_seq_is_never_used_twice_so_a_stale_done_removes_nothing(self):
        first = json.loads(self.waffles.run("add", "note", "AD-1", "--why", "no network", "--data", "{}").stdout)["seq"]
        self.assertEqual(self.waffles.run("done", str(first)).returncode, 0)
        second = json.loads(self.waffles.run("add", "note", "AD-1", "--why", "no network", "--data", "{}").stdout)["seq"]

        r = self.waffles.run("done", str(first))

        self.assertGreater(second, first)
        self.assertEqual(r.returncode, 2)
        self.assertIn("another session may have replayed it", r.stderr)
        self.assertEqual([e["seq"] for e in self.waffles.queued()], [second])

    def test_the_queue_is_kept_out_of_git(self):
        subprocess.run(["git", "init", "-q", self.tmp.name], check=True)

        self.waffles.call("note", "AD-1", {"text": "x"})
        self.waffles.call("note", "AD-1", {"text": "y"})

        with open(os.path.join(self.tmp.name, ".git", "info", "exclude"), encoding="utf-8") as f:
            lines = f.read().splitlines()
        self.assertEqual(lines.count("/.backlog/queue.json"), 1)
        status = subprocess.run(["git", "-C", self.tmp.name, "status", "--porcelain"], capture_output=True, text=True).stdout
        self.assertEqual(status, "")

    def test_the_exclude_line_goes_on_its_own_line_and_only_once(self):
        subprocess.run(["git", "init", "-q", self.tmp.name], check=True)
        exclude = os.path.join(self.tmp.name, ".git", "info", "exclude")
        os.makedirs(os.path.dirname(exclude), exist_ok=True)
        with open(exclude, "w", encoding="utf-8") as f:
            f.write("*.log")

        self.waffles.call("note", "AD-1", {"text": "x"})
        self.waffles.call("note", "AD-1", {"text": "y"})

        with open(exclude, encoding="utf-8") as f:
            self.assertEqual(f.read(), "*.log\n/.backlog/queue.json\n/.backlog/.queue-*\n")

    def test_a_raised_file_that_cannot_be_updated_says_the_raise_is_no_longer_queued(self):
        name = self.write_item()
        later = os.path.join(self.backlog, "later.md")
        with open(later, "w", encoding="utf-8") as f:
            f.write(ITEM.replace("depends: []", f"depends: [{name}]"))
        os.chmod(later, 0o444)
        seq = json.loads(self.waffles.run("add", "raise", name, "--why", "no network").stdout)["seq"]

        r = self.waffles.run("done", str(seq), "--id", "AD-3")
        os.chmod(later, 0o644)

        self.assertEqual(r.returncode, 1)
        self.assertIn(f"{name} is AD-3 in the tracker, and the queue no longer holds its raise", r.stderr)
        self.assertIn("check the tracker for a duplicate of AD-3", r.stderr)
        self.assertEqual(self.waffles.queued(), [])

    def test_list_with_no_backlog_folder_is_empty_and_makes_none(self):
        self.assertEqual(self.waffles.queued(), [])
        self.assertFalse(os.path.exists(self.backlog))


class UsageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.backlog = os.path.join(self.tmp.name, ".backlog")
        os.makedirs(self.backlog)

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, *args):
        return subprocess.run(
            [sys.executable, "-I", SCRIPT, *args, "--backlog", self.backlog], capture_output=True, text=True
        )

    def test_bad_arguments_exit_2_with_the_reason(self):
        cases = [
            (("add", "pull", "AD-1", "--why", "x"), "not a step that writes"),
            (("add", "raise", "AD-1", "--why", "x"), "a raise names the .backlog/ file"),
            (("add", "note", "AD-1"), "--why must say why"),
            (("add", "note", "../AD-1", "--why", "x"), "not an item ID"),
            (("add", "note", "AD-1", "--why", "x", "--data", "[1]"), "--data must be a JSON object"),
            (("add", "note", "AD-1", "--why", "x", "--data", "{"), "--data is not JSON"),
            (("done", "4"), "no queued call 4"),
            (("done", "²"), "done takes the <seq>"),
            (("list", "extra"), "list takes no arguments"),
            (("frob",), "unknown command"),
        ]
        for args, reason in cases:
            r = self.run_script(*args)
            self.assertEqual(r.returncode, 2, args)
            self.assertIn(reason, r.stderr, args)

    def test_a_raise_of_a_missing_file_exits_1(self):
        r = self.run_script("add", "raise", "gone.md", "--why", "no network")

        self.assertEqual(r.returncode, 1)
        self.assertIn("no item file", r.stderr)

    def test_an_id_goes_with_a_raise_only(self):
        added = json.loads(self.run_script("add", "note", "AD-1", "--why", "no network", "--data", '{"text": "x"}').stdout)

        r = self.run_script("done", str(added["seq"]), "--id", "AD-2")

        self.assertEqual(r.returncode, 2)
        self.assertIn("--id goes with a raise", r.stderr)

    def test_a_queue_file_that_does_not_parse_exits_1(self):
        for text, reason in (("{not json", "cannot read"), ('[{"step": "note", "item": "AD-1"}]', "does not hold a list")):
            with open(os.path.join(self.backlog, "queue.json"), "w") as f:
                f.write(text)

            r = self.run_script("list")

            self.assertEqual(r.returncode, 1)
            self.assertIn(reason, r.stderr)


if __name__ == "__main__":
    unittest.main()
