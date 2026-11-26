#!/usr/bin/env python3
"""Render the plan outline into its section of the pull request's description.

Usage: python3 -I checkpoint.py [--pr NUMBER] [--dry-run]

Run in a checkout. The script reads the plan outline from .tmp/plan/ and writes
it as a checklist between the markers below, in the description of the open
pull request for the checked-out branch (or of --pr NUMBER, which must be for
that branch). It leaves the rest of the description as it is. Where the
description has no markers yet, the section takes the place of a
"## Plan outline" section, or goes after the other sections, ahead of the
attribution lines at the end.

When .tmp/plan/assumed-for-you.md is there, the section ends with its list
under "### Assumed for you": the decisions an agent made in the person's
place.

The checklist says "Ahead of the branch" when the checkout holds changes that
are not committed or commits that are not pushed. Once a commit has removed
.tmp/, the checklist is the outline as that commit's parent held it, with the
step "Remove the working files" ticked; only a commit after the base branch
counts. The script never commits or pushes. A
second run with nothing changed changes nothing. --dry-run prints the new
description instead of writing it.

Exit codes: 0 when the description is up to date or there is nothing to do, 1
when git or gh fails, 2 for bad arguments.
"""

import json
import os
import re
import subprocess
import sys

START = "<!-- waffles:plan-outline:start -->"
END = "<!-- waffles:plan-outline:end -->"
HEADING = "## Plan outline"
REMOVE_STEP = "remove the working files"
# The record of decisions made for the person, beside the outline; rendered after the checklist, never read as a checklist.
ASSUMED = "assumed-for-you.md"
ASSUMED_HEADING = "### Assumed for you"

# A step of a goal file, as the plan tool writes it: indent, box, ID, kind marker, title.
GOAL_STEP = re.compile(r"^( *)- \[([ ~rx>-])\] (\S+) (?:([?⤷]) )?(.*)$")
# Any Markdown task list item.
TASK = re.compile(r"^(\s*)[-*+] \[([ xX])\] (.*)$")
NOTE = re.compile(r" <!-- (?:(?!<!--).)* -->$")
LINK = re.compile(r"^(.*?) → (\S+)$")
ESCAPED = re.compile(r"^\\+[?⤷](?: |$)")
STEP_ID = re.compile(r"^\d+(?:\.\d+)*\.?$")
LIST_LINE = re.compile(r"^\s*(?:[-*+]|\d+\.) |^\s*>")
FOOTER = re.compile(r"^(?:Written by Claude\b|🤖 Generated with |https://claude\.ai/code/)")


class Failure(Exception):
    pass


def run(argv, stdin=None):
    """The command's stdout; raises Failure with its stderr when it fails."""
    try:
        done = subprocess.run(argv, input=stdin, capture_output=True, text=True)
    except OSError as error:
        raise Failure(f"{argv[0]} could not run: {error}") from error
    if done.returncode != 0:
        raise Failure(f"{' '.join(argv[:3])} failed: {done.stderr.strip() or done.stdout.strip()}")
    return done.stdout


def git(*args):
    return run(["git", *args])


def try_git(*args):
    try:
        return git(*args)
    except Failure:
        return None


# --- Reading the outline ---------------------------------------------------


def split_front(text):
    """(front matter dict, body lines) of a goal file, or (None, all lines) when it has no front matter."""
    lines = text.replace("\r\n", "\n").split("\n")
    if lines and lines[0] == "---":
        for i in range(1, len(lines)):
            if lines[i] == "---":
                front = {}
                for line in lines[1:i]:
                    key, _, value = line.partition(": ")
                    front[key] = value
                if front.get("goal") and front.get("status") in ("open", "done"):
                    return front, lines[i + 1 :]
                break
    return None, lines


def is_checklist(lines):
    """Whether a file that is not a goal file is a plain checklist: headings and task items only."""
    rows = [line for line in lines if line.strip()]
    return any(TASK.match(r) for r in rows) and all(TASK.match(r) or r.lstrip().startswith("#") for r in rows)


