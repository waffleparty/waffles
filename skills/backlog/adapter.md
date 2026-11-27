# The backlog adapter

waffles knows no issue tracker. Its 3 backlog skills (`backlog`, `backlog-review`,
`work-loop`), its initialization check (`init-check`), and its run skill (`non-interactive`) work on **items** in waffles' item standard below. A repo that
keeps its backlog in a tracker names an **adapter**: a skill that implements
5 steps over that tracker and maps the tracker's fields to the item standard.
waffles calls the steps; the adapter does the reads and writes. A repo that names no
adapter keeps its backlog in `.backlog/` files, as before.

This file is the contract between waffles and an adapter. It names no tracker.

## Naming the adapter

A repo names its adapter with 1 line in the `AGENTS.md` at the root of its
checkout, or in `CLAUDE.md` when the repo has no `AGENTS.md`:

```markdown
Backlog adapter: `tracker-adapter`
```

The line starts with `Backlog adapter:`, then the name of a skill that the
session can load, with or without backticks. A plugin's skill is named with its
plugin, such as `example:tracker-adapter`. Find it with:

```sh
f=AGENTS.md; [ -f "$f" ] || f=CLAUDE.md; grep -m1 -E '^Backlog adapter:' "$f"
```

A repo that has an `AGENTS.md` names its adapter there; its `CLAUDE.md` then
does not count.

The line goes in the file that every agent already reads, so the repo needs no
config file of its own, and a person who reads the file sees the choice.

| The repo | What waffles does |
| --- | --- |
| Names no adapter | `.backlog/` is the backlog. waffles says nothing about a tracker. |
| Names an adapter that the session can load | Each step goes through the adapter. `.backlog/` is the fallback only (see Fallback). |
| Names an adapter that the session cannot load | Each step falls back, with the cause "the adapter skill `<name>` is not installed". The initialization check reports it. |

## The item standard

An item is waffles' unit of work: one item, one branch, one pull request. These 15
fields are what waffles needs to know about an item. An adapter maps each to the
tracker; the third column is the same field in a `.backlog/` file.

| Field | What it holds | In a `.backlog/` file |
| --- | --- | --- |
| `id` | The stable name of the item, given by the tracker | The file name |
| `title` | A short imperative name | `title:` |
| `kind` | `story` (it builds behavior that a person who uses the product sees), `task` (required work that changes no observable behavior), or `bug` | `kind:` |
| `state` | `not ready`, `ready`, `in work`, `in review`, `waiting for deploy`, or `done` | `status:` with `groomed:` (see States) |
| `actor` | Who can do the work: `agent` (an agent alone), `human` (an agent paired with a person), or `assignee` (an agent paired with the item's owner). Exactly 1. | `type:` — `background` is `agent`; `interactive` is `human` or `assignee` |
| `request` | What is asked, in the words of the person who asked | Section `## Request`, verbatim |
| `answers` | Questions and answers from grooming, and notes | Section `## Clarifications` |
| `blocked_by` | The items that must be done first | `depends:` |
| `parent` | The larger item this one is part of, such as an epic | None |
| `owner` | The person responsible for the work | None: the person who uses the repo |
| `due` | The date that orders the list of ready items | None: files keep their own order |
| `component` | Where in the codebase the work is | The repo that holds the file |
| `files` | The documents that belong to the item, such as a spec | Files in `.backlog/<slug>/` |
| `work` | The branch and the pull request | `branch:` and `pr:`, and section `## Progress` |
| `needs_person` | The item stopped and waits for a person, with the reason | `status: escalated`, and the question in `## Progress` |

An item with no `actor` was not adopted yet: it came into the tracker another
way, and nobody said who can do it. waffles lists it, does not build it, and adopts
it with `raise`.

### States

| State | Meaning | In a `.backlog/` file |
| --- | --- | --- |
| `not ready` | Captured; grooming is not finished, or a person has not accepted it | `status: new`, `type: interactive`, and `groomed:` not `true` |
| `ready` | A person accepted it, and it can be built | Any other `status: new` |
| `in work` | Claimed: an agent or a person started it. The lock across machines and people. | `status: running` or `active` |
| `in review` | Its pull request is up for review | `status: review` |
| `waiting for deploy` | Merged, not yet released where its stage says | None: a merged file is deleted |
| `done` | Released, and the definition of done is met | The file is deleted |

Only a person moves an item from `not ready` to `ready`. An agent proposes it.
In a `.backlog/` file, the person's answers in `backlog-review` make that move:
the skill sets `groomed: true` when they close the last gap.

## The 5 steps

Each step takes and returns items in the item standard. Each call ends in 1 of
3 outcomes:

| Outcome | Meaning | What waffles does |
| --- | --- | --- |
| **done** | The step did what it says. | Goes on. |
| **refused**, with the reason | The tracker answered, and the step must not happen: the item is already started, a rule forbids it, or the move does not exist. | Reports the reason. Never queues the call, and never forces another path. |
| **unreachable**, with the cause | The tracker could not be reached: no connection or credentials, no network, or credentials that expired. | Falls back (see Fallback). |

A step that needs a person's answer (an approval, or a choice the adapter
cannot make) asks the person in a session with one present. With nobody
present, it ends **unreachable** with the cause "needs a person: <what>", so
the call waits in the queue for a session with a person.

