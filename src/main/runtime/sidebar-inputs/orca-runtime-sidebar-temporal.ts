import { OrcaRuntimeWithWorkspaceReviewFacts } from './orca-runtime-workspace-review-facts'
import type { OrcaRuntimeWithMigrationCatalog } from '../orca-runtime-migration-catalog'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import { DEFAULT_HIDE_SLEEPING_WORKSPACES } from '../../../shared/constants'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { detectAgentStatusFromTitle } from '../../../shared/agent-detection'
import type { SidebarTemporalSnapshot } from '../../../shared/sidebar-list/sidebar-temporal-snapshot'
import { getMigrationUnsupportedPtySnapshot } from '../../agent-hooks/migration-unsupported-pty-state'
import {
  SidebarTemporalOwner,
  type SidebarRetentionCandidates,
  type SidebarSortSample
} from './sidebar-temporal-owner'
import { SmartSortAgentEntries } from './smart-sort-agent-entries'
import { buildRuntimeSmartSortSources } from './runtime-smart-sort-sources'
import type { AgentStatusStoreView } from './workspace-activity-facts-producer'

type Runtime = OrcaRuntimeWithWorkspaceReviewFacts

/**
 * Feeds main's temporal owner. Its sort inputs restart the settle window where the window's
 * sortEpoch bumps and main can see the cause: catalog changes, agent rows, and pane titles.
 */
