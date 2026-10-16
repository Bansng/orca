import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { recordLayoutApply } from '@/runtime/layout-apply-send'

/**
 * A layout-owner build's record of panes this window put to sleep and already stopped: main
 * records how each pane's agent resumes, one command per tab. The window decides (planner, user
 * sleep) and stops the terminals.
 */
export function recordPaneSleepThroughLayoutOwner(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string,
  records: Record<string, SleepingAgentSessionRecord>
): void {
  const recordsByTabId = new Map<string, SleepingAgentSessionRecord[]>()
  for (const record of Object.values(records)) {
    // A legacy pane key names no pane main holds.
    const tabId = parsePaneKey(record.paneKey)?.tabId
    if (tabId) {
      recordsByTabId.set(tabId, [...(recordsByTabId.get(tabId) ?? []), record])
    }
  }
  for (const [tabId, tabRecords] of recordsByTabId) {
    recordLayoutApply(state, worktreeId, {
      type: 'sleep',
      tabId,
      paneKeys: tabRecords.map((record) => record.paneKey),
      records: tabRecords
    })
  }
}

/** A layout-owner build's record of the one pane this window showed and resumed. */
export function recordPaneWakeThroughLayoutOwner(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string,
  paneKey: string
): void {
  const tabId = parsePaneKey(paneKey)?.tabId
  if (tabId) {
    recordLayoutApply(state, worktreeId, { type: 'wake', tabId, paneKeys: [paneKey] })
  }
}
