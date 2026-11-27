import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { NAMES as ANTIGRAVITY } from '../adapters/command/antigravity.ts'
import { NAMES as CODEX } from '../adapters/command/codex.ts'
import { NAMES as CURSOR } from '../adapters/command/cursor.ts'
import { registryOf } from '../adapters/mcp/registry.ts'
import { NAMES as OPENCODE } from '../adapters/opencode/server.ts'
import { adapterContext } from './backlog-adapter.ts'
import type { Names } from './host.ts'
import { commandsOf, isModeNote, modesText, runBacklog, runProd, runRapid, submitMode, wafflesMode } from './modes.ts'
import { planRules } from './plan-prompt.ts'
import { fakeHost } from './testing.ts'
import { closed, noAnswer, permissionAsked, questionAsked, questionFailed, submitUnattended } from './unattended.ts'

// Claude Code's names, as hooks/host.ts has them: hooks/names.test.ts checks that they are the same.
// Node.js can't load the hooks module, which imports the engine.
const CLAUDE_CODE: Names = {
  assistant: 'Claude',
  product: 'Claude Code',
  planTool: 'mcp__waffles__plan',
  ask: 'AskUserQuestion',
  planMode: "Claude Code's plan mode",
  skill: name => `waffles:${name}`,
  runCommand: '/waffles:non-interactive',
  command: name => `/${name}`,
}

// The MCP server's names from the env of a platform's MCP config file.
async function mcpNames(file: string): Promise<Names> {
  const config = JSON.parse(await fs.readFile(join(import.meta.dirname, '..', file), 'utf8'))
  return registryOf([], config.mcpServers.waffles.env).names
}

const PLATFORMS: [string, Names][] = [
  ['OpenCode', OPENCODE],
  ['Codex', CODEX],
  ['Cursor', CURSOR],
  ['Antigravity', ANTIGRAVITY],
  ['an MCP client', registryOf([], {}).names],
]

const RUN = { isPerson: true, isTyped: true, command: 'non-interactive', isMeta: false, text: '' }

// The texts the model reads during a run: the refusals of a permission request (main, then a subagent),
// of a subagent's question and of the main conversation's question, and the answers to an unanswered start question.
async function runTexts(names: Names): Promise<string[]> {
  const $ = fakeHost({ names })
  await submitUnattended($, RUN)
  const texts = [await permissionAsked($, { isQuestion: false, isAgent: false }), await permissionAsked($, { isQuestion: false, isAgent: true })]
  const asked = await questionAsked($, true)
  texts.push('deny' in asked ? asked.deny : null, await questionFailed($), noAnswer(names), closed(names))
  return texts.map(text => text ?? '')
}

// The texts the modes give: the definitions, the command list, what each command prints, and the notes
// of backlog mode, rapid mode, the handover of rapid work, and a run's start.
async function modeTexts(names: Names): Promise<{ texts: string[]; notes: string[] }> {
  const $ = fakeHost({ names, run: argv => (argv[1] === 'rev-parse' ? { stdout: 'abc1234\n' } : { stdout: '' }) })
  const printed = [await runBacklog($), await runRapid($), (await runProd($)).text]
  await submitUnattended($, RUN)
  await submitMode($, RUN, 'production')
  const commands = commandsOf(names).map(c => c.description)
  return { texts: [modesText(names), planRules(names), ...commands, ...printed, ...$.notes], notes: $.notes }
}

const DEFINITIONS = `# waffles modes

The waffles plugin runs the session in one of four modes:

- production (/prod, the default): the person is present. Questions, approvals and plans for review go to them as usual, and work meets the usual standards: tests, checks, reviews and docs.
- rapid (/rapid): the person is iterating quickly to judge a change. The requested change is made directly and quickly. No tests, linters, type checks or reviews are written or run, and no time goes to docs or polish. Nothing is committed: changes stay in the working tree, so they can be kept or discarded. The reply says briefly what changed.
- backlog (/backlog-entry): each prompt the person types is a backlog entry, not a request. Its full text goes verbatim to the waffles:backlog skill as the skill's arguments, and the reply is only that skill's report. Slash commands run as usual.
- non-interactive (a /waffles:non-interactive run): the person is away. The rules of the waffles:non-interactive skill apply. The run lasts until the person types another prompt.

A line that starts "waffles mode:" states the current mode. One comes with the first message of the conversation, one after each change, and one beside each prompt typed in backlog mode. The most recent statement in the conversation is the current mode. It overrides instructions from any earlier mode, including those of a skill loaded in that mode.

In production mode and during a run, work with a plan outline on a feature branch is committed and pushed in this order. The plan outline is not in the working tree and is never committed. After the first commit, the branch is pushed, and the pull request is opened as a draft. Each step of the outline is one commit, made once the repo's checks pass. Commits stay local until a milestone (a top-level step done with all its child steps, or the last commit before review), and the branch is pushed then and whenever work stops short of one: the end of a session, the end of a run that does not finish, a handoff. No commit message holds a skip tag such as [skip ci]. Once the last commit is pushed, gh pr ready marks the pull request ready. The squash merge's commit body states the essence of the change in about 10 lines, then the pull request's link. The waffles:commit-prep skill states these rules in full.

Rapid work stays pending until production mode starts. The statement that starts production mode then names the rapid work and what comes before other work. Code is committed only once it meets standards: while rapid work is pending, nothing is committed in any mode, until the person picks what happens to it.

The mode describes the main conversation with the person. A subagent is exempt from it in every mode: it follows the brief from the agent that spawned it, and its questions and gaps go back to that agent as the brief asks.`

