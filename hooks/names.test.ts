import { expect, test } from 'claude-code/testing'

import { NAMES } from './host'
import { MODES_SECTION } from './mode'

// core/names.spec.ts pins the texts that these names give byte for byte, with a copy of them: Node.js
// can't load this module, which imports the engine. This test keeps the copy true.
test("Claude Code's names are the ones the core's texts are pinned with", () => {
  expect({ ...NAMES, skill: undefined, command: undefined }).toEqual({
    assistant: 'Claude',
    product: 'Claude Code',
    planTool: 'mcp__waffles__plan',
    ask: 'AskUserQuestion',
    planMode: "Claude Code's plan mode",
    skill: undefined,
    runCommand: '/waffles:non-interactive',
    command: undefined,
  })
  for (const skill of ['backlog', 'commit-prep', 'init-check', 'non-interactive']) expect(NAMES.skill?.(skill)).toBe(`waffles:${skill}`)
  for (const command of ['prod', 'rapid', 'backlog-entry']) expect(NAMES.command?.(command)).toBe(`/${command}`)
})

test("the modes' system prompt section names Claude Code's commands and skills", () => {
  expect(MODES_SECTION.text).toContain(
    '- non-interactive (a /waffles:non-interactive run): the person is away. The rules of the waffles:non-interactive skill apply.',
  )
  expect(MODES_SECTION.text).toContain('- backlog (/backlog-entry): each prompt the person types is a backlog entry, not a request. Its full text goes verbatim to the waffles:backlog skill')
})
