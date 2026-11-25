#!/usr/bin/env python3
"""Hold the backlog adapter calls that could not reach the tracker, for replay.

Usage:
  python3 -I backlog_queue.py add <step> <item> --why <cause> [--data JSON] [--backlog DIR]
  python3 -I backlog_queue.py list [--backlog DIR]
  python3 -I backlog_queue.py done <seq> [--id ID] [--backlog DIR]

A repo that names a backlog adapter keeps its backlog in a tracker. When a write
to it ends "unreachable", waffles queues the call here, in .backlog/queue.json, and
replays the queue, in order, at the next adapter call that succeeds. The steps
that write are raise, claim, ship, and note; pull only reads, so it is never
queued.

<item> is the tracker's ID of the item, or the file name of a .backlog/ item
that has no ID yet. A raise names the file: the file holds the item, and stays
until the raise is replayed.

  add   queues 1 call, after every call already queued. --data holds the call's
        other inputs as a JSON object (the actor of a raise, the event and URL of
        a ship, the text of a note). Prints the entry.
  list  prints the queued calls, oldest first, as a JSON array. Each names the
        item by its ID once a replayed raise gave it one.
  done  removes call <seq> once the adapter answered it: done, or refused. For a
        raise, --id is the item's new ID: later calls for the file name that ID,
        and so does the depends: line of every other item file. The file is
        deleted when its status is still new; a file that work already started
        on becomes <ID>.md, with an id: line, as the work-loop's record of it.
        A raise done with no --id was refused: the later calls for its file are
        removed with it. The queue file goes when it is empty.

A call's <seq> is never used twice, so a done for a call that another session
already replayed exits 2 and removes nothing. The script keeps the queue out of
git with a line in the checkout's .git/info/exclude: the queue belongs to 1
machine. It never calls the tracker, and changes nothing but the queue file,
that exclude line, and, at a raise's done, the item files. Exit codes: 0 when it worked, 1 when the queue
or an item file cannot be read or written, 2 for bad arguments.
"""

import datetime
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
import time

STEPS = ("raise", "claim", "ship", "note")
QUEUE = "queue.json"
EXCLUDES = ("/.backlog/queue.json", "/.backlog/.queue-*")
STATUS = re.compile(r"^status:[ \t]*(\S*)", re.M)
DEPENDS = re.compile(r"^depends:.*$", re.M)


class Failure(Exception):
    """A queue or item file that cannot be read or written: exit code 1."""


class Usage(Exception):
    """Bad arguments: exit code 2."""


def default_backlog():
    """The main checkout's .backlog/: the first worktree that git lists, else the working directory."""
    try:
        out = subprocess.run(
            ["git", "worktree", "list", "--porcelain"], capture_output=True, text=True, check=True
        ).stdout
        main = next(line[len("worktree ") :] for line in out.splitlines() if line.startswith("worktree "))
    except (OSError, subprocess.CalledProcessError, StopIteration):
        main = os.getcwd()
    return os.path.join(main, ".backlog")


def is_file_name(item):
    return item.endswith(".md")


def check_item(item):
    if not item or "/" in item or item.startswith("."):
        raise Usage(f"not an item ID or a .backlog/ file name: {item!r}")


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Locked:
    """Holds an exclusive lock on the backlog folder, so 2 sessions never write the queue at once."""

    def __init__(self, backlog):
        self.backlog = backlog

    def __enter__(self):
        self.fd = os.open(self.backlog, os.O_RDONLY)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)


def read_queue(backlog):
    path = os.path.join(backlog, QUEUE)
    try:
        with open(path, encoding="utf-8") as f:
            entries = json.load(f)
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as e:
        raise Failure(f"cannot read {path}: {e}")
    if not isinstance(entries, list) or not all(
        isinstance(e, dict) and isinstance(e.get("seq"), int) and isinstance(e.get("item"), str) and e.get("step") in STEPS
        for e in entries
    ):
        raise Failure(f"{path} does not hold a list of queued calls")
    return entries


