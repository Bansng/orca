import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeWorktree,
  runtimeOwnedRepoState,
  seedStore
} from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: true,
  callRuntimeRpc: vi.fn(async (..._args: unknown[]) => ({ ok: true, result: {} }))
}))

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const WORKTREE = 'repo1::/path/wt'
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const LEAF = '11111111-1111-4111-8111-111111111111'

function storeWithWorktree() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/wt' })] },
    groupsByWorktree: {
      [WORKTREE]: [{ id: 'group-1', worktreeId: WORKTREE, activeTabId: null, tabOrder: [] }]
    },
    activeGroupIdByWorktree: { [WORKTREE]: 'group-1' },
    unifiedTabsByWorktree: {}
  })
  return store
}

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.callRuntimeRpc.mockClear()
})

describe('createTab in a layout-owner build', () => {
  it('sends main the tab it drew, under its ids and in its group', () => {
    const store = storeWithWorktree()

    store.getState().createTab(WORKTREE, undefined, 'zsh', {
      id: TAB,
      initialLeafId: LEAF,
      startupCwd: '/path/wt/src',
      launchAgent: 'claude',
      viewMode: 'chat'
    })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'layout.apply', {
      command: {
        type: 'createTerminalTab',
        workspace: WORKTREE,
        tabId: TAB,
        leafId: LEAF,
        groupId: 'group-1',
        viewMode: 'chat',
        creation: {
          defaultTitle: 'Terminal 1',
          shellOverride: 'zsh',
          startupCwd: '/path/wt/src',
          launchAgent: 'claude'
        }
      }
    })
    // The window drew it first: its callers act on the tab at once.
    expect(store.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([TAB])
  })

  it('sends the leaf id the window named the first pane with when the caller gave none', () => {
    const store = storeWithWorktree()

    const tab = store.getState().createTab(WORKTREE)

    const leafId = store.getState().terminalLayoutsByTabId[tab.id]?.activeLeafId
    expect(leafId).toBeTruthy()
    expect(mocks.callRuntimeRpc.mock.calls[0]?.[2]).toMatchObject({
      command: { tabId: tab.id, leafId }
    })
  })

  it('leaves a paired server’s workspace to its mirror', () => {
    const store = createTestStore()
    const worktree = makeRuntimeOwnedWorktree({ id: WORKTREE, repoId: 'repo1' }, 'env-1')
    seedStore(
      store,
      runtimeOwnedRepoState('env-1', 'repo1', '/path', {
        worktreesByRepo: { repo1: [worktree] }
      })
    )

    store.getState().createTab(WORKTREE)

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sends nothing in a window-owned build', () => {
    mocks.layoutOwnerIsMain = false
    const store = storeWithWorktree()

    store.getState().createTab(WORKTREE)

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})
