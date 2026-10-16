import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { withLayoutOwnerTabProps } from './tab-bar-layout-owner-props'

const mocks = vi.hoisted(
  (): {
    callRuntimeRpc: ReturnType<typeof vi.fn>
    ownerEnvironmentId: string | null
    unifiedTabsByWorktree: Record<string, Partial<Tab>[]>
  } => ({ callRuntimeRpc: vi.fn(), ownerEnvironmentId: null, unifiedTabsByWorktree: {} })
)

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ unifiedTabsByWorktree: mocks.unifiedTabsByWorktree }) }
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExplicitRuntimeEnvironmentIdForWorktree: () => mocks.ownerEnvironmentId
}))

const pinnedItem = { unifiedTabId: 'tab-editor', isPinned: true }

function windowActions() {
  return {
    setCustomTitle: vi.fn<(tabId: string, title: string | null) => void>(),
    setTabColor: vi.fn<(tabId: string, color: string | null) => void>(),
    togglePinned: vi.fn<(item: typeof pinnedItem) => void>()
  }
}

function wrap(today: ReturnType<typeof windowActions>) {
  return withLayoutOwnerTabProps(today, () => 'wt-1')
}

describe('withLayoutOwnerTabProps', () => {
  beforeEach(() => {
    mocks.callRuntimeRpc.mockReset()
    mocks.ownerEnvironmentId = null
    // A terminal whose tab-bar id differs from its terminal's id, and a chat addressed by its own.
    mocks.unifiedTabsByWorktree = {
      'wt-1': [
        { id: 'tab-term', entityId: 'term-1', contentType: 'terminal' },
        { id: 'tab-chat', entityId: 'session-1', contentType: 'agent-session' }
      ]
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('sends each property to main by tab-bar id, then the window shows the same change', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: {} })
    const today = windowActions()
    const actions = wrap(today)

    actions.setCustomTitle('term-1', 'Build')
    actions.setTabColor('tab-chat', '#f00')
    actions.togglePinned(pinnedItem)

    expect(mocks.callRuntimeRpc.mock.calls.map((call) => call[2])).toEqual([
      {
        command: {
          type: 'renameTab',
          tabId: 'tab-term',
          kind: 'custom',
          title: 'Build',
          workspace: 'wt-1'
        }
      },
      { command: { type: 'setTabProps', tabId: 'tab-chat', color: '#f00', workspace: 'wt-1' } },
      {
        command: { type: 'setTabProps', tabId: 'tab-editor', isPinned: false, workspace: 'wt-1' }
      }
    ])
    expect(today.setCustomTitle).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(today.togglePinned).toHaveBeenCalledWith(pinnedItem))
    expect(today.setCustomTitle).toHaveBeenCalledWith('term-1', 'Build')
    expect(today.setTabColor).toHaveBeenCalledWith('tab-chat', '#f00')
  })

  it('acts as today when main lacks the tab or the call fails', async () => {
    mocks.callRuntimeRpc
      .mockResolvedValueOnce({ ok: false, code: 'tab_not_found' })
      .mockRejectedValueOnce(new Error('closed'))
    const today = windowActions()
    const actions = wrap(today)

    actions.setCustomTitle('term-1', null)
    actions.setTabColor('term-1', null)

    await vi.waitFor(() => expect(today.setTabColor).toHaveBeenCalledWith('term-1', null))
    expect(today.setCustomTitle).toHaveBeenCalledWith('term-1', null)
  })

  it('leaves the window as it is when main refuses', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({ ok: false, code: 'invalid_params' })
    const today = windowActions()

    wrap(today).togglePinned(pinnedItem)

    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled())
    expect(today.togglePinned).not.toHaveBeenCalled()
  })

  it('acts as today at once for a paired server’s workspace or a tab the window cannot name', () => {
    const today = windowActions()
    const actions = wrap(today)

    actions.setCustomTitle('term-unknown', 'x')
    mocks.ownerEnvironmentId = 'env-1'
    actions.togglePinned(pinnedItem)

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(today.setCustomTitle).toHaveBeenCalledWith('term-unknown', 'x')
    expect(today.togglePinned).toHaveBeenCalledWith(pinnedItem)
  })
})
