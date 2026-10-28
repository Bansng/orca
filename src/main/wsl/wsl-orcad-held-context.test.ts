import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import type { WslDistroHolder } from './wsl-distro-holder'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'

const mocks = vi.hoisted(() => {
  const state: { spawned: string[]; refused: string[]; probeStep: (() => void) | null } = {
    spawned: [],
    refused: [],
    probeStep: null
  }
  return state
})

// Like the real execCommand: an aborted signal refuses before anything is spawned.
vi.mock('../ssh/remote-exec/remote-exec-command', () => ({
  execCommand: vi.fn(
    async (_conn: unknown, command: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal?.aborted) {
        mocks.refused.push(command)
        throw options.signal.reason
      }
      mocks.spawned.push(command)
      return command === 'uname -r' ? '5.15.167.4-microsoft-standard-WSL2\n' : ''
    }
  )
}))
// Like the real context resolver: several probes in series, each passed the caller's signal.
vi.mock('../managed-server/install/orcad-remote-context', async () => {
  const { execCommand } = await import('../ssh/remote-exec/remote-exec-command')
  return {
    resolveOrcadRemoteContext: async (
      _target: unknown,
      conn: OrcadHostTransport,
      signal?: AbortSignal
    ) => {
      for (const command of ['uname -sm', 'echo $HOME', 'ldd --version']) {
        await new Promise<void>((resolve) => {
          mocks.probeStep = resolve
        })
        await execCommand(conn, command, { signal })
      }
      return { remoteHome: '/home/u' }
    }
  }
})

import { holdWslDistroWithContext, isWsl1KernelRelease } from './wsl-orcad-held-context'

const target: WslOrcadHostTarget = { kind: 'wsl', id: 'wsl:u', distro: 'U', label: 'U' }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every host call is mocked at its module.
const conn = {} as OrcadHostTransport

function holderRejectingOn(gate: Promise<void>): WslDistroHolder {
  return {
    ensureHeld: vi.fn(async () => {
      await gate
      throw new Error('holder exited before the distro started')
    }),
    adoptHolders: vi.fn(),
    release: vi.fn(),
    releaseAll: vi.fn(),
    holderState: vi.fn()
  }
}

beforeEach(() => {
  mocks.spawned.length = 0
  mocks.refused.length = 0
  mocks.probeStep = null
})

describe('holdWslDistroWithContext', () => {
  it('probes the context while the hold is pending, and resolves only once the distro is held', async () => {
    let finishHold: () => void = () => {}
    const holdDone = new Promise<void>((resolve) => {
      finishHold = resolve
    })
    const hold: WslDistroHolder = {
      ...holderRejectingOn(holdDone),
      ensureHeld: vi.fn(async (distro: string) => {
        await holdDone
        return {
          outcome: 'spawned' as const,
          record: { version: 1 as const, distro, pid: 9, creationTimeMs: 1, startedAtMs: 1 }
        }
      })
    }
    let settled = false
    const held = holdWslDistroWithContext('U', target, conn, hold, undefined).finally(() => {
      settled = true
    })
    for (let step = 0; step < 3; step++) {
      await vi.waitFor(() => expect(mocks.probeStep).not.toBeNull())
      const next = mocks.probeStep
      mocks.probeStep = null
      next?.()
    }
    await vi.waitFor(() =>
      expect(mocks.spawned).toEqual(['uname -r', 'uname -sm', 'echo $HOME', 'ldd --version'])
    )
    // The deploy awaits this before recovery, which may launch orcad.
    expect(settled).toBe(false)

    finishHold()

    await expect(held).resolves.toMatchObject({
      held: { outcome: 'spawned' },
      context: { remoteHome: '/home/u' }
    })
  })

  it('stops the context probes once the hold fails, so nothing can boot the distro again', async () => {
    let failHold: () => void = () => {}
    const holdFails = new Promise<void>((resolve) => {
      failHold = resolve
    })
    const held = holdWslDistroWithContext(
      'U',
      target,
      conn,
      holderRejectingOn(holdFails),
      undefined
    )
    await vi.waitFor(() => expect(mocks.probeStep).not.toBeNull())
    mocks.probeStep?.()
    await vi.waitFor(() => expect(mocks.spawned).toEqual(['uname -r', 'uname -sm']))

    failHold()
    await expect(held).rejects.toThrow('holder exited')
    mocks.probeStep?.()
    await vi.waitFor(() => expect(mocks.refused).toEqual(['echo $HOME']))

    expect(mocks.spawned).toEqual(['uname -r', 'uname -sm'])
  })
})

describe('isWsl1KernelRelease', () => {
  it('tells the WSL 1 syscall layer from a WSL 2 kernel, stock or custom', () => {
    expect(isWsl1KernelRelease('4.4.0-19041-Microsoft')).toBe(true)
    expect(isWsl1KernelRelease('4.4.0-22621-Microsoft\n')).toBe(true)
    expect(isWsl1KernelRelease('5.15.167.4-microsoft-standard-WSL2')).toBe(false)
    expect(isWsl1KernelRelease('6.6.36.6-microsoft-standard-WSL2+')).toBe(false)
    expect(isWsl1KernelRelease('6.10.0-custom')).toBe(false)
  })
})
