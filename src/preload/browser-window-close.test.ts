import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  installBrowserWindowCloseGuard,
  PRELOAD_BROWSER_GUEST_WINDOW_CLOSE_CHANNEL
} from './browser-window-close-installation'
import { BROWSER_GUEST_WINDOW_CLOSE_CHANNEL } from '../shared/browser-guest-window-close'

describe('browser window close preload', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('replaces the native close with a non-replaceable request to Orca', () => {
    const nativeClose = vi.fn()
    const requestClose = vi.fn()
    vi.stubGlobal('window', { close: nativeClose })

    installBrowserWindowCloseGuard(requestClose)

    expect(window.close()).toBeUndefined()
    expect(nativeClose).not.toHaveBeenCalled()
    expect(requestClose).toHaveBeenCalledTimes(1)
    expect(Reflect.set(window, 'close', nativeClose)).toBe(false)
  })

  it('sends on the channel the renderer listens on', () => {
    expect(PRELOAD_BROWSER_GUEST_WINDOW_CLOSE_CHANNEL).toBe(BROWSER_GUEST_WINDOW_CLOSE_CHANNEL)
  })
})
