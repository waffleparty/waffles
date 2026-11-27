---
name: ux-review
description: Visual design review of a web app's UI — the screens touched by pending changes, or the pages named — with before/after mockups the user picks from in the review page, then building their picks. Use when the user asks for a UX, UI, design or visual review, says a UI looks bad, ugly or cluttered, passes the link of an earlier UX review to build from, or asks to re-run a review's analysis with another model or effort.
argument-hint: "[pages, routes or components | link to an earlier review | re-run <run-id> with <model/effort>]"
---

# UX review

Get the UI to where the user wants it in one round. The failure this skill exists to
prevent: a review that judges behaviour (bugs, stale copy, keyboard handling)
while the screens stay ugly. Visual clarity and polish come first. Functional
findings are collected on the side, compactly.

Never commit or push: the user decides when the built picks are committed.

## Pipeline

The review runs as a series of subagents. This session orchestrates: it starts
each agent, passes paths between them, asks the user what only they can decide,
publishes, and handles wake-ups. It does not do the planning, gathering or
analysis itself.

The pipeline needs subagents that take a model and an effort, messages to a
running subagent, and Claude's artifacts with their comments (the review page,
steps 8 to 10). The tools named below are Claude Code's: the Agent tool,
SendMessage, Artifact, and ArtifactComments. Where the platform's subagents
take no model or effort, start them as they are. Where it can't send a running
subagent a message, start a new planner with the run directory and that
step's brief. Where it has no artifacts, stop after step 7, give the user the
path of the analysis's `index.html`, and say that the review page needs
Claude Code.

| Step | Agent | Model / effort | Output in the run directory |
| --- | --- | --- | --- |
| 3. Plan | planner | `opus` / `high` | `plan.md`, `areas.json` |
| 4. Areas | this session asks the user | — | `areas.json` (confirmed) |
| 5. Gather | the planner writes the tasks; one agent per task, in parallel | `sonnet` / `low` | `tasks.json`, `gather/<task-id>/` |
| 6. Check | the same planner | `opus` / `high` | `selection.json` |
| 7. Analyse | one analyst for every confirmed area | the default config (below) unless the user names another | `analysis/<config>/` with `index.html` |

`<config>` is `<model>-<effort>`, for example `fable-high`. Analysis configs:
`fable/high`, `fable/xhigh`, `opus/high`, `opus/xhigh`. Pass them to the Agent
tool as `model` and `effort`; this skill names these levels on purpose. The
default config is `fable/high` when the Agent tool offers `fable`, else
`opus/high`: the strongest design model at `high`, since `xhigh` costs far more
without a visible gain. Any other config runs only when the user asks for it,
in the request or as a re-run.

**Theme.** Review the app's default light mode only, unless the user's request
names a theme or mode. Then review that one instead, or as well if they ask for
both.

Everything a later re-run needs is saved, so a re-run repeats only step 7.

**Who judges what.** The analyst forms the diagnosis by looking at the screens.
Nothing upstream may hand it conclusions: the planner maps the scope and the
jobs, and gatherers capture. A plan that lists problems or questions for the
analysis to answer turns the analyst into a checklist, and the review comes back
as coverage instead of judgment. Earlier passes are the exception: what the user
built or kept is their decision, and the analyst reads it after looking (step 7).

## 1. Scope

- **A re-run request** in chat: go to step 10.
- **An earlier review's link** as the argument: read the artifact's `picks.json`
  (Artifact `read` with `path: "picks.json"`) and the page, then go to step 11.
- **Pages, routes or components** as the argument: review those.
- **Otherwise:** the UI touched by pending changes: `git status`, `git diff HEAD`,
  and untracked files. If the tree is clean, use the branch's diff against the
  default branch.

If nothing in scope renders UI, say so and stop.

## 2. Run directory and app

1. Create `.ux-review/<run-id>/` at the repo root, with `<run-id>` as
   `YYYYMMDD-HHMM`. Add `.ux-review/` to `.git/info/exclude` if it isn't ignored
   already; don't edit the project's `.gitignore`. The run lives in the repo, not
   the scratchpad, so a later session can re-run it.
2. Write `run.json`: `{"runId", "createdAt", "scope": <the argument or the changed files>, "appUrl"}`.
3. Start the app, or reuse the one already running (the waffles dev-server skill). Do it
   here, once, so every agent shares one server instead of each starting its own.

## 3. Plan

