#!/usr/bin/env python3
"""Watch the CI/CD targets in a watch-ci map; exit when the caller must act.

Usage: python3 -I watch.py MAP.json --once
       python3 -I watch.py MAP.json --until-actionable [--budget SECONDS]

The map is built up front by the agent (see SKILL.md); this script never decides
what to watch, it only polls the targets the map names. State is kept in
MAP.state.json, so a restarted watcher never repeats an event.

--once polls every target a single time, prints each one's current state, and exits.

--until-actionable polls until something changes that the caller must see, then
exits. Its last line is one of:
  RETURN              events above need action (FAIL, WAITING, MISSING, …)
  ALL_DONE <result>   every target settled
  CONTINUE <summary>  nothing needs action; a job finished or the budget
                      (default 540 s) ran out. Run again. <summary> is the
                      current progress in one line.
"""

import json
import os
import subprocess
import sys
import time

SETTLED = {"success", "failure", "cancelled", "skipped", "missing", "waiting"}
TERMINAL_EVENT = {
    "success": "DONE",
    "failure": "FAIL",
    "cancelled": "CANCELLED",
    "skipped": "SKIPPED",
    "missing": "MISSING",
    "waiting": "WAITING",
}
GH_FAIL = {"failure", "timed_out", "startup_failure", "action_required"}
ERROR_STREAK = 3
# Events that need the main agent. DONE and SKIPPED don't: the final report covers them.
ACTIONABLE = {"FAIL", "WAITING", "MISSING", "STALLED", "CANCELLED", "ERROR"}
DEFAULT_BUDGET = 540  # stays under the 10-minute limit on a foreground Bash call


def emit(line):
    print(line, flush=True)


def gh(args):
    proc = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=90)
    if proc.returncode != 0:
        err = proc.stderr.strip().splitlines()
        raise RuntimeError(err[-1] if err else f"gh exited {proc.returncode}")
    return json.loads(proc.stdout) if proc.stdout.strip() else None


def gh_state(status, conclusion):
    """Map a GitHub run/job/check status + conclusion to a watch-ci state."""
    if status in ("waiting", "action_required"):
        return "waiting"
    if status != "completed":
        return "running" if status == "in_progress" else "queued"
    if conclusion in ("success", "neutral"):
        return "success"
    if conclusion == "skipped":
        return "skipped"
    if conclusion in ("cancelled", "stale"):
        return "cancelled"
    if conclusion in GH_FAIL:
        return "failure"
    return "failure"


def job_view(job):
    steps = job.get("steps") or []
    done = sum(1 for s in steps if s.get("status") == "completed")
    current = next((s["name"] for s in steps if s.get("status") == "in_progress"), None)
    failed = next(
        (s["name"] for s in steps if s.get("conclusion") in GH_FAIL), None
    )
    return {
        "name": job.get("name", "?"),
        "state": gh_state(job.get("status"), job.get("conclusion")),
        "steps_done": done,
        "steps_total": len(steps),
        "current_step": current,
        "failed_step": failed,
        "url": job.get("url"),
    }


def poll_gh_run(repo, run_id):
    run = gh(["run", "view", str(run_id), "--repo", repo,
              "--json", "status,conclusion,url,jobs,attempt"])
    return {
        "state": gh_state(run.get("status"), run.get("conclusion")),
        "url": run.get("url"),
        "attempt": run.get("attempt", 1),
        "jobs": [job_view(j) for j in run.get("jobs") or []],
    }


def resolve_gh_workflow(t):
    runs = gh(["run", "list", "--repo", t["repo"], "--workflow", t["workflow"],
               "--commit", t["sha"], "-L", "20",
               "--json", "databaseId,createdAt,event"])
    if t.get("event"):
        runs = [r for r in runs if r.get("event") == t["event"]]
    if not runs:
        return None
    return max(runs, key=lambda r: r["createdAt"])["databaseId"]


def poll_gh_check(t):
    data = gh(["api", "-X", "GET", f"repos/{t['repo']}/commits/{t['sha']}/check-runs",
               "-f", f"check_name={t['name']}", "-f", "per_page=100"])
    checks = data.get("check_runs") or []
    if not checks:
        return {"state": "absent"}
    c = max(checks, key=lambda c: c.get("started_at") or "")
    title = (c.get("output") or {}).get("title")
    return {
        "state": gh_state(c.get("status"), c.get("conclusion")),
        "url": c.get("html_url") or c.get("details_url"),
        "detail": title,
    }


def poll_gh_status(t):
    statuses = gh(["api", "-X", "GET", f"repos/{t['repo']}/commits/{t['sha']}/statuses",
                   "-f", "per_page=100"])
    match = next((s for s in statuses if s.get("context") == t["context"]), None)
    if match is None:
        return {"state": "absent"}
    state = {"pending": "running", "success": "success"}.get(match["state"], "failure")
    return {"state": state, "url": match.get("target_url"),
            "detail": match.get("description")}


