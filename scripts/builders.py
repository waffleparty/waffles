#!/usr/bin/env python3
"""Give each builder its own full clone of the repo, on its own branch, within the waffles limits; remove the clone once merged.

Usage:
  python3 -I builders.py clone --root DIR --repo DIR --item ID --branch NAME [--base BRANCH]
  python3 -I builders.py remove --root DIR --path DIR
  python3 -I builders.py limits --repo DIR [--cap 10]
  python3 -I builders.py test-slot [--slots 3] -- COMMAND...

A builder is an agent that builds one item: one clone, one branch, one draft pull request. Builders never share a
checkout, and nothing is copied back from a clone: the work reaches the repo as a pull request.

clone makes `<root>/<owner>/<repo>/<item>` from the main checkout's `origin`. The root is $WAFFLES_BUILDERS_ROOT when it
is set, so a person can keep clones where they like; otherwise --root, which the skills set to `<session
scratchpad>/builders`: the session can write there without a permission prompt, and the plugin names no folder of
its own. A clone that a later session can't find is made again from its pushed branch. It borrows the main checkout's objects while it clones (--reference-if-able, then --dissociate),
so the clone is fast and needs nothing of the main checkout afterwards. The branch starts from origin's BASE: the
default branch, or for an item that depends on one not merged yet, that item's branch (a stacked pull request). A
branch that origin already has is checked out as it is. A clone that already exists for the item is used again when
it is on the same branch. It prints 1 line of JSON: path, branch, base, and whether it was reused.

remove deletes a clone under the root once it holds no change, no stash, and no commit that origin lacks (on a
branch or a detached HEAD).

limits counts, from GitHub, the open pull requests of the repo that wait for human review: marked ready (not a draft),
with a review requested from a person or a team. It counts every developer's. At the cap (10) it refuses: waffles starts
no builder in that repo until one is reviewed, and the reason lists them. A pull request that an agent will merge
itself has no review requested, so it is not counted.

test-slot runs COMMAND (a test run, a linter, a type check) once one of the machine's test slots is free, and holds
the slot until COMMAND ends. The slots are lock files in $WAFFLES_TEST_SLOTS or /tmp/waffles-test-slots-<uid>, shared by
every session of the user; a lock goes with its process, also when it is killed. It exits with COMMAND's code.

Exit codes: 0 when done; 3 when refused, with the reason; 1 when git or gh failed, with its message; 2 for wrong
arguments. test-slot exits with its command's code.
"""

import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import time

# At most this many open pull requests per repo that wait for human review (the owner's cap).
REVIEW_CAP = 10
# Builders running tests at once on this machine. A test suite already spreads over several cores, so on a
# many-core workstation the runs finished per minute stop rising at about 3 at once: past that, another run at once
# only slows the others. --slots sets another count for another machine.
TEST_SLOTS = 3
WAIT_S = 1.0

# git@github.com:owner/repo.git, ssh://git@host/owner/repo.git, https://github.com/owner/repo, or a local path.
REMOTE = re.compile(r"[:/]([^/:]+)/([^/]+?)(?:\.git)?/?$")


class Refused(Exception):
    pass


class GitFailed(Exception):
    pass


def git(cwd, *args, check=True):
    done = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)
    if check and done.returncode != 0:
        raise GitFailed(f"git {' '.join(args)} failed in {cwd}: {done.stderr.strip()}")
    return done.stdout.strip() if check else done


ROOT = None


def root():
    chosen = os.environ.get("WAFFLES_BUILDERS_ROOT") or ROOT
    if not chosen:
        raise Refused("no folder for the clones: pass --root (the skills pass <session scratchpad>/builders) or set WAFFLES_BUILDERS_ROOT.")
    return os.path.realpath(os.path.expanduser(chosen))


def owner_repo(url):
    match = REMOTE.search(url)
    if not match:
        raise Refused(f"origin's URL {url} names no owner and repo.")
    return match.group(1), match.group(2)


def slug(text):
    clean = re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-.")
    if not clean:
        raise Refused(f"the item ID {text!r} makes no folder name.")
    return clean


