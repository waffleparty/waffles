---
name: ask
description: Collect the open, unresolved items from the recent conversation and put them to the user as multiple-choice questions, record the answers where the work lives, and summarize what was decided and what is still open. Use when the user asks to be asked the open questions, to resolve or go through open items, or to make the pending decisions.
---

# Ask

Turn the conversation's loose ends into questions the user can answer quickly, write the answers
into the work, and pick up whatever they deferred for discussion. The input is the recent
conversation plus `$ARGUMENTS` (optional: a topic or file to narrow the scope).

## 1. Collect the open items

Read back through the conversation since its last natural reset (the start of the current task or
topic). An open item is anything a person has to decide that hasn't been decided:

- questions you asked that weren't answered, or were answered only in part;
- options you laid out without a pick;
- assumptions you made and flagged, TODOs, and "we can decide later" points;
- disagreements or concerns raised and not settled;
- open questions or TBDs written in a file the conversation is about (spec, plan, ADR, backlog
  item, design doc).

Drop items the conversation already settled, even implicitly (the user built on one option), and
items made moot by later decisions. Merge duplicates. If `$ARGUMENTS` names a topic or file, keep
only the items about it.

If there are none, say so in one line and stop.

## 2. Prepare each question

For each item, work out what the user needs to answer without scrolling back: what the item is
about, why it's open, and what depends on it. Read the relevant files when the answer turns on
them. Then write:

- **Question text** that stands alone: what the thing is, what is true today, and why it is
  open (the constraint or finding), then the question, ending in `?`. Use the sentences that
  takes. Name files, functions, or sections concretely.
- **Header:** a noun label of 12 characters or fewer (`Cache TTL`, `Auth scope`).
- **Options:** 2 or 3 real answers, your recommendation first with ` (Recommended)` appended to
  its label. Each `description` says what will be true after the option is chosen, then its
  trade-off; the recommended option's description also gives the rationale. Then always, last:
  **Defer for further discussion**, description "Leave this open and discuss it after the
  questions. Add a note to set the direction."
- **Preview on every option, including Defer.** A preview is what makes the note field available.
  Use it for supplemental context: a code or config snippet, a spec excerpt as it would read, or
  a short example. A preview that states an effect or a state is a full sentence: the object, and
  what is true of it. Never a label and 1 word (`protection: held`). For Defer, the preview
  states the item's current state that way.

Order the questions so that ones whose answers change other questions come first.

## 3. Ask

Start with one short chat message: how many open items you found and their headers, so the user
can orient before the dialog opens.

Ask with AskUserQuestion, up to 4 questions per call. Put questions in the same call only when
they're independent; a question whose options or relevance depend on another's answer goes in a
later call, rewritten in light of that answer. Drop questions an answer made moot.

After each call, record its answers (step 4) before the next call. Keep, for each question: the
choice, the user's note if any, and whether it was deferred. A typed "Other" answer is a decision
like any other.

If the user dismisses the dialog, stop asking. Answers already given stay recorded; go to step 5
with the rest listed as open.

## 4. Record

Write each decision where the work it governs lives:

| Conversation was about | Record in |
| --- | --- |
| A spec, plan, ADR, design doc, or README | That file: change the text to reflect the decision, and remove or resolve the matching open question or TBD |
| A backlog item | Its `## Clarifications`, as `**Q:** … **A:** …` |
| An external doc, such as a hosted document or an issue | That doc, through its tool |
| Code with no document | Nowhere on disk; the summary in step 5 is the record |

Fold the note into the decision when it qualifies it ("Option B, but keep the old flag for one
release"). Write deferred items into the same place as open questions, with the user's note as
the direction, so they aren't lost if the discussion doesn't happen now. Don't start
implementation work in this step.

## 5. Summarize

Reply in chat in this shape:

```markdown
### Decided
- **<header>:** <decision, with note if any>, recorded in `<file or doc>`

### Open
- **<header>:** <deferred — direction from note, or "no direction given">
- **<header>:** <not asked — dismissed before this question>
```

Omit an empty section. No other commentary.

## 6. Continue

Then, in this order:

1. **Deferred items with a note:** start the discussion each note asks for, one item at a time,
   most consequential first. Open with what the note asked for (research, a comparison, a
   proposal) and do it; don't re-ask the same question. When the discussion settles an item,
   record it as in step 4.
2. **Deferred items without a note:** leave them open. They're listed in the summary.
3. **Blocked work:** if a task in the conversation was waiting on the decided items, say in one
   line that you're resuming it, then resume it.
