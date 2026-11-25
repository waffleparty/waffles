#!/usr/bin/env python3
"""Refuse a `gh pr merge` while the pull request's head branch still holds .tmp/.

Usage: python3 -I merge_guard.py COMMAND

COMMAND is a whole shell command, as the Bash tool got it. For each `gh pr merge`
in it, the script asks gh for the pull request it names (a number, a URL, a
branch, or the checked-out branch's; `-R` names the repo) and whether .tmp/ is
on its head branch on GitHub and not on its base branch. The working files (the
plan outline, the plan document) are in .tmp/, and the last step of every plan
outline removes them: merged with them, a squash puts them on the default
branch. Heredoc bodies in the command are text, and are not read as shell.

Exit codes: 0 when no merge in the command is refused (the line printed, if
any, says why there was nothing to check); 3 when one is refused, with the
reason on stdout; 1 when gh could not tell, or the command could not be split
into words, with the reason on stdout.
"""

import json
import re
import shlex
import subprocess
import sys
import urllib.parse

# `gh pr merge` flags that take a value.
VALUED = {"-t", "--subject", "-b", "--body", "-F", "--body-file", "-A", "--author-email", "--match-head-commit", "-R", "--repo"}
SEPARATORS = {";", "&&", "||", "|", "&", "(", ")"}
# A heredoc's start: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`.
HEREDOC = re.compile(r"<<(-?)\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")


class Unreadable(Exception):
    pass


def drop_heredocs(command):
    """The command without the bodies of its heredocs, which are text, not shell (an apostrophe in one breaks shlex)."""
    kept = []
    ends = []
    for line in command.split("\n"):
        if ends:
            strip, word = ends[0]
            if (line.lstrip("\t") if strip else line) == word:
                ends.pop(0)
            continue
        kept.append(line)
        ends = [(m.group(1) == "-", m.group(3)) for m in HEREDOC.finditer(line)]
    return "\n".join(kept)


def merges(command):
    """The argument lists of each `gh pr merge` in the command. Raises Unreadable when shlex can't split it."""
    lexer = shlex.shlex(drop_heredocs(command), posix=True, punctuation_chars=";&|()")
    lexer.whitespace_split = True
    lexer.commenters = ""
    try:
        tokens = list(lexer)
    except ValueError as error:
        raise Unreadable(str(error)) from error
    found = []
    for i in range(len(tokens) - 2):
        if tokens[i : i + 3] == ["gh", "pr", "merge"]:
            args = []
            for token in tokens[i + 3 :]:
                # A redirection, such as the heredoc of --body-file -, ends the arguments.
                if token in SEPARATORS or token[:1] in "<>":
                    break
                args.append(token)
            found.append(args)
    return found


def target(args):
    """(selector or None, repo or None) from `gh pr merge`'s arguments."""
    selector = None
    repo = None
    i = 0
    while i < len(args):
        arg = args[i]
        flag, has_value, value = arg.partition("=")
        if arg.startswith("-") and flag in VALUED:
            if not has_value:
                i += 1
                value = args[i] if i < len(args) else ""
            if flag in ("-R", "--repo"):
                repo = value
        elif not arg.startswith("-") and selector is None:
            selector = arg
        i += 1
    return selector, repo


def gh(*args):
    done = subprocess.run(["gh", *args], capture_output=True, text=True)
    return done.returncode, done.stdout, done.stderr.strip()


def has_tmp(owner, name, branch):
    """(True or False, "") when gh could tell whether .tmp/ is on the branch; (None, gh's error) when not."""
    ref = urllib.parse.quote(branch, safe="")
    code, _, err = gh("api", "--silent", f"repos/{owner}/{name}/contents/.tmp?ref={ref}")
    if code == 0:
        return True, ""
    if "404" in err or "Not Found" in err:
        return False, ""
    return None, err


def check(selector, repo):
    """(code, line) for one merge: 0 nothing to refuse, 3 refused, 1 unknown."""
    view = ["pr", "view", *([selector] if selector else []), *(["-R", repo] if repo else [])]
    code, out, err = gh(*view, "--json", "number,headRefName,headRepository,headRepositoryOwner,baseRefName,url")
    if code != 0:
        return 1, f"gh pr view failed, so waffles could not check the head branch for .tmp/: {err}"
    pr = json.loads(out)
    owner = (pr.get("headRepositoryOwner") or {}).get("login")
    name = (pr.get("headRepository") or {}).get("name")
    branch = pr.get("headRefName")
    if not (owner and name and branch):
        return 1, f"gh did not name the head branch of #{pr.get('number')}, so waffles could not check it for .tmp/."
    on_head, err = has_tmp(owner, name, branch)
    if on_head is None:
        return 1, f"gh api failed, so waffles could not check the head branch {branch} of #{pr['number']} for .tmp/: {err}"
    if not on_head:
        return 0, ""
    # A .tmp/ that the base branch holds too is not this branch's working files: the squash adds nothing there.
    base = pr.get("baseRefName")
    where = re.match(r"https://[^/]+/([^/]+)/([^/]+)/pull/", pr.get("url") or "")
    if base and where:
        on_base, err = has_tmp(where.group(1), where.group(2), base)
        if on_base:
            return 0, ""
        if on_base is None:
            return 1, f"gh api failed, so waffles could not check the base branch {base} of #{pr['number']} for .tmp/: {err}"
    return 3, (
            f"Refused: the head branch {branch} of #{pr['number']} still holds .tmp/, the working files. "
            "A squash merge would put them on the default branch. Take the plan outline's last step first: "
        "git rm -r .tmp, commit it as \"Remove the working files\", and push. Then merge."
    )


def main(argv, out=sys.stdout):
    if len(argv) != 1:
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 2
    worst = 0
    lines = []
    try:
        found = merges(argv[0])
    except Unreadable as error:
        print(f"waffles could not split the command into words ({error}), so it did not check for .tmp/ before the merge.", file=out)
        return 1
    for args in found:
        code, line = check(*target(args))
        if line:
            lines.append(line)
        worst = 3 if 3 in (worst, code) else max(worst, code)
    if lines:
        print("\n".join(lines), file=out)
    return worst


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
