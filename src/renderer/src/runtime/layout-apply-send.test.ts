import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'

const mocks = vi.hoisted(() => {
  const sent: { reply: LayoutApplyReply | Error } = { reply: { ok: true, result: {} } }
  const owner: { kind: 'resolved' | 'ambiguous' } = { kind: 'resolved' }
  return { sent, owner }
})
vi.mock('@/lib/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => null,
  runtimeEnvironmentIdForWorkspaceOwner: () =>
    mocks.owner.kind === 'resolved' ? { kind: 'resolved', environmentId: null } : mocks.owner
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async () => {
    if (mocks.sent.reply instanceof Error) {
      throw mocks.sent.reply
    }
    return mocks.sent.reply
  })
}))
vi.mock('@/runtime/layout-frame-position', () => ({
  afterLayoutFrame: (_seq: number | undefined, run: () => void) => run()
}))
vi.mock('@/runtime/layout-owner-pane-intents', () => ({ holdTabPaneTree: () => () => {} }))

import { sendLayoutApply } from './layout-apply-send'

const RENAME = { type: 'renamePane', tabId: 'tab-1', leafId: 'leaf-1', title: 'Pane' } as const

async function send(reply: LayoutApplyReply | Error) {
  mocks.sent.reply = reply
  const handlers = { apply: vi.fn(), asToday: vi.fn(), refused: vi.fn(), unapplied: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner lookup is mocked and never reads the state.
  sendLayoutApply({} as never, 'wt-1', RENAME, handlers)
  await vi.waitFor(() => {
    const calls = Object.values(handlers).reduce(
      (sum, handler) => sum + handler.mock.calls.length,
      0
    )
    expect(calls).toBe(1)
  })
  return handlers
}

describe('sendLayoutApply', () => {
  beforeEach(() => {
    mocks.owner.kind = 'resolved'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  // A window save no longer carries the change, so doing it here would last only until the next frame.
  it.each([
    { reply: { ok: false, code: 'other_partition' } as const, code: 'other_partition' },
    { reply: { ok: false, code: 'host_not_owned' } as const, code: 'host_not_owned' },
    { reply: new Error('disk refused'), code: 'call_failed' }
  ])('logs a $code refusal and draws nothing of its own', async ({ reply, code }) => {
    const handlers = await send(reply)

    expect(handlers.refused).toHaveBeenCalledWith(code)
    expect(handlers.asToday).not.toHaveBeenCalled()
    expect(handlers.unapplied).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(`[layout-owner] renamePane refused`),
      ...(reply instanceof Error ? ['disk refused'] : [code])
    )
  })

  it('acts as today on a twin main routed to a paired server', async () => {
    mocks.owner.kind = 'ambiguous'
    const handlers = await send({ ok: false, code: 'host_not_owned' })

    expect(handlers.asToday).toHaveBeenCalledOnce()
    expect(handlers.refused).not.toHaveBeenCalled()
  })

  it('refuses a change on a workspace a WSL move has paused, drawing nothing', async () => {
    const handlers = await send({ ok: false, code: 'wsl_move_in_progress' })

    expect(handlers.refused).toHaveBeenCalledWith('wsl_move_in_progress')
    expect(handlers.apply).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(
      '[layout-owner] renamePane refused:',
      'wsl_move_in_progress'
    )
  })

  it('handles other refusals and successes as before', async () => {
    const refused = await send({ ok: false, code: 'last_pane' })
    expect(refused.refused).toHaveBeenCalledWith('last_pane')

    const applied = await send({ ok: true, result: { tabId: 'tab-1' } })
    expect(applied.apply).toHaveBeenCalledWith({ tabId: 'tab-1' })
  })
})
