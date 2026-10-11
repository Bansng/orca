import { resolveSshQuickOpenDiscoveryOptions } from '../providers/ssh-quick-open-discovery-options'
import type { IFilesystemProvider } from '../providers/types'
import { QUICK_OPEN_LEGACY_REMOTE_RESULT_LIMIT } from './runtime-file-commands-mobile-file-list-limit'
import { QuickOpenPathRanker } from '../../shared/quick-open-path-search'

export async function searchRemoteQuickOpenFilePaths(
  rootPath: string,
  // `null` is "remote and currently unreachable": quick open reports no matches rather than
  // failing the keystroke, but it never falls back to searching this machine.
  provider: IFilesystemProvider | null,
  query: string,
  limit: number,
  excludePaths?: string[],
  signal?: AbortSignal,
  options: {
    includeIgnored?: boolean
    followSymlinks?: boolean
    allowLegacyIncludeIgnored?: boolean
  } = {}
): Promise<{ paths: string[]; totalCount: number; truncated: boolean }> {
  if (!provider) {
    return { paths: [], totalCount: 0, truncated: false }
  }
  const discovery = await resolveSshQuickOpenDiscoveryOptions(provider, options, signal)
  if (!(await provider.supportsQuickOpenSearch?.({ signal, minimumVersion: 1 }))) {
    // Old relays ignore searchQuery. Keep the compatibility request below the
    // 4 MiB frame ceiling even when legacy paths are near the 64 KiB path cap.
    const legacyFiles = await provider.listFiles(rootPath, {
      excludePaths,
      maxResults: QUICK_OPEN_LEGACY_REMOTE_RESULT_LIMIT,
      signal
    })
    const ranker = new QuickOpenPathRanker(query, limit)
    for (const file of legacyFiles) {
      ranker.consider(file)
    }
    const result = ranker.result()
    return {
      ...result,
      truncated:
        legacyFiles.length >= QUICK_OPEN_LEGACY_REMOTE_RESULT_LIMIT || result.totalCount > limit
    }
  }
  const files = await provider.listFiles(rootPath, {
    excludePaths,
    maxResults: limit + 1,
    ...discovery,
    searchQuery: query,
    signal
  })
  return {
    paths: files.slice(0, limit),
    totalCount: files.length,
    truncated: files.length > limit
  }
}