Start the planner (Agent, `subagent_type: "general-purpose"`, `model: "opus"`,
`effort: "high"`). Keep its agent ID; steps 5 and 6 continue it. Brief it with
the run directory, `run.json`, and this:

- Map the scope to what a person sees: routes, drawers, dialogs, panels, and
  the states worth seeing (empty, many items, long values, selected, error).
  Pick states from fixtures, specs and code; don't enumerate every reachable one.
  Add sibling surfaces only where one shares a component or shell with a surface
  in scope.
- Identify the persona from the project's docs, specs or product copy: who uses
  these screens, the jobs they come to do, and the nouns they think in. If
  nothing states it, infer it from the product and mark it as an inference.
- List the project's design guidance by path: AGENTS.md / CLAUDE.md, DESIGN.md,
  the design system's own docs for agents if it ships any (in its repo or in the
  installed package), specs for these screens, decision records, and the design
  lab if there is one. List them; don't summarise them.
- List **earlier passes** by path: the analysis directories under other runs in
  `.ux-review/` that have an `outcome.json` and overlap this scope, newest
  first. List them; don't summarise them.
- Propose **areas**: 2–5 groups of surfaces, each built around one job the
  persona does ("pay an invoice", "find an order"), not
  around tabs or components. A surface can appear in two areas when two jobs use
  it. When the areas share chrome (a page header, a section shell, the type
  scale), add an area named "Across the page" for it; the other areas leave that
  chrome alone. Also propose one alternative partition, and say which areas to
  leave out if the scope is too broad for one round (more than about 4 areas or
  60 screenshots).
- Write `plan.md`: the surfaces and states, the persona and their jobs, the
  guidance paths, the earlier passes, and the areas. **No findings, problems,
  or questions for the analysis.** If you notice a bug or a contradiction while
  reading code or docs, write it as one line in `ledger-seeds.md`; it goes to
  the functional ledger only.
- Write `areas.json`:
  `{"proposed": [{"id", "name", "job", "surfaces": [...], "states": [...]}], "alternative": [...same shape...], "cut": "<which areas to leave out if needed, and why>"}`.
- Return only "done" and the area names.

## 4. Areas

Ask the user multiple-choice questions (`AskUserQuestion` on Claude Code), giving
each option a preview that lists the areas and their surfaces:

1. **Partition:** the proposed areas (recommended), the alternative, or "by
   page section" (one area per tab or panel).
2. **Areas to review now** (multiSelect): every area in the partition, with the
   planner's suggested cut as the recommendation when the scope is broad.

The user may answer with their own grouping in the notes; follow it. Write the result
to `areas.json` as `"confirmed": [...]`.

## 5. Gather

Continue the planner with a message to its ID (SendMessage on Claude Code) with
the confirmed areas. It writes `tasks.json`: an array of independent gathering tasks,
`{"id", "kind", "area", "brief", "output"}`. Each brief is self-contained and
mechanical, and its output is a path under `gather/<id>/`. Kinds:

- **screenshots**, one task per area: each surface and state in the area once,
  in the review's theme (see Theme above) at a desktop width (~1500), and at a
  narrow width (~1100) only where a layout reflows or wraps. Drawers and panels
  at full height, 1x scale (`deviceScaleFactor: 1`), with the project's
  screenshot tooling, or else Playwright. Write a `manifest.json` of files to
  surface, state and width. Aim for 10–25 captures per area.
- **tokens**, one task: the design system's CSS custom properties in the
  review's theme and the font stack, as `tokens.json`. Nothing per element.
- **content**, one task: realistic values for each surface from fixtures and
  types (names, IDs, counts, long values), so mockups use real content; and the
  entities, relationships and cardinality behind the surfaces, as `content.md`.

Gatherers record; they never judge or suggest. There is no up-front measurement
sweep: the analyst measures what it suspects, in the running app.

Start one agent per task, all in a single message so they run in parallel:
`subagent_type: "general-purpose"`, `model: "sonnet"`, `effort: "low"`. Each
brief is the task's `brief`, plus the app URL, the output path, and: "Write
only to your output path. Return one line: done, or what failed."

Wait for every one to finish. Don't relay results to the planner as they
arrive, and don't read their outputs yourself. If a task failed, start it again
with the same brief plus the last failure line. A task gets 5 attempts in all.
After the fifth failure, stop the review: don't start step 6, and don't work
around the gap. Tell the user which task failed, its output path, and each
attempt's failure line, then end the turn and wait for them.

