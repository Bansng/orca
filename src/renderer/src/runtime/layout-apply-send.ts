// Store-free so store slices can send; `layout-owner-command` reads the store for other callers.
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import type { PaneSide } from '../../../shared/workspace-layout/terminal-pane-tree'
import type { LayoutEditorFile } from '../../../shared/workspace-layout/workspace-layout-model'
import type { EditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import type {
  GroupSide,
  LayoutApplyReply,
  LayoutCommandResult,
  LayoutRefusalCode
} from '../../../shared/workspace-layout/workspace-layout-command-types'

/** What a window sends `layout.apply`; main mints any new id but a browser or editor tab's. */
export type WindowLayoutCommand =
  | { type: 'splitPane'; tabId: string; leafId: string; direction: 'vertical' | 'horizontal' }
  | { type: 'closePane'; tabId: string; leafId: string }
  | { type: 'renamePane'; tabId: string; leafId: string; title: string | null }
  | { type: 'equalizePanes'; tabId: string }
  | { type: 'movePane'; tabId: string; leafId: string; targetLeafId: string; side: PaneSide }
  | { type: 'setPaneRatios'; tabId: string; root: TerminalPaneLayoutNode }
  | { type: 'moveTab'; tabId: string; toGroupId: string; index: number }
  | { type: 'splitGroup'; tabId: string; besideGroupId: string; direction: GroupSide }
  | { type: 'setGroupRatios'; groupLayout: TabGroupLayoutNode }
  | { type: 'closeTabs'; tabIds: [string]; recordClose?: 'user' | 'cleanup' }
  | { type: 'renameTab'; tabId: string; kind: 'custom'; title: string | null }
  | { type: 'setTabProps'; tabId: string; color?: string | null; isPinned?: boolean }
  | {
      type: 'movePaneToNewTab'
      tabId: string
      leafId: string
      groupId: string
      index?: number
      windowDetach: { ptyId: string | null }
    }
  | {
      type: 'openBrowserTab'
      tabId: string
      browserTabId: string
      pageId: string
      profileId: string | null
      sessionPartition: string | null
      groupId?: string
      afterTabId?: string
      index?: number
    }
  | { type: 'openBrowserPage' | 'closeBrowserPage'; browserTabId: string; pageId: string }
  | { type: 'replaceBrowserPage'; browserTabId: string; pageId: string; newPageId: string }
  | {
      type: 'setBrowserTabProfile'
      browserTabId: string
      profileId: string | null
      sessionPartition: string | null
    }
  | {
      type: 'openEditorTab'
      tabId: string
      fileId: string
      contentType: EditorTabContentType
      file?: LayoutEditorFile
      groupId?: string
      preview?: true
    }
  | { type: 'promotePreviewTab'; tabId: string }
  | {
      type: 'moveTabToWorkspace'
      toWorkspace: string
      tabs: { tabId: string; newTabId: string; newEntityId: string }[]
      groupId: string
      file?: LayoutEditorFile
    }
  | { type: 'sleep'; tabId: string; paneKeys: string[]; records: SleepingAgentSessionRecord[] }
  | { type: 'wake'; tabId: string; paneKeys: [string] }

export type LayoutApplyHandlers = {
  apply: (result: LayoutCommandResult) => void
  asToday: () => void
  refused?: (code: LayoutRefusalCode) => void
}

/**
 * A layout command in a layout-owner build: main applies it first, then `apply` shows main's
 * result. `asToday` runs instead when main cannot act on it: a paired server holds the tab
 * (#18202), a move's workspaces are in two partitions, main's copy lacks the workspace, tab, pane
 * or group, or the call threw. `refused` on any other refusal. False when a paired server owns the
 * workspace's layout; the caller acts as today.
 */
export function sendLayoutApply(
  state: Parameters<typeof getExplicitRuntimeEnvironmentIdForWorktree>[0],
  worktreeId: string,
  command: WindowLayoutCommand,
  handlers: LayoutApplyHandlers
): boolean {
  // Why: the same owner test that mirrors a workspace's tabs from a paired server; a focused
  // server must not claim a workspace whose row names no owner.
  if (getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)) {
    return false
  }
  void callRuntimeRpc<LayoutApplyReply>({ kind: 'local' }, 'layout.apply', {
    command: { ...command, workspace: worktreeId }
  })
    .then(
      (reply) => {
        if (reply.ok) {
          handlers.apply(reply.result)
        } else if (
          reply.code === 'host_not_owned' ||
          reply.code === 'other_partition' ||
          mainLacksTarget(reply.code)
        ) {
          // Why lacking: main's copy lags the window's here (the window still saves its own).
          handlers.asToday()
        } else {
          console.warn(`[layout-owner] ${command.type} refused:`, reply.code)
          handlers.refused?.(reply.code)
        }
      },
      (error: unknown) => {
        // Why as today: a thrown write is rolled back. An indeterminate disk write is not, and may
        // leave a pane main minted; accepted until main is the only writer.
        console.warn(`[layout-owner] ${command.type} failed:`, errorMessage(error))
        handlers.asToday()
      }
    )
    // A throwing handler is not a failed call; it must not run the fallback too.
    .catch((error: unknown) => {
      console.warn(`[layout-owner] ${command.type} handler threw:`, errorMessage(error))
    })
  return true
}

const keepWindowCopy = (): void => {}

/** Records a change the window already made; any answer leaves it, since the window's save carries it. */
export function recordLayoutApply(
  state: Parameters<typeof sendLayoutApply>[0],
  worktreeId: string,
  command: WindowLayoutCommand
): void {
  sendLayoutApply(state, worktreeId, command, { apply: keepWindowCopy, asToday: keepWindowCopy })
}

function mainLacksTarget(code: LayoutRefusalCode): boolean {
  return (
    code === 'workspace_not_found' ||
    code === 'tab_not_found' ||
    code === 'pane_not_found' ||
    code === 'group_not_found'
  )
}

function errorMessage(error: unknown): unknown {
  return error instanceof Error ? error.message : error
}
