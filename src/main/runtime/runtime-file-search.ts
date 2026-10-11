import {
  QUICK_OPEN_SEARCH_VERSION,
  isQuickOpenQueryTooLarge
} from '../../shared/quick-open-path-search'
import type { RuntimeFileListResult } from '../../shared/runtime-types'
import type { SearchOptions, SearchResult } from '../../shared/code-search-types'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../../shared/quick-open-listing-limits'
import { limitQuickOpenFilesBySerializedBytes } from '../../shared/quick-open-transport-budget'
import { listQuickOpenFiles } from '../ipc/filesystem-list-files'
import { searchQuickOpenFilePaths as searchHostQuickOpenFilePaths } from '../ipc/filesystem-search-file-paths'
import type { IFilesystemProvider } from '../providers/types'
import { isMobileBinaryPath, isSafeMobileRelativePath } from './runtime-file-command-host'
import {
  requireRuntimeFileProvider,
  runtimeFileRouteForTarget,
  type RuntimeLocalFileHost,
  type ResolvedRuntimeFileTarget
} from './runtime-file-command-target'
import {
  MOBILE_FILE_LIST_LIMIT,
  MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT,
  MOBILE_FILE_PATH_SEARCH_CACHE_ENTRIES,
  MOBILE_FILE_PATH_SEARCH_CACHE_TTL_MS
} from './runtime-file-commands-mobile-file-list-limit'
import { basenameFromRelativePath } from './runtime-file-paths'
import {
  RuntimeMobileFilePathSearchCache,
  rankRuntimeMobileFilePaths
} from './runtime-mobile-file-path-search'
import { searchRemoteQuickOpenFilePaths } from './runtime-remote-quick-open-search'

type RuntimeFileSearchTarget = {
  worktree: Pick<ResolvedRuntimeFileTarget['worktree'], 'id' | 'path'>
  executionHostId: ResolvedRuntimeFileTarget['executionHostId']
}

export type RuntimeFileSearchHost = {
  requireStore: RuntimeLocalFileHost['requireStore']
  resolveRuntimeFileTarget(selector: string): Promise<RuntimeFileSearchTarget>
}

export class RuntimeFileSearch {
  private readonly mobileFilePathSearchCache = new RuntimeMobileFilePathSearchCache(
    MOBILE_FILE_PATH_SEARCH_CACHE_ENTRIES,
    MOBILE_FILE_PATH_SEARCH_CACHE_TTL_MS
  )

  constructor(private readonly host: RuntimeFileSearchHost) {}

  async listMobileFiles(
    worktreeSelector: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<RuntimeFileListResult> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    const route = runtimeFileRouteForTarget(target)
    const files =
      route.kind === 'ssh'
        ? await this.listRemoteMobileFiles(
            worktree.path,
            route.provider,
            MOBILE_FILE_LIST_LIMIT + 1,
            options.signal
          )
        : await listQuickOpenFiles(
            worktree.path,
            store,
            undefined,
            options.signal,
            MOBILE_FILE_LIST_LIMIT + 1
          )
    const entries = files
      .filter((relativePath) => isSafeMobileRelativePath(relativePath))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MOBILE_FILE_LIST_LIMIT)
      .map((relativePath) => ({
        relativePath,
        basename: basenameFromRelativePath(relativePath),
        kind: isMobileBinaryPath(relativePath) ? ('binary' as const) : ('text' as const)
      }))

