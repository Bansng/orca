import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import type { SleepingAgentSessionRecord } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`

// A running agent's workspace sleep: the window's wake relaunches it, and a windowless host has none.
function makeWorkingSleepStore(overrides: Partial<SleepingAgentSessionRecord> = {}) {
  const record: SleepingAgentSessionRecord = {
    paneKey: PANE_KEY,
    tabId: 'host-tab',
    worktreeId: TEST_WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'provider-session-1' },
    prompt: 'do the thing',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep',
    ...overrides
  }
  const fixture = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
    })
  )
  const baseSettings = fixture.runtimeStore.getSettings
  // Why: a resume must not inherit a permission-widening default the launch never used.
  fixture.runtimeStore.getSettings = () => ({
    ...baseSettings(),
    agentDefaultArgs: { claude: '--dangerously-skip-permissions' }
  })
  return fixture
}

function openPane(runtimeStore: unknown, windowStatus: 'blocked' | 'openable') {
  const spawn = vi.fn().mockResolvedValue({ id: 'persisted-pty' })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store implements the runtime store methods these tests reach.
  const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
    getDesktopWindowStatus: () => windowStatus
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const opened = runtime.activateMobileSessionTab(
    `id:${TEST_WORKTREE_ID}`,
    'host-tab',
    HEADLESS_LEAF_ID,
    { notifyClients: false, navigation: 'caller', intent: 'user' }
  )
  return { opened, spawn }
}

function spawnedCommand(spawn: ReturnType<typeof vi.fn>): string {
  const args: unknown = spawn.mock.calls[0]?.[0]
  return typeof args === 'object' && args !== null && 'command' in args
    ? String(args.command ?? '')
    : ''
}

describe('opening a workspace-slept running agent on a host with no window', () => {
  it('resumes its conversation with only the recorded launch flags', async () => {
    const { runtimeStore } = makeWorkingSleepStore()
    const { opened, spawn } = openPane(runtimeStore, 'blocked')

    await expect(opened).resolves.toMatchObject({ tabs: [{ status: 'ready' }] })
    expect(spawn).toHaveBeenCalledOnce()
    const command = spawnedCommand(spawn)
    expect(command).toContain('--resume')
    expect(command).toContain('provider-session-1')
    expect(command).not.toContain('--dangerously-skip-permissions')
  })

  it('keeps the recorded permission flags of the launch it resumes', async () => {
    const { runtimeStore } = makeWorkingSleepStore({
      launchConfig: { agentArgs: '--permission-mode plan', agentEnv: {} }
    })
    const { opened, spawn } = openPane(runtimeStore, 'blocked')

    await opened
    expect(spawnedCommand(spawn)).toMatch(/--permission-mode'? '?plan/)
  })

  it('still refuses a session another pane also records', async () => {
    const { runtimeStore, getSession, setSession } = makeWorkingSleepStore()
    const session = structuredClone(getSession())
    const own = session.sleepingAgentSessionsByPaneKey?.[PANE_KEY]
    if (own && session.sleepingAgentSessionsByPaneKey) {
      const otherKey = `host-tab:${HEADLESS_SECOND_LEAF_ID}`
      session.sleepingAgentSessionsByPaneKey[otherKey] = { ...own, paneKey: otherKey }
    }
    setSession(session)
    const { opened, spawn } = openPane(runtimeStore, 'blocked')

    await opened
    expect(spawnedCommand(spawn)).not.toContain('provider-session-1')
  })

  it('leaves the resume to the window wake on a host that can open one', async () => {
    const { runtimeStore } = makeWorkingSleepStore()
    const { opened, spawn } = openPane(runtimeStore, 'openable')

    await opened
    expect(spawnedCommand(spawn)).not.toContain('provider-session-1')
  })
})
