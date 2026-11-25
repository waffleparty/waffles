---
name: debate
description: Enumerate the viable viewpoints on a decision, argue each against the others, and report the strongest case for each plus a verdict. Uses the query and recent conversation for context. Use when the user asks to debate, weigh, or argue options, or asks which of several options is better.
---

# Debate

Argue a decision from several viewpoints, then report the arguments and a verdict. The input is
the user's query (`$ARGUMENTS`, may be empty) plus the recent conversation and any work in the
repo it refers to.

## 1. Frame the question

Read the query, then the recent conversation: the problem being solved, constraints stated,
options already tried or rejected, and relevant code or config. If the query is empty, debate the
most recent open decision in the conversation. If there is none, ask what to debate and stop.

Classify the scope. It sets what you may add.

| Scope | Example | Options | Criteria |
| --- | --- | --- | --- |
| Open | `/debate how should we cache this?` | Enumerate the viable ones | Choose the ones that matter |
| Options scoped | `/debate which is better, A or B?` | A and B only | Choose the ones that matter |
| Options and criteria scoped | `/debate does A or B scale better?` | A and B only | The named ones only |

Criteria can be scoped without options being scoped (`/debate what's fastest here?`); then
enumerate options but judge on the named criteria.

**Adding an option to a scoped debate.** Add one only when overwhelming precedent makes it the
established best practice for this exact situation, such that leaving it out would mislead.
Being a reasonable alternative isn't enough. Cap: 1 added option. Label it as added and say why
in one line.

**Adding a criterion to a scoped debate.** Add one only when it could decide viability on its
own, such as an unacceptable license, a security or compliance blocker, a hard platform
incompatibility, or a cost (maintenance, operations, migration) large enough to cancel the gains
on the named criteria. Being relevant isn't enough. Label it as added and say what it does to the
outcome.

Constraints already in the conversation (stack, budget, team size, licensing policy) apply in
every scope. Don't re-ask them.

## 2. Research

Ground claims before arguing them. Check the repo for how the options would fit: existing
dependencies, patterns, versions. Look up facts that the argument rests on and that may have
changed: licenses, maintenance status, benchmarks, deprecations. Use web search when available
and the fact is time-sensitive. Mark anything unverified as such; don't present it as fact.

## 3. Argue

For each option, build its strongest honest case (steelman it), then the strongest rebuttal from
the other options. One round of case and rebuttal per option; add a second round only where a
rebuttal has a substantive answer.

- Argue on the criteria from step 1, in the context from step 1. Generic pros and cons that
  ignore the user's situation don't count.
- Each point is concrete: a mechanism, number, or source, not "more scalable" or "better DX".
- Don't invent a balance. If one option is clearly worse, say so; its section can be short.

## 4. Report

Reply in chat in this shape:

```markdown
**Question:** <the question as framed, with scope; note any added options or criteria>

### <Option A>
**Case:** <strongest arguments, bullets>
**Rebuttal:** <strongest counterarguments, bullets>

### <Option B>
…

### Comparison
| Criterion | A | B |
| --- | --- | --- |

### Verdict
<Which option wins, under which conditions, and what would change the answer. If it is a
genuine tie, say what fact or decision breaks it.>
```

Omit the comparison table when there's only 1 criterion. Keep the report to what the decision
needs: the arguments, not a survey. Don't implement the winner or edit files; the debate ends at
the verdict.
