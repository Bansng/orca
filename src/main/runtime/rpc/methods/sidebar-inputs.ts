import { defineMethod } from '../core'
import { getRegisteredSshState, listRegisteredSshTargets } from '../../../ssh/ssh-target-registry'
import { getWslHostService } from '../../../wsl/wsl-host-service-instance'
import { readDesktopSidebarFacts } from '../../sidebar-inputs/desktop-sidebar-facts'

// Registered only with ORCA_SIDEBAR_INPUTS=main, so the producers below always exist.
function requireSwitchedOn<Producer>(producer: Producer | null): Producer {
  if (producer === null) {
    throw new Error('sidebar inputs are off in this build')
  }
  return producer
}

export const SIDEBAR_INPUT_METHODS = [
  defineMethod({
    name: 'sidebarInputs.activityFacts',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) =>
      requireSwitchedOn(runtime.sidebarFacts).getWorkspaceActivityFacts()
  }),
  defineMethod({
    name: 'sidebarInputs.desktopFacts',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) =>
      readDesktopSidebarFacts({
        store: runtime.requireStore(),
        sshTargets: listRegisteredSshTargets(),
        sshStateOf: getRegisteredSshState,
        wslStatuses: getWslHostService()?.getStatuses() ?? []
      })
  }),
  defineMethod({
    name: 'sidebarInputs.pairedServerRows',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => requireSwitchedOn(runtime.pairedServerRows).snapshot()
  }),
  defineMethod({
    name: 'sidebarInputs.reviewFacts',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) =>
      requireSwitchedOn(runtime.sidebarFacts).getWorkspaceReviewFacts()
  })
]
