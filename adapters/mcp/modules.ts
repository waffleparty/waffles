import { modesModule } from './modes.ts'
import { planModule } from './plan.ts'
import type { Module } from './registry.ts'

/**
 * The modules the MCP server can offer, in the order their instructions, tools, prompts, and resources
 * are listed: the modes first, since the plan outline's rules refer to them.
 */
export const MODULES: readonly Module[] = [modesModule, planModule]

/**
 * The modules this process offers: every one, or those `WAFFLES_MCP_MODULES` names (comma-separated).
 * They keep the list's order whatever order the variable names them in, so the same names give the same
 * instructions. A name no module has is reported and passed over.
 */
export function chosenModules(env: NodeJS.ProcessEnv, log: (message: string) => void, modules: readonly Module[] = MODULES): Module[] {
  const listed = env.WAFFLES_MCP_MODULES?.trim()
  if (!listed) return [...modules]
  const names = listed
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
  for (const name of names) if (!modules.some(m => m.name === name)) log(`WAFFLES_MCP_MODULES names no module ${name}; the modules are ${modules.map(m => m.name).join(', ')}.`)
  return modules.filter(m => names.includes(m.name))
}
