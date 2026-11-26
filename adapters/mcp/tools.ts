import { TOOLS } from '../../core/tools.ts'
import { toolOf, type Module } from './registry.ts'

/** The core's tools (core/tools.ts), every one: a tool added to the core's list is offered here with no change. */
export const toolsModule: Module = {
  name: 'tools',
  tools: TOOLS.map(toolOf),
}
