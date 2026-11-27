# The tracker and posting

Read this file before the run's first tracker write, and before it first posts
where other people read (see Ground rules in SKILL.md).

- **The tracker: record the run's own work.** In a repo that names a backlog adapter
  (`adapter.md` in the `backlog` skill's base directory says how), make the adapter's writes about
  the run's own work: `claim` the item the run builds; `ship` it as its pull request is marked
  ready, removed by a merge queue (back to `in work`, with a `note` that says why), merged, or
  deployed; link its pull request; attach its spec where the adapter can; `note` on it, with
  `needs_person: set` when the run stops on it; and `raise` a task for the run's own side work.
  When the tracker cannot be reached, fall back as `adapter.md` says; the work does not wait for it.
- **Say that Claude wrote it.** Before you post where other people read, check which identity
  the tool posts as. Post as Claude when a Claude identity can. When only the user's own login
  works, add "Written by Claude during an unattended run for <login>." as the first line of a
  comment and as the last line of a pull request body. On another platform, its assistant's name
  stands in place of Claude.
