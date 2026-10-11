import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validateGitExecArgs } from '../../relay/git-exec-validator'
import {
  getSshGitProviderMock,
  getActiveMultiplexerMock,
  removeWorktreeMock,
  forceDeleteLocalBranchMock,
  gitExecFileAsyncMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { materializeWorktreePushTargetRemoteSsh } from './worktree-remote'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import { makeWorktreeMeta, mockKnownFeatureWorktree } from './worktrees-test-fixtures'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('../providers/ssh-git-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshGitDispatchModuleMock()
)
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('./ssh', async () => (await import('./worktrees-test-module-mocks')).sshModuleMock())
vi.mock('../ssh/ssh-target-registry', async () =>
  (await import('./worktrees-test-module-mocks')).sshTargetRegistryModuleMock()
)
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

describe('registerWorktreeHandlers', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  // Was "adds the fork remote ... through git.exec": create used to mint the fork
  // remote unconditionally. It now defers to first sync (#17828) -- split in two so
  // each half stays true to a single claim: create stays a no-op, sync still mints.
  it('defers minting the fork remote for an SSH fork-PR worktree until first sync', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: 'origin/main'
    }
    // Why: run every exec through the relay's own validator so a create shape the
    // relay rejects fails here instead of on the user's SSH host.
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      validateGitExecArgs(args)
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'git@github.com:stablyai/orca.git\n', stderr: '' }
      }
      if (args[0] === 'remote' && args.length === 1) {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing exact ref'), { code: 1 })
      }
      return { stdout: '', stderr: '' }
    })
    const provider = {
      exec,
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-contributor-fix',
          head: 'abc123',
          branch: 'refs/heads/contributor/fix',
          isBare: false,
          isMainWorktree: false
        }
      ])
    }
    const mux = { request: vi.fn().mockResolvedValue(undefined), notify: vi.fn() }
    store.getRepos.mockReturnValue([repo])
    store.getRepo.mockReturnValue(repo)
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue(mux)
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)

    await handlers['worktrees:create'](null, {
      repoId: 'repo-ssh',
      name: 'contributor-fix',
      branchNameOverride: 'contributor/fix',
      pushTarget: {
        remoteName: 'pr-contributor-orca',
        branchName: 'contributor/fix',
        remoteUrl: 'https://github.com/contributor/orca.git'
      }
    })

    expect(exec).not.toHaveBeenCalledWith(
      ['remote', 'add', 'pr-contributor-orca', 'https://github.com/contributor/orca.git'],
      '/remote/repo'
    )
    // fetchRemoteTrackingRef IS called once here, but for create's unrelated
    // base-ref refresh (origin/main) -- not for the fork remote, which defers.
    expect(provider.fetchRemoteTrackingRef).not.toHaveBeenCalledWith(
      '/remote/repo',
      'pr-contributor-orca',
      'contributor/fix',
      'refs/remotes/pr-contributor-orca/contributor/fix'
    )
    expect(store.setWorktreeMeta).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        pushTarget: {
          remoteName: 'pr-contributor-orca',
          branchName: 'contributor/fix',
          remoteUrl: 'https://github.com/contributor/orca.git'
        }
      })
    )
  })

  // Companion to the deferral test above: `materializeWorktreePushTargetRemoteSsh` is
  // exactly what `git:push`/`git:pull`'s SSH dispatch calls before syncing, so this is
  // "first sync" without needing the sync IPC handlers registered in this harness.
  it('mints the fork remote for an SSH fork-PR worktree on first sync', async () => {
    const exec = vi.fn().mockImplementation(async (args: string[]) => {
      validateGitExecArgs(args)
      if (args[0] === 'remote' && args[1] === 'get-url') {
        throw new Error('No such remote')
      }
      if (args[0] === 'remote' && args.length === 1) {
        return { stdout: 'origin\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const fetchRemoteTrackingRef = vi.fn().mockResolvedValue(undefined)
    const markRemoteOrcaCreated = vi.fn().mockResolvedValue(undefined)
    const target = {
      remoteName: 'pr-contributor-orca',
      branchName: 'contributor/fix',
      remoteUrl: 'https://github.com/contributor/orca.git'
    }

    const result = await materializeWorktreePushTargetRemoteSsh(
      { exec, fetchRemoteTrackingRef, markRemoteOrcaCreated } as unknown as SshGitProvider,
      '/remote/repo',
      target
    )

    expect(result).toEqual({ ...target, remoteCreated: true })
    expect(exec).toHaveBeenCalledWith(
      ['remote', 'add', 'pr-contributor-orca', 'https://github.com/contributor/orca.git'],
      '/remote/repo'
    )
    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/remote/repo',
      'pr-contributor-orca',
      'contributor/fix',
      'refs/remotes/pr-contributor-orca/contributor/fix'
    )
    expect(markRemoteOrcaCreated).toHaveBeenCalledWith('/remote/repo', 'pr-contributor-orca')
  })

  // The relay-upgrade-messaging, fetch-failure rollback, and sibling-remote-preserved
  // cases used to be exercised here because create minted the remote unconditionally.
  // That code (prepareWorktreePushTargetSsh) is unchanged -- it just no longer runs at
  // create time for a fork remote, only from materializeWorktreePushTargetRemoteSsh on
  // first sync. Coverage for all three moved with it to
  // worktree-remote-push-target-materialization.test.ts, which calls that function directly.
})

describe('worktree preserved branch fork remotes', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  it('preserves the branch on remove for worktrees created from an existing local branch', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue(undefined)
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ preserveBranchOnDelete: true }))

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(removeWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/feature-wt',
      false,
      expect.objectContaining({
        deleteBranch: false,
        knownRemovedWorktree: expect.objectContaining({
          branch: 'feature',
          head: 'feature',
          path: '/workspace/feature-wt'
        })
      })
    )
  })

  it('force-deletes a branch that was preserved by safe worktree removal', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue({
      preservedBranch: { branchName: 'feature/test', head: 'def456' }
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })
    const result = await handlers['worktrees:forceDeletePreservedBranch'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt',
      branchName: 'feature/test',
      expectedHead: 'def456'
    })

    expect(result).toMatchObject({ deleted: true })
    expect(forceDeleteLocalBranchMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'feature/test',
      'def456'
    )
  })

  it('force-deletes a preserved SSH branch without borrowing colliding local metadata', async () => {
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'ssh',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1',
      worktreeBaseRef: null
    }
    const worktreeId = 'repo-ssh::/remote/feature-wt'
    const localRepo = { ...repo, path: '/workspace/repo', connectionId: undefined }
    const provider = {
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      forceDeletePreservedBranch: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: repo.path,
          head: 'main',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature-wt',
          head: 'def456',
          branch: 'feature/test',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue({
        preservedBranch: { branchName: 'feature/test', head: 'def456' }
      }),
      worktreeIsClean: vi.fn().mockResolvedValue({ clean: true })
    }
    store.getRepos.mockReturnValue([localRepo, repo])
    store.getRepo.mockReturnValue(localRepo)
    store.getWorktreeMeta.mockReturnValue(
      makeWorktreeMeta({ hostId: 'local', preserveBranchOnDelete: true })
    )
    getSshGitProviderMock.mockReturnValue(provider)
    getActiveMultiplexerMock.mockReturnValue({ request: vi.fn(), notify: vi.fn() })

    await handlers['worktrees:remove'](null, { worktreeId, hostId: 'ssh:conn-1' })
    expect(provider.removeWorktree).toHaveBeenCalledWith('/remote/feature-wt', undefined)
    const result = await handlers['worktrees:forceDeletePreservedBranch'](null, {
      worktreeId,
      branchName: 'feature/test',
      expectedHead: 'def456',
      hostId: 'ssh:conn-1'
    })

    expect(result).toMatchObject({ deleted: true })
    expect(provider.forceDeletePreservedBranch).toHaveBeenCalledWith(
      '/remote/repo',
      'feature/test',
      'def456'
    )
    expect(forceDeleteLocalBranchMock).not.toHaveBeenCalled()
  })

  it('rejects stale preserved-branch cleanup actions with an old head', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue({
      preservedBranch: { branchName: 'feature/test', head: 'new456' }
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    await expect(
      handlers['worktrees:forceDeletePreservedBranch'](null, {
        worktreeId: 'repo-1::/workspace/feature-wt',
        branchName: 'feature/test',
        expectedHead: 'old123'
      })
    ).rejects.toThrow('No preserved branch cleanup is pending')
    expect(forceDeleteLocalBranchMock).not.toHaveBeenCalled()
  })

  it('removes an unused Orca-created fork remote after deleting its worktree', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue(undefined)
    const pushTarget = {
      remoteName: 'pr-contributor-orca',
      branchName: 'feature/from-fork',
      remoteUrl: 'https://github.com/contributor/orca.git',
      remoteCreated: true
    }
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ pushTarget }))
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-1::/workspace/feature-wt': makeWorktreeMeta({ pushTarget })
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'config') {
        throw new Error('no branch config')
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'https://github.com/contributor/orca.git\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'remove', 'pr-contributor-orca'], {
      cwd: '/workspace/repo'
    })
  })

  it('keeps an Orca-created fork remote while another worktree still uses it', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue(undefined)
    const pushTarget = {
      remoteName: 'pr-contributor-orca',
      branchName: 'feature/from-fork',
      remoteUrl: 'https://github.com/contributor/orca.git',
      remoteCreated: true
    }
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ pushTarget }))
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-1::/workspace/feature-wt': makeWorktreeMeta({ pushTarget }),
      'repo-1::/workspace/other-wt': makeWorktreeMeta({
        pushTarget: {
          ...pushTarget,
          branchName: 'other-branch'
        }
      })
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['remote', 'remove', 'pr-contributor-orca'],
      expect.any(Object)
    )
  })

  it('ignores matching push targets from other repos when deciding fork remote cleanup', async () => {
    mockKnownFeatureWorktree()
    removeWorktreeMock.mockResolvedValue(undefined)
    const pushTarget = {
      remoteName: 'pr-contributor-orca',
      branchName: 'feature/from-fork',
      remoteUrl: 'https://github.com/contributor/orca.git',
      remoteCreated: true
    }
    store.getWorktreeMeta.mockReturnValue(makeWorktreeMeta({ pushTarget }))
    store.getAllWorktreeMeta.mockReturnValue({
      'repo-1::/workspace/feature-wt': makeWorktreeMeta({ pushTarget }),
      'repo-2::/workspace/other-wt': makeWorktreeMeta({
        pushTarget: {
          ...pushTarget,
          branchName: 'other-branch'
        }
      })
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'config') {
        throw new Error('no branch config')
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'https://github.com/contributor/orca.git\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await handlers['worktrees:remove'](null, {
      worktreeId: 'repo-1::/workspace/feature-wt'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'remove', 'pr-contributor-orca'], {
      cwd: '/workspace/repo'
    })
  })
})
