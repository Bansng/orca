// What the window's own unread rule decided per workspace. With the switch on the window writes no
// flag; its decisions are kept here only for the workspace-unread shadow to compare.
export const windowUnreadDecisions = new Map<string, boolean>()

export function noteWindowUnreadDecision(workspaceId: string, isUnread: boolean): void {
  windowUnreadDecisions.set(workspaceId, isUnread)
}
