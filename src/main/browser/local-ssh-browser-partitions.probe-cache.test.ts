import { beforeEach, describe, expect, it, vi } from 'vitest'

type TestContents = {
  id: number
  session: object
  destroyed: boolean
  isDestroyed: () => boolean
}

const mocks = vi.hoisted(() => {
  const contents: TestContents[] = []
  return {
    contents,
    probe: vi.fn<() => Promise<'ok' | 'forwarding-blocked' | 'ssh-unavailable'>>(),
    census: vi.fn(() => [...contents]),
    closeGuest: vi.fn((contents: TestContents) => {
      contents.destroyed = true
    }),
    clearPolicies: vi.fn<(partition: string) => void>(),
    policy: vi.fn<() => Promise<void>>(),
    sessionForPartition: (_partition: string): object => ({}),
    emitCreated: (_contents: TestContents): void => {},
    listenerCount: (): number => 0
  }
})

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const app = new EventEmitter()
  const sessions = new Map<string, object>()
  const fromPartition = (partition: string): object => {
    let existing = sessions.get(partition)
    if (!existing) {
      existing = { partition }
      sessions.set(partition, existing)
    }
    return existing
  }
  mocks.sessionForPartition = fromPartition
  mocks.emitCreated = (contents) => {
    app.emit('web-contents-created', {}, contents)
  }
  mocks.listenerCount = () => app.listenerCount('web-contents-created')
  return {
    app,
    session: { fromPartition },
    webContents: { getAllWebContents: mocks.census }
  }
})
vi.mock('./browser-route-guest-guard', () => ({ closeRouteGuest: mocks.closeGuest }))
vi.mock('./browser-route-partition-binding-runtime', () => {
  const fingerprints = new Map<string, string>()
  return {
    activeBrowserRoutePartitionOrcaProfileId: () => 'orca-profile-1',
    currentBrowserRoutePartitionBindingStore: () => ({
      get: (partition: string) => fingerprints.get(partition) ?? null,
      set: (partition: string, fingerprint: string) => {
        fingerprints.set(partition, fingerprint)
        return []
      },
      touch: vi.fn()
    })
  }
})
vi.mock('./browser-route-partition-retention', () => ({
  isBrowserRoutePartitionRetainedByAnyOwner: () => false,
  registerBrowserRoutePartitionRetentionProbe: vi.fn()
}))
vi.mock('./browser-route-partition-storage-dependencies', () => ({
  releaseEvictedBrowserRoutePartitionStorage: vi.fn(async () => {})
}))
vi.mock('./browser-route-session-policy', () => ({
  prepareBrowserRouteSessionPolicy: mocks.policy
}))
vi.mock('./browser-route-webrtc-policy', () => ({ enforceBrowserRouteWebRtcPolicy: vi.fn() }))
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    requireRouteBrowserProfile: vi.fn(),
    setupRoutePartitionPolicies: vi.fn(),
    clearRoutePartitionPolicies: mocks.clearPolicies
  }
}))
vi.mock('./local-ssh-browser-route', () => ({
  retainLocalSshBrowserRoute: vi.fn(async () => ({ host: '127.0.0.1', port: 1080 })),
  probeLocalSshBrowserRouteForwarding: mocks.probe,
  closeLocalSshBrowserRouteForTarget: vi.fn(async () => {})
}))

import {
  prepareLocalSshBrowserPartition,
  releaseLocalSshBrowserPartitionsForTarget
} from './local-ssh-browser-partitions'

beforeEach(() => {
  mocks.probe.mockReset().mockResolvedValue('ok')
  mocks.policy.mockReset().mockResolvedValue(undefined)
  mocks.contents.length = 0
  mocks.census.mockClear()
  mocks.clearPolicies.mockReset()
  mocks.closeGuest.mockReset().mockImplementation((contents) => {
    contents.destroyed = true
  })
})

function createContents(partition: string): TestContents {
  const contents = {
    id: mocks.contents.length + 1,
    session: mocks.sessionForPartition(partition),
    destroyed: false,
    isDestroyed: () => contents.destroyed
  }
  mocks.contents.push(contents)
  mocks.emitCreated(contents)
  return contents
}

