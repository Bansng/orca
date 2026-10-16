import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export function getProviderRuntimeContextKey(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): string {
  return getEnvironmentRuntimeContextKey(settings?.activeRuntimeEnvironmentId?.trim() || null)
}

/** Context key for an explicit owner; `null` is this app. */
export function getEnvironmentRuntimeContextKey(environmentId: string | null): string {
  const baseKey = environmentId ? `runtime:${environmentId}` : 'local'
  return `${baseKey}#${providerRuntimeSessionGeneration}`
}

/** Whether a context key from {@link getEnvironmentRuntimeContextKey} names a paired server. */
export function isEnvironmentRuntimeContextKey(key: string | null | undefined): boolean {
  return key?.startsWith('runtime:') ?? false
}

/** The host a context key from {@link getEnvironmentRuntimeContextKey} was read from. */
export function runtimeTargetForContextKey(key: string): RuntimeClientTarget {
  const base = key.slice(0, key.lastIndexOf('#') === -1 ? key.length : key.lastIndexOf('#'))
  return base.startsWith('runtime:')
    ? { kind: 'environment', environmentId: base.slice('runtime:'.length) }
    : { kind: 'local' }
}

export function hasRemoteProviderRuntime(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): boolean {
  return Boolean(settings?.activeRuntimeEnvironmentId?.trim())
}

let providerRuntimeSessionGeneration = 0

export function bumpProviderRuntimeSessionGeneration(): number {
  providerRuntimeSessionGeneration += 1
  return providerRuntimeSessionGeneration
}
