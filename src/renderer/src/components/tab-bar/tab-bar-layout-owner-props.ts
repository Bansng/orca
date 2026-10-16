import { useAppStore } from '@/store'
import { findRenamableUnifiedTab } from '@/store/terminals/renamable-unified-tab'
import type { WindowLayoutCommand } from '@/runtime/layout-apply-send'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'

type TabPropsActions<Item extends { unifiedTabId: string; isPinned: boolean }> = {
  setCustomTitle: (tabId: string, title: string | null) => void
  setTabColor: (tabId: string, color: string | null) => void
  togglePinned: (item: Item) => void
}

type TabPropsChange = { title: string | null } | { color: string | null } | { isPinned: boolean }

/**
 * The tab bar's rename, color and pin in a layout-owner build: main changes its copy first, then
 * the window's own action shows the same change. The window's action runs alone when main is not
 * asked: no such tab, or a paired server owns the workspace.
 */
export function withLayoutOwnerTabProps<Item extends { unifiedTabId: string; isPinned: boolean }>(
  actions: TabPropsActions<Item>,
  worktreeId: () => string
): TabPropsActions<Item> {
  const change = (tabBarTabId: string | null, props: TabPropsChange, today: () => void): void => {
    if (!tabBarTabId) {
      today()
      return
    }
    const command: WindowLayoutCommand =
      'title' in props
        ? { type: 'renameTab', tabId: tabBarTabId, kind: 'custom', title: props.title }
        : { type: 'setTabProps', tabId: tabBarTabId, ...props }
    if (!sendLayoutCommandToOwner(worktreeId(), command, { apply: today, asToday: today })) {
      today()
    }
  }
  return {
    setCustomTitle: (tabId, title) =>
      change(renamableTabBarTabId(tabId), { title }, () => actions.setCustomTitle(tabId, title)),
    setTabColor: (tabId, color) =>
      change(renamableTabBarTabId(tabId), { color }, () => actions.setTabColor(tabId, color)),
    togglePinned: (item) =>
      change(item.unifiedTabId, { isPinned: !item.isPinned }, () => actions.togglePinned(item))
  }
}

/** The tab-bar tab a rename or color addresses: a terminal by its terminal's id, a chat by its own. */
function renamableTabBarTabId(tabId: string): string | null {
  return findRenamableUnifiedTab(useAppStore.getState().unifiedTabsByWorktree, tabId)?.id ?? null
}