def goal_items(body, is_removed):
    """The checklist lines of a goal file's steps."""
    items = []
    for line in body:
        m = GOAL_STEP.match(line)
        if not m:
            continue
        indent, box, step_id, _, title = m.groups()
        title = NOTE.sub("", title)
        # The plan tool escapes a planned title that starts like a kind marker.
        if ESCAPED.match(title):
            title = title[1:]
        state = {" ": "open", "~": "open", "r": "open", "x": "done", "-": "dropped", ">": "deferred"}[box]
        if state == "deferred":
            link = LINK.match(title)
            title = f"{link.group(1)} (moved to the backlog: {link.group(2)})" if link else f"{title} (moved to the backlog)"
        elif state == "dropped":
            title = f"~~{title}~~ (dropped)"
        if is_removed and title.strip().lower() == REMOVE_STEP:
            state = "done"
        mark = " " if state == "open" else "x"
        items.append(f"{indent}- [{mark}] {step_id}. {title}")
    return items


def checklist_items(lines, is_removed):
    """The task items of a plain checklist file, with each step ID written as `1.`."""
    items = []
    for line in lines:
        m = TASK.match(line)
        if not m:
            continue
        indent, box, text = m.groups()
        first, _, rest = text.partition(" ")
        if STEP_ID.match(first) and rest:
            text = f"{first.rstrip('.')}. {rest}"
            title = rest
        else:
            title = text
        mark = "x" if box in "xX" or (is_removed and title.strip().lower() == REMOVE_STEP) else " "
        items.append(f"{indent}- [{mark}] {text}")
    return items


def assumed_items(text):
    """The lines of the "assumed for you" file without its headings, and without blank lines at either end."""
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").split("\n") if not line.startswith("#")]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def render(files, is_removed):
    """
    The checklist for the outline files, a list of (name, text) sorted by name, then the "assumed for you"
    list when there is one; None when no file is an outline.
    """
    goals = []
    plain = []
    assumed = []
    for name, text in files:
        if name == ASSUMED:
            assumed = assumed_items(text)
            continue
        front, body = split_front(text)
        if front is not None:
            goals.append((front["goal"], goal_items(body, is_removed)))
        elif is_checklist(body):
            title = next((line.lstrip("#").strip() for line in body if line.startswith("#")), name[:-3])
            plain.append((title, checklist_items(body, is_removed)))
    # A plan document beside the goal files is not a checklist; goal files come first when both are there.
    parts = goals or plain
    if not parts:
        return None
    if len(parts) == 1:
        lines = list(parts[0][1])
    else:
        lines = []
        for title, items in parts:
            lines += [*([""] if lines else []), f"### {title}", "", *items]
    if assumed:
        lines += ["", ASSUMED_HEADING, "", *assumed]
    return lines


def outline_files(top, base):
    """
    The outline files and whether a commit removed them: ([(name, text)], is_removed), or None. Only a
    commit on this branch, after `base` (a ref of the base branch), counts as the one that removed them.
    """
    folder = os.path.join(top, ".tmp", "plan")
    if os.path.isdir(folder):
        names = sorted(n for n in os.listdir(folder) if n.endswith(".md") and not n.startswith("."))
        files = []
        for name in names:
            path = os.path.join(folder, name)
            if os.path.isfile(path):
                with open(path, encoding="utf-8") as f:
                    files.append((name, f.read()))
        if files:
            return files, False
    # Not in the working tree: as HEAD holds it, else as the parent of the commit that removed it.
    files = committed_files("HEAD")
    if files:
        return files, False
    if base is None:
        return None
    last = (try_git("log", "-1", "--format=%H", f"{base}..HEAD", "--", ".tmp/plan") or "").strip()
    files = committed_files(f"{last}^") if last else None
    return (files, True) if files else None


def committed_files(rev):
    """The outline files in .tmp/plan/ at a commit, as [(name, text)]; empty when it has none."""
    listed = try_git("ls-tree", "--name-only", f"{rev}:.tmp/plan")
    if not listed:
        return []
    names = sorted(n for n in listed.split("\n") if n.endswith(".md") and not n.startswith("."))
    return [(name, git("show", f"{rev}:.tmp/plan/{name}")) for name in names]


# --- The state of the checkout --------------------------------------------


def base_ref(base):
    """The remote ref of the base branch, else of the remote's default branch; None when neither is there."""
    if base and try_git("rev-parse", "--verify", "-q", f"refs/remotes/origin/{base}") is not None:
        return f"refs/remotes/origin/{base}"
    default = (try_git("symbolic-ref", "-q", "refs/remotes/origin/HEAD") or "").strip()
    return default or None


