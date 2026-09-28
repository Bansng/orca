import {
  mobileSnapshotByteBudget,
  serializeStableMobileRendererSnapshot
} from './terminal-snapshot-publication'
import { getOutputAfterSnapshotSeq } from './terminal-stream-replay'
import type { SerializedSnapshot } from './terminal-stream-types'
import type {
  LegacyBinarySubscriptionState,
  TerminalSubscriptionArgs
} from './terminal-legacy-subscription-types'

const MOBILE_RENDERER_MOUNT_READY_TIMEOUT_MS = 3_000

type TerminalRead = Awaited<ReturnType<TerminalSubscriptionArgs['runtime']['readTerminal']>>
type InitialScreen = { read: TerminalRead; serialized: SerializedSnapshot }

/** Decides whether a PTY with no headless model needs a renderer mount, and what screen to publish; null once the stream closed. */
export async function settleRendererAttachment(
  args: TerminalSubscriptionArgs,
  state: LegacyBinarySubscriptionState,
  initial: InitialScreen,
  scrollbackFrame: Parameters<typeof mobileSnapshotByteBudget>[2]
): Promise<InitialScreen | null> {
  const {
    params,
    runtime,
    registration,
    ptyId,
    missingHeadlessStateBeforeMobileFit,
    rendererMountRequestedBeforePty,
    serializerGenerationBeforeMobileFit
  } = args
  const { signal } = registration
  let { read, serialized } = initial
  // Same frame as the scrollback send below, which publishes whichever snapshot this adopts.
  const serializeRendererScreen = () =>
    serializeStableMobileRendererSnapshot(
      runtime,
      ptyId,
      mobileSnapshotByteBudget(params.snapshotByteBudget, state.streamId, scrollbackFrame)
    )
  const adoptRendererSnapshot = async (
    stableRendererSnapshot: NonNullable<SerializedSnapshot>
  ): Promise<void> => {
    read = await runtime.readTerminal(params.terminal)
    if (state.closed) {
      return
    }
    serialized = stableRendererSnapshot
    const trailingOutput = state.pendingOutput.flatMap((item) => {
      const output = getOutputAfterSnapshotSeq(item, stableRendererSnapshot.seq)
      const seq = item.meta?.seq
      return output && typeof seq === 'number' ? [{ data: output.data, seq }] : []
    })
    runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(
      ptyId,
      stableRendererSnapshot,
      trailingOutput
    )
  }
  // Why: missing model state (not blank snapshot text) signals a never-attached PTY. Any renderer answer,
  // even a blank or moving one, proves attachment; the renderer ignores mount requests for mounted tabs.
  let rendererAttached = serialized?.source === 'renderer'
  if (missingHeadlessStateBeforeMobileFit && !rendererAttached) {
    const probe = await serializeRendererScreen()
    if (state.closed) {
      return null
    }
    rendererAttached = probe.kind !== 'absent'
    // Why: only a settled, non-blank, renderer-ordered screen may replace the chosen one: a moving
    // screen has no exact seam, a parked pane is blank before hydrating, and without a seq every
    // buffered chunk would replay on top of a screen that already holds it.
    if (
      probe.kind === 'settled' &&
      probe.snapshot.data.length > 0 &&
      typeof probe.snapshot.seq === 'number'
    ) {
      await adoptRendererSnapshot(probe.snapshot)
      if (state.closed) {
        return null
      }
    }
  }
  const mountRequested =
    missingHeadlessStateBeforeMobileFit &&
    !rendererAttached &&
    (rendererMountRequestedBeforePty || runtime.requestRendererTerminalTabMount(params.terminal))
  if (mountRequested) {
    // Why: an idle legacy PTY emits no later byte, so wait for a settle proving this remount completed before replaying its screen.
    const mountWaitController = new AbortController()
    const abortMountWait = (): void => mountWaitController.abort()
    state.abortRendererMountWait = abortMountWait
    if (signal.aborted) {
      abortMountWait()
    } else {
      signal.addEventListener('abort', abortMountWait, { once: true })
    }
    const rendererReadyPromise = runtime
      .waitForRendererTerminalSerializer(
        ptyId,
        serializerGenerationBeforeMobileFit,
        undefined,
        mountWaitController.signal
      )
      .catch(() => false)
    const finishMountWait = (): void => {
      signal.removeEventListener('abort', abortMountWait)
      if (state.abortRendererMountWait === abortMountWait) {
        state.abortRendererMountWait = () => {}
      }
    }
    void rendererReadyPromise.then(finishMountWait, finishMountWait)
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null
    const initialDeadline = new Promise<boolean>((resolve) => {
      deadlineTimer = setTimeout(() => resolve(false), MOBILE_RENDERER_MOUNT_READY_TIMEOUT_MS)
      if (typeof deadlineTimer.unref === 'function') {
        deadlineTimer.unref()
      }
    })
    const rendererReady = await Promise.race([rendererReadyPromise, initialDeadline])
    if (deadlineTimer) {
      clearTimeout(deadlineTimer)
    }
    if (state.closed || signal.aborted) {
      return null
    }
    if (rendererReady) {
      const stable = await serializeRendererScreen()
      if (state.closed) {
        return null
      }
      if (stable.kind === 'settled' && stable.snapshot.data.length > 0) {
        await adoptRendererSnapshot(stable.snapshot)
        if (state.closed) {
          return null
        }
      }
    } else {
      // Why: a renderer can settle after the bounded initial response; keep observing so an idle PTY self-heals without bytes.
      state.lateRendererReadyPromise = rendererReadyPromise
    }
  }
  return { read, serialized }
}
