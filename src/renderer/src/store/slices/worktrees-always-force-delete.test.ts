import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees-slice-test-harness'

beforeEach(() => {
  vi.clearAllMocks()
  resetWorktreeSliceModuleMemory()
  resetRemoteRuntimeMocks()
  mockApi.worktrees.remove.mockResolvedValue({})
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'rpc-rm',
    ok: true,
    result: {},
    _meta: { runtimeId: 'runtime-remote' }
  })
})

it.each([undefined, false, true])(
  'uses the saved force-delete preference for local deletion: %s',
  async (enabled) => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1' })
    store.setState({
      settings: { ...getDefaultSettings('/home/test'), alwaysForceDeleteWorktrees: enabled },
      worktreesByRepo: { [wt.repoId]: [wt] }
    })

    expect(
      await store.getState().removeWorktree({ id: wt.id, executionHostId: null }, false)
    ).toEqual({ ok: true })
    expect(mockApi.worktrees.remove).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: wt.id,
        force: enabled === true,
        allowUnverifiedPtyStop: enabled === true,
        allowFailedArchiveHook: false
      })
    )
  }
)

it('applies the preference through the existing remote removal flags', async () => {
  const store = createTestStore()
  const wt = makeWorktree({
    id: 'repo1::/path/wt1',
    repoId: 'repo1',
    hostId: 'runtime:env-1',
    runtimeOwnerEnvironmentId: 'env-1'
  })
  store.setState({
    settings: {
      ...getDefaultSettings('/home/test'),
      activeRuntimeEnvironmentId: 'different-focused-hub',
      alwaysForceDeleteWorktrees: true
    },
    worktreesByRepo: { [wt.repoId]: [wt] }
  })

  expect(
    await store.getState().removeWorktree({ id: wt.id, executionHostId: 'runtime:env-1' }, false)
  ).toEqual({ ok: true })
  expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
    expect.objectContaining({
      selector: 'env-1',
      method: 'worktree.rm',
      params: expect.objectContaining({
        worktree: `id:${wt.id}`,
        force: true,
        allowUnverifiedPtyStop: true,
        runHooks: true
      })
    })
  )
  expect(mockApi.worktrees.remove).not.toHaveBeenCalled()
})

it('still reports a failed forced removal instead of treating the workspace as deleted', async () => {
  mockApi.worktrees.remove.mockRejectedValue(new Error('Workspace is locked'))
  const store = createTestStore()
  const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1' })
  store.setState({
    settings: { ...getDefaultSettings('/home/test'), alwaysForceDeleteWorktrees: true },
    worktreesByRepo: { [wt.repoId]: [wt] }
  })

  expect(
    await store.getState().removeWorktree({ id: wt.id, executionHostId: null }, false)
  ).toEqual({ ok: false, error: 'Workspace is locked' })
  expect(store.getState().worktreesByRepo[wt.repoId]).toEqual([wt])
})

it('keeps forgetting a disconnected workspace metadata-only when the preference is enabled', async () => {
  const store = createTestStore()
  const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', hostId: 'ssh:offline' })
  store.setState({
    settings: { ...getDefaultSettings('/home/test'), alwaysForceDeleteWorktrees: true },
    worktreesByRepo: { [wt.repoId]: [wt] }
  })

  expect(
    await store.getState().removeWorktree({ id: wt.id, executionHostId: 'ssh:offline' }, false, {
      mode: 'forget-local'
    })
  ).toEqual({ ok: true })
  expect(mockApi.worktrees.forgetLocal).toHaveBeenCalledWith(
    expect.objectContaining({ worktreeId: wt.id })
  )
  expect(mockApi.worktrees.remove).not.toHaveBeenCalled()
  expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
})

it('deletes a preserved branch with its saved head when the branch preference is enabled', async () => {
  const store = createTestStore()
  const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1' })
  store.setState({
    settings: {
      ...getDefaultSettings('/home/test'),
      alwaysForceDeletePreservedBranches: true
    },
    worktreesByRepo: { [wt.repoId]: [wt] }
  })
  mockApi.worktrees.remove.mockResolvedValueOnce({
    preservedBranch: { branchName: 'feature/test', head: 'abc123' }
  })

  expect(await store.getState().removeWorktree({ id: wt.id, executionHostId: null })).toEqual({
    ok: true
  })
  expect(mockApi.worktrees.forceDeletePreservedBranch).toHaveBeenCalledWith({
    worktreeId: wt.id,
    branchName: 'feature/test',
    expectedHead: 'abc123',
    hostId: 'local'
  })
})

it('keeps a recoverable branch when automatic deletion fails', async () => {
  const store = createTestStore()
  const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1' })
  store.setState({
    settings: {
      ...getDefaultSettings('/home/test'),
      alwaysForceDeletePreservedBranches: true
    },
    worktreesByRepo: { [wt.repoId]: [wt] }
  })
  mockApi.worktrees.remove.mockResolvedValueOnce({
    preservedBranch: { branchName: 'feature/test', head: 'abc123' }
  })
  mockApi.worktrees.forceDeletePreservedBranch.mockRejectedValueOnce(new Error('branch moved'))

  expect(await store.getState().removeWorktree({ id: wt.id, executionHostId: null })).toEqual({
    ok: true,
    preservedBranch: { branchName: 'feature/test', head: 'abc123', hostId: 'local' }
  })
})

it('routes automatic branch deletion through the owner runtime', async () => {
  const store = createTestStore()
  const wt = makeWorktree({
    id: 'repo1::/path/wt1',
    repoId: 'repo1',
    hostId: 'runtime:env-1',
    runtimeOwnerEnvironmentId: 'env-1'
  })
  store.setState({
    settings: {
      ...getDefaultSettings('/home/test'),
      alwaysForceDeletePreservedBranches: true
    },
    worktreesByRepo: { [wt.repoId]: [wt] }
  })
  runtimeEnvironmentCall.mockImplementation(({ method }) => ({
    id: 'rpc-removal',
    ok: true,
    result:
      method === 'worktree.rm'
        ? { preservedBranch: { branchName: 'feature/remote', head: 'abc123' } }
        : { deleted: true },
    _meta: { runtimeId: 'runtime-remote' }
  }))

  expect(
    await store.getState().removeWorktree({ id: wt.id, executionHostId: 'runtime:env-1' })
  ).toEqual({ ok: true })
  expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
    expect.objectContaining({
      selector: 'env-1',
      method: 'worktree.forceDeleteBranch',
      params: expect.objectContaining({
        worktree: `id:${wt.id}`,
        branchName: 'feature/remote',
        expectedHead: 'abc123'
      })
    })
  )
})
