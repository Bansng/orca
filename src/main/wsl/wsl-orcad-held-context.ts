import { resolveOrcadRemoteContext } from '../managed-server/install/orcad-remote-context'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import type { WslDistroHolder } from './wsl-distro-holder'
import { refuseMissingWslDistro, WslDistroVersion1Error } from './wsl-distro-unsupported'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'

/** WSL 1 runs no Linux kernel, so the pinned Node and its pty cannot run there. */
export function isWsl1KernelRelease(release: string): boolean {
  return /^\d+\.\d+\.\d+-\d+-Microsoft$/.test(release.trim())
}

/**
 * Refuses WSL 1, then acquires the holder alongside the read-only context probes: the kernel probe
 * already started the distro, so the holder spawns nothing extra, and it is held before the caller
 * may launch orcad (recovery included) or WSL could idle-stop its distro.
 */
export async function holdWslDistroWithContext(
  name: string,
  target: WslOrcadHostTarget,
  conn: OrcadHostTransport,
  holder: WslDistroHolder,
  signal: AbortSignal | undefined
) {
  const kernel = await execCommand(conn, 'uname -r', { signal }).catch(refuseMissingWslDistro(name))
  if (isWsl1KernelRelease(kernel)) {
    throw new WslDistroVersion1Error(name)
  }
  // Once the hold fails, stop the probes: after dispose they fall back to fresh wsl.exe execs,
  // which would boot a distro that just went away (E9).
  const probes = new AbortController()
  if (signal?.aborted) {
    probes.abort(signal.reason)
  }
  const stopProbes = (): void => probes.abort(signal?.reason)
  signal?.addEventListener('abort', stopProbes, { once: true })
  try {
    const [held, context] = await Promise.all([
      holder.ensureHeld(name).catch((error: unknown) => {
        probes.abort(error)
        throw error
      }),
      resolveOrcadRemoteContext(target, conn, probes.signal)
    ])
    return { held, context }
  } catch (error) {
    probes.abort(error)
    throw error
  } finally {
    signal?.removeEventListener('abort', stopProbes)
  }
}