def write_queue(backlog, entries):
    path = os.path.join(backlog, QUEUE)
    try:
        if not entries:
            if os.path.exists(path):
                os.remove(path)
            return
        fd, tmp = tempfile.mkstemp(dir=backlog, prefix=".queue-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(entries, f, indent=2)
                f.write("\n")
            os.replace(tmp, path)
        except BaseException:
            os.unlink(tmp)
            raise
    except OSError as e:
        raise Failure(f"cannot write {path}: {e}")


def exclude_from_git(backlog):
    """Adds the queue to the checkout's .git/info/exclude. Outside git, or when that fails, it does nothing."""
    try:
        out = subprocess.run(
            ["git", "-C", os.path.dirname(os.path.abspath(backlog)), "rev-parse", "--git-common-dir"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        info = os.path.join(os.path.dirname(os.path.abspath(backlog)), out, "info")
        path = os.path.join(info, "exclude")
        text = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
        have = {line.strip() for line in text.splitlines()}
        missing = [line for line in EXCLUDES if line not in have]
        if missing:
            os.makedirs(info, exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                # A file that does not end in a newline would join its last line to the first one added.
                f.write(("\n" if text and not text.endswith("\n") else "") + "".join(f"{line}\n" for line in missing))
    except (OSError, subprocess.CalledProcessError):
        pass


def add(backlog, step, item, why, data):
    if step not in STEPS:
        raise Usage(f"not a step that writes: {step!r}; use one of {', '.join(STEPS)}")
    check_item(item)
    if not why:
        raise Usage("--why must say why the tracker could not be reached")
    if step == "raise" and not is_file_name(item):
        raise Usage(f"a raise names the .backlog/ file that holds the item, not {item!r}")
    try:
        os.makedirs(backlog, exist_ok=True)
    except OSError as e:
        raise Failure(f"cannot make {backlog}: {e}")
    with Locked(backlog):
        if is_file_name(item) and not os.path.isfile(os.path.join(backlog, item)):
            raise Failure(f"no item file {os.path.join(backlog, item)}")
        entries = read_queue(backlog)
        entry = {
            # Milliseconds since the epoch, past every seq queued: a seq is never used twice, also once the
            # queue was empty.
            "seq": max([int(time.time() * 1000)] + [e["seq"] + 1 for e in entries]),
            "step": step,
            "item": item,
            "data": data,
            "why": why,
            "at": now(),
        }
        entries.append(entry)
        write_queue(backlog, entries)
    exclude_from_git(backlog)
    return entry


def pending(backlog):
    if not os.path.isdir(backlog):
        return []
    with Locked(backlog):
        return read_queue(backlog)


def done(backlog, seq, new_id=None):
    """Removes call seq. Returns the lines that say what changed."""
    if not os.path.isdir(backlog):
        raise Usage(f"no queued call {seq}: another session may have replayed it")
    with Locked(backlog):
        entries = read_queue(backlog)
        entry = next((e for e in entries if e["seq"] == seq), None)
        if entry is None:
            raise Usage(f"no queued call {seq}: another session may have replayed it")
        name = entry["item"]
        is_raise = entry["step"] == "raise" and is_file_name(name)
        if new_id is not None:
            check_item(new_id)
            if is_file_name(new_id) or not is_raise:
                raise Usage("--id goes with a raise of a .backlog/ file only, and names a tracker ID")
        entries = [e for e in entries if e is not entry]
        lines = [f"Removed queued call {seq}: {entry['step']} {name}."]
        if is_raise and new_id is None:
            # The raise was refused: the calls after it have no item to reach.
            dropped = [e for e in entries if e["item"] == name]
            entries = [e for e in entries if e["item"] != name]
            lines += [f"Removed queued call {e['seq']}: {e['step']} {name}, since {name} was not raised." for e in dropped]
        if new_id is not None:
            for e in entries:
                if e["item"] == name:
                    e["item"] = new_id
        # The queue first: a file deleted before a queue write that fails would leave a raise with no item.
        write_queue(backlog, entries)
        if new_id is not None:
            try:
                lines += raised(backlog, name, new_id)
            except Failure as e:
                # The queue holds the raise no longer, so a replay cannot raise it twice; the file can still be
                # taken for a local item and raised by hand.
                raise Failure(
                    f"{e}. {name} is {new_id} in the tracker, and the queue no longer holds its raise: rename or delete "
                    f"{os.path.join(backlog, name)} by hand, and check the tracker for a duplicate of {new_id} if the "
                    "file was raised again"
                )
    return lines


def raised(backlog, name, new_id):
    """After a replayed raise: names the ID in other items' depends:, and deletes or renames the item file."""
    lines = []
    for other in sorted(os.listdir(backlog)):
        path = os.path.join(backlog, other)
        if other == name or not is_file_name(other) or not os.path.isfile(path):
            continue
        try:
            text = open(path, encoding="utf-8").read()
            new = DEPENDS.sub(lambda m: re.sub(rf"(?<![\w.-]){re.escape(name)}(?![\w.-])", new_id, m.group(0)), text, count=1)
            if new != text:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(new)
                lines.append(f"{other} now depends on {new_id}.")
        except OSError as e:
            raise Failure(f"cannot update {path}: {e}")
    path = os.path.join(backlog, name)
    try:
        text = open(path, encoding="utf-8").read()
    except FileNotFoundError:
        return lines + [f"{name} is {new_id} in the tracker."]
    except OSError as e:
        raise Failure(f"cannot read {path}: {e}")
    status = STATUS.search(text)
    try:
        if status is None or status.group(1) in ("", "new"):
            os.remove(path)
            lines.append(f"{name} is {new_id} in the tracker; deleted {path}.")
        else:
            record = os.path.join(backlog, f"{new_id}.md")
            if os.path.exists(record):
                return lines + [f"{name} is {new_id} in the tracker; kept {path}, since {record} exists."]
            with open(record, "w", encoding="utf-8") as f:
                f.write(re.sub(r"\A---\n", f"---\nid: {new_id}\n", text, count=1))
            os.remove(path)
            lines.append(f"{name} is {new_id} in the tracker; its work goes on, so it is now {record}.")
    except OSError as e:
        raise Failure(f"cannot update {path}: {e}")
    folder = os.path.splitext(path)[0]
    if os.path.isdir(folder):
        lines.append(f"Kept {folder}/: check that the tracker holds its files, then delete it.")
    return lines


def parse(argv):
    args = {"backlog": None, "why": None, "data": None, "id": None}
    positional = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("--backlog", "--why", "--data", "--id"):
            if i + 1 >= len(argv):
                raise Usage(f"{arg} needs a value")
            args[arg[2:]] = argv[i + 1]
            i += 2
        elif arg.startswith("--"):
            raise Usage(f"unknown option {arg}")
        else:
            positional.append(arg)
            i += 1
    if not positional:
        raise Usage("name a command: add, list, or done")
    return positional, args


def main(argv):
    try:
        positional, args = parse(argv)
        backlog = args["backlog"] or default_backlog()
        command, rest = positional[0], positional[1:]
        if command == "add":
            if len(rest) != 2:
                raise Usage("add takes <step> <item>")
            data = {}
            if args["data"] is not None:
                try:
                    data = json.loads(args["data"])
                except ValueError as e:
                    raise Usage(f"--data is not JSON: {e}")
                if not isinstance(data, dict):
                    raise Usage("--data must be a JSON object")
            print(json.dumps(add(backlog, rest[0], rest[1], args["why"], data)))
        elif command == "list":
            if rest:
                raise Usage("list takes no arguments")
            print(json.dumps(pending(backlog), indent=2))
        elif command == "done":
            if len(rest) != 1 or not re.fullmatch(r"[0-9]+", rest[0]):
                raise Usage("done takes the <seq> of a queued call")
            print("\n".join(done(backlog, int(rest[0]), args["id"])))
        else:
            raise Usage(f"unknown command {command!r}")
    except Usage as e:
        print(f"backlog_queue: {e}", file=sys.stderr)
        return 2
    except Failure as e:
        print(f"backlog_queue: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
