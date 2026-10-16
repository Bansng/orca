import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { recordLayoutApply } from '@/runtime/layout-apply-send'
import {
  recordPaneSleepThroughLayoutOwner,
  recordPaneWakeThroughLayoutOwner
} from './terminal-sleep-layout-owner'

const mocks = vi.hoisted(() => ({ send: vi.fn<typeof recordLayoutApply>() }))

vi.mock('@/runtime/layout-apply-send', () => ({ recordLayoutApply: mocks.send }))

const WT = 'repo1::/path/wt1'
const STATE = {}
const A1 = 'tab-a:11111111-1111-4111-8111-111111111111'
const A2 = 'tab-a:22222222-2222-4222-8222-222222222222'
const B1 = 'tab-b:33333333-3333-4333-8333-333333333333'

function record(paneKey: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId: WT,
    agent: 'codex',
    providerSession: { key: 'session_id', id: paneKey },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1
  }
}

describe('sleep and wake through the layout owner', () => {
  beforeEach(() => {
    mocks.send.mockReset()
  })

  it('sends one sleep per tab naming only the panes it stopped', () => {
    const records = {
      [A1]: record(A1),
      [A2]: record(A2),
      [B1]: record(B1),
      // A legacy pane key names no pane main holds.
      'tab-a:1': record('tab-a:1')
    }

    recordPaneSleepThroughLayoutOwner(STATE, WT, records)

    expect(mocks.send.mock.calls.map((call) => call[2])).toEqual([
      { type: 'sleep', tabId: 'tab-a', paneKeys: [A1, A2], records: [record(A1), record(A2)] },
      { type: 'sleep', tabId: 'tab-b', paneKeys: [B1], records: [record(B1)] }
    ])
  })

  it('sends nothing when nothing slept, as a worktree removal', () => {
    recordPaneSleepThroughLayoutOwner(STATE, WT, {})

    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('wakes the one pane the window resumed', () => {
    recordPaneWakeThroughLayoutOwner(STATE, WT, A2)

    expect(mocks.send).toHaveBeenCalledWith(STATE, WT, {
      type: 'wake',
      tabId: 'tab-a',
      paneKeys: [A2]
    })
  })
})
