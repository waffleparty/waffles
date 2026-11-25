# UI taste

Use this when you diagnose a screen and when you draw an "after" state. The project's
design system decides specific values (tokens, components, sizes). This file decides the
judgment calls the design system leaves open.

**Style north star: Linear.** Refined, tight type, quiet metadata, subtle contrast between
surfaces, nothing decorative. **Interaction north star: tools the user already knows.** Model a
new pattern on GitHub (reviews, PRs, reviewers), VS Code or Cursor (panes, status bar,
Problems, composer), Notion (table headers, icon-led entries), Google Drive (sources as
folders), or macOS settings rather than inventing one, and say which one you modelled.

## Content: less, and the right thing first

- The primary content is the star. Metadata, settings, counts and provenance come after it
  or behind a disclosure. Nobody opens a folder to be "bombarded with metrics and settings".
- Every label, caption, help line, legend, chip, count and banner must earn its place. Help
  text goes in a tooltip, a help bubble, or external docs, never inline.
- Show status only when something is wrong. No "all clear" or success lines. A warning links
  to the problem.
- Say each thing once: a count in one place, a value not echoed in its own breadcrumb trail,
  a drawer that adds depth instead of restating the table row it came from.
- Status is a colored dot or small icon plus one word, not a sentence. Two indicators that
  mean the same thing become one.
- Don't state what's implicit, don't restate the product name, no preamble.
- Don't show exhaustively (everyone who could review, every possible option). Show what
  happened or what is asked for.
- Progressive disclosure for depth: hover card, popover, collapsed section. Hide empty
  sections. When consolidating surfaces, keep their depth.

## Hierarchy: tone and size, not spacing alone

- A real type scale: the title is clearly the largest thing; section headings step down to
  body size and get weight, not size; labels and captions are smaller and in the quiet text
  token. Base text is about 14px; very little goes smaller.
- Labels quieter than values. Group headers quieter than what they group (date groups must
  not outshine their events). Secondary text slightly smaller than the content it annotates.
- One filled primary action; secondaries quiet. The main choice is the most prominent thing.
  Don't bury a feature under another button.
- Quiet secondary chrome must never look disabled.

## Layout and fit

- One spacing rule. Even rhythm between sections; a hairline or a gap marks where one ends.
- Exact alignment: one label column across a surface, baselines shared by chips and tab
  text, status dots centred in their column, table headers aligned with cells. When several
  things misalign, find the systemic cause and fix that.
- Keep related things together. Nothing justified to the far edge away from what it belongs
  to. Use spare width: lift a control into the title line instead of giving two buttons a
  full-width row.
- No boxes in boxes. A drawer or card is already a container: prefer hairlines and space
  over nested cards and bordered tables inside it.
- Content fits its real width: no clipped tables, no truncated key values, no dangling
  wrapped item. Wrap rather than truncate a value that matters.
- One level of scrolling. Empty states top-aligned. Stable chrome: nothing appears or
  vanishes between pages, no layout shift.
- Size controls to their content: inputs, not textareas, for short text; list rows, not
  cards with large delete icons.
- Relative sizes and viewport-scaled gutters, not pixel caps.

## Colour and surfaces

- Every colour comes from the theme (or is derived from a theme colour). No hex, no
  library defaults such as MUI blue.
- Colour carries meaning and is used sparingly. Red only when there is something to act on
  (non-zero, late, blocked). Grey for "just a note". Minor inline actions use the text
  colour, not the accent. Yellow is a real yellow, clearly apart from orange and red.
- Separate surfaces by contrast between them, not by shadows or outline strokes. No glows.
- Every theme the app has gets its own look, at least dark and light. Light mode is where
  accents turn too saturated and dark dialogs slip through.
- Interaction states in order: hover and ripple lighter than selected; highlight distinct
  from borders; the selected item obvious.

## Components and consistency

- Design-system components first; no hand-rolled controls or odd composites. If the design
  system can't do it, build a candidate component that can be ported back, and say so. Fix
  systemic problems in the design system, not per screen.
- The same concept looks the same everywhere: one component, one format, one word. The same
  job uses the same control.
- Grouped controls look alike at rest: use the control the most demanding member needs.
  Judge a row or group as one object, not control by control.
- One entry point per job.
- Field labels sit above the field, never floating or notched.
- Icons: outline, thin strokes (about 1.2 on a 24 grid), never emoji, used the same way on
  every surface. Icon-only only when the meaning is unambiguous; otherwise a text link.
- Tables: sortable and reorderable, hairline rows edge to edge, full-row highlight, a short
  header row, a rowspan instead of repeating a value on every row.
- Edit in place by default, with no view/edit switch; ask for a change description in a
  dialog on Save.
- A change shows the old value struck through, then the new one.
- Provisional things are dashed, not animated (animation reads as "in progress").
- Motion is a smooth ease with no overshoot, and only the moving element animates.

## Copy

- Short, precise, domain-accurate. Noun labels ("Scope"), not phrases ("What it rests on").
  Name the function, not an invented noun.
- One term per concept across the whole UI; title case for proper names.
- Never imply behaviour the product doesn't have.
- Plain, positive empty states ("No recent activity").
- Feeds read as events: "Priya approved CASE-5063".

## Habits to strip from every "after" state

These are agent defaults that reviewers keep removing. Check each mockup against this list before
you move on:

- an added caption, subtitle, helper line or legend
- chips or badges for things that are just values
- status written as a sentence
- a state, label or concept the spec doesn't have
- a card or bordered table inside a drawer, panel or card
- a hardcoded or library-default colour; accent used for decoration
- a fix that only works on the one screen you cropped
- generic dashboard styling: big-number stat tiles, gradients, emoji, ornament, motion for
  its own sake
