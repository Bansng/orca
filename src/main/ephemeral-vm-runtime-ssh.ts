import { getSshFilesystemProvider } from './providers/ssh-filesystem-dispatch'
import { getSshGitProvider } from './providers/ssh-git-dispatch'
import { connectRegisteredSshTarget, getSshConnectionStore } from './ipc/ssh'
import {
  disconnectRegisteredSshTarget,
  removeRegisteredSshTarget
} from './ipc/ssh-session-teardown'
import type { EphemeralVmRecipeConnection } from '../shared/ephemeral-vm-recipes'
import type { SshTarget } from '../shared/ssh-types'

const SSH_PROVIDER_READY_TIMEOUT_MS = 10_000
const SSH_PROVIDER_READY_INTERVAL_MS = 100

export type RuntimeOwnedSshConnectionResult = {
  targetId: string
  target: SshTarget
  /** The managed Orca server that serves this host; absent when it is reached directly. */
  environmentId?: string
}

export async function connectRuntimeOwnedSshTarget(args: {
  runtimeId: string
  connection: Extract<EphemeralVmRecipeConnection, { type: 'ssh' }>
  signal?: AbortSignal
}): Promise<RuntimeOwnedSshConnectionResult> {
  const store = getSshConnectionStore()
  if (!store) {
    throw new Error('SSH handlers are not registered.')
  }
  const target = store.upsertRuntimeOwnedTarget(args.runtimeId, args.connection.target)
  let environmentId: string | undefined
  try {
    const state = await connectRegisteredSshTarget(target.id)
    if (state.status !== 'connected') {
      throw new Error(state.error || `SSH target did not connect: ${state.status}`)
    }
    if (state.managedServer?.kind === 'managed') {
      // Its server answers for the host; no direct providers are registered for it.
      environmentId = state.managedServer.environmentId
    } else {
      await waitForRuntimeSshProviders(target.id, args.signal)
    }
  } catch (error) {
    // The target is persisted at upsert, so a failed connect/provider-wait would
    // orphan it; remove it (idempotent) before rethrowing so cleanup is complete.
    await removeRuntimeOwnedSshTarget(target.id).catch(() => undefined)
    throw error
  }
  return { targetId: target.id, target, ...(environmentId ? { environmentId } : {}) }
}

export async function disconnectRuntimeOwnedSshTarget(targetId: string | undefined): Promise<void> {
  if (!targetId) {
    return
  }
  await disconnectRegisteredSshTarget(targetId)
}

export async function removeRuntimeOwnedSshTarget(targetId: string | undefined): Promise<void> {
  if (!targetId) {
    return
  }
  await removeRegisteredSshTarget(targetId)
}

async function waitForRuntimeSshProviders(targetId: string, signal?: AbortSignal): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < SSH_PROVIDER_READY_TIMEOUT_MS) {
    if (signal?.aborted) {
      throw new Error(`SSH provider wait aborted for target "${targetId}".`)
    }
    if (getSshGitProvider(targetId) && getSshFilesystemProvider(targetId)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, SSH_PROVIDER_READY_INTERVAL_MS))
  }
  throw new Error(`SSH relay providers were not ready for target "${targetId}".`)
}
