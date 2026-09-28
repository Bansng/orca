import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

const request: RpcRequest = {
  id: 'req-1',
  authToken: 'tok',
  method: 'terminal.subscribe',
  params: {
    terminal: 'terminal-1',
    client: { id: 'phone-1', type: 'mobile' },
    capabilities: { terminalBinaryStream: 1 }
  }
}

function asRuntime(double: Record<string, unknown>): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal.subscribe reads only the members the double provides.
  return double as unknown as OrcaRuntimeService
}

type PaneDouble = {
  /** What the desktop renderer's serializer answers; null when no pane is registered. */
  rendererScreen: () => string | null
  waitForRendererTerminalSerializer: OrcaRuntimeService['waitForRendererTerminalSerializer']
}

function subscribeMobile(pane: PaneDouble) {
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const registry = createSubscriptionRegistryDouble()
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    subscribeToPtyExit: vi.fn(() => vi.fn()),
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    // A daemon PTY reattached after a desktop restart has no headless model yet.
    hasHeadlessTerminalState: vi.fn(() => false),
    requestRendererTerminalTabMount: vi.fn(() => true),
    getRendererTerminalSerializerGenerationForHandle: vi.fn(() => 1),
    getRendererTerminalSerializerGeneration: vi.fn(() => 1),
    getPtyOutputSequence: vi.fn(() => 4),
    replaceHeadlessTerminalFromRendererSnapshotForRecovery: vi.fn(),
    waitForRendererTerminalSerializer: vi.fn(pane.waitForRendererTerminalSerializer),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
    registerRemoteTerminalViewSubscriber: vi.fn(() => vi.fn()),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    // The restored provider snapshot wins the preference order over the live renderer.
    serializeTerminalBuffer: vi.fn(async () => ({
      data: 'restored provider history',
      cols: 80,
      rows: 24,
      seq: 2
    })),
    serializeRendererTerminalBuffer: vi.fn(async () => {
      const screen = pane.rendererScreen()
      return screen === null
        ? null
        : { data: screen, cols: 80, rows: 24, seq: 4, source: 'renderer' as const }
    }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
  }
  const dispatcher = new RpcDispatcher({ runtime: asRuntime(runtime), methods: TERMINAL_METHODS })
  const done = dispatcher.dispatchStreaming(request, vi.fn(), {
    connectionId: 'conn-phone',
    sendBinary: (bytes) => {
      binaryFrames.push(bytes)
    },
    registerBinaryStreamHandler: vi.fn(() => vi.fn())
  })
  const snapshotText = (): string =>
    binaryFrames
      .map((bytes) => decodeTerminalStreamFrame(bytes))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
      .map((frame) => decodeTerminalStreamText(frame!.payload))
      .join('')
  const close = async (): Promise<void> => {
    runtime.cleanupSubscription('terminal-1:phone-1')
    await done
  }
  return { runtime, snapshotText, close }
}

describe('terminal subscribe for a pane the desktop already has mounted', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers from the live renderer without waiting out the mount deadline', async () => {
    // The renderer drops a mount request for a mounted tab, so no newer serializer settle ever arrives.
    const subscription = subscribeMobile({
      rendererScreen: () => 'live desktop prompt $ ',
      waitForRendererTerminalSerializer: (_ptyId, _after, _timeout, signal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false), { once: true })
        })
    })

    await vi.advanceTimersByTimeAsync(100)

    expect(subscription.snapshotText()).toContain('live desktop prompt $ ')
    expect(subscription.runtime.requestRendererTerminalTabMount).not.toHaveBeenCalled()
    expect(
      subscription.runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery
    ).toHaveBeenCalledWith('pty-1', expect.objectContaining({ data: 'live desktop prompt $ ' }), [])
    await subscription.close()
  })

  it('still requests the mount and waits for its settle when no pane is registered', async () => {
    let mounted = false
    const subscription = subscribeMobile({
      rendererScreen: () => (mounted ? 'mounted idle prompt $ ' : null),
      waitForRendererTerminalSerializer: (_ptyId, afterGeneration) => {
        expect(afterGeneration).toBe(1)
        return new Promise<boolean>((resolve) => {
          setTimeout(() => {
            mounted = true
            resolve(true)
          }, 500)
        })
      }
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(subscription.runtime.requestRendererTerminalTabMount).toHaveBeenCalledWith('terminal-1')
    expect(subscription.snapshotText()).toBe('')

    await vi.advanceTimersByTimeAsync(400)
    expect(subscription.snapshotText()).toContain('mounted idle prompt $ ')
    expect(subscription.snapshotText()).not.toContain('restored provider history')
    await subscription.close()
  })
})