    return {
      worktree: worktree.id,
      rootPath: worktree.path,
      files: entries,
      totalCount: files.length,
      truncated: files.length > MOBILE_FILE_LIST_LIMIT
    }
  }

  async searchMobileFilePaths(
    worktreeSelector: string,
    query: string,
    limit: number
  ): Promise<RuntimeFileListResult> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    const route = runtimeFileRouteForTarget(target)
    // Why: identical paths exist on local and on several SSH hosts; the cache key must name the
    // resolved host, which `connectionId` could not tell apart from "unresolved".
    const cacheKey = `${target.executionHostId}:${worktree.id}:${worktree.path}`
    const inventory = await this.mobileFilePathSearchCache.get(cacheKey, async () => {
      const listed =
        route.kind === 'ssh'
          ? await this.listRemoteMobileFiles(
              worktree.path,
              route.provider,
              MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT + 1
            )
          : await listQuickOpenFiles(
              worktree.path,
              store,
              undefined,
              undefined,
              MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT + 1
            )
      const safePaths = listed
        .filter((relativePath) => isSafeMobileRelativePath(relativePath))
        .sort((a, b) => a.localeCompare(b))
      return {
        paths: safePaths.slice(0, MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT),
        totalCount: safePaths.length,
        truncated: safePaths.length > MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT
      }
    })
    const matches = rankRuntimeMobileFilePaths(inventory.paths, query, limit)
    return {
      worktree: worktree.id,
      rootPath: worktree.path,
      files: matches.paths.map((relativePath) => ({
        relativePath,
        basename: basenameFromRelativePath(relativePath),
        kind: isMobileBinaryPath(relativePath) ? ('binary' as const) : ('text' as const)
      })),
      totalCount: matches.totalCount,
      truncated: inventory.truncated || matches.totalCount > limit
    }
  }

  async searchQuickOpenFilePaths(
    worktreeSelector: string,
    query: string,
    limit: number,
    excludePaths?: string[],
    signal?: AbortSignal,
    options: {
      includeIgnored?: boolean
      followSymlinks?: boolean
      allowLegacyIncludeIgnored?: boolean
    } = {}
  ): Promise<RuntimeFileListResult> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    const route = runtimeFileRouteForTarget(target)
    const quickOpenSearchVersion =
      route.kind !== 'ssh'
        ? QUICK_OPEN_SEARCH_VERSION
        : (await route.provider?.supportsQuickOpenSearch?.({ signal, minimumVersion: 3 }))
          ? 3
          : (await route.provider?.supportsQuickOpenSearch?.({ signal, minimumVersion: 2 }))
            ? 2
            : (await route.provider?.supportsQuickOpenSearch?.({ signal, minimumVersion: 1 }))
              ? 1
              : 0
    const result =
      !query.trim() || isQuickOpenQueryTooLarge(query)
        ? { paths: [], totalCount: 0, truncated: false }
        : route.kind === 'ssh'
          ? await searchRemoteQuickOpenFilePaths(
              worktree.path,
              route.provider,
              query,
              limit,
              excludePaths,
              signal,
              options
            )
          : await searchHostQuickOpenFilePaths(worktree.path, this.host.requireStore(), {
              ...options,
              query,
              limit,
              excludePaths,
              signal
            })
    return {
      worktree: worktree.id,
      rootPath: worktree.path,
      files: result.paths.map((relativePath) => ({
        relativePath,
        basename: basenameFromRelativePath(relativePath),
        kind: isMobileBinaryPath(relativePath) ? ('binary' as const) : ('text' as const)
      })),
      totalCount: result.totalCount,
      quickOpenSearchVersion,
      truncated: result.truncated
    }
  }

  async searchRuntimeFiles(
    worktreeSelector: string,
    options: Omit<SearchOptions, 'rootPath'>,
    requestOptions: { signal?: AbortSignal } = {}
  ): Promise<SearchResult> {
    throwIfSignalAborted(requestOptions.signal)
    const target = await waitForPromiseWithSignal(
      this.host.resolveRuntimeFileTarget(worktreeSelector),
      requestOptions.signal
    )
    throwIfSignalAborted(requestOptions.signal)
    const provider = requireRuntimeFileProvider(target, {
      requireStore: () => this.host.requireStore()
    })
    return provider.search({ ...options, rootPath: target.worktree.path }, requestOptions)
  }

  async listRuntimeFiles(
    worktreeSelector: string,
    options: {
      candidatePaths?: string[]
      includeIgnored?: boolean
      followSymlinks?: boolean
      excludePaths?: string[]
      maxContentBytes?: number
      maxResults?: number
      signal?: AbortSignal
    } = {}
  ): Promise<string[]> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const route = runtimeFileRouteForTarget(target)
    if (route.kind === 'ssh') {
      // Why: quick-open listings degrade to empty for an unreachable host rather than throwing.
      const provider = route.provider
      if (!provider) {
        return []
      }
      const maxResults =
        options.maxResults ??
        (options.maxContentBytes === undefined ? undefined : QUICK_OPEN_LISTING_MAX_RESULTS)
      if (
        (options.candidatePaths !== undefined ||
          options.includeIgnored === false ||
          options.followSymlinks) &&
        !(await provider.supportsQuickOpenSearch?.({
          signal: options.signal,
          minimumVersion: options.candidatePaths !== undefined ? 3 : 2
        }))
      ) {
        throw new Error(
          options.candidatePaths !== undefined
            ? 'Update the remote host to validate Quick Open recent files.'
            : 'Update the remote host to use Quick Open listing options.'
        )
      }
      const files = await provider.listFiles(target.worktree.path, {
        excludePaths: options.excludePaths,
        ...(options.candidatePaths === undefined ? {} : { candidatePaths: options.candidatePaths }),
        includeIgnored: options.includeIgnored,
        followSymlinks: options.followSymlinks,
        maxResults,
        signal: options.signal
      })
      return options.maxContentBytes === undefined
        ? files
        : limitQuickOpenFilesBySerializedBytes(files, options.maxContentBytes)
    }
    return listQuickOpenFiles(
      target.worktree.path,
      this.host.requireStore(),
      options.excludePaths,
      options.signal,
      options.maxResults,
      options.maxContentBytes,
      undefined,
      options
    )
  }

  // `null` provider is the caller's "this host is unreachable" answer, not "list it here".
  private async listRemoteMobileFiles(
    rootPath: string,
    provider: IFilesystemProvider | null,
    maxResults?: number,
    signal?: AbortSignal
  ): Promise<string[]> {
    if (!provider) {
      return []
    }
    return provider.listFiles(rootPath, { maxResults, signal })
  }
}
