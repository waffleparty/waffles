// The waffles plugin's terminal UI part for OpenCode 2: the mode and the plan outline's current step in
// the footer under the prompt, and the plan outline in the sidebar. It draws only what the server part
// keeps in the session's metadata (see view.ts), so it works with a remote server too. OpenCode compiles
// this file; the type check and the tests cover view.ts.
import { Plugin } from '@opencode/plugin/tui'
import { For, Show } from 'solid-js'

import { footerParts, outlineLines } from './view.ts'

export default Plugin.define({
  id: 'waffles.tui',
  setup(context) {
    const metadata = (sessionID) => (sessionID ? context.data.session.get(sessionID)?.metadata : undefined)

    const footer = context.ui.slot({
      append: 'prompt.footer.status',
      render: (input) => {
        const parts = () => footerParts(metadata(input.sessionID))
        return (
          <box flexDirection="row">
            <text fg={parts().color}>{parts().mark}</text>
            <text fg={context.theme.text.muted}> {parts().mode}</text>
            <Show when={parts().step}>
              <text fg={context.theme.text.muted}> · {parts().step}</text>
            </Show>
          </box>
        )
      },
    })

    const sidebar = context.ui.slot({
      append: 'sidebar.content',
      render: (input) => {
        const lines = () => outlineLines(metadata(input.sessionID))
        return (
          <Show when={lines().length > 0}>
            <box flexDirection="column">
              <text fg={context.theme.text.muted}>Plan outline</text>
              <For each={lines()}>{(line) => <text>{line}</text>}</For>
            </box>
          </Show>
        )
      },
    })

    return () => {
      footer?.dispose?.()
      sidebar?.dispose?.()
    }
  },
})