### pull

Lists the items that can be built now, or the items that still need grooming.

- **Input:** the repo, and the state to list: `ready` (the default) or
  `not ready`.
- **Output:** the items in that state, each with all its fields, ordered by
  `due`, soonest first. Each `blocked_by` entry carries the blocking item's
  state, so waffles can leave out an item whose blocker is not `done`. Items with the same `due`, or with none, keep the tracker's own
  order, after the ones with a date. An item with `needs_person` set says so.
  An empty list comes with its reason when there is one, such as "no component
  of this repo is linked to an item"; an empty list is **done**, not a failure.
- **State:** changes nothing.
- **Unreachable:** waffles lists the `.backlog/` files instead.

### raise

Creates an item for new work, or adopts an item that exists.

- **Input, to create:** an item with no `id`: `title`, `kind`, `actor`,
  `request`, and where they are known `blocked_by`,
  `parent`, `component`, and `files`.
- **Input, to adopt:** an `id`, and the `actor` that the request names.
- **Output:** the item's `id`. When an item that is not `done` already covers
  the same work, `raise` adopts that item and returns its `id`.
- **State:** a new item is `not ready`. `raise` never creates an item in
  `ready` or moves one there. Adopting fills the missing fields; it never
  changes the `request` text that a person wrote, and writes what the item
  lacks as an answer instead.
- **Refused:** the adopted item has a different `actor` that a person set.

### claim

Starts the work on an item.

- **Input:** the `id`, and the person responsible: the person who started the
  session or the run.
- **Output:** the item.
- **State:** `ready` becomes `in work`, and `owner` becomes the person
  responsible, also when someone else was the owner. The owner does not change
  after that. A `task` that the agent raised for its own side work, and that the
  person told it to do now, may be claimed from `not ready`.
- **Refused:** the item is already `in work` or later (the reason gives its
  state and owner); it has no `actor`, or more than 1; it is `actor: human` and
  nobody is present; it is `actor: assignee` and the session was not started by
  its owner.

### ship

Moves an item after an event on its pull request.

- **Input:** the `id`, the event, and the pull request's URL when the work
  has one.
- **Output:** the item.
- **State:**

  | Event | New state |
  | --- | --- |
  | `ready for review`: the pull request is marked ready | `in review` |
  | `removed`: a merge queue removed the pull request; `note` says why | `in work` |
  | `merged`: the pull request is merged | `waiting for deploy` |
  | `deployed`: released where its stage says, and the definition of done is met | `done` |

  `ship` also links the pull request to the item (`work`), once, when it is
  given.
- **Refused:** the tracker offers no such move from the current state. The
  reason gives the current state and the moves offered.

### note

Adds an answer or a note to an item, or marks that it waits for a person.

- **Input:** the `id`, the text, optionally `needs_person`: `set` or
  `clear`, and optionally `files`: the paths of files to attach, such as a
  spec.
- **Output:** the item, and for each file in `files` whether it is attached.
- **State:** adds the text to `answers`. With `set`, `needs_person` is set, and
  the text says what the item waits for and what the person must decide or do.
  With `clear`, it is cleared, and the text says that the work goes on. Each
  file is added to `files`.
- **A tracker that cannot attach a file:** the note is still made, and the
  step is **done**; the output says which files are not attached and why. waffles
  then links each one from the item instead.

## Fallback

In a repo that names an adapter, `.backlog/` is a temporary queue for the time
the tracker cannot be reached. The queue is the waffles backlog queue tool
(`backlog_queue`; each platform adds its own prefix to the name, such as
`mcp__waffles__backlog_queue`). Where that tool is missing, the queue is
`scripts/backlog-queue.ts` of the waffles plugin
(`${CLAUDE_PLUGIN_ROOT}/scripts/backlog-queue.ts`, which is
`<skill-dir>/../../scripts/backlog-queue.ts` from a skill's base directory;
`<queue>` below), with the same commands as the tool's `op`, the item as an
argument, and the other inputs as flags. It keeps the calls in
`.backlog/queue.json` of the main checkout, and never calls the tracker
itself. The queue belongs to 1 machine: it keeps the file out of git (a line in
`.git/info/exclude`), so another clone never replays it again.

