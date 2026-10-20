// A frame that changes only its panes' terminal bindings shows without a workspace rebuild: the
// store's pane trees take the frame's bindings, and each tab's focused pane is resolved as the
// rebuild resolves it. Anything only a rebuild shows exactly falls back to one.

import { resolvePtyBoundActiveLeafId } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import type { AppState } from '@/store/types'
import { layoutContainsLeafId } from '../../../shared/workspace-layout/terminal-pane-tree'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import { isDrawnTabHeld } from './layout-owner-drawn-tab-holds'
import { isTabPaneTreeHeld } from './layout-owner-pane-intents'

type TerminalLayouts = AppState['terminalLayoutsByTabId']

function sharesATerminal(layout: PublishedWorkspaceLayout): boolean {
  const ptyIds = layout.tabs.flatMap((tab) =>
    (tab.terminal?.panes ?? []).flatMap((pane) => (pane.ptyId ? [pane.ptyId] : []))
  )
  return new Set(ptyIds).size !== ptyIds.length
}

/**
 * `layouts` with the frame's bindings shown, the same object when it already shows them. Null
 * when only a rebuild shows them as the rebuild would: a terminal two panes name (restore releases
 * one), a pane tree the store lacks or draws otherwise, or a tab the window's own command holds.
 */
export function terminalLayoutsWithFrameBindings(
  layouts: TerminalLayouts,
  workspace: string,
  frame: PublishedWorkspaceLayout
): TerminalLayouts | null {
  if (sharesATerminal(frame)) {
    return null
  }
  let next = layouts
  for (const tab of frame.tabs) {
    const panes = tab.terminal?.panes
    if (!panes) {
      continue
    }
    const current = layouts[tab.entityId]
    const bound = current?.ptyIdsByLeafId ?? {}
    if (panes.every((pane) => bound[pane.leafId] === pane.ptyId)) {
      continue
    }
    const leafIds = new Set(panes.map((pane) => pane.leafId))
    if (
      !current?.root ||
      panes.some((pane) => !layoutContainsLeafId(current.root, pane.leafId)) ||
      Object.keys(bound).some((leafId) => !leafIds.has(leafId)) ||
      isTabPaneTreeHeld(tab.entityId) ||
      isDrawnTabHeld(workspace, tab.id) ||
      isDrawnTabHeld(workspace, tab.entityId)
    ) {
      return null
    }
    const ptyIdsByLeafId = Object.fromEntries(
      panes.flatMap((pane) => (pane.ptyId ? [[pane.leafId, pane.ptyId]] : []))
    )
    const activeLeafId = resolvePtyBoundActiveLeafId({
      root: current.root,
      activeLeafId: current.activeLeafId,
      ptyIdsByLeafId
    })
    next = { ...next, [tab.entityId]: { ...current, ptyIdsByLeafId, activeLeafId } }
  }
  return next
}