describe('prepareLocalSshBrowserPartition probe caching', () => {
  it('does not let a Try-anyway success satisfy a later probed prepare from cache', async () => {
    mocks.probe.mockResolvedValue('forwarding-blocked')

    const skipped = await prepareLocalSshBrowserPartition({
      targetId: 'target-undo',
      browserProfileId: 'default',
      skipProbe: true
    })
    expect(skipped.partition).toMatch(/^persist:orca-browser-v1-/)
    expect(mocks.probe).not.toHaveBeenCalled()

    await expect(
      prepareLocalSshBrowserPartition({ targetId: 'target-undo', browserProfileId: 'default' })
    ).rejects.toThrow('browser_local_route_forwarding_blocked')
    expect(mocks.probe).toHaveBeenCalledTimes(1)
  })

  it('still caches probed successes without re-probing', async () => {
    mocks.probe.mockResolvedValue('ok')

    const first = await prepareLocalSshBrowserPartition({
      targetId: 'target-cached',
      browserProfileId: 'default'
    })
    const second = await prepareLocalSshBrowserPartition({
      targetId: 'target-cached',
      browserProfileId: 'default'
    })
    expect(second.partition).toBe(first.partition)
    expect(mocks.probe).toHaveBeenCalledTimes(1)
  })

  it('mints the same partition for skipped and probed prepares of one target', async () => {
    mocks.probe.mockResolvedValue('ok')

    const skipped = await prepareLocalSshBrowserPartition({
      targetId: 'target-same',
      browserProfileId: 'default',
      skipProbe: true
    })
    const probed = await prepareLocalSshBrowserPartition({
      targetId: 'target-same',
      browserProfileId: 'default'
    })
    expect(probed.partition).toBe(skipped.partition)
  })
})

describe('releaseLocalSshBrowserPartitionsForTarget', () => {
  it.each([10, 100])(
    'enumerates contents once for %i prepared profiles and preserves other targets',
    async (profiles) => {
      const targetId = `census-${profiles}`
      const removed: TestContents[] = []
      for (let index = 0; index < profiles; index++) {
        const { partition } = await prepareLocalSshBrowserPartition({
          targetId,
          browserProfileId: `profile-${index}`
        })
        removed.push(createContents(partition))
      }
      const sibling = await prepareLocalSshBrowserPartition({
        targetId: `sibling-${profiles}`,
        browserProfileId: 'default'
      })
      const survivor = createContents(sibling.partition)
      for (let index = 0; index < 1_000; index++) {
        createContents('unrelated')
      }
      const listeners = mocks.listenerCount()
      mocks.clearPolicies.mockImplementation((partition) => {
        expect(
          removed
            .filter((contents) => contents.session === mocks.sessionForPartition(partition))
            .every((contents) => contents.destroyed)
        ).toBe(true)
      })

      await releaseLocalSshBrowserPartitionsForTarget(targetId)

      expect(mocks.census).toHaveBeenCalledTimes(1)
      expect(mocks.closeGuest).toHaveBeenCalledTimes(profiles)
      expect(removed.every((contents) => contents.destroyed)).toBe(true)
      expect(survivor.destroyed).toBe(false)
      expect(mocks.contents.slice(profiles + 1).every((contents) => !contents.destroyed)).toBe(true)
      expect(mocks.clearPolicies).toHaveBeenCalledTimes(profiles)
      expect(mocks.listenerCount()).toBe(listeners)
    }
  )

  it('refreshes the census for a guest created while another prepare is pending', async () => {
    const first = await prepareLocalSshBrowserPartition({
      targetId: 'late-guest',
      browserProfileId: 'first'
    })
    const firstContents = createContents(first.partition)
    const gate = Promise.withResolvers<void>()
    mocks.policy.mockImplementationOnce(() => gate.promise)
    const second = prepareLocalSshBrowserPartition({
      targetId: 'late-guest',
      browserProfileId: 'second'
    })
    const firstClosed = Promise.withResolvers<void>()
    mocks.closeGuest.mockImplementationOnce((contents) => {
      contents.destroyed = true
      firstClosed.resolve()
    })
    const listeners = mocks.listenerCount()
    const releasing = releaseLocalSshBrowserPartitionsForTarget('late-guest')
    await firstClosed.promise
    gate.resolve()
    const late = createContents((await second).partition)
    await releasing

    expect(firstContents.destroyed).toBe(true)
    expect(late.destroyed).toBe(true)
    expect(mocks.census).toHaveBeenCalledTimes(2)
    expect(mocks.listenerCount()).toBe(listeners)
  })

  it('skips destroyed guests and does no native census for an absent target', async () => {
    const { partition } = await prepareLocalSshBrowserPartition({
      targetId: 'destroyed-guest',
      browserProfileId: 'default'
    })
    const dead = createContents(partition)
    dead.destroyed = true
    const live = createContents(partition)
    await releaseLocalSshBrowserPartitionsForTarget('destroyed-guest')
    expect(mocks.closeGuest.mock.calls.map(([contents]) => contents)).toEqual([live])
    const calls = mocks.census.mock.calls.length
    await releaseLocalSshBrowserPartitionsForTarget('absent')
    expect(mocks.census).toHaveBeenCalledTimes(calls)
  })

  it('releases the creation listener if policy cleanup throws', async () => {
    const { partition } = await prepareLocalSshBrowserPartition({
      targetId: 'failed-cleanup',
      browserProfileId: 'default'
    })
    createContents(partition)
    const listeners = mocks.listenerCount()
    mocks.clearPolicies.mockImplementationOnce(() => {
      throw new Error('policy cleanup failed')
    })
    await expect(releaseLocalSshBrowserPartitionsForTarget('failed-cleanup')).rejects.toThrow(
      'policy cleanup failed'
    )
    expect(mocks.listenerCount()).toBe(listeners)
  })
})
