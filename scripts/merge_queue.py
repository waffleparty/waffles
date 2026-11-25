#!/usr/bin/env python3
"""Tell how a pull request merges (directly, or through its base branch's merge queue), and where it stands.

Usage:
  python3 -I merge_queue.py mode PR [--repo OWNER/NAME]
  python3 -I merge_queue.py state PR [--repo OWNER/NAME]

PR is a number, a URL, or a branch, as gh takes it.

mode reads the rules that apply to the pull request's base branch (`gh api repos/<o>/<r>/rules/branches/<base>`). With
a `merge_queue` rule, "merge" means "add to the queue": `gh pr merge <n>` (no merge method, no --auto), and the queue
tests it on the newest base branch and merges it later, or removes it. GitHub adds it only when it has a valid
approval: its review decision (`gh pr view --json reviewDecision`) is APPROVED, or empty when no review is required.
Without one, GitHub refuses (also for an admin), and the command is the admin bypass, `gh pr merge <n> --admin` with
the queue's merge method, which merges at once past the queue: a run uses it as its --admin rule says, and outside a
run the pull request waits for a reviewer. Without a queue, it merges at once: `gh pr merge <n> --squash` with the
subject and body passed. A plan with no rulesets (a private repo on GitHub's free plan) has no queue. Prints 1 line
of JSON: queue (true or false), base, approved (with a queue), the review decision, the command, and why.

state prints 1 line of JSON with "state" one of:
  merged    the pull request is merged;
  queued    it is in the merge queue ("position", and the entry's "entry" state);
  waiting   auto-merge is on, and it joins the queue (or merges) once its checks pass;
  removed   the queue removed it, and auto-merge is off ("reason", from GitHub): move the item back to in work, with
            a note that gives the reason;
  closed    it was closed without a merge;
  open      none of these.

Exit codes: 0 when gh answered; 1 when it did not, with its message; 2 for wrong arguments.
"""

import argparse
import json
import re
import subprocess
import sys
import urllib.parse

URL = re.compile(r"github\.com/([^/]+)/([^/]+)/pull/(\d+)")
NO_RULESETS = "Upgrade to GitHub Pro"
# A merge queue rule's merge_method, as a `gh pr merge` flag.
METHODS = {"MERGE": "--merge", "SQUASH": "--squash", "REBASE": "--rebase"}
QUERY = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      merged
      isInMergeQueue
      mergeQueueEntry { state position }
      autoMergeRequest { enabledAt }
      timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes {
          __typename
          ... on RemovedFromMergeQueueEvent { createdAt reason }
          ... on AddedToMergeQueueEvent { createdAt }
        }
      }
    }
  }
}
"""


class Failed(Exception):
    pass


def gh(*args):
    done = subprocess.run(["gh", *args], capture_output=True, text=True)
    if done.returncode != 0:
        raise Failed(f"gh {args[0]} {args[1] if len(args) > 1 else ''} failed: {(done.stderr or done.stdout).strip()}")
    return done.stdout


def pull_request(selector, repo):
    flags = ["-R", repo] if repo else []
    view = json.loads(gh("pr", "view", selector, *flags, "--json", "number,url,baseRefName,reviewDecision"))
    match = URL.search(view["url"])
    if not match:
        raise Failed(f"gh gave no GitHub URL for {selector}: {view['url']}")
    return match.group(1), match.group(2), view["number"], view["baseRefName"], view.get("reviewDecision") or ""


def mode(selector, repo):
    owner, name, number, base, review = pull_request(selector, repo)
    branch = urllib.parse.quote(base, safe="")
    done = subprocess.run(["gh", "api", f"repos/{owner}/{name}/rules/branches/{branch}"], capture_output=True, text=True)
    if done.returncode != 0 and NO_RULESETS in done.stdout + done.stderr:
        rules, why = [], "the repo's plan has no rulesets, so its base branch has no merge queue"
    elif done.returncode != 0:
        raise Failed(f"gh api rules/branches/{base} failed: {(done.stderr or done.stdout).strip()}")
    else:
        rules = json.loads(done.stdout)
        why = None
    queue = next((rule for rule in rules if rule.get("type") == "merge_queue"), None)
    if queue and review in ("APPROVED", ""):
        return {
            "queue": True, "base": base, "approved": True, "review": review or None, "command": f"gh pr merge {number}",
            "why": f"{base} has a merge queue, and the pull request has a valid approval or needs none: the command adds it to the queue once its checks pass, and the queue merges it later or removes it",
        }
    if queue:
        method = METHODS.get((queue.get("parameters") or {}).get("merge_method"), "--squash")
        message = "" if method == "--rebase" else " --subject <subject> --body <digest>"
        return {
            "queue": True, "base": base, "approved": False, "review": review, "command": f"gh pr merge {number} {method} --admin{message}",
            "why": f"{base} has a merge queue, and the pull request has no valid approval (review decision {review}), so GitHub refuses to add it to the queue, also for an admin: in a run, the command merges it at once past the queue, as the run's --admin rule says; outside a run, leave it for a reviewer, whose approval lets `gh pr merge {number}` add it to the queue",
        }
    return {
        "queue": False, "base": base, "command": f"gh pr merge {number} --squash --subject <subject> --body <digest>",
        "why": why or f"{base} has no merge queue: the pull request merges at once",
    }


def state(selector, repo):
    owner, name, number, _, _ = pull_request(selector, repo)
    data = json.loads(gh("api", "graphql", "-f", f"owner={owner}", "-f", f"name={name}", "-F", f"number={number}", "-f", f"query={QUERY}"))
    pr = data["data"]["repository"]["pullRequest"]
    events = pr["timelineItems"]["nodes"]
    last = events[-1] if events else None
    if pr["merged"]:
        return {"state": "merged", "number": number}
    if pr["isInMergeQueue"]:
        entry = pr.get("mergeQueueEntry") or {}
        return {"state": "queued", "number": number, "position": entry.get("position"), "entry": entry.get("state")}
    if pr["state"] == "CLOSED":
        return {"state": "closed", "number": number}
    if pr.get("autoMergeRequest"):
        return {"state": "waiting", "number": number}
    if last and last["__typename"] == "RemovedFromMergeQueueEvent":
        return {"state": "removed", "number": number, "reason": last.get("reason") or "GitHub gave no reason", "at": last.get("createdAt")}
    return {"state": "open", "number": number}


def main(argv, out=sys.stdout):
    parser = argparse.ArgumentParser(prog="merge_queue.py")
    parser.add_argument("command", choices=["mode", "state"])
    parser.add_argument("pr")
    parser.add_argument("--repo", help="OWNER/NAME, when PR is not a URL and the folder is not the repo")
    try:
        args = parser.parse_args(argv)
    except SystemExit as error:
        return 2 if error.code else 0
    try:
        result = mode(args.pr, args.repo) if args.command == "mode" else state(args.pr, args.repo)
    except Failed as error:
        print(str(error), file=out)
        return 1
    print(json.dumps(result), file=out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
