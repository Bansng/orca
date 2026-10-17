// Which terminal panes main's layout frames hold, for readers outside the frame sync. Its own
// module so those readers do not pull the frame sync into window-owned builds.

type TerminalPane = { tabId: string; leafId: string; ptyId: string }
type TerminalPaneQuery = (worktreeId: string, pane: TerminalPane) => boolean

let query: TerminalPaneQuery | null = null

/** Set by the window's layout stream once it opens. */
export function provideLayoutFrameTerminalPanes(next: TerminalPaneQuery): void {
  query = next
}

/** Whether main's frames will draw this terminal's pane; false before the window's stream opens. */
export function layoutFramesHoldTerminalPane(worktreeId: string, pane: TerminalPane): boolean {
  return query?.(worktreeId, pane) ?? false
}