```
adapter call ─► queue empty? ─no─► replay the queue first ─► unreachable ─► queue this call too
     │              │ yes                 │ every call answered
     │              ▼                     ▼
     │         make the call ◄────────────┘
     │              │ unreachable
     │              ▼
     │         queue it ─► say that waffles fell back, and why
     ▼
  done or refused ─► go on
```

- **Say it each time.** Each call that falls back gets 1 line, in this form:
  `Fell back to .backlog/: <step> <item> did not reach the tracker (<cause>). Queued as call <seq>.`
  The cause is the adapter's: no connection or credentials, no network,
  credentials that expired, the adapter skill not installed, or "needs a person:
  <what>". Without the line, expired credentials would quietly start a second
  backlog on 1 machine.
- **pull** falls back by listing the `.backlog/` files, with the line
  `Fell back to .backlog/: pull did not reach the tracker (<cause>). Listing the local items only.`
  It queues nothing.
- **raise** falls back by writing the item as a `.backlog/` file, as in a repo
  with no tracker, then queuing the raise with the file's name:
  `{"op": "add", "step": "raise", "item": "<file>", "why": "<cause>", "data": {"actor": "<actor>"}}`
  (or `node <queue> add raise <file> --why "<cause>" --data '{"actor": "<actor>"}'`).
  The answer is the entry, with its `seq`.
  The file stays a local item until the raise is replayed: the other skills can
  groom it and work it.
- **claim, ship, note** fall back by queuing the call (`"op": "add"`) with the
  item's `id`, or with its file name when it has no `id` yet, and the call's
  other inputs in `data` (`{"event": "merged", "url": "<pull request>"}`,
  `{"text": "<note>", "needs_person": "set"}`). The local file of an item with no
  `id` takes the change too, as in a repo with no tracker. A note's `files` go
  in `data` as paths; when the replay finds one gone from the checkout (a
  later commit removed it), the note links it at the last commit that held it
  instead.
- **A claim that fell back holds no lock.** `in work` is the lock across
  machines and people only once the tracker holds it. Say so in the line:
  `… Queued as call <seq>. The tracker does not show <item> as started, so someone else can claim it.`
- **Replay** at the start of the next call to the adapter, before the call
  itself: list the queue (`{"op": "list"}`, or `node <queue> list`; the tool
  answers with `entries`), make its first call through the adapter, then
  remove it (`{"op": "done", "seq": <seq>}`, or `node <queue> done <seq>`). For a
  raise, pass the new ID (`"id": "<new id>"`, or `--id <new id>`): the queue
  names the new `id` in the calls after it and in the `depends:` of the other
  item files, and deletes the item file,
  or, when work on it already started, renames it to `<id>.md` with an `id:`
  line, as the work-loop's record of the work. List again and repeat until the
  queue is empty. Stop at the first call that is unreachable again, and queue
  the new call after the rest; a call that needs a person is the one exception
  (see below).
- **A refused call** in the replay is removed and reported, never queued again.
  `done` of a raise with no `id` means it was refused: the queue removes the
  later calls for its file too, and the file stays a local item.
- **A call that needs a person**, in a replay with nobody present: leave it,
  and every later call for the same item, in the queue, and replay the calls
  for other items. Otherwise 1 call that waits for a person would hold back
  every write after it.
- **Never write twice.** Before it replays a write that may have reached the
  tracker before the failure, the adapter reads the item first: a raise looks
  for the same work and adopts it, and a note that is already there is not
  posted again. When `done` answers that the call is not queued, another session
  replayed it: go on with the next.
- **Report the replay** in 1 line per call: `Replayed call <seq>: <step> <item> — done (<new id>)`
  or `— refused: <reason>`.
- **Keep the file while it is queued.** A skill that would delete an item file
  (after a merge, or when the person drops the item) leaves it while a queued
  call names it; the replay of its raise deletes it.
  When the person drops an item whose calls are queued, remove those calls with
  `done` before deleting the file, so the replay raises nothing for it.

## Writes about the agent's own work

These writes mirror what the agent did, so the adapter may make them with no
approval, also in a run with nobody present: `claim`; `ship`; `note` on an item
the agent works on; and `raise` of a `task` for the agent's own side work.
