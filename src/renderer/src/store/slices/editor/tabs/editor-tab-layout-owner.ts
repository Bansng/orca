// Editor tabs in a layout-owner build (phase C4). The window still draws an open or close first:
// `openFile` returns at once and its callers focus, reveal and reposition the tab by id. Main then
// records the tab under the window's ids, with the window's group, and replaces that group's
// preview by the same shared rule the window used. Main's copy reaches the window through frames.

import type { Tab } from '../../../../../../shared/tab-types'
import type { LayoutEditorFile } from '../../../../../../shared/workspace-layout/workspace-layout-model'
import { recordLayoutApply } from '@/runtime/layout-apply-send'
import { newGroupSplitOf } from '@/runtime/layout-owner-new-group-split'
import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import type { RestoredEditorOwnerResult } from '../types/restored-editor-owner'
import { isEditorTabContentType } from './editor-tab-content-type'

type EditorOwnerState = Parameters<typeof recordLayoutApply>[0] &
  Pick<AppState, 'openFiles' | 'unifiedTabsByWorktree' | 'groupsByWorktree' | 'layoutByWorktree'>

/** A new editor tab the window just drew. */
export function recordOpenedEditorTabInLayoutOwner(state: EditorOwnerState, tab: Tab): void {
  if (!isEditorTabContentType(tab.contentType)) {
    return
  }
  const file = state.openFiles.find(
    (candidate) => candidate.id === tab.entityId && candidate.worktreeId === tab.worktreeId
  )
  recordLayoutApply(state, tab.worktreeId, {
    type: 'openEditorTab',
    tabId: tab.id,
    fileId: tab.entityId,
    contentType: tab.contentType,
    groupId: tab.groupId,
    // Open to the side: main makes the window's new split with the tab.
    ...newGroupSplitOf(state, tab.worktreeId, tab.groupId, tab.id),
    ...(tab.isPreview ? { preview: true } : {}),
    // Only edit-mode files are restored after restart; the window saves no other.
    ...(file?.mode === 'edit' ? { file: restorableEditorFile(file) } : {})
  })
}

/** Preview tabs the window just made permanent (activation, an edit, a pin). */
export function recordPromotedEditorTabsInLayoutOwner(
  state: EditorOwnerState,
  tabs: readonly Pick<Tab, 'id' | 'worktreeId'>[]
): void {
  for (const tab of tabs) {
    recordLayoutApply(state, tab.worktreeId, { type: 'promotePreviewTab', tabId: tab.id })
  }
}

/** The preview tabs that show a file, which making the file permanent promotes. */
export function previewEditorTabsOf(
  tabsByWorktree: AppState['unifiedTabsByWorktree'],
  fileId: string,
  tabId?: string
): Tab[] {
  return Object.values(tabsByWorktree).flatMap((tabs) =>
    tabs.filter(
      (tab) =>
        tab.entityId === fileId &&
        tab.isPreview === true &&
        isEditorTabContentType(tab.contentType) &&
        (!tabId || tab.id === tabId)
    )
  )
}

/** An editor tab the window just closed. */
export function recordClosedEditorTabInLayoutOwner(
  state: EditorOwnerState,
  tab: Pick<Tab, 'id' | 'worktreeId' | 'contentType'>
): void {
  if (isEditorTabContentType(tab.contentType)) {
    recordLayoutApply(state, tab.worktreeId, { type: 'closeTabs', tabIds: [tab.id] })
  }
}

/** Where a reopened editor tab ended up once the window restored its old position. */
export function recordReopenedEditorTabPositionInLayoutOwner(
  state: EditorOwnerState,
  worktreeId: string,
  fileId: string,
  groupId: string | undefined
): void {
  const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) =>
      candidate.entityId === fileId &&
      isEditorTabContentType(candidate.contentType) &&
      (groupId === undefined || candidate.groupId === groupId)
  )
  const group = tab
    ? (state.groupsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === tab.groupId)
    : undefined
  const index = tab && group ? group.tabOrder.indexOf(tab.id) : -1
  if (tab && group && index !== -1) {
    recordLayoutApply(state, worktreeId, {
      type: 'moveTab',
      tabId: tab.id,
      toGroupId: group.id,
      index
    })
  }
}

/**
 * Restored editor tabs the window just moved to the workspace that owns their file (F42), read
 * off the store before and after the move. A host change within one workspace sends nothing: only
 * a paired server's tabs do that, and main does not own their layout.
 */
export function recordRestoredEditorMoveInLayoutOwner(
  before: EditorOwnerState,
  after: EditorOwnerState,
  sourceWorktreeId: string,
  result: RestoredEditorOwnerResult
): void {
  const file = result.ok
    ? after.openFiles.find((candidate) => candidate.id === result.fileId)
    : undefined
  const targetWorktreeId = file?.worktreeId
  if (!file || !targetWorktreeId || targetWorktreeId === sourceWorktreeId) {
    return
  }
  const editorTabs = (state: EditorOwnerState, worktreeId: string): Tab[] =>
    (state.unifiedTabsByWorktree[worktreeId] ?? []).filter((tab) =>
      isEditorTabContentType(tab.contentType)
    )
  const stayed = new Set(editorTabs(after, sourceWorktreeId).map((tab) => tab.id))
  const left = editorTabs(before, sourceWorktreeId).filter((tab) => !stayed.has(tab.id))
  const had = new Set(
    editorTabs(before, targetWorktreeId).map((tab) => `${tab.id}\0${tab.entityId}`)
  )
  // The window appends the moved tabs in their source order.
  const joined = editorTabs(after, targetWorktreeId).filter(
    (tab) => !had.has(`${tab.id}\0${tab.entityId}`)
  )
  const groupId = joined.at(-1)?.groupId
  if (!groupId || left.length !== joined.length) {
    return
  }
  recordLayoutApply(after, sourceWorktreeId, {
    type: 'moveTabToWorkspace',
    toWorkspace: targetWorktreeId,
    tabs: left.map((tab, index) => ({
      tabId: tab.id,
      newTabId: joined[index]!.id,
      newEntityId: joined[index]!.entityId
    })),
    groupId,
    ...(file.mode === 'edit' ? { file: restorableEditorFile(file) } : {})
  })
}

/** The fields the window's session save keeps for an edit-mode file. */
export function restorableEditorFile(file: OpenFile): LayoutEditorFile {
  return {
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: file.language,
    ...(file.runtimeEnvironmentId !== undefined
      ? { runtimeEnvironmentId: file.runtimeEnvironmentId }
      : {}),
    ...(file.externalSshTargetId ? { externalSshTargetId: file.externalSshTargetId } : {}),
    ...(file.readOnly === true ? { readOnly: true } : {}),
    ...(file.readOnly === true && file.liveTail === true ? { liveTail: true } : {})
  }
}
