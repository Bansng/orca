import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { writeWindowSaveWatchingLayout } from './window-save-divergence'

function session(tabs: { id: string; title?: string }[]): WorkspaceSessionState {
  return addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'group-1',
      tabs: tabs.map((tab, index) => {
        const leaves: [string, string?][] = [[leaf(index + 1)]]
        return { ...tab, leaves }
      })
    }
  ])
}

/** Runs a save that replaces the stored session with `next`, as the store would. */
function save(stored: WorkspaceSessionState, next: WorkspaceSessionState, hostId = 'local') {
  let current = stored
  writeWindowSaveWatchingLayout(
    () => current,
    hostId,
    () => {
      current = next
    },
    'session:set'
  )
  return current
}

describe('writeWindowSaveWatchingLayout', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let logDir: string | null = null

  afterEach(() => {
    warn.mockClear()
    vi.unstubAllEnvs()
    if (logDir) {
      rmSync(logDir, { recursive: true, force: true })
      logDir = null
    }
  })

  it('stays quiet for a save that leaves main’s layout as it is', () => {
    const tabs = [{ id: 'tab-a' }, { id: 'tab-b' }]

    expect(save(session(tabs), session(tabs))).toEqual(session(tabs))
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports a tab the save added, dropped, renamed or moved, and still writes it', () => {
    logDir = mkdtempSync(join(tmpdir(), 'orca-divergence-'))
    const logPath = join(logDir, 'divergence.jsonl')
    vi.stubEnv('ORCA_LAYOUT_SAVE_DIVERGENCE_LOG', logPath)

    const next = session([{ id: 'tab-b', title: 'renamed' }, { id: 'tab-c' }])
    expect(save(session([{ id: 'tab-a' }, { id: 'tab-b' }]), next)).toBe(next)

    const [line] = readFileSync(logPath, 'utf8').trim().split('\n')
    const logged = JSON.parse(line!)
    expect(logged).toMatchObject({ source: 'session:set', partition: 'local', workspace: GIT_KEY })
    expect(logged.paths).toEqual(
      expect.arrayContaining([
        'tab tab-a removed',
        'tab tab-c added',
        'group group-1 changed: tabOrder'
      ])
    )
    expect(warn).toHaveBeenCalledOnce()
  })

  it('reports a reorder of the same tabs', () => {
    save(session([{ id: 'tab-a' }, { id: 'tab-b' }]), session([{ id: 'tab-b' }, { id: 'tab-a' }]))

    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({
        paths: expect.arrayContaining(['group group-1 changed: tabOrder'])
      })
    )
  })

  it('still writes the save when its log cannot be written', () => {
    vi.stubEnv(
      'ORCA_LAYOUT_SAVE_DIVERGENCE_LOG',
      join(tmpdir(), 'orca-missing-dir', 'x', 'log.jsonl')
    )
    const next = session([{ id: 'tab-c' }])

    expect(save(session([{ id: 'tab-a' }]), next)).toBe(next)
    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] save divergence log write failed:',
      expect.anything()
    )
  })

  it('reports a pane record the save changed, which the published layout does not carry', () => {
    const stored = session([{ id: 'tab-a' }])
    const next = structuredClone(stored)
    next.terminalLayoutsByTabId['tab-a'] = {
      ...next.terminalLayoutsByTabId['tab-a']!,
      titlesByLeafId: { [leaf(1)]: 'build' }
    }

    save(stored, next)

    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({ paths: [`leaf ${leaf(1)} added`] })
    )
  })

  it('writes once when the check cannot read the stored copy, and lets a failed write throw', () => {
    const write = vi.fn()
    writeWindowSaveWatchingLayout(
      () => {
        throw new Error('unreadable')
      },
      'local',
      write,
      'session:set'
    )
    expect(write).toHaveBeenCalledOnce()

    const read = vi.fn(() => session([{ id: 'tab-a' }]))
    expect(() =>
      writeWindowSaveWatchingLayout(
        read,
        'local',
        () => {
          throw new Error('disk full')
        },
        'session:set'
      )
    ).toThrow('disk full')
    expect(read).toHaveBeenCalledOnce()
  })

  it('counts panes only rebound to their terminals after the layout changes', () => {
    const bound = (ptyId: string): WorkspaceSessionState => {
      const result = session([{ id: 'tab-a' }, { id: 'tab-b' }])
      result.terminalLayoutsByTabId['tab-a'] = {
        ...result.terminalLayoutsByTabId['tab-a']!,
        ptyIdsByLeafId: { [leaf(1)]: ptyId }
      }
      return result
    }
    const next = bound('pty-2')
    next.tabGroups![GIT_KEY]![0]!.tabOrder.reverse()

    save(bound('pty-1'), next)

    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({ paths: ['group group-1 changed: tabOrder', '1 pane(s) rebound'] })
    )
  })

  it('counts a pane’s first terminal binding as a rebind, not a layout change', () => {
    const stored = session([{ id: 'tab-a' }])
    const next = structuredClone(stored)
    next.terminalLayoutsByTabId['tab-a'] = {
      ...next.terminalLayoutsByTabId['tab-a']!,
      ptyIdsByLeafId: { [leaf(1)]: 'pty-1' }
    }

    save(stored, next)

    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({ paths: ['1 pane(s) rebound'] })
    )
  })

  it('reports a default-tab record of a workspace with no tabs, and a terminal row owner', () => {
    const stored = emptySession()
    const next = {
      ...emptySession(),
      defaultTerminalTabsAppliedByWorktreeId: { 'repo-1::/Users/dev/notes': true as const },
      tabsByWorktree: { 'repo-1::/Users/dev/empty': [] }
    }

    save(stored, next)

    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({
        workspace: 'repo-1::/Users/dev/notes',
        paths: ['defaultTabsAppliedByWorkspace changed']
      })
    )
    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({
        workspace: 'repo-1::/Users/dev/empty',
        paths: expect.arrayContaining(['terminal row owner changed'])
      })
    )
  })

  it('leaves a paired server’s partition alone: its layout is the server’s', () => {
    const next = session([{ id: 'tab-c' }])
    expect(save(session([{ id: 'tab-a' }]), next, 'runtime:env-1')).toBe(next)
    expect(warn).not.toHaveBeenCalled()
  })
})
