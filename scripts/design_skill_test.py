"""Tests for the messages the design skill sends superpowers. Run: python3 -m unittest discover -s scripts -p '*_test.py'

The layer over superpowers 7.0.2 rests on 3 preferences that the skill's own text allows (where the spec and
the plan go, and that an execution method was supplied) and on 2 next steps that it overrides. These tests
read the 2 prompts in skills/design/SKILL.md and the run reviewer's definition, so an edit cannot drop one.
"""

import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
SKILL_DIR = os.path.join(PLUGIN, "skills", "design")

with open(os.path.join(SKILL_DIR, "SKILL.md"), encoding="utf-8") as f:
    SKILL = f.read()
with open(os.path.join(PLUGIN, "agents", "run-reviewer.md"), encoding="utf-8") as f:
    REVIEWER = f.read()

PROMPTS = re.findall(r"^```text\n(.*?)^```$", SKILL, re.MULTILINE | re.DOTALL)
# The skill's prose, with its line breaks as spaces, for the sentences that wrap.
FLAT = " ".join(SKILL.split())
BRAINSTORMING = next(p for p in PROMPTS if "superpowers:brainstorming" in p)
WRITING_PLANS = next(p for p in PROMPTS if "superpowers:writing-plans" in p)


class Handover(unittest.TestCase):
    def test_the_spec_goes_to_tmp_plan_and_nothing_under_docs_superpowers(self):
        self.assertIn("Write the design doc to <checkout path>/.tmp/plan/spec.md.", BRAINSTORMING)
        self.assertIn("Write nothing under docs/superpowers/.", BRAINSTORMING)
        self.assertIn("Do not commit", BRAINSTORMING)

    def test_brainstorming_stops_after_the_approval_so_waffles_attaches_the_spec_first(self):
        self.assertIn("Do not invoke writing-plans or any other skill yet", BRAINSTORMING)
        self.assertIn("waffles attaches the spec to the item first", BRAINSTORMING)

    def test_no_stop_is_answered_in_advance(self):
        self.assertIn("I answer each one when it comes.", BRAINSTORMING)
        for advance in ("treat it as approved", "as approved by me", "I pick your recommendation", "take the one you recommend"):
            self.assertNotIn(advance.lower(), BRAINSTORMING.lower())

    def test_the_handover_carries_the_brief_the_rows_and_the_scenarios(self):
        for part in ("<request>", "<watchpoints>", "<rows and scenarios>", "<answers>"):
            self.assertIn(part, BRAINSTORMING)


class WritingPlans(unittest.TestCase):
    def test_the_plan_goes_to_tmp_plan_and_nothing_under_docs_superpowers(self):
        self.assertIn("Write the plan to <checkout path>/.tmp/plan/plan.md.", WRITING_PLANS)
        self.assertIn("Write nothing under docs/superpowers/.", WRITING_PLANS)

    def test_it_is_told_that_waffles_builds_and_not_to_ask_how_to_carry_the_plan_out(self):
        # writing-plans 7.0.2 asks only for a review when "an execution method has already been supplied".
        self.assertIn("The execution method is supplied now: waffles builds this plan", WRITING_PLANS)
        self.assertIn("Do not ask me how to carry it out", WRITING_PLANS)
        self.assertIn("Invoke no other skill, and write no code: waffles builds it.", WRITING_PLANS)

    def test_the_tasks_keep_the_heading_the_outline_script_reads(self):
        self.assertIn("`### Task N: <name>`", WRITING_PLANS)
        script = os.path.normpath(os.path.join(SKILL_DIR, "..", "..", "scripts", "outline_from_plan.py"))
        self.assertIn("<skill-dir>/../../scripts/outline_from_plan.py", FLAT)
        self.assertTrue(os.path.isfile(script))


class RunReviewer(unittest.TestCase):
    def test_its_definition_names_no_model(self):
        front = REVIEWER.split("---\n")[1]
        self.assertNotRegex(front, r"(?m)^model:")
        self.assertIn("most capable model", front)
        self.assertTrue("pass as `model` the most capable model in the Agent tool's options" in FLAT)
        self.assertTrue('use `general-purpose` with the same model and `effort: "high"`' in FLAT)

    def test_the_run_skill_passes_it_a_model_while_other_waffles_types_get_none(self):
        with open(os.path.join(PLUGIN, "skills", "non-interactive", "SKILL.md"), encoding="utf-8") as f:
            run_skill = " ".join(f.read().split())
        self.assertIn("so pass neither, except to `waffles:decider` and `waffles:run-reviewer`: they name no model", run_skill)
        self.assertIn("| `waffles:run-reviewer`, with `model` the most capable in the Agent tool's options", run_skill)

    def test_it_reports_what_it_assumed_for_the_person(self):
        self.assertIn("Assumed for you:", REVIEWER)
        self.assertTrue(".tmp/plan/assumed-for-you.md" in FLAT)


class Decider(unittest.TestCase):
    def test_its_definition_names_no_model_and_the_run_skill_passes_the_most_capable(self):
        with open(os.path.join(PLUGIN, "agents", "decider.md"), encoding="utf-8") as f:
            front = f.read().split("---\n")[1]
        with open(os.path.join(PLUGIN, "skills", "non-interactive", "deciding.md"), encoding="utf-8") as f:
            deciding = " ".join(f.read().split())
        self.assertNotRegex(front, r"(?m)^model:")
        self.assertIn("most capable model", front)
        self.assertIn("pass as `model` the most capable model in the Agent tool's options", deciding)
        self.assertNotIn("Fable", deciding)


if __name__ == "__main__":
    unittest.main()
