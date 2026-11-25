#!/usr/bin/env python3
"""Make the plan outline's steps from a plan document.

Usage: python3 -I outline_from_plan.py PLAN [--spec SPEC] [--title TITLE]

PLAN is a plan document (an implementation plan, such as the one superpowers'
writing-plans writes to .tmp/plan/plan.md). The script prints the goal and its
steps as JSON, in the shape the plan tool's op "goal" takes:

    {"title": "<the plan's title>", "steps": [{"title": "<task>"}, ...]}

Each task of the plan is 1 step, in the plan's order: a level-3 heading
"### Task N: <name>" (a period or a dash in place of the colon counts too)
gives the step "<name>", and a task with a dotted number, "### Task 1.1: <name>",
gives the step "1.1: <name>". Headings inside fenced code blocks are text, not
tasks. A fence closes at a line of its own marker at any indent: a fence inside
a list item is indented relative to the item, so its opening and closing lines
can have different indents. The title is the plan's first level-1 heading,
without a trailing "Implementation Plan"; when the plan has none, the first
level-1 heading of SPEC, else TITLE, else null. The last step is always
"Remove the working files", added when the plan does not end with it.

The script reads only the headings, never the plan's header: writing-plans
rewrites its header line when it is told how the plan will be carried out, so
nothing may depend on that line.

Exit codes: 0 when it printed the steps; 1 when a file cannot be read or the
plan has no task heading, with the reason on stderr; 2 for bad arguments.
"""

import json
import re
import sys

REMOVE_STEP = "Remove the working files"
TASK = re.compile(r"^###\s+Task\s+(\d+(?:\.\d+)*)\s*[:.–—-]\s*(.+?)\s*#*\s*$")
TITLE = re.compile(r"^#\s+(.+?)\s*#*\s*$")
SUFFIX = re.compile(r"\s*[:–—-]?\s*implementation plan$", re.IGNORECASE)
FENCE = re.compile(r"^\s*(`{3,}|~{3,})")


def outline(text):
    """(title or None, [(task number, task name)]) of a plan document."""
    title = None
    tasks = []
    fence = None
    for line in text.replace("\r\n", "\n").split("\n"):
        m = FENCE.match(line)
        if m:
            mark = m.group(1)
            if fence is None:
                fence = mark
            elif mark[0] == fence[0] and len(mark) >= len(fence) and not line.strip()[len(mark) :].strip():
                fence = None
            continue
        if fence is not None:
            continue
        task = TASK.match(line)
        if task:
            tasks.append(task.groups())
            continue
        heading = TITLE.match(line)
        if heading and title is None:
            title = SUFFIX.sub("", heading.group(1)) or heading.group(1)
    return title, tasks


def read(path, err):
    """The file's text, or None with the reason on err."""
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError as error:
        print(f"outline_from_plan: {path} cannot be read: {error.strerror}", file=err)
        return None


def main(argv, out=sys.stdout, err=sys.stderr):
    args = list(argv)
    path = spec = fallback = None
    while args:
        arg = args.pop(0)
        if arg == "--spec" and args:
            spec = args.pop(0)
        elif arg == "--title" and args:
            fallback = args.pop(0)
        elif not arg.startswith("-") and path is None:
            path = arg
        else:
            path = None
            break
    if path is None:
        print(__doc__.split("\n\n")[1], file=err)
        return 2
    text = read(path, err)
    if text is None:
        return 1
    title, tasks = outline(text)
    if not tasks:
        print(f"outline_from_plan: {path} has no task heading (### Task N: <name>). Make the steps by hand.", file=err)
        return 1
    if title is None and spec is not None:
        spec_text = read(spec, err)
        if spec_text is None:
            return 1
        title = outline(spec_text)[0]
    if title is None:
        title = fallback
    steps = [f"{number}: {name}" if "." in number else name for number, name in tasks]
    if tasks[-1][1].strip().lower() != REMOVE_STEP.lower():
        steps.append(REMOVE_STEP)
    print(json.dumps({"title": title, "steps": [{"title": s} for s in steps]}, ensure_ascii=False), file=out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
