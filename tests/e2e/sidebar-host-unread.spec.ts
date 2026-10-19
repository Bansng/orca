import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { postClaudeHook, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { SIDEBAR_INPUTS_BUILD, expectNoSidebarShadowMismatches } from './helpers/sidebar-shadow'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import {
  WorkspaceRowsSnapshotSchema,
  type WorkspaceRow
} from '../../src/shared/sidebar-list/workspace-rows'

test.skip(
  !SIDEBAR_INPUTS_BUILD,
  'the host raises the unread flag only in an ORCA_SIDEBAR_INPUTS=main build'
)

async function readHostRow(page: Page, rowKey: string): Promise<WorkspaceRow | undefined> {
  const response = await page.evaluate(() =>
    window.api.runtime.call({ method: 'sidebarInputs.workspaceRows' })
  )
  if (!response.ok) {
    throw new Error('sidebarInputs.workspaceRows failed')
  }
  return WorkspaceRowsSnapshotSchema.parse(response.result).rows[rowKey]
}

test('the host raises the unread flag where the window’s user is not looking, as the window would', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(90_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const endpoint = await readHookEndpoint(electronApp)
  const pane = await waitForActivePaneHookDescriptor(orcaPage)
  const rowKey = `local|${pane.worktreeId}`
  const unread = async (): Promise<boolean | undefined> =>
    (await readHostRow(orcaPage, rowKey))?.isUnread
  await expect.poll(unread).toBe(false)

  // Input in the window confirms the user is present, and the agent's tab is on screen.
  await orcaPage.mouse.move(40, 40)
  await orcaPage.mouse.move(60, 60)
  await postClaudeHook(endpoint, pane, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
  await postClaudeHook(endpoint, pane, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
  await expect.poll(async () => (await readHostRow(orcaPage, rowKey))?.smartTier).toBe('done')
  expect(await unread()).toBe(false)

  // Settings is up, so no workspace is on screen: the finish is news.
  await orcaPage.evaluate(() => window.__store?.setState({ activeView: 'tasks' }))
  await postClaudeHook(endpoint, pane, { hook_event_name: 'UserPromptSubmit', prompt: 'more' })
  await postClaudeHook(endpoint, pane, { hook_event_name: 'Stop', last_assistant_message: 'ok' })
  await expect.poll(unread).toBe(true)
  // The window's copy is the host's record.
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (id) =>
          Object.values(window.__store?.getState().worktreesByRepo ?? {})
            .flat()
            .find((worktree) => worktree.id === id)?.isUnread,
        pane.worktreeId
      )
    )
    .toBe(true)
  await expectNoSidebarShadowMismatches(orcaPage)

  // Mark as read writes through to the host.
  await orcaPage.evaluate((id) => {
    window.__store?.getState().setWorkspaceUnreadByUser(id, false, 'local')
  }, pane.worktreeId)
  await expect.poll(unread).toBe(false)

  await postClaudeHook(endpoint, pane, {
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'ls' }
  })
  await expect.poll(unread).toBe(true)
  await expectNoSidebarShadowMismatches(orcaPage)
})
