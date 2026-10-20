import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as WorkspaceSessionModule from '@/lib/workspace-session'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { localDesktopSession } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import {
  GIT_KEY,
  leaf
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import type { LayoutFrameSlices } from '../store/workspace-layout-frame-slices'
import { endLayoutFramePositions } from './layout-frame-position'
import { holdTabPaneTree } from './layout-owner-pane-intents'
import { holdDrawnTabs } from './layout-owner-drawn-tab-holds'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
// The rebuild reads the window's session back first: a call means a workspace rebuild ran.
vi.mock('@/lib/workspace-session', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceSessionModule>()
  return { ...actual, buildWorkspaceSessionPayload: vi.fn(actual.buildWorkspaceSessionPayload) }
})

const stream = vi.hoisted(
  (): { onFrame: ((frame: WorkspaceLayoutChangeFrame) => void) | null } => ({ onFrame: null })
)
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (
    _target: unknown,
    _params: unknown,
    onFrame: (frame: WorkspaceLayoutChangeFrame) => void
  ) => {
    stream.onFrame = onFrame
    return { close: () => {} }
  }
}))

createStoreSessionMockApi()

const SLICES: (keyof LayoutFrameSlices)[] = [
  'tabsByWorktree',
  'terminalLayoutsByTabId',
  'activeTabIdByWorktree',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'activeGroupIdByWorktree',
  'layoutByWorktree',
  'openFiles',
  'activeFileIdByWorktree',
  'browserTabsByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeTabTypeByWorktree'
]

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function publishedOf(session: WorkspaceSessionState): PublishedWorkspaceLayout {
  const { layout } = loadWorkspaceLayoutWithoutReport('local', session, nameBasedLoadContext())
  return publishWorkspaceLayout(layout.workspaces[GIT_KEY]!, 'local')
}

/** The frame with one pane's terminal binding changed; absent `ptyId` unbinds it. */
function rebound(
  layout: PublishedWorkspaceLayout,
  tabId: string,
  leafId: string,
  ptyId: string | undefined
): PublishedWorkspaceLayout {
  const next = structuredClone(layout)
  const pane = next.tabs
    .find((tab) => tab.entityId === tabId)!
    .terminal!.panes.find((candidate) => candidate.leafId === leafId)!
  if (ptyId === undefined) {
    delete pane.ptyId
  } else {
    pane.ptyId = ptyId
  }
  return next
}

/** Boots a window shown from the session's frame; each later frame arrives as main sends it. */
async function boot() {
  const store = createTestStore()
  const session = localDesktopSession()
  await bootWindowFromPartitions(store, [{ hostId: 'local', session }])
  const sync = openWorkspaceLayoutFrameSync(store)
  const first = publishedOf(session)
  stream.onFrame!({ type: 'snapshot', workspaces: [{ key: GIT_KEY, layout: first }] })
  sync.start()
  await settle()
  vi.mocked(buildWorkspaceSessionPayload).mockClear()
  const send = async (layout: PublishedWorkspaceLayout, asSnapshot = false): Promise<void> => {
    stream.onFrame!(
      asSnapshot
        ? { type: 'snapshot', workspaces: [{ key: GIT_KEY, layout }] }
        : { type: 'workspace', key: GIT_KEY, layout }
    )
    await settle()
  }
  return { store, sync, first, send }
}

/** What a rebuild shows for these frames: a second snapshot redraws every workspace. */
async function rebuiltState(frames: PublishedWorkspaceLayout[]) {
  const { store, sync, send } = await boot()
  for (const frame of frames) {
    await send(frame, true)
  }
  sync.close()
  return store.getState()
}

const slicesOf = (state: Record<string, unknown>) =>
  Object.fromEntries(SLICES.map((slice) => [slice, state[slice]]))

afterEach(() => endLayoutFramePositions())

describe('a frame that changes only panes’ terminal bindings', () => {
  // A respawn of a gone process: its pane is unbound, then bound again.
  it.each([
    ['unbinds a pane', [[leaf(1), undefined]]],
    [
      'unbinds then binds the same id again',
      [
        [leaf(1), undefined],
        [leaf(1), `${GIT_KEY}@@aaaa0001`]
      ]
    ],
    ['binds a new id', [[leaf(1), 'pty-fresh']]],
    ['unbinds the focused pane of a split', [[leaf(2), undefined]]]
  ] as const)('%s exactly as a rebuild shows it, without one', async (_, steps) => {
    const { store, sync, first, send } = await boot()
    const frames: PublishedWorkspaceLayout[] = []
    let frame = first
    for (const [leafId, ptyId] of steps) {
      frame = rebound(frame, 'tab-shell', leafId, ptyId)
      frames.push(frame)
      await send(frame)
    }
    const shown = store.getState()
    sync.close()

    expect(buildWorkspaceSessionPayload).not.toHaveBeenCalled()
    const rebuilt = await rebuiltState(frames)
    expect(buildWorkspaceSessionPayload).toHaveBeenCalled()
    expect(slicesOf(shown)).toEqual(slicesOf(rebuilt))
    // Presence: the binding the frame names is the store's.
    const [leafId, ptyId] = steps.at(-1)!
    expect(shown.terminalLayoutsByTabId['tab-shell']!.ptyIdsByLeafId?.[leafId]).toBe(ptyId)
  })

  it('writes nothing to the store when the store already shows those bindings', async () => {
    const { store, sync, first, send } = await boot()
    const layout = store.getState().terminalLayoutsByTabId['tab-shell']!
    store.setState({
      terminalLayoutsByTabId: {
        ...store.getState().terminalLayoutsByTabId,
        'tab-shell': {
          ...layout,
          ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [leaf(1)]: 'pty-fresh' }
        }
      }
    })
    const writes = vi.fn()
    const stop = store.subscribe(writes)

    await send(rebound(first, 'tab-shell', leaf(1), 'pty-fresh'))

    stop()
    expect(writes).not.toHaveBeenCalled()
    expect(buildWorkspaceSessionPayload).not.toHaveBeenCalled()
    sync.close()
  })

  it('keeps a tab the window’s own pane command holds as the store has it', async () => {
    const { store, sync, first, send } = await boot()
    const before = store.getState().terminalLayoutsByTabId['tab-shell']
    const release = holdTabPaneTree('tab-shell')

    await send(rebound(first, 'tab-shell', leaf(1), 'pty-fresh'))

    expect(store.getState().terminalLayoutsByTabId['tab-shell']).toBe(before)
    release()
    sync.close()
  })

  it('keeps a tab the window drew before main answered as the store has it', async () => {
    const { store, sync, first, send } = await boot()
    const before = store.getState().terminalLayoutsByTabId['tab-shell']
    const release = holdDrawnTabs([{ workspace: GIT_KEY, ids: ['tab-shell'] }])

    await send(rebound(first, 'tab-shell', leaf(1), 'pty-fresh'))

    expect(store.getState().terminalLayoutsByTabId['tab-shell']).toBe(before)
    release()
    sync.close()
  })

  it('still rebuilds a frame that also changes structure', async () => {
    const { store, sync, first, send } = await boot()
    const renamed = rebound(first, 'tab-shell', leaf(1), 'pty-fresh')
    renamed.tabs.find((tab) => tab.entityId === 'tab-shell')!.customTitle = 'renamed'

    await send(renamed)

    expect(buildWorkspaceSessionPayload).toHaveBeenCalled()
    expect(
      store.getState().tabsByWorktree[GIT_KEY]!.find((tab) => tab.id === 'tab-shell')
    ).toMatchObject({ customTitle: 'renamed' })
    sync.close()
  })
})