test("Claude Code's names give the modes' definitions and the command texts byte for byte as before", async () => {
  assert.equal(modesText(CLAUDE_CODE), DEFINITIONS)
  assert.deepEqual(commandsOf(CLAUDE_CODE), [
    { name: 'backlog-entry', description: 'Turn every prompt you type into backlog items, until /prod' },
    { name: 'prod', description: 'Return to production mode from /rapid, /backlog-entry or a run' },
    { name: 'rapid', description: 'Make changes quickly, without tests or commits, until /prod' },
  ])
  const { notes } = await modeTexts(CLAUDE_CODE)
  assert.equal(notes[0], "waffles mode: backlog. Each typed prompt goes verbatim to the waffles:backlog skill, and the reply is only that skill's report.")
  assert.match(notes[2]!, /Then the person is asked, with AskUserQuestion, which of three to do: .* Both defer options add one waffles:backlog item that lists/)
  assert.equal(
    notes[3],
    "waffles mode: non-interactive. A /waffles:non-interactive run has started: the person is away until they type a prompt, and the waffles:non-interactive skill's rules apply.",
  )
})

test("Claude Code's names give the run's texts byte for byte as before", async () => {
  assert.deepEqual(await runTexts(CLAUDE_CODE), [
    "Denied: The user is away during a /waffles:non-interactive run and can't approve this. Sending the same action again gets the same answer. Reach the goal another way if there is one. If there is none, leave the step to the user in the plan outline, with the exact command or step and this denial's text as the reason, and carry on with the rest of the work.",
    "Denied: The user is away during a /waffles:non-interactive run and can't approve this. Sending the same action again gets the same answer. Reach the goal another way if there is one. If there is none, report it in your result, with the exact command or step, and carry on with the rest of your piece.",
    "Denied: The user is away during a /waffles:non-interactive run and can't answer. Report the question in your result, and carry on with the rest of your piece.",
    "Denied: The user is away during a /waffles:non-interactive run and can't answer. A run asks 1 question, at its start. Make the decision yourself, note it on its step in the plan outline if it is worth checking, and keep going.",
    'No answer in 60 seconds. The user has stepped away. Take what the waffles:non-interactive skill says for no answer, and ask nothing else during this run.',
    'The question was closed without an answer. Take what the waffles:non-interactive skill says for no answer, and ask nothing else during this run.',
  ])
})

for (const [platform, names] of PLATFORMS) {
  test(`${platform}'s names give texts in its own forms`, async () => {
    const { texts, notes } = await modeTexts(names)
    const all = [...texts, ...(await runTexts(names)), await adapterContext(fakeHost({ names, files: { '/work/AGENTS.md': 'Backlog adapter: tracker\n' } }))]
    for (const text of all) {
      assert.doesNotMatch(text, /AskUserQuestion/)
      // Only a platform that names its skills `waffles:<skill>` reads that form.
      if (names.skill?.('backlog') !== 'waffles:backlog') assert.doesNotMatch(text, /waffles:[a-z]/)
    }
    assert.match(notes[2]!, new RegExp(`Then the person is asked, with ${names.ask}, which`))
    const run = names.runCommand === undefined ? 'run of the non-interactive skill' : `${names.runCommand} run`
    assert.ok(all.some(text => text.includes(`during a ${run} and`)))
    assert.ok(modesText(names).includes(`- non-interactive (a ${run}):`))
  })

  test(`the notes of a change of mode in ${platform}'s names are mode notes`, async () => {
    const { notes } = await modeTexts(names)
    for (const note of notes) assert.equal(isModeNote(names, note), true, note)
    assert.equal(isModeNote(names, 'waffles mode: backlog. Add the export.'), false)
  })
}

test("OpenCode's texts name a skill as its prompt does, and a run by @non-interactive", async () => {
  const { texts } = await modeTexts(OPENCODE)
  assert.ok(texts.every(text => !text.includes('/waffles:')))
  assert.match(modesText(OPENCODE), /- non-interactive \(a @non-interactive run\): the person is away\. The rules of the non-interactive skill apply\./)
  assert.match(planRules(OPENCODE), /"backlog 3\.4": the backlog skill writes the item/)
})

test("each platform's MCP config names the skills, the run and the question tool as its hooks do", async () => {
  for (const [file, hooks] of [
    ['mcp.json', CODEX],
    ['mcp_config.json', ANTIGRAVITY],
    ['adapters/command/cursor-mcp.json', CURSOR],
  ] as const) {
    const names = await mcpNames(file)
    assert.equal(names.skill?.('backlog'), hooks.skill?.('backlog'), file)
    assert.equal(names.runCommand, hooks.runCommand, file)
    assert.equal(names.ask, hooks.ask, file)
    assert.equal(modesText(names), modesText(hooks), file)
  }
})
