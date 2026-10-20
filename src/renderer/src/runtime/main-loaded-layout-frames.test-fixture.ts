// Main's loaded layout as the frames its stream sends: what main publishes for a stored partition,
// so a switch-on test feeds the window the layout main holds instead of the window's own restore.

import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import type { WorkspaceLayoutModel } from '../../../shared/workspace-layout/workspace-layout-model'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'

/** The model main loads from one stored partition, with the ids it mints at load. */
export function loadMainLayoutModel(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState
): WorkspaceLayoutModel {
  return loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext()).layout
}

/** What main publishes for each workspace of a model, by workspace key. */
export function publishedLayoutsOf(
  model: WorkspaceLayoutModel
): Record<string, PublishedWorkspaceLayout> {
  return Object.fromEntries(
    Object.entries(model.workspaces).map(([key, workspace]) => [
      key,
      publishWorkspaceLayout(workspace, model.hostId)
    ])
  )
}

/** What main publishes for one stored partition, by workspace key. */
export function mainLoadedLayouts(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState
): Record<string, PublishedWorkspaceLayout> {
  return publishedLayoutsOf(loadMainLayoutModel(hostId, session))
}

/** The snapshot frame a stream opens with. */
export function layoutSnapshotFrame(
  layouts: Record<string, PublishedWorkspaceLayout>,
  seq?: number
): WorkspaceLayoutChangeFrame {
  return {
    type: 'snapshot',
    workspaces: Object.entries(layouts).map(([key, layout]) => ({ key, layout })),
    ...(seq === undefined ? {} : { seq })
  }
}
