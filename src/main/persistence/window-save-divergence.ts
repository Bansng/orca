// A layout-owner build's check that the window's session saves no longer carry layout: every tab
// change should reach main as a command, so a save that changes main's layout model is a change
// main learned only from the save. Dark: reports only, never alters or fails the write.

import { appendFileSync } from 'node:fs'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { loadWorkspaceLayoutWithoutReport } from '../../shared/workspace-layout/workspace-layout-load'
import { stableJson } from '../../shared/workspace-layout/workspace-layout-load-report'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import type {
  WorkspaceLayout,
  WorkspaceLayoutModel
} from '../../shared/workspace-layout/workspace-layout-model'
import type { TabGroupLayoutNode } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/** Set by evidence runs: each divergence is appended there as one JSON line. */
const LOG_PATH_ENV = 'ORCA_LAYOUT_SAVE_DIVERGENCE_LOG'
const MAX_PATHS = 12
const RECORDS = ['defaultTabsAppliedByWorkspace', 'clientHostedBrowserPagesByWorkspace'] as const
/** A pane's terminal binding: it still reaches main only through saves, on every spawn. */
const BINDING_FIELDS = new Set(['ptyId', 'incarnationId'])

export type WindowSaveDivergence = { workspace: string; paths: string[] }

type WorkspaceDiff = { paths: string[]; rebound: number }

/** Main's layout model of one partition, as the session holds it. */
export function layoutModelOf(
  session: WorkspaceSessionState | null | undefined,
  hostId: ExecutionHostId
): WorkspaceLayoutModel | null {
  return session
    ? loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext()).layout
    : null
}

/** The fields two copies of one record differ in. */
function changedFields(before: unknown, after: unknown): string[] {
  if (typeof before !== 'object' || typeof after !== 'object' || !before || !after) {
    return stableJson(before ?? null) === stableJson(after ?? null) ? [] : ['value']
  }
  const was = new Map(Object.entries(before))
  const now = new Map(Object.entries(after))
  return [...new Set([...was.keys(), ...now.keys()])].filter(
    (key) => stableJson(was.get(key) ?? null) !== stableJson(now.get(key) ?? null)
  )
}

function diffKeyed(
  prefix: string,
  before: Map<string, unknown>,
  after: Map<string, unknown>
): string[] {
  const paths: string[] = []
  for (const [id, item] of after) {
    if (!before.has(id)) {
      paths.push(`${prefix} ${id} added`)
      continue
    }
    const fields = changedFields(before.get(id), item)
    if (fields.length > 0) {
      paths.push(`${prefix} ${id} changed: ${fields.join(', ')}`)
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) {
      paths.push(`${prefix} ${id} removed`)
    }
  }
  return paths
}

function listById<T>(items: readonly T[] | undefined, id: (item: T) => string) {
  return new Map<string, unknown>((items ?? []).map((item) => [id(item), item]))
}

function recordById(items: Readonly<Record<string, unknown>> | undefined) {
  return new Map<string, unknown>(Object.entries(items ?? {}))
}

function bindingOnly(leaf: unknown): boolean {
  return (
    typeof leaf === 'object' &&
    leaf !== null &&
    Object.keys(leaf).every((key) => BINDING_FIELDS.has(key))
  )
}

/** Panes whose only change is their terminal binding, first bind and unbind included. */
function reboundLeaves(
  before: Readonly<Record<string, unknown>> | undefined,
  after: Readonly<Record<string, unknown>> | undefined
): { rebound: Set<string>; was: Map<string, unknown>; now: Map<string, unknown> } {
  const was = recordById(before)
  const now = recordById(after)
  const rebound = new Set<string>()
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    const old = was.get(id)
    const next = now.get(id)
    const changed = old === undefined || next === undefined ? null : changedFields(old, next)
    if (
      changed
        ? changed.length > 0 && changed.every((field) => BINDING_FIELDS.has(field))
        : bindingOnly(old ?? next)
    ) {
      rebound.add(id)
      was.delete(id)
      now.delete(id)
    }
  }
  return { rebound, was, now }
}

/** A lone group with no stored tree is that group's leaf, as main's own save writes it. */
function groupTreeOf(workspace: WorkspaceLayout): TabGroupLayoutNode | null {
  const [only, ...rest] = workspace.groups
  return (
    workspace.groupLayout ?? (only && rest.length === 0 ? { type: 'leaf', groupId: only.id } : null)
  )
}