## 6. Check

Continue the planner with: "All gathering is done. Outputs: <the list of task
IDs and paths>." If the planner is gone, start a new
planner (same model and effort) with the step 3 brief and tell it `plan.md`,
`areas.json` and `tasks.json` already exist.

The planner checks that each area's captures cover its surfaces and states
(recapturing a gap itself if it's small) and writes `selection.json`:

```json
{"config": "<default config>", "selectedAt": "<ISO timestamp>"}
```

The config is the default config (see Pipeline) unless the user's request named a
model or effort; then it's that. The planner doesn't revise `plan.md` with findings.

## 7. Analyse

Start one analyst for all the confirmed areas: `subagent_type:
"general-purpose"`, `model` and `effort` from `selection.json`. Its output
directory is `analysis/<config>/`. Brief it with the run directory, its output
directory, the app URL and how to drive a browser (the project's own browser
tooling, or else Playwright), and the paths to this skill's
`Analyst brief` section, `taste.md` and `review-page.html`. For a regenerate
(step 10), also give it the earlier review's analysis directory, which holds
its `index.html`, `review.json` and the submitted `picks.json`. It returns one
line: done and the page path, or what failed.

Each run reviews its areas on their own terms. Consistency across the whole
app is a lens for a later `/ux-review`, once the major issues are built, not a
step in this one.

### Analyst brief

You review every confirmed area in `areas.json`, each built around one job the
person does, and build the review page. Suggestions are grouped by area. Only
"Across the page" changes the shared chrome (page header, section shell, type
scale); in every other area's mockups, draw that chrome as it is today, so
each suggestion can be picked on its own.

Read `taste.md` before you look at any screen. You'll apply it twice: when you
diagnose, and again when you draw each "after" state.

Work in this order. The order is the point: you look and judge before you read
anything that could tell you what to think.

1. **Look.** Read every screenshot in each area's manifest yourself. Start from
   the persona's job in `plan.md`: what does the person come to this area to do,
   and does the screen make that the obvious thing?
2. **Earlier passes.** If `plan.md` lists earlier passes, read each one's
   `review.json` and `outcome.json`. A suggestion whose status is `built` or
   `kept` is resolved: the user built it or chose today's version. Don't raise the
   problems it fixed again. If a built one didn't land as drawn, that's one
   line in the ledger. What's left (`undecided` suggestions, `more` lines,
   problems no suggestion fixed) is where this pass starts: judge each against
   what you just saw, and drop any the screens no longer show.
3. **Diagnose.** Name the 2–4 visual problems that matter most in each area.
   Give each a short name and one sentence. Use these lenses:

   | Lens | Ask |
   | --- | --- |
   | Job | Does the layout put what this job needs first, and where the person will look for it? Is the main action where the job happens? |
   | Hierarchy | Is there a type scale with clear steps? Are labels quieter than values? Does the eye land on the right thing first? |
   | Rhythm | Is there one spacing rule between blocks? Do edges and baselines line up? |
   | Containment | Are there boxes in boxes, or cards and bordered tables inside a container? |
   | Fit | Does the content fit its real width, or does it wrap, truncate, clip or dangle? |
   | Noise | Are there labels, captions, chips or counts that don't earn their place? Are facts repeated? |
   | Consistency | Is the same concept drawn differently within the area, or here than elsewhere in the app ("status is a dot plus a word here and a chip everywhere else")? Do grouped controls look alike? |
   | Colour | Is colour only used for meaning? Is every colour a token? |

4. **Measure.** For each problem, measure it in the running app with a short
   browser script (`getComputedStyle`, `getBoundingClientRect`, contrast
   between surfaces): "titles start at 162, 187 and 177px", "card #282C2F on
   panel #25292B, 1.04:1". Measure what you suspect; don't sweep. A problem the
   numbers don't support goes. Save the numbers in `measure/` in your output
   directory.
5. **Read.** Now read `tokens.json`, `content.md`, and the guidance paths in
   `plan.md`. Guidance can confirm a problem, overrule it (the design system
   requires it), or settle which direction fits; it doesn't add problems.
   `content.md` gives you real values for the mockups. If the data model
   blocks a direction you want (a missing field, the wrong cardinality, data
   no screen shows), note it as a one-line model constraint.
