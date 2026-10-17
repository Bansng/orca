import { OrcaRuntimeWithWorkspaceActivityFacts } from './orca-runtime-workspace-activity-facts'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import type { OrcaRuntimeWithMigrationCatalog } from '../orca-runtime-migration-catalog'
import {
  buildWorkspaceReviewFacts,
  type WorkspaceReviewFactsSnapshot
} from '../../../shared/sidebar-list/workspace-review-facts'

/**
 * PR facts per workspace, read on demand from this host's copy of the PR cache. The window
 * persists its cache here within a second of any change; orcad has no window, so it reads only
 * what its profile already holds.
 */
export abstract class OrcaRuntimeWithWorkspaceReviewFacts extends OrcaRuntimeWithWorkspaceActivityFacts {
  async getWorkspaceReviewFacts(): Promise<WorkspaceReviewFactsSnapshot> {
    if (!this.store) {
      return { facts: {} }
    }
    const { worktrees } = await this.listResolvedWorktreeSnapshot()
    return {
      facts: buildWorkspaceReviewFacts(
        worktrees,
        this.store.getRepos(),
        this.store.getGitHubCache().pr
      )
    }
  }
}

export function sidebarFactsRuntime(
  runtime: OrcaRuntimeWithMigrationCatalog
): OrcaRuntimeWithWorkspaceReviewFacts | null {
  // Why the switch first: it lets a switch-off build fold the instanceof away.
  return ORCA_SIDEBAR_INPUTS_IS_MAIN && runtime instanceof OrcaRuntimeWithWorkspaceReviewFacts
    ? runtime
    : null
}
