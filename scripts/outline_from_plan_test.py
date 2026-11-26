"""Tests for outline_from_plan.py. Run: python3 -m unittest discover -s scripts -p '*_test.py'"""

import io
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "outline_from_plan.py")
sys.path.insert(0, HERE)

import outline_from_plan  # noqa: E402

# A plan as writing-plans 7.0.2 writes it once it is told that waffles builds: its header line names waffles, not a
# superpowers skill, and each task ends with a commit step.
PLAN = textwrap.dedent(
    """\
    # Line Count Flag Implementation Plan

    > **For agentic workers:** waffles builds this plan, task by task, one commit per task. Steps use checkbox (`- [ ]`) syntax for tracking.

    **Goal:** Add a --lines flag to wc.py.

    ## Global Constraints

    - Python 3.11, standard library only.

    ---

    ### Task 1: Count lines

    **Files:**
    - Modify: `wc.py`

    - [ ] **Step 1: Write the failing test**

    ````markdown
    ### Task 9: Not a task, only an example inside a fence
    ````

    - [ ] **Step 5: Commit**

    ```bash
    git commit -m "feat: count lines"
    ### Task 8: a shell comment that looks like a heading
    ```

    ### Task 2 — Add the --lines flag ###

    - [ ] **Step 1: Write the failing test**

    ### Task 3. Document the flag in the README
    """
)


def run(text, *args, spec=None):
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "plan.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        if spec is not None:
            spec_path = os.path.join(tmp, "spec.md")
            with open(spec_path, "w", encoding="utf-8") as f:
                f.write(spec)
            args = ("--spec", spec_path, *args)
        out, err = io.StringIO(), io.StringIO()
        code = outline_from_plan.main([path, *args], out=out, err=err)
        return code, out.getvalue(), err.getvalue()


class OutlineFromPlan(unittest.TestCase):
    def test_each_task_heading_is_one_step_and_the_last_step_removes_the_working_files(self):
        code, out, _ = run(PLAN)

        self.assertEqual(code, 0)
        self.assertEqual(
            json.loads(out),
            {
                "title": "Line Count Flag",
                "steps": [
                    {"title": "Count lines"},
                    {"title": "Add the --lines flag"},
                    {"title": "Document the flag in the README"},
                    {"title": "Remove the working files"},
                ],
            },
        )

    def test_the_header_line_does_not_matter(self):
        # The header that writing-plans writes when nobody told it how the plan is carried out.
        original = PLAN.replace(
            "waffles builds this plan, task by task, one commit per task.",
            "REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.",
        )
        without = "\n".join(line for line in PLAN.split("\n") if not line.startswith("> "))

        self.assertEqual(run(original)[1], run(PLAN)[1])
        self.assertEqual(run(without)[1], run(PLAN)[1])

    def test_a_plan_that_ends_with_removing_the_working_files_gets_it_once(self):
        code, out, _ = run(PLAN + "\n### Task 4: Remove the working files\n")

        self.assertEqual(code, 0)
        titles = [s["title"] for s in json.loads(out)["steps"]]
        self.assertEqual(titles.count("Remove the working files"), 1)
        self.assertEqual(titles[-1], "Remove the working files")

    def test_a_plan_with_no_task_heading_fails_with_the_reason(self):
        code, out, err = run("# A Plan\n\n## Steps\n\n1. Do the thing\n")

        self.assertEqual((code, out), (1, ""))
        self.assertIn("has no task heading (### Task N: <name>)", err)

    def test_a_plan_with_no_title_takes_the_specs_then_the_given_one(self):
        plan = "### Task 1: Count lines\n"
        spec = "# Line count flag design\n\n- Issue: ITEM-58\n"

        self.assertEqual(json.loads(run(plan, spec=spec)[1])["title"], "Line count flag design")
        self.assertEqual(json.loads(run(plan, "--title", "ITEM-58: Count lines", spec="No heading\n")[1])["title"], "ITEM-58: Count lines")
        self.assertEqual(json.loads(run(plan, "--title", "ITEM-58: Count lines")[1])["title"], "ITEM-58: Count lines")
        self.assertIsNone(json.loads(run(plan)[1])["title"])
        # The plan's own title comes first.
        self.assertEqual(json.loads(run("# Count Implementation Plan\n\n" + plan, "--title", "x", spec=spec)[1])["title"], "Count")

    def test_a_task_with_a_dotted_number_keeps_the_full_number(self):
        code, out, _ = run("### Task 1: Count lines\n### Task 1.1: Count empty lines\n### Task 2.3.1 - Print them\n")

        self.assertEqual(code, 0)
        self.assertEqual(
            [s["title"] for s in json.loads(out)["steps"]],
            ["Count lines", "1.1: Count empty lines", "2.3.1: Print them", "Remove the working files"],
        )

    def test_a_fence_in_a_list_item_closes_at_another_indent(self):
        plan = textwrap.dedent(
            """\
            ### Task 1: Count lines

            - [ ] **Step 1: Write the failing test**

              ```python
              ### Task 7: a comment, not a task
                ```

            ### Task 2: Print the count
            """
        )
        code, out, _ = run(plan)

        self.assertEqual(code, 0)
        self.assertEqual([s["title"] for s in json.loads(out)["steps"]], ["Count lines", "Print the count", "Remove the working files"])

    def test_a_missing_file_and_bad_arguments(self):
        err = io.StringIO()
        self.assertEqual(outline_from_plan.main(["/nonexistent/plan.md"], out=io.StringIO(), err=err), 1)
        self.assertIn("cannot be read", err.getvalue())
        self.assertEqual(outline_from_plan.main([], out=io.StringIO(), err=io.StringIO()), 2)
        self.assertEqual(outline_from_plan.main(["--help"], out=io.StringIO(), err=io.StringIO()), 2)
        self.assertEqual(outline_from_plan.main(["a.md", "--title"], out=io.StringIO(), err=io.StringIO()), 2)
        self.assertEqual(run("### Task 1: Count\n", "--spec", "/nonexistent/spec.md")[0], 1)

    def test_the_command_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "plan.md")
            with open(path, "w", encoding="utf-8") as f:
                f.write(PLAN)
            done = subprocess.run([sys.executable, "-I", SCRIPT, path], capture_output=True, text=True)

        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(len(json.loads(done.stdout)["steps"]), 4)


if __name__ == "__main__":
    unittest.main()
