// Whether this window owes main a session write: one is scheduled or not yet acknowledged. Fed by
// the session write subscriber in a layout-owner build only; layout frames wait while it is busy,
// so a frame never replaces a change main has not received yet. Frames also wait while a layout
// command whose answer the window draws itself is in flight.

let busy = false
let held = 0
let idleListener: (() => void) | null = null

export function reportWindowSessionWriteActivity(nextBusy: boolean): void {
  if (busy === nextBusy) {
    return
  }
  busy = nextBusy
  if (!isWindowSessionWriteBusy()) {
    idleListener?.()
  }
}

/** Holds layout frames until the returned release runs; releasing twice is a no-op. */
export function holdLayoutFramesForWindowCommand(): () => void {
  held += 1
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    held -= 1
    if (!isWindowSessionWriteBusy()) {
      idleListener?.()
    }
  }
}

export function isWindowSessionWriteBusy(): boolean {
  return busy || held > 0
}

/** The one listener: the window's layout frame sync. */
export function onWindowSessionWriteIdle(listener: () => void): () => void {
  idleListener = listener
  return () => {
    if (idleListener === listener) {
      idleListener = null
    }
  }
}
