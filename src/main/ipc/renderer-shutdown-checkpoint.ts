import { ipcMain } from 'electron'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { Store } from '../persistence'
import { isFrozenOrcadSourceSessionPartition } from '../ssh/orcad-retained-source'
import { windowSaveForMain } from '../persistence/window-save-pane-trees'
import { writeWindowSaveWatchingLayout } from '../persistence/window-save-divergence'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'

type StageBeforeUnloadSyncArgs = {
  sessions: { state: WorkspaceSessionState; hostId?: ExecutionHostId }[]
  ui: Partial<PersistedUIState>
}

export type ShutdownCheckpointResult = { ok: boolean }

/** Matches the will-quit teardown budget so a stalled disk can't strand a restart. */
export const SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS = 20_000

function flushStagedStateWithDeadline(store: Store): Promise<ShutdownCheckpointResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<ShutdownCheckpointResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      console.error('[app] Timed out persisting staged renderer state')
      resolve({ ok: false })
    }, SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS)
  })
  // Why not drain to stable: Store retries a superseded staged write without
  // chasing unrelated live mutations, which the deadline would otherwise cut off.
  const flush = store
    .flushPendingOrThrowAsync({ signal: controller.signal, drainToStableGeneration: false })
    .then((): ShutdownCheckpointResult => ({ ok: true }))
    .catch((error): ShutdownCheckpointResult => {
      console.error('[app] Failed to persist staged renderer state:', error)
      return { ok: false }
    })
  return Promise.race([flush, deadline]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

export function registerRendererShutdownCheckpointHandler(store: Store): void {
  // Why: beforeunload cannot await, so the sync reply only reports staging.
  // Durability is joined out-of-band by paths that are about to navigate.
  let pendingCheckpoint: Promise<ShutdownCheckpointResult> = Promise.resolve({ ok: true })

  ipcMain.on('app:stage-before-unload-sync', (event, args: StageBeforeUnloadSyncArgs) => {
    let ok = true
    try {
      for (const { state, hostId } of args.sessions) {
        if (!isFrozenOrcadSourceSessionPartition(store, hostId)) {
          // Switch point: main keeps its own pane trees over the window's, and reports any layout
          // the save still changes.
          const stage = (): void =>
            store.stageWorkspaceSessionBeforeUnload(
              ORCA_LAYOUT_OWNER_IS_MAIN
                ? windowSaveForMain(store.getWorkspaceSession(hostId), state, hostId)
                : state,
              hostId
            )
          if (ORCA_LAYOUT_OWNER_IS_MAIN) {
            writeWindowSaveWatchingLayout(
              () => store.getWorkspaceSession(hostId),
              hostId,
              stage,
              'shutdown-checkpoint'
            )
          } else {
            stage()
          }
        }
      }
      store.updateUI(args.ui)
    } catch (error) {
      console.error('[app] Failed to stage renderer state before unload:', error)
      ok = false
    }
    pendingCheckpoint = ok ? flushStagedStateWithDeadline(store) : Promise.resolve({ ok: false })
    event.returnValue = { ok }
  })

  ipcMain.handle(
    'app:await-before-unload-checkpoint',
    (): Promise<ShutdownCheckpointResult> => pendingCheckpoint
  )
}
