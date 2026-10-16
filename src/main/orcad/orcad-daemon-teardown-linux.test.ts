import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { describe, expect, it, vi } from 'vitest'
import { readAgentProcess } from '../../shared/agent-process-presence-probe'
import type { LinuxStatEvidence } from '../daemon/daemon-incarnation-evidence-types'
import { DaemonEndpointOwnershipError } from '../daemon/daemon-endpoint-adoption'
import { cleanupDaemonForProtocol } from '../daemon/daemon-protocol-cleanup'
import {
  killAndAwaitExit,
  killProfileDaemons,
  waitForProcessExit
} from './orcad-daemon-teardown-fixture'

vi.mock('../daemon/daemon-protocol-cleanup', () => ({ cleanupDaemonForProtocol: vi.fn() }))

const ZOMBIE_PARENT = `
import os, select, sys
pid = os.fork()
if pid == 0:
    os._exit(0)
try:
    print(pid, flush=True)
    select.select([sys.stdin], [], [], 25)
finally:
    os.waitpid(pid, 0)
`

describe('daemon teardown exit proof', () => {
  it.skipIf(process.platform !== 'linux')(
    'accepts an unreaped zombie while its owned parent remains alive, then reaps it',
    async () => {
      const parent = spawnProcess({
        program: process.env.PYTHON || 'python3',
        args: ['-c', ZOMBIE_PARENT],
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: null
      })
      let stdout = ''
      let stderr = ''
      parent.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
      parent.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      const closed = new Promise<number | null>((resolve, reject) => {
        parent.once('error', reject)
        parent.once('close', resolve)
      })
      let zombiePid = 0
      try {
        await vi.waitFor(
          async () => {
            zombiePid = Number(stdout.trim())
            expect(Number.isSafeInteger(zombiePid) && zombiePid > 0).toBe(true)
            expect(await readAgentProcess(zombiePid)).toMatchObject({
              verdict: 'live',
              zombie: true
            })
          },
          { timeout: 5_000, interval: 25 }
        )
        expect(() => process.kill(zombiePid, 0)).not.toThrow()
        await waitForProcessExit([zombiePid])
        await killAndAwaitExit([zombiePid])
        expect(parent.exitCode).toBeNull()
        expect(() => process.kill(zombiePid, 0)).not.toThrow()
        expect(await readAgentProcess(zombiePid)).toMatchObject({ verdict: 'live', zombie: true })
      } finally {
        // EOF releases waitpid even when an assertion fails; never orphan the zombie.
        parent.stdin.end()
        expect(await closed).toBe(0)
        expect(stderr).toBe('')
        if (zombiePid > 0) {
          expect(() => process.kill(zombiePid, 0)).toThrow(
            expect.objectContaining({ code: 'ESRCH' })
          )
        }
      }
    },
    20_000
  )

  it('still rejects a live process at the unchanged ten-second deadline', async () => {
    vi.useFakeTimers()
    try {
      const rejected = expect(waitForProcessExit([process.pid])).rejects.toThrow(
        `Processes did not exit: ${process.pid}`
      )
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      expect(() => process.kill(process.pid, 0)).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  const zombieStat = `42 (daemon) Z ${Array(18).fill('0').join(' ')} 100`
  it.each<[string, LinuxStatEvidence]>([
    ['missing proc entry after occupied signal', { status: 'missing' }],
    ['unavailable proc entry', { status: 'unavailable' }],
    ['truncated zombie entry', { status: 'present', value: '42 (daemon) Z' }],
    ['malformed start ticks', { status: 'present', value: zombieStat.replace(/100$/, 'bad') }],
    ['different pid', { status: 'present', value: zombieStat.replace(/^42/, '43') }],
    ['live proc entry', { status: 'present', value: zombieStat.replace(') Z', ') S') }]
  ])('does not accept %s as exit proof', async (_name, stat) => {
    vi.useFakeTimers()
    try {
      const rejected = expect(
        waitForProcessExit([42], {
          platform: 'linux',
          signalProcess: () => {},
          readStat: async () => stat
        })
      ).rejects.toThrow('Processes did not exit: 42')
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a stalled proc read without treating timeout as exit', async () => {
    vi.useFakeTimers()
    try {
      const rejected = expect(
        waitForProcessExit([42], {
          platform: 'linux',
          signalProcess: () => {},
          readStat: () => new Promise(() => {})
        })
      ).rejects.toThrow('Processes did not exit: 42')
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['EPERM', 'EACCES'])(
    'keeps signal %s pending without accepting proc evidence',
    async (code) => {
      vi.useFakeTimers()
      const readStat = vi.fn(async (): Promise<LinuxStatEvidence> => ({
        status: 'present',
        value: zombieStat
      }))
      try {
        const rejected = expect(
          waitForProcessExit([42], {
            platform: 'linux',
            signalProcess: () => {
              throw Object.assign(new Error(code), { code })
            },
            readStat
          })
        ).rejects.toThrow('Processes did not exit: 42')
        await vi.advanceTimersByTimeAsync(10_000)
        await rejected
        expect(readStat).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('preserves ESRCH exit proof without requiring proc evidence', async () => {
    const readStat = vi.fn()
    await waitForProcessExit([42], {
      platform: 'linux',
      signalProcess: () => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      },
      readStat
    })
    expect(readStat).not.toHaveBeenCalled()
  })

  it.each<NodeJS.Platform>(['darwin', 'win32'])(
    'keeps occupied %s processes pending',
    async (platform) => {
      vi.useFakeTimers()
      const readStat = vi.fn(async (): Promise<LinuxStatEvidence> => ({
        status: 'present',
        value: zombieStat
      }))
      try {
        const rejected = expect(
          waitForProcessExit([42], { platform, signalProcess: () => {}, readStat })
        ).rejects.toThrow('Processes did not exit: 42')
        await vi.advanceTimersByTimeAsync(10_000)
        await rejected
        expect(readStat).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    }
  )
})

describe('profile daemon cleanup after loss of contact', () => {
  const unverified = () =>
    new DaemonEndpointOwnershipError(
      'Daemon cleanup aborted: the expected daemon could not be verified'
    )

  async function exitedChildPid(): Promise<number> {
    const child = spawnProcess({ program: process.execPath, args: ['-e', ''], timeoutMs: null })
    const pid = child.pid
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', () => resolve())
    })
    if (!pid) {
      throw new Error('Child did not start')
    }
    return pid
  }

  function profile(pid: number, onTestFinished: (cleanup: () => void) => void): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-profile-exit-'))
    onTestFinished(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'daemon'))
    writeFileSync(join(root, 'daemon', 'daemon-v1.pid'), JSON.stringify({ pid }))
    return root
  }

  it('accepts an unverified endpoint only after the recorded process has exited', async ({
    onTestFinished
  }) => {
    const pid = await exitedChildPid()
    vi.mocked(cleanupDaemonForProtocol).mockRejectedValueOnce(unverified())
    await expect(killProfileDaemons(profile(pid, onTestFinished))).resolves.toBeUndefined()
  })

  it('still rejects a live recorded process at the exit deadline without killing it', async ({
    onTestFinished
  }) => {
    vi.mocked(cleanupDaemonForProtocol).mockRejectedValueOnce(unverified())
    const root = profile(process.pid, onTestFinished)
    const signal = vi.spyOn(process, 'kill')
    vi.useFakeTimers()
    try {
      const result = killProfileDaemons(root).then(
        () => null,
        (error: unknown) => error
      )
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await result).toMatchObject({
        errors: [expect.objectContaining({ message: `Processes did not exit: ${process.pid}` })]
      })
      expect(signal).toHaveBeenCalledWith(process.pid, 0)
      expect(signal.mock.calls.every(([, mode]) => mode === 0)).toBe(true)
    } finally {
      vi.useRealTimers()
      signal.mockRestore()
    }
  })

  it.for([
    new DaemonEndpointOwnershipError(
      'Daemon cleanup aborted: the endpoint is owned by a different daemon than expected'
    ),
    new Error('unexpected cleanup failure')
  ])('preserves %s even when the recorded process exited', async (error, { onTestFinished }) => {
    const pid = await exitedChildPid()
    vi.mocked(cleanupDaemonForProtocol).mockRejectedValueOnce(error)
    await expect(killProfileDaemons(profile(pid, onTestFinished))).rejects.toMatchObject({
      errors: [error]
    })
  })
})
