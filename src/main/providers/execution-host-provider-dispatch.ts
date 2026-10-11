/**
 * Host-keyed provider dispatch: one route per execution host kind, `local` included.
 *
 * The input is an `ExecutionHostId`, never null, and an id that names no host throws instead of
 * degrading to `local`, so work whose host is unknown never runs on this client (#11163). The
 * resolution layer (`getRepoExecutionHostId`, `getWorktreeExecutionHostId`,
 * `resolveWorktreeExecutionHost`) reports `unresolved` as its own verdict.
 *
 * Each kind is its own variant so callers switch exhaustively:
 *   - `local` git and filesystem routes carry a per-call factory, because they need per-worktree
 *     options (WSL distro, shared links, admission tier) a shared provider would drop.
 *   - `runtime:<env>` is forwarded to that server. Its repo's `connectionId` names the server's SSH
 *     target, so it must never reach this client's SSH table.
 *   - `ssh` with `provider: null` means "remote and unreachable", never "local".
 */

import {
  parseExecutionHostId,
  type ExecutionHostId,
  type LOCAL_EXECUTION_HOST_ID,
  type ParsedExecutionHost
} from '../../shared/execution-host'
import { createLocalFilesystemProvider } from './local-filesystem-provider'
import { createLocalGitProvider } from './local-git-provider'
import { getSshGitProvider, sshGitProviderMissingError } from './ssh-git-dispatch'
import type { SshGitProvider } from './ssh-git-provider'
import {
  getSshFilesystemProvider,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
} from './ssh-filesystem-dispatch'
import type { IFilesystemProvider, IGitProvider } from './types'

/** An id that names no execution host. Never degrade to local — that is the whole defect class. */
export class UnresolvableExecutionHostError extends Error {
  constructor(readonly hostId: string | null | undefined) {
    super(
      `Cannot route work: ${JSON.stringify(hostId ?? null)} names no execution host. ` +
        'Refusing to fall back to this machine.'
    )
    this.name = 'UnresolvableExecutionHostError'
  }
}

/** Asking this process for a host it does not execute is a routing mistake, not a fallback. */
export class ExecutionHostNotDispatchableError extends Error {
  constructor(readonly hostId: ExecutionHostId) {
    super(`Execution host ${hostId} is not dispatched by this process.`)
    this.name = 'ExecutionHostNotDispatchableError'
  }
}

type LocalRoute = { kind: 'local'; hostId: typeof LOCAL_EXECUTION_HOST_ID }
/** Local git needs per-worktree options (WSL distro, shared links), so the route carries a factory. */
type LocalGitRoute = LocalRoute & { createProvider: typeof createLocalGitProvider }
/** Local file work authorizes against the caller's store, so the route carries a factory too. */
type LocalFilesystemRoute = LocalRoute & { createProvider: typeof createLocalFilesystemProvider }
type RuntimeRoute = { kind: 'runtime'; hostId: `runtime:${string}`; environmentId: string }
type SshRoute<TProvider> = {
  kind: 'ssh'
  hostId: `ssh:${string}`
  connectionId: string
  /** `null` is "remote, currently unreachable" — never "local". */
  provider: TProvider | null
}

// The SSH table stores `SshGitProvider`; narrowing the route to `IGitProvider` would drop the
// remote-only methods (commit-message plans, push-target materialization) that callers need.
export type ExecutionHostGitRoute = LocalGitRoute | RuntimeRoute | SshRoute<SshGitProvider>
export type ExecutionHostFilesystemRoute =
  | LocalFilesystemRoute
  | RuntimeRoute
  | SshRoute<IFilesystemProvider>

// Takes an unvalidated string rather than `ExecutionHostId`: validating is the point, and host
// ids also arrive from persistence and IPC where the compiler cannot vouch for them.
function parseRoutableHost(hostId: string | null | undefined): ParsedExecutionHost {
  const parsed = parseExecutionHostId(hostId)
  if (!parsed) {
    throw new UnresolvableExecutionHostError(hostId)
  }
  return parsed
}

export function resolveGitRouteForHost(hostId: string | null | undefined): ExecutionHostGitRoute {
  const parsed = parseRoutableHost(hostId)
  switch (parsed.kind) {
    case 'local':
      return { kind: 'local', hostId: parsed.id, createProvider: createLocalGitProvider }
    case 'ssh':
      return {
        kind: 'ssh',
        hostId: parsed.id,
        connectionId: parsed.targetId,
        provider: getSshGitProvider(parsed.targetId) ?? null
      }
    case 'runtime':
      return { kind: 'runtime', hostId: parsed.id, environmentId: parsed.environmentId }
  }
}

export function resolveFilesystemRouteForHost(
  hostId: string | null | undefined
): ExecutionHostFilesystemRoute {
  const parsed = parseRoutableHost(hostId)
  switch (parsed.kind) {
    case 'local':
      return { kind: 'local', hostId: parsed.id, createProvider: createLocalFilesystemProvider }
    case 'ssh':
      return {
        kind: 'ssh',
        hostId: parsed.id,
        connectionId: parsed.targetId,
        provider: getSshFilesystemProvider(parsed.targetId) ?? null
      }
    case 'runtime':
      return { kind: 'runtime', hostId: parsed.id, environmentId: parsed.environmentId }
  }
}

type ReachableSshRoute<TProvider> = SshRoute<TProvider> & { provider: TProvider }
export type ReachableGitRoute = LocalGitRoute | ReachableSshRoute<SshGitProvider>
export type ReachableFilesystemRoute = LocalFilesystemRoute | ReachableSshRoute<IFilesystemProvider>

/** For work this process runs itself: `runtime:` and an unreachable SSH host throw, never run here. */
export function requireReachableGitRoute(hostId: string | null | undefined): ReachableGitRoute {
  const route = resolveGitRouteForHost(hostId)
  switch (route.kind) {
    case 'local':
      return route
    case 'ssh': {
      const { provider } = route
      if (!provider) {
        throw sshGitProviderMissingError(route.connectionId)
      }
      return { ...route, provider }
    }
    case 'runtime':
      throw new ExecutionHostNotDispatchableError(route.hostId)
  }
}

export function requireReachableFilesystemRoute(
  hostId: string | null | undefined
): ReachableFilesystemRoute {
  const route = resolveFilesystemRouteForHost(hostId)
  switch (route.kind) {
    case 'local':
      return route
    case 'ssh': {
      const { provider } = route
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return { ...route, provider }
    }
    case 'runtime':
      throw new ExecutionHostNotDispatchableError(route.hostId)
  }
}

/** For call sites that are structurally remote-only: local and runtime are both routing errors. */
export function requireGitProviderForHost(hostId: string | null | undefined): IGitProvider {
  const route = requireReachableGitRoute(hostId)
  if (route.kind !== 'ssh') {
    throw new ExecutionHostNotDispatchableError(route.hostId)
  }
  return route.provider
}

export function requireFilesystemProviderForHost(
  hostId: string | null | undefined
): IFilesystemProvider {
  const route = requireReachableFilesystemRoute(hostId)
  if (route.kind !== 'ssh') {
    throw new ExecutionHostNotDispatchableError(route.hostId)
  }
  return route.provider
}