export abstract class OrcaRuntimeWithSidebarTemporal extends OrcaRuntimeWithWorkspaceReviewFacts {
  private readonly smartSortAgentEntries = new SmartSortAgentEntries()
  private readonly sidebarTemporal = new SidebarTemporalOwner(this.sidebarClock, {
    sortBy: () => this.store?.getUI?.().sortBy ?? 'smart',
    // The durable file keeps the hide form; the window reads it the same way at hydration.
    showSleepingWorkspaces: () =>
      !(this.store?.getUI?.().hideSleepingWorkspaces ?? DEFAULT_HIDE_SLEEPING_WORKSPACES),
    readSortSample: () => this.readSidebarSortSample(),
    retentionCandidates: () => this.readSidebarRetentionCandidates()
  })

  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithWorkspaceReviewFacts>) {
    super(...args)
    this.workspaceActivityFacts.onChange(() => this.sidebarTemporal.noteActivityChange())
    this.store?.onUIChanged?.(() => this.sidebarTemporal.noteViewChange())
    // Every catalog change, from IPC or the runtime, reaches clients through this one bus.
    this.clientEvents.on(
      (event) => {
        if (event.type === 'worktreesChanged') {
          this.noteSidebarRowsChange()
        } else if (event.type === 'reposChanged') {
          this.sidebarTemporal.noteRepoChange()
        }
      },
      { consumesTerminalSideEffects: false }
    )
  }

  // Whether rows came or went decides if the change settles at once, so count after it lands.
  // The count can come from a listing cached just before the change; the change then settles late.
  private noteSidebarRowsChange(): void {
    if (!this.sidebarTemporal.running) {
      return
    }
    void this.listResolvedWorktreeSnapshot().then(
      ({ worktrees }) =>
        this.sidebarTemporal.noteRowsChange(
          worktrees.filter((worktree) => !worktree.isArchived).length
        ),
      (error: unknown) => console.warn('[sidebar-temporal] could not count rows', error)
    )
  }

  getSidebarTemporalSnapshot(): SidebarTemporalSnapshot {
    return this.sidebarTemporal.snapshot()
  }

  beginSidebarListSession(sessionId: string): void {
    this.sidebarTemporal.beginSession(sessionId)
  }

  /** Attaches every sidebar producer that reads the hook server's store. */
  attachSidebarAgentStatusStore(store: AgentStatusStoreView): () => void {
    const detachActivity = this.workspaceActivityFacts.attachAgentStatusStore(store)
    const detachEntries = this.smartSortAgentEntries.attach(store, () =>
      this.sidebarTemporal.noteSortInputChange()
    )
    return () => {
      detachActivity()
      detachEntries()
      this.sidebarTemporal.dispose()
    }
  }

  override syncWindowGraph(...args: Parameters<Runtime['syncWindowGraph']>) {
    if (!this.sidebarTemporal.running) {
      return super.syncWindowGraph(...args)
    }
    const before = this.readSidebarGraphSortCauses()
    const result = super.syncWindowGraph(...args)
    const after = this.readSidebarGraphSortCauses()
    // A title's reading counts both ways; a tab only re-sorts when it gains its first terminal.
    const resorts = (key: string): boolean =>
      key.startsWith('title:')
        ? (before.get(key) ?? '') !== (after.get(key) ?? '')
        : after.has(key) && !before.has(key)
    if ([...new Set([...before.keys(), ...after.keys()])].some(resorts)) {
      this.sidebarTemporal.noteSortInputChange()
    }
    return result
  }

  /**
   * What a graph sync can change that the window re-sorts on: a pane title's agent reading on a
   * workspace not in front, and the first live terminal of a tab in the workspace in front.
   */
  private readSidebarGraphSortCauses(): Map<string, string> {
    const active = this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)?.activeWorktreeId
    const causes = new Map<string, string>()
    for (const leaf of this.leaves.values()) {
      if (leaf.worktreeId === active) {
        if (leaf.ptyId) {
          causes.set(`pty:${leaf.tabId}`, 'live')
        }
      } else if (leaf.paneTitle) {
        causes.set(
          `title:${leaf.tabId}:${leaf.paneRuntimeId}`,
          detectAgentStatusFromTitle(leaf.paneTitle) ?? ''
        )
      }
    }
    return causes
  }

  private async readSidebarSortSample(): Promise<SidebarSortSample> {
    const { worktrees } = await this.listResolvedWorktreeSnapshot()
    const repoMap = new Map((this.store?.getRepos() ?? []).map((repo) => [repo.id, repo]))
    return {
      // Ranks are host-qualified; a row without a stamped host belongs to its repo's host.
      worktrees: worktrees.map((worktree) => {
        const repo = repoMap.get(worktree.repoId)
        return worktree.hostId || !repo
          ? worktree
          : { ...worktree, hostId: getRepoExecutionHostId(repo) }
      }),
      repoMap,
      sources: buildRuntimeSmartSortSources({
        tabs: this.tabs.values(),
        leaves: this.leaves.values(),
        sessionTabs: this.mobileSessionTabsByWorktree,
        isUnverifiablePty: (ptyId) => this.getPtyLivenessVerdict(ptyId)?.status === 'unverifiable',
        agentStatusByPaneKey: this.smartSortAgentEntries.byPaneKey(),
        migrationUnsupported: getMigrationUnsupportedPtySnapshot()
      })
    }
  }

  private readSidebarRetentionCandidates(): SidebarRetentionCandidates {
    const { facts } = this.workspaceActivityFacts.snapshot()
    return {
      ids: Object.keys(facts),
      isActive: (worktreeId) => worktreeId in facts,
      isUnverifiableGap: (worktreeId) =>
        !this.terminalSleepByWorktreeId.has(worktreeId) &&
        (this.mobileSessionTabsByWorktree
          .get(worktreeId)
          ?.tabs.some((tab) => tab.type === 'terminal') ??
          [...this.tabs.values()].some((tab) => tab.worktreeId === worktreeId))
    }
  }
}

/** The top sidebar layer, so a switch-off build folds the instanceof away with the switch. */
export function sidebarFactsRuntime(
  runtime: OrcaRuntimeWithMigrationCatalog
): OrcaRuntimeWithSidebarTemporal | null {
  return ORCA_SIDEBAR_INPUTS_IS_MAIN && runtime instanceof OrcaRuntimeWithSidebarTemporal
    ? runtime
    : null
}
