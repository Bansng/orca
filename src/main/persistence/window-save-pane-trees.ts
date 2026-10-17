// A window's session save in a layout-owner build: every pane change reaches main as a layout
// command, so the save's pane trees (which panes a tab has, their shape and sizes) are dropped for
// tabs main holds, and main keeps its own. The rest of each pane layout stays the window's: which
// pane is focused or zoomed, its terminals and scrollback. A tab main does not hold yet keeps the
// window's tree, as does a paired server's partition: main applies no pane command there.

import { parseExecutionHostId } from '../../shared/execution-host'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'

function withStoredPaneTrees(
  stored: Readonly<Record<string, TerminalLayoutSnapshot>> | undefined,
  incoming: Record<string, TerminalLayoutSnapshot>
): Record<string, TerminalLayoutSnapshot> {
  let result = incoming
  for (const [tabId, layout] of Object.entries(incoming)) {
    const root = stored?.[tabId]?.root
    if (root && layout.root !== root) {
      result = result === incoming ? { ...incoming } : result
      result[tabId] = { ...layout, root }
    }
  }
  return result
}

/** The save main applies, in a layout-owner build (the IPC entries call it behind the switch). */
export function windowSaveForMain<T extends WorkspaceSessionState | WorkspaceSessionPatch>(
  stored: WorkspaceSessionState,
  save: T,
  hostId: string | null | undefined
): T {
  if (!save.terminalLayoutsByTabId || parseExecutionHostId(hostId)?.kind === 'runtime') {
    return save
  }
  const layouts = withStoredPaneTrees(stored.terminalLayoutsByTabId, save.terminalLayoutsByTabId)
  return layouts === save.terminalLayoutsByTabId
    ? save
    : { ...save, terminalLayoutsByTabId: layouts }
}