6. **Suggest.** Make **at most 10 suggestions for the whole page**, usually
   6–10, ranked by impact on the job. Each fixes one or more of your named
   problems. Every confirmed area should get at least one; an area with no
   problem worth a suggestion says so in the overview. List the rest one line
   each under `more` in `review.json`.
7. **Next pass.** Decide whether another pass is advisable. It is when strong
   problems were left under `more` by the cap, when an area got no suggestion
   because of the cap, or when this round's suggestions change the layout
   enough that what's left can only be judged once they're built. It isn't when
   what's left is minor. Say which in one sentence.

Write each functional issue you notice along the way (behaviour, copy that
contradicts the product, accessibility) as one line in the ledger, and keep
going.

**Directions first.** Each suggestion has a Before and 2–3 After options. Start
by asking whether the structure is right, and lean towards options that are
different directions:

- A direction changes **structure**: where things live, what is shown or
  hidden, what is merged or split, which control does the job, which product
  pattern it follows. Moving the status and assignee controls up beside Report
  is a direction; the same strip with lighter labels is a treatment.
- If two options have the same elements in the same places, they're one
  direction. Unless refinement is the point (below), merge them and look for
  another.
- Each direction says which product it's modelled on (see `taste.md`).

Some problems are about refinement, not structure: the layout is right and the
question is the weight, spacing, density or tone. Then options that refine the
same layout in different ways are the right answer, and the suggestion says
so in its problem statement. Don't invent a structural change to fill a slot.

The other rules for options:
- **Include a minimal-change option** whenever today's version is mostly right:
  the same layout with only the specific fixes. The user sometimes keeps the before.
- **Keep plausible options you don't recommend,** especially compact ones, and
  say why you don't recommend them. The user picks them when compactness or
  consistency wins.
- **Say where the fix belongs:** in the app, in the design system (a token,
  component or guideline), in a candidate component built for porting back, or
  in the data model. A data-model option also gets an option that works within
  today's model.
- **Subjective continuous values** (blur, opacity, a gap, a radius): if the
  project has a design lab, add a control with a sensible range and step, and
  note it on the suggestion.

**Mockups** are high fidelity, not wireframes, and they should look better than
the before at a glance:

- They are drawn at the surface's true pixel width.
- They use the product's tokens and measured type.
- They use real copy and data from `content.md`, the app's font stack, and real
  icons as inline SVG.
- Before and after show the same content, so they compare directly.
- Every option in a suggestion is drawn at the same width as the before crop.
  Only a difference in content may change an option's height.
- Each should read as a finished screen of a well-made product:
  one type scale, one spacing rhythm, shared edges, nothing cramped. If an
  option looks worse than the before, fix it or drop it. Fewer finished
  mockups beat more rough ones.

Then check each mockup against the "Habits to strip" list in `taste.md`.

**Prose.** The suggestion's problem statement is one or two sentences. Each
option's note is at most 60 words: when it works, what it costs, what it's
modelled on, then a short "Fix:" clause saying where it lands. Name guidelines,
decisions and lab options in words. Code identifiers and file paths go only in
the "Fix:" clause and the ledger.

**Regenerating.** When you're given an earlier review with a submitted
`picks.json`, you redraw that review instead of starting over. Skip Look and
Diagnose; the earlier review's problems stand unless a note says otherwise.
Every piece of feedback is used:

- A suggestion with a note: redraw its options to answer the note, starting
  from the option that was picked. The picked option, revised, is the
  recommended one.
- A suggestion with no note: carry it over unchanged, with the picked option
  marked recommended.
- The overall notes apply across the page. They can add, drop, merge or
  re-rank suggestions; the cap of 10 still holds.

Measure again only what a redrawn option needs. In `review.json`, add
`"regeneratedFrom": "<earlier analysis directory>"` and `"feedback": [{"n",
"note", "handling"}]`, one entry per note including the overall notes. The
header says the page is a regenerated review and how many suggestions were
redrawn.

**Page.** Build it in your output directory:

1. Copy `review-page.html` to `index.html` and fill it in. Its comments say
   where everything goes.
2. **Order.** "Across the page" first, if there is one, then the areas in
   `areas.json`'s confirmed order, each area's suggestions in rank order.
   Number the suggestions 01, 02, … across the page.
3. **Header.** A two- or three-sentence summary: the verdict, the number of
   decisions, the analysis config, and whether another pass is advisable. On a
   later pass, also say how many earlier problems it carries forward.
