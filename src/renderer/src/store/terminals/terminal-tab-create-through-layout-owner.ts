// Terminal tab creates in a layout-owner build (phase C3). Main writes each tab under the ids the
// window drew it with, before any later command from this window names its pane, so a split of a
// just-created pane finds it. The window still draws first: its callers act on the tab at once
// (select, retitle, anchor, mount, launch). Main's copy reaches the window through layout frames.

import { createBrowserUuid } from '@/lib/browser-uuid'
import { holdLayoutFramesForWindowCommand } from '@/lib/window-session-write-activity'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type {
  CommandOf,
  LayoutApplyReply
} from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { AppState } from '../types'

/** What the window's `createTab` just drew, as main's create command. */
export function terminalTabCreateCommand(
  state: AppState,
  tab: TerminalTab
): CommandOf<'createTerminalTab'> & { tabId: string; leafId: string } {
  const root = state.terminalLayoutsByTabId[tab.id]?.root
  const entry = state.unifiedTabsByWorktree[tab.worktreeId]?.find(
    (candidate) => candidate.entityId === tab.id && candidate.contentType === 'terminal'
  )
  const creation = {
    defaultTitle: tab.defaultTitle ?? tab.title,
    ...(tab.shellOverride ? { shellOverride: tab.shellOverride } : {}),
    ...(tab.startupCwd ? { startupCwd: tab.startupCwd } : {}),
    ...(tab.forceHostRuntime ? { forceHostRuntime: true } : {}),
    ...(tab.launchAgent ? { launchAgent: tab.launchAgent } : {})
  }
  return {
    type: 'createTerminalTab',
    workspace: tab.worktreeId,
    tabId: tab.id,
    // createTab always lays out a single first pane.
    leafId: root?.type === 'leaf' ? root.leafId : '',
    // A group main lacks (the workspace's first, or a split made with the tab) falls back to
    // main's own placement until the window's save names it.
    ...(entry ? { groupId: entry.groupId } : {}),
    ...(entry?.viewMode ? { viewMode: entry.viewMode } : {}),
    creation
  }
}

/**
 * Sends a tab the window just drew to main. Nothing to undo on any answer: main holding the same
 * pane already, or a paired server or no partition holding the workspace, leaves the window's own
 * session save to carry the tab, as today.
 */
export function recordCreatedTerminalTabInLayoutOwner(
  state: AppState,
  command: CommandOf<'createTerminalTab'> & { tabId: string; leafId: string }
): void {
  // Why: a paired server mirrors this workspace's tabs; main does not own its layout.
  if (getExplicitRuntimeEnvironmentIdForWorktree(state, command.workspace)) {
    return
  }
  void callRuntimeRpc<LayoutApplyReply>({ kind: 'local' }, 'layout.apply', { command }).then(
    (reply) => {
      if (!reply.ok && reply.code !== 'host_not_owned') {
        console.warn('[layout-owner] createTerminalTab refused:', reply.code)
      }
    },
    (error: unknown) => {
      console.warn(
        '[layout-owner] createTerminalTab failed:',
        error instanceof Error ? error.message : error
      )
    }
  )
}

/**
 * A workspace's first terminal on activation (F23). Main creates it only into a workspace its copy
 * holds no tab of, so this window and the runtime asking at once still make one tab. The window
 * draws main's answer itself, under main's ids; frames wait meanwhile so they cannot draw it first
 * without the window's own facts (main gets its shell and cwd with the window's next save). False
 * when a paired server owns the workspace's layout. `create` with no ids opens the terminal as
 * today: main holds no partition for the workspace.
 */
export function createInitialTerminalThroughLayoutOwner(
  getState: () => AppState,
  worktreeId: string,
  create: (ids?: { tabId: string; leafId: string }) => void
): boolean {
  if (getExplicitRuntimeEnvironmentIdForWorktree(getState(), worktreeId)) {
    return false
  }
  const tabId = createBrowserUuid()
  const leafId = createBrowserUuid()
  // Today's create, only while the workspace is still shown and still empty, as before the await.
  const createAsToday = (): void => {
    const state = getState()
    if (state.activeWorktreeId === worktreeId && !state.tabsByWorktree[worktreeId]?.length) {
      create()
    }
  }
  const release = holdLayoutFramesForWindowCommand()
  void callRuntimeRpc<LayoutApplyReply>({ kind: 'local' }, 'layout.apply', {
    command: {
      type: 'createTerminalTab',
      workspace: worktreeId,
      tabId,
      leafId,
      initial: 'activation'
    }
  })
    .then(
      (reply) => {
        if (reply.ok) {
          // No tab id: main's copy already shows a tab here, which its frames bring.
          if (reply.result.tabId === tabId && !holdsTerminalTab(getState(), tabId)) {
            create({ tabId, leafId })
          }
        } else if (reply.code === 'host_not_owned') {
          createAsToday()
        } else {
          console.warn('[layout-owner] initial createTerminalTab refused:', reply.code)
        }
      },
      (error: unknown) => {
        // Why as today: a thrown write is rolled back, so main holds no such tab.
        console.warn(
          '[layout-owner] initial createTerminalTab failed:',
          error instanceof Error ? error.message : error
        )
        createAsToday()
      }
    )
    .catch((error: unknown) => {
      console.warn(
        '[layout-owner] initial terminal create threw:',
        error instanceof Error ? error.message : error
      )
    })
    .finally(release)
  return true
}

function holdsTerminalTab(state: AppState, tabId: string): boolean {
  return Object.values(state.tabsByWorktree).some((tabs) => tabs.some((tab) => tab.id === tabId))
}
