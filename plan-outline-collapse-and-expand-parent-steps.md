---
goal: Plan outline: collapse and expand parent steps
status: open
current: 4.3.2
created: 2026-11-27T04:44:40.018Z
updated: 2026-11-27T06:16:31.179Z
---
- [x] 1 Settle the open design decisions
  - [x] 1.1 Disclosure glyph
  - [x] 1.2 Count indicator on a collapsed row
  - [x] 1.3 New steps versus all-closed in one turn
  - [x] 1.4 Toggle by hand
- [x] 2 Build collapse state, rendering, and turn rules
  - [x] 2.1 Collapse state in session state, with step aliases
  - [x] 2.2 Turn evaluation as a pure function
  - [x] 2.3 Gutter, glyph, and count in paneRows
  - [x] 2.4 Cut room for the count
  - [x] 2.5 Claude Code pane: draw and click
  - [x] 2.6 OpenCode panel: metadata, draw, and click
  - [x] 2.7 Run the turn evaluation at each turn boundary
- [x] 3 Update docs
  - [x] 3.1 docs/plan-outline.md
  - [x] 3.2 docs/opencode.md
- [ ] 4 Ship the pull request
  - [x] 4.2 Feature branch and draft pull request
  - [ ] 4.3 Review the branch
    - [x] 4.3.1 ⤷ Fix the 5 should-fix review findings
    - [ ] 4.3.2 ⤷ Fix the second review's findings
  - [ ] 4.4 CI green and pull request ready <!-- aliases=4.1,6 -->
- [x] 5 ⤷ Pause mark shows as text on iPad
  - [x] 5.1 ? Pick the pause glyph from an iPad test page
  - [x] 5.2 ? Change the pause mark in code, tests, and docs
