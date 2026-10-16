import { agentHookServer } from '../agent-hooks/server'
import { forgetFailedAgentLaunches } from '../agent-launch/agent-launch-pane-attachment'
import {
  terminalLeafMovePaneKeys,
  type TerminalLeafMoveRequest
} from '../../shared/terminal-leaf-move'
import type { OrcaRuntimeService } from './orca-runtime'

/** After a committed move of a pane into a new tab: agent-status and orchestration keys follow. */
export function rekeyMovedPaneOwners(
  runtime: Pick<OrcaRuntimeService, 'getExistingOrchestrationDb'> | undefined,
  /** `ptyId` is the terminal the committed move bound the pane to. */
  request: TerminalLeafMoveRequest
): void {
  const { from: fromPaneKey, to: toPaneKey } = terminalLeafMovePaneKeys(request)
  forgetFailedAgentLaunches(request.worktreeId, {
    kind: 'pane',
    tabId: request.sourceTabId,
    leafId: request.leafId
  })
  try {
    // The process keeps the pane key baked into its env, so status must alias old to new.
    agentHookServer.transferPaneAuthority(
      fromPaneKey,
      toPaneKey,
      request.ptyId ?? undefined,
      Date.now(),
      {
        authorityVerified: true
      }
    )
  } catch (error) {
    console.warn('[pty] moved pane kept its old agent-status key:', error)
  }
  try {
    runtime?.getExistingOrchestrationDb()?.rekeyWorkerTerminalResourcePaneKey({
      fromPaneKey,
      toPaneKey
    })
  } catch (error) {
    console.warn('[pty] moved pane kept its old orchestration resource key:', error)
  }
}