4. **Overview.** The persona from `plan.md`; under "What's wrong visually",
   each area's problems under its name; the Areas list (name, job, decision
   numbers); then **More suggestions**, the `more` lines under their area
   names; model constraints if any; then the functional ledger: your lines and
   `ledger-seeds.md`, with exact duplicates removed.
5. Put your before crops in `shots/`. Write `picks.json` containing
   `{"status": "open"}`.
6. Write `review.json`: `{"verdict", "nextPass": {"advisable": true|false, "reason"}, "areas": [{"id", "name", "problems": [{"name", "evidence"}], "more": ["<one line each>"]}], "suggestions": [{"n", "area", "title", "fixes": ["<problem names>"]}], "modelConstraints": [...], "ledger": [{"severity", "text", "where"}]}`.
   A later pass reads it with the build's `outcome.json`.
7. **Check once.** Render the finished page in a browser at 1440 wide,
   screenshot each suggestion slide, and Read the screenshots. Fix a mockup
   that overflows, comes out at the wrong scale next to its crop, has an empty
   frame, or looks worse than its before. Re-render only the slides you
   changed. Don't render options one by one while drawing. Locally the picker
   says "open on claude.ai"; that is expected.
8. Don't publish. Return one line: done and the page path, or what failed.

## 8. Publish

This session publishes, so the page's comments wake it. Publish the
analyst's `index.html` as a **new** artifact; don't overwrite an earlier
review, including one from the same run at another config. Pass
`capabilities: {artifact: {}, comments: {}}`, and pass `files` with `shots/*`
and `picks.json`. Record the artifact link in the analysis directory as
`artifact.json`.

In chat, give the link, the analysis config, the areas, the verdict, and
whether another pass is advisable (from `review.json`), in three or four lines.
Ask the user to pick in the page and press Submit. Then end the turn without
polling.

## 9. Wake-ups

Submit opens a dialog with the overall notes and the next step: Finalize
(build) or Regenerate. Its action saves `picks.json`, with the step in
`action`, then sends Claude a one-line comment from the page. That comment,
not the new version, is what wakes this session. A new version on its own
notifies no one. The comment arrives as an "auto-replied to comment thread"
notification, and Claude Code has already posted an acknowledgement in the
thread. Don't post another.

- **"UX review picks submitted…"** (`action: "build"`): go to step 11.
- **"UX review regenerate requested…"** (`action: "regenerate"`): go to step 10.

Either way, read the whole `picks.json` in that turn: every pick, every
suggestion's note, and the overall notes. None of it waits for a later turn.

The watch is single-use. Once `picks.json` is read for a submission, stop the
watch on that artifact: ArtifactComments `watch` with `url` and `on: false`.
A regenerate publishes a new artifact with its own watch (step 8), so the old
one isn't needed. Stopping the watch doesn't affect `read` or `resolve` on the
threads. If the user wants to submit again from the same page, they say
"submitted" or "regenerate" in chat.

If this session isn't watching the artifact, or the comment can't be sent, the
page tells the user to say "picks submitted" or "regenerate" in chat. Act on
that the same way.

In auto mode, the classifier declines comment wake-ups unless
`~/.claude/settings.json` allows `ArtifactComments`. The narrower
`Artifact(action:reply)` only takes effect where a server-side flag is on.
Without it the comment is still delivered, but no turn starts. In the chat
message with the link, tell the user: "If I don't pick it up within a minute,
say 'submitted' or 'regenerate' here."

## 10. Re-run or regenerate

A **re-run** repeats the analysis with another model or effort; the user asks
for it in chat ("re-run <run-id> with <config>"). A **regenerate** comes from
the page's Submit dialog and redraws the review from the picks and notes.

1. Find the run. For a re-run, use the run ID in the message, or the most
   recent run in `.ux-review/` and say which one. For a regenerate, use the run
   the page was published from (the analysis directory whose `artifact.json`
   names it).
2. Check that `.ux-review/<run-id>/` has `plan.md`, `areas.json`,
   `selection.json` and `gather/`. If the run directory is gone, say so and
   offer a fresh review.
3. For a re-run, append the request to `selection.json` as
   `"reruns": [{"config", "requestedAt"}]` and leave the original config as it
   is. For a regenerate, save the submitted `picks.json` (Artifact `read`,
   `path: "picks.json"`) into the earlier analysis directory; the config stays
   the same.
