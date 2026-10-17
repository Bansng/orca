// Simulator tabs in a layout-owner build. The window still draws the tab first (the emulator pane
// attaches to it by id); main records each open and close under the window's ids, so a window save
// no longer teaches main a simulator tab. Nothing to undo on any answer.

import type { Tab } from '../../../shared/tab-types'
import type { AppState } from '@/store/types'
import { recordLayoutApply } from '@/runtime/layout-apply-send'
import { newGroupSplitOf } from '@/runtime/layout-owner-new-group-split'

type SimulatorTabState = Parameters<typeof recordLayoutApply>[0] &
  Pick<AppState, 'groupsByWorktree' | 'layoutByWorktree'>

/** A simulator tab the window just drew, placed where the window drew it. */
export function recordOpenedSimulatorTabInLayoutOwner(state: SimulatorTabState, tab: Tab): void {
  if (tab.contentType !== 'simulator') {
    return
  }
  const order = state.groupsByWorktree[tab.worktreeId]?.find(
    (group) => group.id === tab.groupId
  )?.tabOrder
  const position = order?.indexOf(tab.id) ?? -1
  const afterTabId = position > 0 ? order?.[position - 1] : undefined
  recordLayoutApply(state, tab.worktreeId, {
    type: 'openSimulatorTab',
    tabId: tab.id,
    groupId: tab.groupId,
    ...(afterTabId ? { afterTabId } : position === 0 ? { index: 0 } : {}),
    createdAt: tab.createdAt,
    // Opened to the right: main makes the window's new split with the tab.
    ...newGroupSplitOf(state, tab.worktreeId, tab.groupId, tab.id)
  })
}

/** A simulator tab the window just closed. */
export function recordClosedSimulatorTabInLayoutOwner(
  state: SimulatorTabState,
  tab: Pick<Tab, 'id' | 'worktreeId' | 'contentType'>
): void {
  if (tab.contentType === 'simulator') {
    recordLayoutApply(state, tab.worktreeId, { type: 'closeTabs', tabIds: [tab.id] })
  }
}
