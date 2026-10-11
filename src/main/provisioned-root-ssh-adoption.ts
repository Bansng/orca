import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import type {
  AdoptProvisionedRootArgs,
  CreateWorktreeResult
} from '../shared/worktree/create-types'
import type { AutomationWorkspaceProvenance } from '../shared/worktree/types'
import { isRuntimeOwnedSshTargetId, toSshExecutionHostId } from '../shared/execution-host'
import {
  getEphemeralVmRecipeResultCheckoutMode,
  getEphemeralVmRecipeResultProjectRoot
} from '../shared/ephemeral-vm-recipes'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { getSshGitProvider } from './providers/ssh-git-dispatch'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority
} from './ssh/ssh-provider-authority'
import { attachEphemeralVmRuntimeToWorkspace } from './ephemeral-vm-runtime-attachment'
import { mergeWorktree } from './ipc/worktree-logic'
import {
  buildProvisionedRootMeta,
  provisionedRootPathsEqual,
  verifyProvisionedRootCheckout
} from './provisioned-root-checkout'

type AdoptionArgs = AdoptProvisionedRootArgs & {
  automationProvenance?: AutomationWorkspaceProvenance
}

export async function adoptProvisionedRootSshCheckout(args: {
  userDataPath: string
  request: AdoptionArgs
  repo: Repo
  store: Store
  isRepoCurrent: () => boolean
}): Promise<CreateWorktreeResult> {
  const { request, repo, store } = args
  if (request.sparseCheckout) {
    throw new Error('Provisioned-root recipes do not support sparse checkout.')
  }
  const connectionId = repo.connectionId
  if (!connectionId || !isRuntimeOwnedSshTargetId(connectionId)) {
    throw new Error('Provisioned-root adoption requires a runtime-owned SSH target.')
  }
  if (request.executionHostId !== toSshExecutionHostId(connectionId)) {
    throw new Error('Provisioned-root workspace host does not match its SSH target.')
  }

  const runtime = requireOwnedProvisionedRootRuntime(
    args.userDataPath,
    request.runtimeId,
    connectionId
  )
  const projectRoot = getEphemeralVmRecipeResultProjectRoot(runtime.recipeResult)
  if (
    !provisionedRootPathsEqual(request.expectedPath, projectRoot) ||
    !provisionedRootPathsEqual(repo.path, projectRoot)
  ) {
    throw new Error('The recipe projectRoot does not match the imported Git checkout root.')
  }

  const provider = getSshGitProvider(connectionId)
  if (!provider) {
    throw new Error('The recipe-created SSH connection is no longer available.')
  }
  const authority = { ...getSshProviderAuthority(connectionId) }
  const [worktrees, sparseCheckoutEnabled] = await Promise.all([
    provider.listWorktrees(repo.path),
    isSparseCheckoutEnabled(provider, projectRoot)
  ])
  if (
    getSshGitProvider(connectionId) !== provider ||
    !isCurrentSshProviderAuthority(authority) ||
    !args.isRepoCurrent()
  ) {
    throw new Error('The recipe-created SSH connection changed during checkout verification.')
  }
  requireOwnedProvisionedRootRuntime(args.userDataPath, request.runtimeId, connectionId)

  const gitWorktree = verifyProvisionedRootCheckout({
    worktrees,
    sparseCheckoutEnabled,
    projectRoot,
    request
  })

  const worktreeId = `${repo.id}::${gitWorktree.path}`
  attachEphemeralVmRuntimeToWorkspace({
    userDataPath: args.userDataPath,
    runtimeId: request.runtimeId,
    workspaceId: worktreeId
  })
  const now = Date.now()
  const meta = store.setWorktreeMeta(
    worktreeId,
    buildProvisionedRootMeta(store, repo, request, {
      branchName: gitWorktree.branch.replace(/^refs\/heads\//, ''),
      now,
      hostId: args.request.executionHostId,
      source: 'ssh'
    })
  )
  return { worktree: mergeWorktree(repo.id, gitWorktree, meta) }
}

async function isSparseCheckoutEnabled(
  provider: NonNullable<ReturnType<typeof getSshGitProvider>>,
  projectRoot: string
): Promise<boolean> {
  const { stdout } = await provider.exec(
    ['config', '--bool', '--get', '--default=false', 'core.sparseCheckout'],
    projectRoot
  )
  return stdout.trim() === 'true'
}

function requireOwnedProvisionedRootRuntime(
  userDataPath: string,
  runtimeId: string,
  connectionId: string
): EphemeralVmRuntimeRecord {
  const runtime = listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === runtimeId)
  if (!runtime) {
    throw new Error(`Unknown ephemeral VM runtime: ${runtimeId}`)
  }
  if (
    runtime.connectionMode !== 'ssh' ||
    runtime.sshTargetId !== connectionId ||
    runtime.recipe?.checkoutMode !== 'provisioned-root' ||
    getEphemeralVmRecipeResultCheckoutMode(runtime.recipeResult) !== 'provisioned-root' ||
    ['cleanup_pending', 'cleanup_failed', 'cleaned'].includes(runtime.status)
  ) {
    throw new Error('The ephemeral VM runtime does not own this provisioned SSH checkout.')
  }
  return runtime
}
