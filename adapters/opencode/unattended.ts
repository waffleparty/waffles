import type { Host } from '../../core/host.ts'
import { CLOSED, NO_ANSWER, questionAsked, questionDone, questionFailed, START_ANSWER_MS } from '../../core/unattended.ts'

/** OpenCode's built-in tool the model asks the person a question with. */
export const QUESTION_TOOL = 'question'

type Context = { sessionID: string; signal: AbortSignal }
type Execute<C extends Context, R> = (input: any, context: C) => Promise<R>

/**
 * The question tool's executor with the unattended run's rules around it. Outside a run the question
 * goes through. During a run, the run's start question goes to the person for `answerMs`; every other
 * question is refused at once, so none waits all night. A refusal is thrown: the model reads it as
 * the call's error and goes on, where a dismissed question would end its turn.
 *
 * At the end of the wait the question's own signal is aborted, which takes the question off the
 * screen. `sessionOf` gives the session's host, and whether it is a subagent; null leaves the call alone.
 */
export function guardQuestion<C extends Context, R>(
  original: Execute<C, R>,
  sessionOf: (sessionID: string) => Promise<{ $: Host; isChild: boolean } | null>,
  answerMs = START_ANSWER_MS,
): Execute<C, R> {
  return async (input, context) => {
    const session = await sessionOf(context.sessionID).catch(() => null)
    if (!session) return original(input, context)
    let asked: Awaited<ReturnType<typeof questionAsked>>
    try {
      asked = await questionAsked(session.$, session.isChild)
    } catch {
      // A check that fails must not leave a question open all night: during a run, refuse.
      const deny = await questionFailed(session.$)
      if (deny === null) return original(input, context)
      throw new Error(deny)
    }
    if ('pass' in asked) return original(input, context)
    if ('deny' in asked) throw new Error(asked.deny)

    const stop = new AbortController()
    const onAbort = () => stop.abort()
    context.signal.addEventListener('abort', onAbort)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), answerMs)
    })
    try {
      const answer = await Promise.race([original(input, { ...context, signal: stop.signal }).catch(() => 'closed' as const), timeout])
      if (answer === 'timeout') {
        stop.abort()
        throw new Error(NO_ANSWER)
      }
      if (answer === 'closed') throw new Error(CLOSED)
      return answer
    } finally {
      clearTimeout(timer)
      context.signal.removeEventListener('abort', onAbort)
      await questionDone(session.$)
    }
  }
}
