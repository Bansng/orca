import { describe, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { readTerminalSpawnAdmissionArg } from './terminal-spawn-gate'

function createPayloads(requestSpy: { mock: { calls: unknown[][] } }): unknown[] {
  return requestSpy.mock.calls.filter(([type]) => type === 'createOrAttach').map(([, p]) => p)
}

describe('daemon spawn intent wire', () => {
  it('forwards a declared intent on create and omits it on attach-only', async () => {
    const ensureConnectedSpy = vi
      .spyOn(DaemonClient.prototype, 'ensureConnected')
      .mockResolvedValue()
    const requestSpy = vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValue({
      isNew: true,
      pid: null,
      shellState: 'unsupported',
      snapshot: null
    })
    const adapter = new DaemonPtyAdapter({
      socketPath: '/tmp/orca-intent.sock',
      tokenPath: '/tmp/orca-intent.token'
    })
    try {
      await adapter.spawn({
        sessionId: 'intent',
        cols: 80,
        rows: 24,
        spawnIntent: 'automatic-restore'
      })
      await adapter.spawn({ sessionId: 'plain', cols: 80, rows: 24 })
      const [declared, undeclared] = createPayloads(requestSpy)
      expect(declared).toHaveProperty('spawnIntent', 'automatic-restore')
      expect(undeclared).not.toHaveProperty('spawnIntent')
    } finally {
      adapter.dispose()
      requestSpy.mockRestore()
      ensureConnectedSpy.mockRestore()
    }
  })

  it('reads the launcher flag and observes for anything else', () => {
    expect(readTerminalSpawnAdmissionArg(['node', 'entry', '--spawn-admission', 'enforce'])).toBe(
      'enforce'
    )
    expect(readTerminalSpawnAdmissionArg(['node', 'entry', '--spawn-admission', 'bogus'])).toBe(
      'observe'
    )
    expect(readTerminalSpawnAdmissionArg(['node', 'entry'])).toBe('observe')
  })
})
