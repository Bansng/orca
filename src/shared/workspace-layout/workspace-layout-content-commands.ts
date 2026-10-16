// Opening editor, browser and agent-session tabs: the tab and its content record in one apply.

import type { EditorTabView } from '../editor-tab-view-types'
import { applied, refuse, workspaceOrEmpty, type Applied } from './workspace-layout-command-steps'
import type { CommandOf, LayoutContext } from './workspace-layout-command-types'
import { admitsInitialSurface } from './workspace-layout-initial-surface'
import type { LayoutContentTab, LayoutTab, WorkspaceLayoutModel } from './workspace-layout-model'
import { withWorkspace } from './workspace-layout-removal'
import { placeContentTab, promotePreviewTab } from './workspace-layout-tab-commands'

function contentTab(
  context: LayoutContext,
  fields: Pick<LayoutContentTab, 'kind' | 'entityId'> & Partial<LayoutContentTab>
): LayoutContentTab {
  return {
    id: context.mintId(),
    createdAt: context.now(),
    customTitle: null,
    color: null,
    ...fields
  }
}

/**
 * An open tab for the same file in the target group is returned instead of a second one; a
 * non-preview open pins it. Another group's tab for the file does not count: a file opened in a
 * second split gets its own tab there, as the window does.
 */
export function openEditorTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openEditorTab'>,
  context: LayoutContext
): Applied {
  const key = command.workspace
  const workspace = model.workspaces[key]
  const sameFile = (tab: LayoutTab): boolean =>
    tab.entityId === command.fileId && tab.kind === command.contentType
  if (command.tabId) {
    // The same open again (a tab this window drew, then sent twice or saved first) changes nothing.
    const drawn = workspace?.tabs.find((tab) => tab.id === command.tabId)
    if (drawn && sameFile(drawn)) {
      return applied(model, { tabId: drawn.id })
    }
    const holds = Object.values(model.workspaces).some((entry) =>
      entry.tabs.some((tab) => tab.id === command.tabId)
    )
    if (holds) {
      return refuse('tab_exists')
    }
  }
  let target = model
  if (command.groupId && !workspace?.groups.some((entry) => entry.id === command.groupId)) {
    if (workspace?.groups.length) {
      // Another group would put the tab where its sender did not.
      return refuse('group_not_found')
    }
    // A workspace with no group takes the sender's, as the window keeps its emptied root group.
    target = withWorkspace(model, key, {
      ...workspaceOrEmpty(model, key),
      groups: [{ id: command.groupId, tabOrder: [] }]
    })
  }
  const group =
    target.workspaces[key]?.groups.find((entry) => entry.id === command.groupId) ??
    target.workspaces[key]?.groups[0]
  const existing = workspace?.tabs.find(
    (tab) => sameFile(tab) && group?.tabOrder.includes(tab.id) === true
  )
  if (existing) {
    const pinned =
      existing.isPreview && !command.preview
        ? promotePreviewTab(model, {
            type: 'promotePreviewTab',
            workspace: key,
            tabId: existing.id
          })
        : applied(model)
    const next = pinned.ok ? pinned.model : model
    return applied(withEditorView(next, key, existing.id, command.view), { tabId: existing.id })
  }
  const tab = contentTab(context, {
    ...(command.tabId ? { id: command.tabId } : {}),
    kind: command.contentType,
    entityId: command.fileId,
    ...(command.preview ? { isPreview: true } : {})
  })
  const placed = placeContentTab(target, key, tab, command, context)
  let next = placed.model
  const file = command.file
  if (file) {
    const workspace = next.workspaces[key]!
    const files = (workspace.editorFiles ?? []).filter((entry) => entry.filePath !== file.filePath)
    next = withWorkspace(next, key, { ...workspace, editorFiles: [...files, file] })
  }
  return applied(withEditorView(next, key, tab.id, command.view), {
    tabId: tab.id,
    refused: placed.refused
  })
}

function withEditorView(
  model: WorkspaceLayoutModel,
  key: string,
  tabId: string,
  view: EditorTabView | undefined
): WorkspaceLayoutModel {
  if (!view) {
    return model
  }
  const workspace = model.workspaces[key]!
  return withWorkspace(model, key, {
    ...workspace,
    editorViews: { ...workspace.editorViews, [tabId]: view }
  })
}

export function openBrowserTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openBrowserTab'>,
  context: LayoutContext
): Applied {
  const key = command.workspace
  // A host's tab is named by its page; a window names its tab-bar entry and record itself.
  const browserTabId = command.browserTabId ?? command.pageId ?? context.mintId()
  const tabId = command.tabId ?? browserTabId
  const pageId = command.pageId ?? context.mintId()
  // Only a window's open names its record; a host's is checked against its saved pages first.
  const taken = command.browserTabId
    ? takenBrowserTabIds(model, key, { tabId, browserTabId, pageId })
    : null
  if (taken) {
    return taken
  }
  const tab = contentTab(context, {
    kind: 'browser',
    id: tabId,
    entityId: browserTabId
  })
  const next = placeContentTab(model, key, tab, command, context).model
  const workspace = next.workspaces[key]!
  const browserTab = {
    id: browserTabId,
    sessionProfileId: command.profileId ?? null,
    ...(command.sessionPartition ? { sessionPartition: command.sessionPartition } : {}),
    pageIds: [pageId],
    createdAt: tab.createdAt
  }
  return applied(
    withWorkspace(next, key, {
      ...workspace,
      browserTabs: [...(workspace.browserTabs ?? []), browserTab]
    }),
    { tabId: tab.id, pageId }
  )
}

/**
 * The same open again (a window's create resent) changes nothing; an id another tab or page holds
 * refuses it. Null when every id is free.
 */
function takenBrowserTabIds(
  model: WorkspaceLayoutModel,
  key: string,
  ids: { tabId: string; browserTabId: string; pageId: string }
): Applied | null {
  const own = model.workspaces[key]
  const record = own?.browserTabs?.find((entry) => entry.id === ids.browserTabId)
  if (
    record?.pageIds?.includes(ids.pageId) &&
    own?.tabs.some((tab) => tab.id === ids.tabId && tab.entityId === ids.browserTabId)
  ) {
    return applied(model, { tabId: ids.tabId, pageId: ids.pageId })
  }
  const workspaces = Object.values(model.workspaces)
  if (
    workspaces.some((workspace) =>
      workspace.tabs.some((tab) =>
        [tab.id, tab.entityId].some((id) => id === ids.tabId || id === ids.browserTabId)
      )
    )
  ) {
    return refuse('tab_exists')
  }
  return holdsBrowserPage(model, ids.pageId) ? refuse('page_exists') : null
}

export function holdsBrowserPage(model: WorkspaceLayoutModel, pageId: string): boolean {
  return Object.values(model.workspaces).some((workspace) =>
    workspace.browserTabs?.some((entry) => entry.pageIds?.includes(pageId))
  )
}

export function openAgentSessionTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openAgentSessionTab'>,
  context: LayoutContext
): Applied {
  if (command.initial && !admitsInitialSurface(model, command.workspace, command.initial)) {
    return applied(model)
  }
  const tab = contentTab(context, {
    ...(command.tabId ? { id: command.tabId } : {}),
    kind: 'agent-session',
    entityId: command.sessionId,
    agentSessionAgent: command.agent
  })
  return applied(placeContentTab(model, command.workspace, tab, command, context).model, {
    tabId: tab.id
  })
}
