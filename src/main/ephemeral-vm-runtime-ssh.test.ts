import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  remove: vi.fn(async () => {}),
  gitProvider: vi.fn(),
  fsProvider: vi.fn()
}))

vi.mock('./ipc/ssh', () => ({
  connectRegisteredSshTarget: mocks.connect,
  getSshConnectionStore: () => ({
    upsertRuntimeOwnedTarget: (runtimeId: string) => ({
      id: `runtime-ssh-${runtimeId}`,
      label: 'VM',
      host: 'vm',
      port: 22,
      username: 'root'
    })
  })
}))
vi.mock('./ipc/ssh-session-teardown', () => ({
  disconnectRegisteredSshTarget: vi.fn(),
  removeRegisteredSshTarget: mocks.remove
}))
vi.mock('./providers/ssh-git-dispatch', () => ({ getSshGitProvider: mocks.gitProvider }))
vi.mock('./providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: mocks.fsProvider
}))

import { connectRuntimeOwnedSshTarget } from './ephemeral-vm-runtime-ssh'

const connection = {
  type: 'ssh' as const,
  projectRoot: '/workspace/repo',
  target: { label: 'VM', host: 'vm', port: 22, username: 'root' }
}

describe('connectRuntimeOwnedSshTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns the managed server a recipe VM's host runs, without waiting on relay providers", async () => {
    mocks.connect.mockResolvedValue({
      targetId: 'runtime-ssh-vm-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      managedServer: { kind: 'managed', environmentId: 'env-vm' }
    })
    await expect(
      connectRuntimeOwnedSshTarget({ runtimeId: 'vm-1', connection })
    ).resolves.toMatchObject({ targetId: 'runtime-ssh-vm-1', environmentId: 'env-vm' })
    expect(mocks.gitProvider).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('waits for the direct providers when the host has no managed server', async () => {
    mocks.connect.mockResolvedValue({
      targetId: 'runtime-ssh-vm-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mocks.gitProvider.mockReturnValue({})
    mocks.fsProvider.mockReturnValue({})
    const result = await connectRuntimeOwnedSshTarget({ runtimeId: 'vm-1', connection })
    expect(result.environmentId).toBeUndefined()
    expect(mocks.gitProvider).toHaveBeenCalledWith('runtime-ssh-vm-1')
  })
})
