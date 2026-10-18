import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SshConnection } from './ssh-connection'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { resetSshConnectionMocks, ssh2Mock } from './ssh-connection-test-harness'
import * as sshClientMock from './__tests__/ssh-connection-test-client'

vi.mock('ssh2', async () => (await import('./ssh-connection-test-harness')).createSsh2Module())
vi.mock('./system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('./system-ssh-args', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshArgsMocks(await importOriginal())
)
vi.mock('./system-ssh-command', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshCommandMocks(await importOriginal())
)
vi.mock('./system-ssh-file-binary-transfer', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshFileBinaryTransferMocks(
    await importOriginal()
  )
)
vi.mock('./system-ssh-file-transfer', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshFileTransferMocks(
    await importOriginal()
  )
)
vi.mock('./ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('./ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)
vi.mock('./ssh-g-config-resolution', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSshGConfigResolutionMocks(
    await importOriginal()
  )
)

beforeEach(resetSshConnectionMocks)
afterEach(() => {
  vi.restoreAllMocks()
})

it('logs an exec channel error nothing else handles, naming the target and channel kind', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const conn = new SshConnection(createTarget(), createCallbacks())
  await conn.connect()
  ssh2Mock.execBehavior = 'pending'
  const opening = conn.exec('true')
  await vi.waitFor(() => expect(sshClientMock.pendingExecCallback).not.toBeNull())
  const channel = Object.assign(new EventEmitter(), { close: vi.fn() })
  sshClientMock.pendingExecCallback?.(undefined, channel)
  await opening

  expect(() => channel.emit('error', new Error('channel reset'))).not.toThrow()
  expect(warn).toHaveBeenCalledWith(
    '[ssh] Unhandled exec channel error for Test Server: channel reset'
  )
  await conn.disconnect()
})
