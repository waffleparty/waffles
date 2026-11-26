import type { Register } from 'claude-code'

import { adapterContext } from './adapter'
import { registerCheckpoint } from './checkpoint'
import { devServersItem, registerDevServers, startDevServers } from './dev-servers'
import { completeEffort, effortLabel, registerEffort, startEffort, submitEffort } from './effort'
import { completeMode, endMode, interactionMode, modeContext, MODES_SECTION, registerMode, startMode, submitMode, wafflesMode } from './mode'
import { completePlan, endPlan, registerPlan, startPlan, submitPlan } from './plan'
import { RULES, planContext } from './plan-prompt'
import { footerItem, registerPlanUi } from './plan-ui'
import { isRunning, registerUnattended, submitUnattended } from './unattended'

const RUN = '#f97316'
const IDLE = '#6495ed'
const BACKLOG = '#a855f7'
const RAPID = '#7fff00'

export const register: Register = on => {
  registerEffort(on)
  registerUnattended(on)
  registerMode(on)
  registerPlan(on)
  registerPlanUi(on)
  registerCheckpoint(on)
  registerDevServers(on)

  // The validator allows one unmatched hook per event per module, so the prompt.submit,
  // prompt.compose, prompt.context, session.start, session.end and turn.complete hooks below call
  // each module in turn.
  on('prompt.submit', async ($, e, next) => {
    submitEffort(e)
    // Read before the prompt starts or ends a run, so the model is told of the change.
    const before = await wafflesMode($)
    await submitUnattended($, e)
    submitPlan($, e)
    return next(await submitMode($, e, before))
  })

  // Sections with the same bytes in every request, so the prompt cache holds.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { ...r, sections: [...r.sections, MODES_SECTION, RULES] }
  })

  // Sent once, when the conversation holds no copy: its first request, after a compaction or /clear.
  // A plan outline that can't be read leaves its block out, not the first message. A repo that names a
  // backlog adapter gets a block that asks for the waffles initialization check.
  on('prompt.context', async ($, e, next) => {
    const blocks = [...e.blocks, { name: 'wafflesMode', text: await modeContext($) }]
    const outline = await planContext($).catch(() => '')
    if (outline) blocks.push({ name: 'planOutline', text: outline })
    const adapter = await adapterContext($)
    if (adapter) blocks.push({ name: 'backlogAdapter', text: adapter })
    return next({ ...e, blocks })
  })

  // The mode resets first, and a plan outline failure never stops the session's end.
  on('session.end', async ($, e, next) => {
    await endMode($, e)
    await endPlan($, e).catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await completeEffort($)
      await completeMode($)
    } else await completePlan($, e.agentId)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await startEffort($)
    await startMode($)
    // A plan outline that fails to start leaves the dev-server poll to start.
    await startPlan($).catch(() => undefined)
    await startDevServers($)
    return next(e)
  })

  // The footer's right end: the interaction mode (or an active run), the engine's modes, the dev servers' menu,
  // auto effort's state, then the plan outline's current step. The hint line on the left draws a plugin's tree on a
  // row below its own, so the run marker lives here.
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const isRun = await isRunning($)
    const mode = await interactionMode($)
    const servers = await devServersItem($, e)
    const effort = await effortLabel($)
    const { modes } = e.props
    const { Box, Text } = $.ui.resolve(e)
    // Each part with its text, which the plan outline item measures to fit the row.
    const shown = [
      isRun
        ? {
            text: '▶ non-interactive',
            part: (
              <Box>
                <Text color={RUN}>▶</Text>
                <Text dimColor> non-interactive</Text>
              </Box>
            ),
          }
        : {
            text: `● ${mode}`,
            part: (
              <Box>
                <Text color={mode === 'backlog' ? BACKLOG : mode === 'rapid' ? RAPID : IDLE}>●</Text>
                <Text dimColor> {mode}</Text>
              </Box>
            ),
          },
      modes.length > 0 ? { text: modes.join(' & '), part: <Text dimColor>{modes.join(' & ')}</Text> } : null,
      servers,
      effort ? { text: effort, part: <Text dimColor>{effort}</Text> } : null,
    ].filter(p => p !== null)
    const outline = await footerItem($, e, shown.map(p => p.text))
    const parts = [...shown.map(p => p.part), ...(outline ? [outline] : [])]
    return <Box>{parts.flatMap((part, i) => (i > 0 ? [<Text dimColor> · </Text>, part] : [part]))}</Box>
  })
}
