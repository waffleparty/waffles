import type { EngineInterface } from 'claude-code'

import { adapterContext as context, namedAdapter as named } from '../core/backlog-adapter.ts'
import { hostOf } from './host'

/** The skill the checkout names as its backlog adapter, and the file that names it; null when none does. */
export async function namedAdapter($: EngineInterface): Promise<{ skill: string; file: string } | null> {
  return named(hostOf($))
}

/** The first message's block in a checkout that names a backlog adapter; empty with none named. */
export async function adapterContext($: EngineInterface): Promise<string> {
  return context(hostOf($))
}
