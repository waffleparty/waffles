#!/usr/bin/env python3
"""Build a throwaway local branch in the main checkout that merges every pull request waiting for the person.

Usage:
  python3 -I review_branch.py build --repo DIR (--pr N... | --waiting)
  python3 -I review_branch.py done --repo DIR

The person reviews several finished UI items at once: one branch, `waffles-review`, holds the default branch with each
pull request merged into it, and one dev server serves it. The branch is never pushed: it has no upstream, and done
deletes it.

build fetches each pull request's head from origin (refs/pull/<n>/head, kept under refs/waffles-review/), starts
`waffles-review` from origin's default branch, and merges them in the order given, unsigned, since the merges never leave
this machine. A pull request that conflicts with the ones before it is left out, and the output names it. --waiting
takes the open pull requests that are ready and ask the person for a review (`gh pr list --search
review-requested:@me`). Run build again to rebuild the branch after a waiting pull request changed. It refuses a
checkout with changes to tracked files, since it switches branches. It records the branch the checkout was on in
`<git dir>/waffles/review.json`.

done switches back to that branch and deletes `waffles-review` and its fetched refs. Both build and done refuse when
`waffles-review` holds a commit that is not a merge of the pull requests (someone's own work, or their own branch of that
name), since they would lose it.

Prints 1 line of JSON. Exit codes: 0 when done; 3 when refused, with the reason; 1 when git or gh failed, with its
message; 2 for wrong arguments.
"""

import argparse
import json
import os
import subprocess
import sys

BRANCH = "waffles-review"
REFS = "refs/waffles-review"


class Refused(Exception):
    pass


class Failed(Exception):
    pass


def git(cwd, *args, check=True):
    done = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)
    if check and done.returncode != 0:
        raise Failed(f"git {' '.join(args)} failed: {done.stderr.strip()}")
    return done


def out_of(cwd, *args):
    return git(cwd, *args).stdout.strip()


def state_path(main):
    return os.path.join(out_of(main, "rev-parse", "--absolute-git-dir"), "waffles", "review.json")


def read_state(main):
    try:
        with open(state_path(main), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def own_commits(main):
    """Commits on waffles-review that are not the merges this script made: someone's own work, which a rebuild or done would lose."""
    if git(main, "rev-parse", "--verify", "--quiet", f"refs/heads/{BRANCH}", check=False).returncode != 0:
        return ""
    default = git(main, "symbolic-ref", "--short", "refs/remotes/origin/HEAD", check=False).stdout.strip() or "HEAD"
    return out_of(main, "log", "--oneline", "--no-merges", BRANCH, "--not", default, f"--glob={REFS}/*")


def refuse_own_commits(main):
    own = own_commits(main)
    if own:
        raise Refused(
            f"the branch {BRANCH} holds commits that are not merges of the pull requests, and rebuilding or deleting it "
            f"would lose them. Move them to another branch first:\n{own}"
        )


def waiting(main):
    done = subprocess.run(
        ["gh", "pr", "list", "--state", "open", "--search", "review-requested:@me", "--json", "number,isDraft"],
        cwd=main, capture_output=True, text=True,
    )
    if done.returncode != 0:
        raise Failed(f"gh pr list failed: {done.stderr.strip()}")
    return sorted(pr["number"] for pr in json.loads(done.stdout) if not pr.get("isDraft"))


def build(repo, prs, from_gh):
    main = out_of(repo, "rev-parse", "--show-toplevel")
    if out_of(main, "status", "--porcelain", "--untracked-files=no"):
        raise Refused(f"{main} has changes to tracked files. Commit or stash them, then build the review branch.")
    numbers = waiting(main) if from_gh else prs
    if not numbers:
        raise Refused("no pull request waits for review.")
    current = out_of(main, "branch", "--show-current")
    state = read_state(main)
    back = state["from"] if state and current == BRANCH else current
    if not back:
        raise Refused(f"{main} is not on a branch (a detached HEAD), so done could not switch back.")

    refuse_own_commits(main)
    git(main, "fetch", "--quiet", "origin")
    default = out_of(main, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    specs = [f"+refs/pull/{n}/head:{REFS}/pr-{n}" for n in numbers]
    git(main, "fetch", "--quiet", "origin", *specs)
    git(main, "switch", "--quiet", "--no-track", "-C", BRANCH, default)
    merged, left_out = [], []
    for n in numbers:
        done = git(main, "-c", "commit.gpgsign=false", "merge", "--quiet", "--no-ff", "--no-edit", "-m", f"Review: pull request #{n}", f"{REFS}/pr-{n}", check=False)
        if done.returncode == 0:
            merged.append(n)
        else:
            git(main, "merge", "--abort", check=False)
            left_out.append(n)
    path = state_path(main)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    result = {"branch": BRANCH, "from": back, "base": default, "merged": merged, "conflicts": left_out}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
        f.write("\n")
    return result


def done(repo):
    main = out_of(repo, "rev-parse", "--show-toplevel")
    state = read_state(main)
    if not state:
        raise Refused(f"no review branch was built in {main}.")
    refuse_own_commits(main)
    if out_of(main, "branch", "--show-current") == BRANCH:
        if out_of(main, "status", "--porcelain", "--untracked-files=no"):
            raise Refused(f"{BRANCH} has changes to tracked files. Discard or keep them elsewhere first.")
        git(main, "switch", "--quiet", state["from"])
    git(main, "branch", "-D", BRANCH, check=False)
    for ref in out_of(main, "for-each-ref", "--format=%(refname)", REFS).splitlines():
        git(main, "update-ref", "-d", ref)
    os.remove(state_path(main))
    return {"branch": state["from"], "deleted": BRANCH}


def main(argv, out=sys.stdout):
    parser = argparse.ArgumentParser(prog="review_branch.py")
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build", help="merge the waiting pull requests into the local branch waffles-review")
    b.add_argument("--repo", required=True, help="the main checkout")
    which = b.add_mutually_exclusive_group(required=True)
    which.add_argument("--pr", type=int, nargs="+", help="the pull requests, in merge order")
    which.add_argument("--waiting", action="store_true", help="every ready pull request that asks you for a review")
    d = sub.add_parser("done", help="switch back and delete waffles-review")
    d.add_argument("--repo", required=True)
    try:
        args = parser.parse_args(argv)
    except SystemExit as error:
        return 2 if error.code else 0
    try:
        result = build(args.repo, args.pr, args.waiting) if args.command == "build" else done(args.repo)
    except Refused as error:
        print(f"Refused: {error}", file=out)
        return 3
    except Failed as error:
        print(str(error), file=out)
        return 1
    print(json.dumps(result), file=out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
