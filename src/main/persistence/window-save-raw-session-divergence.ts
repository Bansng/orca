// What a window's save changes that main's layout model cannot show, read from the stored session
// itself: the Loader rebuilds a dropped terminal tab-bar entry from its row, places closed-tab
// records into whatever workspace a key names, and main keeps its own pane trees over the save's.
// Each finding is added to `paths` under its workspace.

import { stableJson } from '../../shared/workspace-layout/workspace-layout-load-report'
import type { WorkspaceLayoutModel } from '../../shared/workspace-layout/workspace-layout-model'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/** The report key of a pane tree whose tab no workspace names. */
const UNPLACED = '(no workspace)'

export type SavedPaneTrees = Readonly<Record<string, TerminalLayoutSnapshot>>

/** The terminal tabs (by entity id) each workspace's stored tab bar names. */
export function terminalTabBarEntries(session: WorkspaceSessionState): Map<string, Set<string>> {
  return new Map(
    Object.entries(session.unifiedTabs ?? {}).map(([workspace, entries]) => [
      workspace,
      new Set(
        entries.flatMap((entry) => (entry.contentType === 'terminal' ? [entry.entityId] : []))
      )
    ])
  )
}

function addPath(paths: Map<string, string[]>, workspace: string, path: string): void {
  paths.set(workspace, [...(paths.get(workspace) ?? []), path])
}

/**
 * A tab-bar entry the save dropped from a tab bar it still writes, while the row stays: the Loader
 * rebuilds that entry from the row, so main's model shows no change.
 */
export function droppedTabBarEntries(
  wasEntries: ReadonlyMap<string, ReadonlySet<string>>,
  now: WorkspaceSessionState | null | undefined,
  paths: Map<string, string[]>
): void {
  const nowEntries = now ? terminalTabBarEntries(now) : new Map<string, Set<string>>()
  for (const [workspace, entities] of wasEntries) {
    const kept = nowEntries.get(workspace)
    // No tab bar at all: a save that predates main's first frame for the workspace.
    if (!kept) {
      continue
    }
    const rows = new Set((now?.tabsByWorktree?.[workspace] ?? []).map((row) => row.id))
    for (const entityId of entities) {
      if (!kept.has(entityId) && rows.has(entityId)) {
        addPath(paths, workspace, `terminal ${entityId} tab-bar entry removed`)
      }
    }
  }
}

/**
 * The save's pane trees that differ from main's: main keeps its own for every tab it has one for
 * (windowSaveForMain), so each is reported under the workspace whose tab or row names it.
 */
export function overriddenPaneTrees(
  stored: WorkspaceSessionState | null | undefined,
  model: WorkspaceLayoutModel | null,
  saved: SavedPaneTrees,
  paths: Map<string, string[]>
): void {
  const homes = new Map<string, string>()
  for (const [workspace, rows] of Object.entries(stored?.tabsByWorktree ?? {})) {
    rows.forEach((row) => homes.set(row.id, workspace))
  }
  for (const [workspace, layout] of Object.entries(model?.workspaces ?? {})) {
    layout.tabs.forEach((tab) => homes.set(tab.entityId, workspace))
  }
  for (const [tabId, layout] of Object.entries(saved)) {
    const mains = stored?.terminalLayoutsByTabId?.[tabId]?.root
    if (mains && stableJson(mains) !== stableJson(layout.root ?? null)) {
      addPath(paths, homes.get(tabId) ?? UNPLACED, `pane tree ${tabId} kept over the save’s`)
    }
  }
}

type PartitionCopy = {
  model: WorkspaceLayoutModel | null
  closed: WorkspaceSessionState['closedTerminalTabTombstonesByTabId']
}

/**
 * Closed-tab records of a workspace only one copy has: the model diff cannot tell a record the
 * Loader just placed there (already stored, unplaced) from one the save added or dropped.
 */
export function closedTabsOfOneSidedWorkspaces(
  was: PartitionCopy,
  now: PartitionCopy,
  paths: Map<string, string[]>
): void {
  const oneSided = (from: PartitionCopy, other: PartitionCopy, change: string) => {
    for (const [workspace, layout] of Object.entries(from.model?.workspaces ?? {})) {
      if (other.model?.workspaces[workspace]) {
        continue
      }
      for (const tabId of Object.keys(layout.closedTerminalTabs ?? {})) {
        if (other.closed?.[tabId]?.worktreeId !== layout.worktreeId) {
          addPath(paths, workspace, `closed tab ${tabId} ${change}`)
        }
      }
    }
  }
  oneSided(now, was, 'added')
  oneSided(was, now, 'removed')
}
