import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-route-types'
import { launchedSelection, type PendingSessionSelection } from './pending-session-selection'
import { useMobileSessionTabApplication } from './use-mobile-session-tab-application'

function terminalTab(id: string, terminal: string, isActive = false): MobileSessionTab {
  return { type: 'terminal', id, parentTabId: id, leafId: 'leaf', title: 'T', terminal, isActive }
}

function chatTab(id: string, sessionId: string): MobileSessionTab {
  return { type: 'agent-session', id, title: 'Claude', sessionId, agent: 'claude', isActive: false }
}

let version = 0
function snapshot(tabs: MobileSessionTab[], extra: Partial<SessionTabsResult> = {}) {
  version += 1
  const active = tabs.find((tab) => tab.isActive) ?? null
  return {
    worktree: 'workspace-1',
    publicationEpoch: 'host-epoch:client-navigation',
    snapshotVersion: version,
    tabs,
    activeTabId: active?.id ?? null,
    activeTabType: active?.type ?? null,
    ...extra
  }
}

function scope(pending: PendingSessionSelection | null) {
  const sendRequest = vi.fn(async () => ({
    id: 'x',
    ok: true as const,
    result: {},
    _meta: { runtimeId: 'r' }
  }))
  const client: Pick<RpcClient, 'sendRequest'> = { sendRequest }
  return {
    sendRequest,
    state: {
      setTerminals: vi.fn(),
      terminalsRef: { current: [] },
      setSessionTabs: vi.fn(),
      sessionTabsRef: { current: [] },
      appliedSnapshotMarkerRef: { current: { epoch: null, version: -1 } },
      appliedSessionTabsRevisionRef: { current: 0 },
      closedTabTombstonesRef: { current: new Map() },
      reconcileBufferedDraftsRef: { current: vi.fn() },
      setTerminalsLoaded: vi.fn(),
      defaultTerminalHandlesToLiveInput: vi.fn(),
      setActiveHandle: vi.fn(),
      setActiveSessionTabId: vi.fn(),
      activeSessionTabIdRef: { current: 'tab-old' },
      selectedSessionTabIdRef: { current: 'tab-old' },
      markdownDocsRef: { current: new Map() },
      initializedHandlesRef: { current: new Set<string>() },
      terminalDiagnosticsRef: { current: { tabsApplied: vi.fn() } },
      activeHandleRef: { current: 'term_old' },
      activeSessionTabTypeRef: { current: 'terminal' },
      pendingSelectionRef: { current: pending },
      pendingBrowserFocusPageIdRef: { current: null },
      initialSessionAutoCreateRef: { current: { sawSessionTabs: true } },
      unsubscribeTerminal: vi.fn(),
      subscribeToTerminal: vi.fn(),
      lastKnownTerminalCountRef: { current: 0 },
      clientRef: { current: client }
    }
  }
}

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

function mount(state: ReturnType<typeof scope>['state']) {
  let model: ReturnType<typeof useMobileSessionTabApplication> | undefined
  function Harness() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope carries every member applySessionTabs reads; a missing one throws on use.
    model = useMobileSessionTabApplication(state as never)
    return null
  }
  act(() => {
    renderer = create(createElement(Harness))
  })
  return (result: SessionTabsResult) => model!.applySessionTabs(result)
}

function activations(sendRequest: ReturnType<typeof scope>['sendRequest']): unknown[] {
  return sendRequest.mock.calls.flatMap((call: unknown[]) =>
    call[0] === 'session.tabs.activate' ? [call[1]] : []
  )
}

describe('landing on a launched tab', () => {
  it('records a launched terminal as this device’s pick on the host once its tab arrives', () => {
    const { state, sendRequest } = scope(launchedSelection({ handle: 'term_new' }))
    const apply = mount(state)
    const old = terminalTab('tab-old', 'term_old', true)

    apply(snapshot([old]))
    expect(activations(sendRequest)).toEqual([])

    apply(snapshot([old, terminalTab('tab-new', 'term_new')]))
    expect(activations(sendRequest)).toEqual([
      {
        worktree: 'id:workspace-1',
        tabId: 'tab-new',
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      }
    ])
    expect(state.setActiveSessionTabId).toHaveBeenLastCalledWith('tab-new')
    expect(state.unsubscribeTerminal).toHaveBeenCalledWith('term_old')
    expect(state.subscribeToTerminal).toHaveBeenLastCalledWith('term_new')

    // Landed once: a later snapshot that still shows the old tab active does not re-send.
    apply(snapshot([old, terminalTab('tab-new', 'term_new')]))
    expect(activations(sendRequest)).toHaveLength(1)
  })

  it('records a launched chat, found by its session, by the tab id the host gave it', () => {
    const { state, sendRequest } = scope(launchedSelection({ sessionId: 'claude_s1' }))
    const apply = mount(state)

    apply(snapshot([terminalTab('tab-old', 'term_old', true), chatTab('opaque-7', 'claude_s1')]))

    expect(activations(sendRequest)).toEqual([expect.objectContaining({ tabId: 'opaque-7' })])
    expect(state.setActiveSessionTabId).toHaveBeenLastCalledWith('opaque-7')
  })

  it('leaves the host’s choice alone when it moved this device itself', () => {
    const { state, sendRequest } = scope(launchedSelection({ handle: 'term_new' }))
    const apply = mount(state)

    apply(
      snapshot([terminalTab('tab-old', 'term_old', true), terminalTab('tab-new', 'term_new')], {
        navigationIntent: 'follow'
      })
    )

    expect(activations(sendRequest)).toEqual([])
    expect(state.setActiveSessionTabId).toHaveBeenLastCalledWith('tab-old')
  })
})