4. Run step 7, then step 8. Skip steps 3–6. A regenerate passes the earlier
   analysis directory to the analyst. If the output directory already exists,
   use the next free suffix (`-2`, `-3`, …); for a re-run, ask first whether to
   replace it instead.
5. `resolve` the comment thread that asked for it (ArtifactComments `read`
   lists them).

## 11. Build the picks

1. Read `picks.json` (Artifact `read`, `path: "picks.json"`). For each
   suggestion it has a `choice` (`before` means keep it as is) and `notes`, plus
   overall `notes`.
   - The artifact is private by default, so the picks are the user's. If the
     artifact has been shared with others who can edit, confirm the picks with
     the user in chat before building.
   - The notes override the mockup wherever they differ. The overall notes
     apply to every pick they touch.
   - If a note is ambiguous, ask about that one suggestion and build the rest.
   - A suggestion missing from `picks` is undecided: leave it.
   - When the build is done, `resolve` every open submit thread
     (ArtifactComments `read` lists them). Reply only on a thread that has no
     acknowledgement yet, for example when the user said "submitted" in chat.
2. Build systemic picks first (type scale, shared shell or components), then
   each surface.
3. Use design-system components and tokens. Follow the project's convention for
   custom components (for example a `candidates/` folder meant for porting back).
4. Roll each pick out to every surface it applies to, not only the one that was
   cropped.
5. How you check the result (screenshots, tests, checks) is up to the project's
   conventions and its other skills.
6. Write `outcome.json` in the review's analysis directory, so a later pass
   skips what's resolved:
   `{"builtAt", "artifact", "suggestions": [{"n", "title", "choice", "status": "built"|"kept"|"undecided"}]}`.
   `kept` is a `before` choice; `undecided` is a suggestion missing from
   `picks`.
7. Report what was built for each pick, how each note was applied (the
   overall notes included), and anything that differs from its mockup and why. If the review said another pass is advisable, say so and
   offer to run it.

## Common mistakes

| Mistake | Instead |
| --- | --- |
| Leading with bugs, copy and accessibility | Visual problems first; functional findings go in the ledger |
| A plan that lists problems or questions for the analysis | The plan maps surfaces, jobs and areas; the analyst finds the problems |
| Reviewing tab by tab | Group surfaces by the job the person does; confirm the areas with the user |
| Capturing every state, theme and width | Each state once, in the default light mode, narrow only where it reflows |
| Measuring everything up front | Look first, then measure what you suspect |
| Reading guidance, code or earlier passes before looking | Look, then earlier passes, diagnose, measure, then read |
| Letting a gathering agent judge or suggest | Gatherers record; the analyst looks at every screenshot |
| Doing the planning, gathering or analysis in this session | Start the agent for that step at its model and effort |
| One analyst per area, or a separate assembler | One analyst reviews every area and builds the page |
| Analysing at `xhigh` by default | The default config unless the user names another |
| Feeding gathering results to the planner one by one | Wait for all of them, then send one message |
| Retrying a failed gatherer without limit, or carrying on past a gap | 5 attempts per task, then stop and report to the user |
| Re-running planning or gathering for a re-run | Reuse the run directory; repeat only step 7 |
| Overwriting an earlier review's artifact | Publish every analysis as a new artifact |
| Raising a problem an earlier pass resolved | Skip what was built or kept; start from what's left |
| Generic mockups in made-up colours | Product tokens, measured type, true width, real content |
| Options that only restyle one layout when the structure is the problem | Directions that move, merge or remove things, plus a minimal-change option |
| Mockups that look worse than the before | Fix or drop them at the page check |
| Rendering every option while drawing | Render the finished page once; re-render only the slides you changed |
| Dropping a compact option because it's not your favourite | Show it and say why you don't recommend it |
| More than 10 suggestions | Rank them; the rest go under More suggestions, and the header says whether another pass is advisable |
| Keeping a weak suggestion to fill out an area | One line under More suggestions |
| Silently dropping findings past the cap | List them one line each under More suggestions |
| Reconciling consistency across the app in the same run | Leave it to a later review's Consistency lens |
| Notes full of decision IDs and code identifiers | Plain words; identifiers only in "Fix:" and the ledger |
| Mockups that add captions, chips or legends | Strip them using the list in `taste.md` |
| Fixing only the cropped surface | Roll each pick out to every sibling surface |
| Reviewing every theme by default | The default light mode, unless the user names one |