def poll_command(t):
    proc = subprocess.run(t["command"], shell=True, capture_output=True, text=True,
                          timeout=120)
    if proc.returncode != 0:
        err = proc.stderr.strip().splitlines()
        raise RuntimeError(err[-1] if err else f"command exited {proc.returncode}")
    return json.loads(proc.stdout)


def poll(t, st):
    kind = t["kind"]
    if kind == "gh-run":
        return poll_gh_run(t["repo"], t["run_id"])
    if kind == "gh-workflow":
        run_id = st.get("run_id") or resolve_gh_workflow(t)
        if run_id is None:
            return {"state": "absent"}
        st["run_id"] = run_id
        return poll_gh_run(t["repo"], run_id)
    if kind == "gh-check":
        return poll_gh_check(t)
    if kind == "gh-status":
        return poll_gh_status(t)
    if kind == "command":
        return poll_command(t)
    raise RuntimeError(f"unknown kind {kind!r}")


def resolve_absent(t, st, states, now, m, labels):
    """Decide what a target that hasn't appeared yet means."""
    deps = t.get("after") or []
    appear = 60 * t.get("appear_minutes", m.get("appear_minutes", 10))
    if deps:
        dep_states = [states.get(d) for d in deps]
        if t.get("needs_success", True):
            bad = [d for d in deps if states.get(d) in
                   ("failure", "cancelled", "skipped", "missing")]
            if bad:
                names = ", ".join(labels.get(d, d) for d in bad)
                return {"state": "skipped", "detail": f"{names} did not succeed"}
        if not all(s in SETTLED - {"waiting"} for s in dep_states):
            names = ", ".join(labels.get(d, d) for d in deps)
            return {"state": "absent", "detail": f"starts after {names}"}
        st.setdefault("deps_done_at", now)
        since = st["deps_done_at"]
    else:
        st.setdefault("first_absent", now)
        since = st["first_absent"]
    if now - since > appear:
        return {"state": "missing",
                "detail": f"no run appeared within {appear // 60} min"}
    return {"state": "absent", "detail": "not started yet"}


def describe(label, r, expected_jobs):
    state = r["state"]
    jobs = r.get("jobs")
    if not jobs:
        if state == "absent":
            return f"{label}: {r.get('detail') or 'not started yet'}"
        extra = f" ({r['detail']})" if r.get("detail") else ""
        return f"{label}: {state}{extra}"
    total = max(len(jobs), expected_jobs or 0)
    done = sum(1 for j in jobs if j["state"] in SETTLED - {"waiting"})
    parts = []
    for j in jobs:
        if j["state"] == "running":
            step = f", now \"{j['current_step']}\"" if j.get("current_step") else ""
            parts.append(f"monitoring {j['name']} ({j['steps_done']}/{j['steps_total']}"
                         f" steps completed{step})")
        elif j["state"] == "waiting":
            parts.append(f"{j['name']} waiting for approval")
    body = "; ".join(parts) if parts else state
    return f"{label}: {body} · {done}/{total} jobs done"


def short(label, r, expected_jobs):
    """One compact progress fragment for the CONTINUE summary."""
    state = r["state"]
    jobs = r.get("jobs") or []
    if state in SETTLED:
        return f"{label} {TERMINAL_EVENT[state].lower()}"
    if not jobs:
        return f"{label} {'not started' if state == 'absent' else state}"
    total = max(len(jobs), expected_jobs or 0)
    done = sum(1 for j in jobs if j["state"] in SETTLED - {"waiting"})
    now = next((j.get("current_step") or j["name"] for j in jobs
                if j["state"] == "running"), None)
    return f"{label} {done}/{total} jobs" + (f' · now "{now}"' if now else "")


def terminal_line(label, r):
    state = r["state"]
    event = TERMINAL_EVENT[state]
    url = f" {r['url']}" if r.get("url") else ""
    jobs = r.get("jobs") or []
    if state == "failure":
        bad = [j for j in jobs if j["state"] == "failure"]
        if bad:
            where = "; ".join(
                f"job {j['name']}" + (f', step "{j["failed_step"]}"'
                                       if j.get("failed_step") else "")
                + (f" {j['url']}" if j.get("url") else "")
                for j in bad)
            return f"{event} {label}: {where}"
    if state == "waiting":
        who = [j["name"] for j in jobs if j["state"] == "waiting"]
        what = f"job {', '.join(who)} " if who else ""
        return f"{event} {label}: {what}waiting for approval{url}"
    if state == "skipped" and r.get("detail"):
        return f"{event} {label}: {r['detail']}"
    detail = f" ({r['detail']})" if r.get("detail") else ""
    jobs_note = f" ({len(jobs)} jobs)" if jobs and state == "success" else ""
    return f"{event} {label}: {state}{jobs_note}{detail}{url}"