def ahead_note(branch):
    """The "ahead of the branch" line, or None when everything is committed and pushed."""
    reasons = []
    upstream = try_git("rev-parse", "--verify", "-q", f"refs/remotes/origin/{branch}")
    if upstream is None:
        reasons.append("the branch is not pushed")
    else:
        count = int(git("rev-list", "--count", f"{upstream.strip()}..HEAD").strip() or 0)
        if count:
            reasons.append(f"{count} commit{'s' if count != 1 else ''} not pushed")
    if git("status", "--porcelain").strip():
        reasons.append("changes not committed")
    if not reasons:
        return None
    return f"> **Ahead of the branch:** this checklist includes work that is not on the branch yet ({'; '.join(reasons)})."


# --- The description -------------------------------------------------------


def section(items, note):
    return [START, HEADING, "", *([note, ""] if note else []), *items, END]


def place(body, block):
    """The description with the section replaced, or added where it belongs."""
    newline = "\r\n" if "\r\n" in body else "\n"
    lines = body.split(newline) if body else []
    if START in lines and END in lines[lines.index(START) :]:
        start = lines.index(START)
        end = lines.index(END, start)
        lines[start : end + 1] = block
        return newline.join(lines)
    heading = next((i for i, line in enumerate(lines) if line.strip().lower() == HEADING.lower()), None)
    if heading is not None:
        end = heading + 1
        last = heading
        while end < len(lines) and (not lines[end].strip() or LIST_LINE.match(lines[end])):
            if lines[end].strip():
                last = end
            end += 1
        lines[heading : last + 1] = block
        return newline.join(lines)
    # After the other sections, ahead of the attribution lines at the end.
    at = len(lines)
    while at > 0 and (not lines[at - 1].strip() or FOOTER.match(lines[at - 1])):
        at -= 1
    footer = [line for line in lines[at:] if line.strip()]
    if not footer:
        at = len(lines)
        while at > 0 and not lines[at - 1].strip():
            at -= 1
    head = lines[:at]
    tail = lines[at:]
    gap_before = [""] if head else []
    gap_after = [""] if tail and tail[0].strip() else []
    return newline.join([*head, *gap_before, *block, *gap_after, *tail])


def main(argv, out=sys.stdout):
    pr = None
    dry_run = False
    args = list(argv)
    while args:
        arg = args.pop(0)
        if arg == "--dry-run":
            dry_run = True
        elif arg == "--pr" and args and args[0].isdigit():
            pr = args.pop(0)
        else:
            print(__doc__.split("\n\n")[1], file=sys.stderr)
            return 2
    try:
        top = git("rev-parse", "--show-toplevel").strip()
        branch = git("rev-parse", "--abbrev-ref", "HEAD").strip()
        try:
            view = run(["gh", "pr", "view", *([pr] if pr else []), "--json", "number,url,body,headRefName,baseRefName,state"])
        except Failure:
            print(f"No pull request for {'#' + pr if pr else 'the branch ' + branch}: nothing to update.", file=out)
            return 0
        info = json.loads(view)
        if info.get("state") != "OPEN":
            print(f"Pull request #{info['number']} is {str(info.get('state')).lower()}: its checklist stays as it ended.", file=out)
            return 0
        if info.get("headRefName") != branch:
            print(f"Pull request #{info['number']} is for {info.get('headRefName')}, not {branch}: nothing to update.", file=out)
            return 0
        found = outline_files(top, base_ref(info.get("baseRefName")))
        if found is None:
            print(f"No plan outline in .tmp/plan/: #{info['number']} stays as it is.", file=out)
            return 0
        items = render(*found)
        if items is None:
            print(f"No checklist in .tmp/plan/: #{info['number']} stays as it is.", file=out)
            return 0
        note = ahead_note(branch)
        body = info.get("body") or ""
        new = place(body, section(items, note))
        if dry_run:
            print(new, file=out)
            return 0
        if new == body:
            print(f"The plan outline in #{info['number']} is up to date.", file=out)
            return 0
        run(["gh", "pr", "edit", str(info["number"]), "--body-file", "-"], stdin=new)
        print(f"Updated the plan outline in #{info['number']}{' (ahead of the branch)' if note else ''}: {info['url']}", file=out)
        return 0
    except Failure as error:
        print(f"checkpoint: {error}", file=out)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
