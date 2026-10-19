import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { defineSidebarShadowDomain } from './sidebar-shadow-comparison'
import { windowUnreadDecisions as windowDecisions } from './window-unread-decisions'

// The workspace unread flag: what the window's own rule decided, next to the flag the owning host
// holds (the records this store lists). Only flags either side moved since the check first saw the
// workspace are compared, so flags restored at startup are no one's decision. A clear from any
// client (a phone opening it, a read on another window) reaches every window, so it resets this
// window's decision too; only a raise is the host's call.

function storeFlags(state: AppState): Map<string, boolean> {
  const flags = new Map<string, boolean>()
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    for (const worktree of worktrees) {
      flags.set(worktree.id, worktree.isUnread)
    }
  }
  for (const folder of state.folderWorkspaces) {
    const key = folderWorkspaceKey(folder.id)
    flags.set(key, (flags.get(key) ?? false) || folder.isUnread)
  }
  return flags
}

const firstSeen = new Map<string, boolean>()
const lastSeen = new Map<string, boolean>()

export const workspaceUnreadShadow = defineSidebarShadowDomain<boolean>({
  name: 'workspace-unread',
  readMain: async () => {
    const current = storeFlags(useAppStore.getState())
    for (const [workspaceId, flag] of current) {
      if (!firstSeen.has(workspaceId)) {
        firstSeen.set(workspaceId, flag)
      }
      if (lastSeen.get(workspaceId) === true && !flag) {
        windowDecisions.set(workspaceId, false)
      }
      lastSeen.set(workspaceId, flag)
    }
    const values = new Map<string, boolean>()
    for (const [workspaceId, flag] of current) {
      if (windowDecisions.has(workspaceId) || firstSeen.get(workspaceId) !== flag) {
        values.set(workspaceId, flag)
      }
    }
    return { values }
  },
  readWindow: (main) => {
    const values = new Map<string, boolean>()
    for (const workspaceId of main.values.keys()) {
      values.set(
        workspaceId,
        windowDecisions.get(workspaceId) ?? firstSeen.get(workspaceId) ?? false
      )
    }
    return values
  },
  equals: (window, main) => (window ?? false) === (main ?? false)
})
