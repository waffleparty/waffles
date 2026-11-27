// The waffles plugin's terminal UI part for OpenCode 2: the mode and the plan outline's current step in
// the footer under the prompt, the plan outline in a session panel (a click on a parent step's row
// collapses or expands it), and a command's line for the person as a toast. It draws only what the server
// part keeps in the session's metadata (see view.ts), so it works with a remote server too. OpenCode
// compiles this file; the type check and the tests cover view.ts.
import { Plugin } from '@opencode/plugin/tui'
import { createEffect, For, Show } from 'solid-js'

import { footerParts, noticeOf, outlineRows, PIECE_COLORS, PLAN_RPC, pressOptions, toggleOf } from './view.ts'

// The panel's name: OpenCode shares one panel between plugins, and each draws under its own name.
const PANEL = 'waffles.plan'
// The columns the panel's frame and padding take from its width.
const FRAME = 4

export default Plugin.define({
  id: 'waffles.tui',
  setup(context) {
    const metadata = (sessionID) => (sessionID ? context.data.session.get(sessionID)?.metadata : undefined)
    const muted = () => context.theme.text.muted
    // The sessions whose panel has opened by itself: a goal opens it once, and the person's close holds.
    const opened = new Set()
    // The sessions whose panel is open because a goal opened it, not the person.
    const unasked = new Set()

    // The footer item must not break onto a second row: it is one text element that neither wraps nor
    // shrinks, so the row gives way at the folder's name instead.
    const footer = context.ui.slot({
      append: 'prompt.footer.status',
      render: (input) => {
        const parts = () => footerParts(metadata(input.sessionID))
        return (
          <text wrapMode="none" flexShrink={0}>
            <span style={{ fg: parts().color }}>{parts().mark}</span>
            <span style={{ fg: muted() }}>{` ${parts().mode}${parts().step ? ` · ${parts().step}` : ''}`}</span>
          </text>
        )
      },
    })

    const styleOf = (piece) => ({
      fg: piece.isDim ? muted() : piece.color ? PIECE_COLORS[piece.color] : undefined,
      bold: piece.isBold === true,
      italic: piece.isItalic === true,
    })

    // A click on a parent step's row collapses or expands it: the server part changes the session's
    // collapsed steps, and the metadata it writes draws the panel again. The call goes to the session's
    // folder, whose server part holds the session.
    const plan = context.client.rpc(PLAN_RPC)
    const press = (sessionID, row) => {
      const id = toggleOf(row)
      if (!sessionID || id === undefined) return
      void plan.press({ sessionID, id }, pressOptions(context.data.session.get(sessionID))).catch(() => undefined)
    }

    const panel = context.ui.slot({
      append: 'session.panel',
      render: (input) => {
        const rows = () => outlineRows(metadata(input.sessionID), Math.max(20, input.width - FRAME))
        // A terminal too narrow for a side panel shows the panel over the chat. One that opened by itself
        // closes again there: the footer still names the current step, and /plan-outline opens it.
        createEffect(() => {
          if (input.name !== PANEL || !unasked.has(input.sessionID)) return
          if (input.presentation === 'fullscreen') {
            unasked.delete(input.sessionID)
            input.close()
          }
        })
        // The current step is brought into view when it is outside the rows shown: when the panel opens,
        // and when the step changes. A step already in view leaves the scroll position alone.
        let box
        const current = () => rows().findIndex((row) => row.some((piece) => piece.color === 'cyan'))
        createEffect(() => {
          const index = current()
          if (index < 0) return
          // After the rows are laid out, so the box knows its height.
          setTimeout(() => {
            if (!box) return
            const height = box.viewport?.height ?? box.height ?? 0
            const top = box.scrollTop ?? 0
            if (height > 0 && (index < top || index >= top + height)) box.scrollTo(Math.max(0, index - Math.floor(height / 2)))
          }, 50)
        })
        return (
          <Show when={input.name === PANEL}>
            <box flexDirection="column" paddingLeft={1} paddingRight={1} flexGrow={1} minHeight={0}>
              <text fg={muted()}>Plan outline</text>
              <Show when={rows().length > 0} fallback={<text fg={muted()}>No active goal.</text>}>
                {/* A goal can hold more steps than the terminal has rows: the rows scroll with the mouse wheel, and with the keys while the panel has the focus. */}
                <scrollbox ref={(el) => (box = el)} flexGrow={1} minHeight={0} focused={input.focused}>
                  <For each={rows()}>
                    {(row) => (
                      <text wrapMode="none" onMouseUp={() => press(input.sessionID, row)}>
                        <For each={row}>{(piece) => <span style={styleOf(piece)}>{piece.text}</span>}</For>
                      </text>
                    )}
                  </For>
                </scrollbox>
              </Show>
            </box>
          </Show>
        )
      },
    })

    // A goal that becomes active opens the panel, once per session; /plan-outline opens and closes it.
    // A command's line for the person shows as a toast, once: the one there when the session opens is old.
    const seen = new Map()
    const opener = context.ui.slot({
      append: 'session.composer.top',
      render: (input) => {
        createEffect(() => {
          const sessionID = input.sessionID
          if (!sessionID) return
          const notice = noticeOf(metadata(sessionID), seen.get(sessionID) ?? null)
          const isFirst = !seen.has(sessionID)
          if (isFirst) seen.set(sessionID, notice?.at ?? 0)
          if (!notice || isFirst) return
          seen.set(sessionID, notice.at)
          context.ui.toast.show({ message: notice.text })
        })
        createEffect(() => {
          const sessionID = input.sessionID
          if (!sessionID || opened.has(sessionID)) return
          if (outlineRows(metadata(sessionID), 40).length === 0) return
          opened.add(sessionID)
          if (context.ui.panel.current() !== undefined) return
          unasked.add(sessionID)
          context.ui.panel.open(PANEL, { presentation: 'panel' })
        })
        return null
      },
    })

    const command = context.ui.slot({
      append: 'app',
      render: () => {
        context.keymap.layer(() => ({
          mode: 'global',
          commands: [
            {
              id: 'waffles.plan',
              title: 'Plan outline: open or close',
              slash: { name: 'plan-outline' },
              run: () => {
                const current = context.ui.panel.current()
                if (current?.name === PANEL) return context.ui.panel.close()
                // Opened by the person, so it stays where the terminal is narrow too.
                if (current) unasked.delete(current.sessionID)
                context.ui.panel.open(PANEL, { presentation: 'panel' })
              },
            },
          ],
        }))
        return null
      },
    })

    return () => {
      for (const slot of [footer, panel, opener, command]) slot?.dispose?.()
    }
  },
})
