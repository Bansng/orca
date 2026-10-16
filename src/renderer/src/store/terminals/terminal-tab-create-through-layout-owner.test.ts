import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { LayoutApplyReply } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import { isWindowSessionWriteBusy } from '@/lib/window-session-write-activity'
import { createTestStore, makeTab } from '../slices/store-test-helpers'
import { createInitialTerminalThroughLayoutOwner } from './terminal-tab-create-through-layout-owner'

const mocks = vi.hoisted(() => {
  const held: {
    pairedServer: string | null
    reply: ((value: LayoutApplyReply) => void) | null
    fail: ((error: Error) => void) | null
  } = { pairedServer: null, reply: null, fail: null }
  return Object.assign(held, { callRuntimeRpc: vi.fn() })
})

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExplicitRuntimeEnvironmentIdForWorktree: () => mocks.pairedServer
}))

const WORKTREE = 'repo1::/path/wt'

function stateWith(tabIds: string[] = [], activeWorktreeId = WORKTREE): AppState {
  const store = createTestStore()
  store.setState({
    activeWorktreeId,
    tabsByWorktree: { [WORKTREE]: tabIds.map((id) => makeTab({ id, worktreeId: WORKTREE })) }
  })
  return store.getState()
}

function start(state: () => AppState = () => stateWith()) {
  const create = vi.fn()
  const routed = createInitialTerminalThroughLayoutOwner(state, WORKTREE, create)
  const command = mocks.callRuntimeRpc.mock.calls[0]?.[2]?.command
  return { create, routed, command }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  mocks.pairedServer = null
  mocks.callRuntimeRpc.mockReset()
  mocks.callRuntimeRpc.mockImplementation(
    () =>
      new Promise<LayoutApplyReply>((resolve, reject) => {
        mocks.reply = resolve
        mocks.fail = reject
      })
  )
})

describe('createInitialTerminalThroughLayoutOwner', () => {
  it('asks main for the first tab and draws main’s answer, holding frames meanwhile', async () => {
    const { create, routed, command } = start()

    expect(routed).toBe(true)
    expect(command).toMatchObject({
      type: 'createTerminalTab',
      workspace: WORKTREE,
      initial: 'activation'
    })
    expect(isWindowSessionWriteBusy()).toBe(true)
    mocks.reply?.({ ok: true, result: { tabId: command.tabId, leafId: command.leafId } })
    await settle()

    expect(create).toHaveBeenCalledWith({ tabId: command.tabId, leafId: command.leafId })
    expect(isWindowSessionWriteBusy()).toBe(false)
  })

  it('draws nothing when main’s copy already has a tab there', async () => {
    const { create } = start()

    mocks.reply?.({ ok: true, result: {} })
    await settle()

    expect(create).not.toHaveBeenCalled()
    expect(isWindowSessionWriteBusy()).toBe(false)
  })

  it('does not draw a tab twice when the window already shows it', async () => {
    let state = stateWith()
    const { create, command } = start(() => state)

    state = stateWith([command.tabId])
    mocks.reply?.({ ok: true, result: { tabId: command.tabId, leafId: command.leafId } })
    await settle()

    expect(create).not.toHaveBeenCalled()
  })

  it('opens the terminal as today when main holds no partition for the workspace, or fails', async () => {
    const unowned = start()
    mocks.reply?.({ ok: false, code: 'host_not_owned' })
    await settle()
    expect(unowned.create).toHaveBeenCalledWith()

    mocks.callRuntimeRpc.mockClear()
    const failed = start()
    mocks.fail?.(new Error('layout_store_unavailable'))
    await settle()
    expect(failed.create).toHaveBeenCalledWith()
    expect(isWindowSessionWriteBusy()).toBe(false)
  })

  it('opens nothing as today once the user has left the workspace', async () => {
    let state = stateWith()
    const { create } = start(() => state)

    state = stateWith([], 'repo1::/path/other')
    mocks.reply?.({ ok: false, code: 'host_not_owned' })
    await settle()

    expect(create).not.toHaveBeenCalled()
  })

  it('opens nothing as today once the workspace got a tab meanwhile', async () => {
    let state = stateWith()
    const { create } = start(() => state)

    state = stateWith(['tab-opened-meanwhile'])
    mocks.fail?.(new Error('layout_store_unavailable'))
    await settle()

    expect(create).not.toHaveBeenCalled()
  })

  it('leaves a paired server’s workspace to the caller', () => {
    mocks.pairedServer = 'env-1'

    const { routed } = start()

    expect(routed).toBe(false)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})
