import { join } from 'node:path'

export const OPENCODE_LEGACY_HOOKS_DIR = 'opencode-hooks'
export const OPENCODE2_LEGACY_HOOKS_DIR = 'opencode2-hooks'

// Why: before 1.4.209 Orca pointed OPENCODE_CONFIG_DIR at this dir; shells and OpenCode 2 background services from then can still load it.
export function getOpenCodeLegacySharedConfigDir(
  userDataPath: string,
  legacyHooksDir: string
): string {
  return join(userDataPath, legacyHooksDir, 'shared')
}

export function isOpenCodeLegacySharedConfigDir(
  configDir: string | undefined,
  userDataPath: string
): boolean {
  return (
    configDir !== undefined &&
    [OPENCODE_LEGACY_HOOKS_DIR, OPENCODE2_LEGACY_HOOKS_DIR].some(
      (hooksDir) => configDir === getOpenCodeLegacySharedConfigDir(userDataPath, hooksDir)
    )
  )
}
