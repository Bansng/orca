import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import type { NewGroupSplit } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { TabsSlice } from '@/store/slices/tabs/tabs-slice-contract'

/**
 * The split that made a just-opened tab's group, when the group holds no other tab. Main stores no
 * empty group, so it lacks that group (the window made it with the tab, or empty a moment before)
 * and makes it with the tab, beside the sibling the window split. None for a workspace's only
 * group, or a sibling that is itself split, which the window's split never makes. `state` may
 * predate the tab (an editor open passes the store from before it).
 */
export function newGroupSplitOf(
  state: Pick<TabsSlice, 'groupsByWorktree' | 'layoutByWorktree'>,
  worktreeId: string,
  groupId: string,
  tabId: string
): { split: NewGroupSplit } | null {
  const group = state.groupsByWorktree[worktreeId]?.find((entry) => entry.id === groupId)
  const layout = state.layoutByWorktree[worktreeId]
  if (!group || group.tabOrder.some((id) => id !== tabId) || !layout) {
    return null
  }
  return splitBeside(layout, groupId)
}

function splitBeside(node: TabGroupLayoutNode, groupId: string): { split: NewGroupSplit } | null {
  if (node.type === 'leaf') {
    return null
  }
  const isFirst = node.first.type === 'leaf' && node.first.groupId === groupId
  const isSecond = node.second.type === 'leaf' && node.second.groupId === groupId
  if (!isFirst && !isSecond) {
    return splitBeside(node.first, groupId) ?? splitBeside(node.second, groupId)
  }
  const sibling = isFirst ? node.second : node.first
  if (sibling.type !== 'leaf') {
    return null
  }
  const sides =
    node.direction === 'horizontal' ? (['left', 'right'] as const) : (['up', 'down'] as const)
  return { split: { besideGroupId: sibling.groupId, direction: sides[isFirst ? 0 : 1] } }
}