def inside(path, folder):
    return os.path.commonpath([path, folder]) == folder


def clone(repo, item, branch, base):
    main = os.path.realpath(git(repo, "rev-parse", "--show-toplevel"))
    url = git(main, "remote", "get-url", "origin")
    owner, name = owner_repo(url)
    path = os.path.join(root(), owner, name, slug(item))
    if inside(path, main) or inside(main, path):
        raise Refused(f"the clone {path} would be inside the main checkout {main}, or hold it.")

    if os.path.exists(path):
        if not os.path.isdir(os.path.join(path, ".git")):
            raise Refused(f"{path} exists and is not a clone.")
        if git(path, "remote", "get-url", "origin") != url:
            raise Refused(f"{path} is a clone of another remote.")
        current = git(path, "branch", "--show-current")
        if current != branch:
            raise Refused(f"{path} is the clone of item {item} on branch {current}, not {branch}.")
        return {"path": path, "branch": branch, "base": recorded_base(path), "reused": True}

    os.makedirs(os.path.dirname(path), exist_ok=True)
    common = os.path.realpath(os.path.join(main, git(main, "rev-parse", "--git-common-dir")))
    done = subprocess.run(["git", "clone", "--quiet", "--reference-if-able", common, "--dissociate", url, path], capture_output=True, text=True)
    if done.returncode != 0:
        raise GitFailed(f"git clone {url} failed: {done.stderr.strip()}")
    try:
        if not base:
            base = git(path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").split("/", 1)[1]
        on_origin = git(path, "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{branch}", check=False).returncode == 0
        if on_origin:
            git(path, "switch", "--quiet", "--track", f"origin/{branch}")
        else:
            if git(path, "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{base}", check=False).returncode != 0:
                raise Refused(f"origin has no branch {base} to start {branch} from. Push the item it depends on first.")
            git(path, "switch", "--quiet", "--no-track", "-c", branch, f"origin/{base}")
    except (Refused, GitFailed):
        shutil.rmtree(path)
        raise
    record = os.path.join(path, ".git", "waffles", "builder.json")
    os.makedirs(os.path.dirname(record), exist_ok=True)
    with open(record, "w", encoding="utf-8") as f:
        json.dump({"item": item, "branch": branch, "base": base, "main": main}, f, indent=2)
        f.write("\n")
    return {"path": path, "branch": branch, "base": base, "reused": False}


def recorded_base(path):
    try:
        with open(os.path.join(path, ".git", "waffles", "builder.json"), encoding="utf-8") as f:
            return json.load(f).get("base")
    except (OSError, ValueError):
        return None


def remove(path):
    path = os.path.realpath(path)
    if not inside(path, root()) or path == root():
        raise Refused(f"{path} is not a builder's clone under {root()}.")
    if not os.path.isdir(os.path.join(path, ".git")):
        raise Refused(f"{path} is not a clone.")
    if git(path, "status", "--porcelain"):
        raise Refused(f"{path} holds changes that are not committed.")
    if git(path, "stash", "list"):
        raise Refused(f"{path} holds stashed changes.")
    git(path, "fetch", "--quiet", "origin")
    ahead = git(path, "log", "--oneline", "HEAD", "--branches", "--not", "--remotes")
    if ahead:
        raise Refused(f"{path} holds commits that origin lacks:\n{ahead}")
    shutil.rmtree(path)
    parent = os.path.dirname(path)
    while parent != root() and inside(parent, root()) and not os.listdir(parent):
        os.rmdir(parent)
        parent = os.path.dirname(parent)
    return {"path": path, "removed": True}


def waiting_for_review(repo):
    """The open pull requests that wait for human review: ready, with a review requested."""
    done = subprocess.run(
        ["gh", "pr", "list", "--state", "open", "--limit", "1000", "--json", "number,title,url,isDraft,reviewRequests"],
        cwd=repo, capture_output=True, text=True,
    )
    if done.returncode != 0:
        raise GitFailed(f"gh pr list failed in {repo}, so the pull requests that wait for review are not counted: {done.stderr.strip()}")
    try:
        prs = json.loads(done.stdout)
    except ValueError as error:
        raise GitFailed(f"gh pr list answered no JSON: {error}")
    return [pr for pr in prs if not pr.get("isDraft") and pr.get("reviewRequests")]


def limits(repo, cap):
    main = os.path.realpath(git(repo, "rev-parse", "--show-toplevel"))
    waiting = waiting_for_review(main)
    if len(waiting) >= cap:
        listed = "\n".join(f"- #{pr['number']} {pr['title']}: {pr['url']}" for pr in sorted(waiting, key=lambda p: p["number"]))
        raise Refused(
            f"{len(waiting)} open pull requests in {os.path.basename(main)} wait for human review (ready, with a review "
            f"requested), and the cap is {cap}. Start no builder in this repo until one of them is reviewed:\n{listed}"
        )
    return {"waiting": len(waiting), "cap": cap, "numbers": sorted(pr["number"] for pr in waiting)}


def slots_dir():
    return os.environ.get("WAFFLES_TEST_SLOTS") or f"/tmp/waffles-test-slots-{os.getuid()}"


def test_slot(slots, command, out):
    """Runs command holding 1 of the machine's test slots; waits for one while all are held."""
    folder = slots_dir()
    os.makedirs(folder, exist_ok=True)
    said = False
    while True:
        for n in range(slots):
            handle = open(os.path.join(folder, f"slot-{n}.lock"), "a")
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                handle.close()
                continue
            try:
                out.flush()
                return subprocess.run(command, env={**os.environ, "WAFFLES_TEST_SLOT": str(n)}).returncode
            finally:
                handle.close()
        if not said:
            print(f"Waiting for a test slot: all {slots} are in use on this machine.", file=out, flush=True)
            said = True
        time.sleep(WAIT_S)


def main(argv, out=sys.stdout):
    parser = argparse.ArgumentParser(prog="builders.py")
    sub = parser.add_subparsers(dest="command", required=True)
    c = sub.add_parser("clone", help="make a builder's clone and branch")
    c.add_argument("--root", help="the folder for the clones; $WAFFLES_BUILDERS_ROOT wins when set")
    c.add_argument("--repo", required=True, help="the main checkout")
    c.add_argument("--item", required=True, help="the item's ID, or its .backlog/ file's stem")
    c.add_argument("--branch", required=True, help="the item's branch")
    c.add_argument("--base", help="the branch to start from; default: origin's default branch")
    r = sub.add_parser("remove", help="delete a builder's clone whose work is on origin")
    r.add_argument("--root", help="the folder for the clones; $WAFFLES_BUILDERS_ROOT wins when set")
    r.add_argument("--path", required=True)
    m = sub.add_parser("limits", help="refuse at 10 open pull requests that wait for human review")
    m.add_argument("--repo", required=True, help="the main checkout")
    m.add_argument("--cap", type=int, default=REVIEW_CAP)
    s = sub.add_parser("test-slot", help="run a test command in 1 of the machine's test slots")
    s.add_argument("--slots", type=int, default=TEST_SLOTS)
    s.add_argument("cmd", nargs=argparse.REMAINDER, help="-- then the command")
    try:
        args = parser.parse_args(argv)
    except SystemExit as error:
        return 2 if error.code else 0
    if args.command == "test-slot":
        command = args.cmd[1:] if args.cmd[:1] == ["--"] else args.cmd
        if not command or args.slots < 1:
            print("test-slot needs a command after --, and 1 slot or more.", file=out)
            return 2
        return test_slot(args.slots, command, out)
    global ROOT
    ROOT = getattr(args, "root", None)
    try:
        if args.command == "clone":
            result = clone(args.repo, args.item, args.branch, args.base)
        elif args.command == "limits":
            result = limits(args.repo, args.cap)
        else:
            result = remove(args.path)
    except Refused as error:
        print(f"Refused: {error}", file=out)
        return 3
    except GitFailed as error:
        print(str(error), file=out)
        return 1
    print(json.dumps(result), file=out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