def overall(states):
    vals = set(states.values())
    if vals & {"failure", "missing"}:
        return "failure"
    if "cancelled" in vals:
        return "cancelled"
    if "waiting" in vals:
        return "waiting"
    return "success"


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def run(map_path, once, budget):
    m = load(map_path, None)
    if not m or not m.get("targets"):
        emit(f"ERROR map {map_path} is missing or has no targets")
        return 2
    state_path = map_path + ".state.json"
    state = load(state_path, {"started": time.time(), "targets": {}})
    targets = m["targets"]
    labels = {t["id"]: t.get("label", t["id"]) for t in targets}
    poll_s = m.get("poll_seconds", 30)
    stall_s = 60 * m.get("stall_minutes", 30)
    max_s = 60 * m.get("max_minutes", 180)
    began = time.time()

    if once:
        emit(f"SNAPSHOT {len(targets)} targets for {m.get('context', 'this change')}: "
             + ", ".join(labels.values()))

    while True:
        now = time.time()
        states = {}
        summary = []
        actionable = False
        jobs_moved = False
        for t in targets:  # map order: upstream targets come before their dependents
            tid = t["id"]
            st = state["targets"].setdefault(tid, {})
            try:
                r = poll(t, st)
                st["errors"] = 0
            except Exception as e:  # noqa: BLE001 - one bad poll must not kill the watch
                st["errors"] = st.get("errors", 0) + 1
                if st["errors"] == ERROR_STREAK:
                    emit(f"ERROR {labels[tid]}: {e}")
                    actionable = True
                states[tid] = st.get("last_state", "queued")
                summary.append(f"{labels[tid]} poll failing")
                continue
            if r["state"] == "absent":
                r = {**r, **resolve_absent(t, st, states, now, m, labels)}
            s = r["state"]
            states[tid] = s
            attempt = r.get("attempt", 1)
            if st.get("attempt") != attempt:
                st["attempt"] = attempt
                for k in ("reported", "queued_since", "stalled", "jobs_done"):
                    st.pop(k, None)
            st["last_state"] = s
            summary.append(short(labels[tid], r, t.get("expected_jobs")))

            if s in SETTLED:
                if once or st.get("reported") != s:
                    line = terminal_line(labels[tid], r)
                    emit(line)
                    st["reported"] = s
                    actionable |= line.split(" ", 1)[0] in ACTIONABLE
                    jobs_moved = True
                continue
            st.pop("reported", None)

            if s == "queued":
                st.setdefault("queued_since", now)
                if now - st["queued_since"] > stall_s and not st.get("stalled"):
                    emit(f"STALLED {labels[tid]}: queued for "
                         f"{int((now - st['queued_since']) // 60)} min {r.get('url', '')}"
                         .rstrip())
                    st["stalled"] = True
                    actionable = True
            else:
                st.pop("queued_since", None)

            done = sum(1 for j in r.get("jobs") or [] if j["state"] in SETTLED - {"waiting"})
            if done != st.get("jobs_done", 0):
                st["jobs_done"] = done
                jobs_moved = True
            if once:
                emit("PROGRESS " + describe(labels[tid], r, t.get("expected_jobs")))

        save(state_path, state)
        settled = [tid for tid, s in states.items() if s in SETTLED]
        if len(settled) == len(targets):
            emit(f"ALL_DONE {overall(states)}")
            return 0
        if once:
            emit(f"PENDING {len(settled)}/{len(targets)} targets settled")
            return 0
        if now - state["started"] > max_s:
            emit(f"TIMEOUT after {max_s // 60} min; "
                 f"{len(settled)}/{len(targets)} targets settled")
            emit("ALL_DONE incomplete")
            return 0
        if actionable:
            emit("RETURN")
            return 0
        if jobs_moved or time.time() - began + poll_s > budget:
            emit("CONTINUE " + " · ".join(summary))
            return 0
        time.sleep(poll_s)


if __name__ == "__main__":
    argv = sys.argv[1:]
    budget = DEFAULT_BUDGET
    if "--budget" in argv:
        i = argv.index("--budget")
        budget = int(argv[i + 1])
        del argv[i:i + 2]
    flags = {a for a in argv if a.startswith("--")}
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1 or len(flags & {"--once", "--until-actionable"}) != 1:
        print(__doc__.strip(), file=sys.stderr)
        sys.exit(2)
    sys.exit(run(os.path.abspath(args[0]), "--once" in flags, budget))
