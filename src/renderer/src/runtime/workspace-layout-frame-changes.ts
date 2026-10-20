// What changed between two frames of one workspace: its structure, only its panes' terminal
// bindings, or only their live titles. Each JSON is kept per frame: title frames arrive at spinner
// rate, and a respawned terminal's binding frames one per restored pane.

import { shownLiveTitle } from '@/store/workspace-layout-frame-slices'
import type { TerminalTabTitleUpdate } from '@/store/slices/terminal-tab-title-batch'
import { stableJson } from '../../../shared/workspace-layout/workspace-layout-load-report'
import type {
  PublishedPane,
  PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'

const structureJsonByLayout = new WeakMap<PublishedWorkspaceLayout, string>()
const unboundJsonByLayout = new WeakMap<PublishedWorkspaceLayout, string>()

function jsonWithoutPaneFields(
  layout: PublishedWorkspaceLayout,
  strip: (pane: PublishedPane) => object
): string {
  return stableJson({
    ...layout,
    tabs: layout.tabs.map((tab) =>
      tab.terminal
        ? { ...tab, terminal: { ...tab.terminal, panes: tab.terminal.panes.map(strip) } }
        : tab
    )
  })
}

function cached(
  cache: WeakMap<PublishedWorkspaceLayout, string>,
  layout: PublishedWorkspaceLayout,
  strip: (pane: PublishedPane) => object
): string {
  let json = cache.get(layout)
  if (json === undefined) {
    json = jsonWithoutPaneFields(layout, strip)
    cache.set(layout, json)
  }
  return json
}

/** A frame's JSON without live titles. */
export function structureJson(layout: PublishedWorkspaceLayout): string {
  return cached(structureJsonByLayout, layout, ({ liveTitle: _liveTitle, ...pane }) => pane)
}

/** A frame's JSON without live titles or terminal bindings: a pane's binding is its status. */
export function unboundStructureJson(layout: PublishedWorkspaceLayout): string {
  return cached(
    unboundJsonByLayout,
    layout,
    ({ liveTitle: _liveTitle, ptyId: _ptyId, ptyGeneration: _ptyGeneration, ...pane }) => pane
  )
}

/** Title changes between two frames of one workspace, for the pane each tab shows. */
export function liveTitleUpdates(
  shown: PublishedWorkspaceLayout,
  next: PublishedWorkspaceLayout,
  focusedLeafId: (tabId: string) => string | null | undefined
): TerminalTabTitleUpdate[] {
  const shownById = new Map(shown.tabs.map((tab) => [tab.id, tab]))
  const updates: TerminalTabTitleUpdate[] = []
  for (const tab of next.tabs) {
    const shownTab = shownById.get(tab.id)
    if (!tab.terminal || !shownTab) {
      continue
    }
    const focused = focusedLeafId(tab.entityId)
    const title = shownLiveTitle(tab, focused)
    if (title !== undefined && title !== shownLiveTitle(shownTab, focused)) {
      updates.push({ tabId: tab.entityId, title })
    }
  }
  return updates
}