/** What a save changed in one workspace of main's model; empty paths and no rebound when nothing. */
export function diffWorkspaceLayouts(
  before: WorkspaceLayout | undefined,
  after: WorkspaceLayout | undefined
): WorkspaceDiff {
  if (!before || !after) {
    return {
      paths: before === after ? [] : [after ? 'workspace added' : 'workspace removed'],
      rebound: 0
    }
  }
  const leaves = reboundLeaves(before.leaves, after.leaves)
  const paths = [
    ...diffKeyed(
      'group',
      listById(before.groups, (g) => g.id),
      listById(after.groups, (g) => g.id)
    ),
    ...diffKeyed(
      'tab',
      listById(before.tabs, (t) => t.id),
      listById(after.tabs, (t) => t.id)
    ),
    ...diffKeyed(
      'file',
      listById(before.editorFiles, (f) => f.filePath),
      listById(after.editorFiles, (f) => f.filePath)
    ),
    ...diffKeyed('editor view', recordById(before.editorViews), recordById(after.editorViews)),
    ...diffKeyed(
      'browser',
      listById(before.browserTabs, (b) => b.id),
      listById(after.browserTabs, (b) => b.id)
    ),
    ...diffKeyed(
      'closed tab',
      recordById(before.closedTerminalTabs),
      recordById(after.closedTerminalTabs)
    ),
    ...diffKeyed('leaf', leaves.was, leaves.now)
  ]
  if (stableJson(groupTreeOf(before)) !== stableJson(groupTreeOf(after))) {
    paths.push('group layout changed')
  }
  return { paths, rebound: leaves.rebound.size }
}

/** Each workspace whose part of main's model differs between two copies of one partition. */
export function windowSaveDivergences(
  was: WorkspaceLayoutModel | null,
  now: WorkspaceLayoutModel | null
): WindowSaveDivergence[] {
  // Records count for a workspace with no tabs too.
  const workspaces = new Set(
    [was, now].flatMap((model) =>
      model
        ? [
            ...Object.keys(model.workspaces),
            ...RECORDS.flatMap((record) => Object.keys(model.records[record] ?? {})),
            ...Object.keys(model.legacy.terminalRowOwners)
          ]
        : []
    )
  )
  const result: WindowSaveDivergence[] = []
  for (const workspace of workspaces) {
    const { paths, rebound } = diffWorkspaceLayouts(
      was?.workspaces[workspace],
      now?.workspaces[workspace]
    )
    for (const record of RECORDS) {
      if (
        stableJson(was?.records[record]?.[workspace] ?? null) !==
        stableJson(now?.records[record]?.[workspace] ?? null)
      ) {
        paths.push(`${record} changed`)
      }
    }
    if (
      Boolean(was?.legacy.terminalRowOwners[workspace]) !==
      Boolean(now?.legacy.terminalRowOwners[workspace])
    ) {
      paths.push('terminal row owner changed')
    }
    // The binding count goes last and is never cut, so it crowds out no structural change.
    const shown =
      rebound > 0
        ? [...paths.slice(0, MAX_PATHS - 1), `${rebound} pane(s) rebound`]
        : paths.slice(0, MAX_PATHS)
    if (shown.length > 0) {
      result.push({ workspace, paths: shown })
    }
  }
  return result
}

function report(source: string, partition: ExecutionHostId, divergence: WindowSaveDivergence) {
  console.warn('[layout-owner] window save changed main layout:', source, divergence)
  const logPath = process.env[LOG_PATH_ENV]
  if (!logPath) {
    return
  }
  try {
    appendFileSync(
      logPath,
      `${JSON.stringify({ at: Date.now(), source, partition, ...divergence })}\n`
    )
  } catch (error) {
    console.warn('[layout-owner] save divergence log write failed:', error)
  }
}

/**
 * Runs the window's save `write` and reports what it changed in main's layout model. A paired
 * server's partition is skipped: its layout is the server's, mirrored by the window. Nothing here
 * can fail the save: the write's own errors propagate, the check's are only logged.
 */
export function writeWindowSaveWatchingLayout(
  read: () => WorkspaceSessionState | null | undefined,
  hostId: string | null | undefined,
  write: () => void,
  source: string
): void {
  const partition = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  if (parseExecutionHostId(partition)?.kind === 'runtime') {
    write()
    return
  }
  let was: WorkspaceLayoutModel | null | undefined
  try {
    was = layoutModelOf(read(), partition)
  } catch (error) {
    console.warn('[layout-owner] save divergence check failed:', error)
  }
  write()
  if (was === undefined) {
    return
  }
  try {
    for (const divergence of windowSaveDivergences(was, layoutModelOf(read(), partition))) {
      report(source, partition, divergence)
    }
  } catch (error) {
    console.warn('[layout-owner] save divergence check failed:', error)
  }
}
