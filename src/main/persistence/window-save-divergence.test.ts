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
import { windowSaveForMain } from './window-save-pane-trees'

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

  it('reports a default-tab record of a workspace with no tabs', () => {
    const stored = emptySession()
    const next = {
      ...emptySession(),
      defaultTerminalTabsAppliedByWorktreeId: { 'repo-1::/Users/dev/notes': true as const }
    }

    save(stored, next)

    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({
        workspace: 'repo-1::/Users/dev/notes',
        paths: ['defaultTabsAppliedByWorkspace changed']
      })
    )
  })

  it('stays quiet for a save that only names a workspace with nothing in it', () => {
    const key = 'repo-1::/Users/dev/empty'
    const next = { ...emptySession(), unifiedTabs: { [key]: [] }, tabGroups: { [key]: [] } }

    save(emptySession(), next)
    save(next, emptySession())

    expect(warn).not.toHaveBeenCalled()
  })

  it('reports an empty terminal row a save adds or drops: a relaunch reads it there', () => {
    const key = 'repo-1::/Users/dev/emptied'
    const emptied = { ...emptySession(), tabsByWorktree: { [key]: [] } }

    save(emptySession(), emptied)
    save(emptied, emptySession())

    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({ workspace: key, paths: ['terminal row owner changed'] })
    )
  })

  it('reports a closed tab record only when the save adds or drops it, not when a key places it', () => {
    const key = 'repo-1::/Users/dev/empty'
    const closed = {
      closedTerminalTabTombstonesByTabId: { 'tab-x': { worktreeId: key, closedAt: 1 } }
    }
    const stored = { ...emptySession(), ...closed }
    const named = { ...stored, unifiedTabs: { [key]: [] } }

    save(stored, named)
    expect(warn).not.toHaveBeenCalled()

    save(named, { ...named, closedTerminalTabTombstonesByTabId: {} })
    save({ ...emptySession(), unifiedTabs: {} }, named)
    for (const path of ['closed tab tab-x removed', 'closed tab tab-x added']) {
      expect(warn).toHaveBeenCalledWith(
        '[layout-owner] window save changed main layout:',
        'session:set',
        expect.objectContaining({ workspace: key, paths: [path] })
      )
    }
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('reports a closed tab record the save moves into a workspace only it names', () => {
    const from = 'repo-1::/Users/dev/old'
    const to = 'repo-1::/Users/dev/new'
    const closedIn = (key: string) => ({
      ...emptySession(),
      closedTerminalTabTombstonesByTabId: { 'tab-x': { worktreeId: key, closedAt: 1 } }
    })

    save(closedIn(from), { ...closedIn(to), unifiedTabs: { [to]: [] } })

    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({ workspace: to, paths: ['closed tab tab-x added'] })
    )
  })

  it('still reports a workspace with tabs that the save adds or drops', () => {
    save(emptySession(), session([{ id: 'tab-a' }]))
    save(session([{ id: 'tab-a' }]), emptySession())

    for (const path of ['workspace added', 'workspace removed']) {
      expect(warn).toHaveBeenCalledWith(
        '[layout-owner] window save changed main layout:',
        'session:set',
        expect.objectContaining({ workspace: GIT_KEY, paths: expect.arrayContaining([path]) })
      )
    }
  })

  it('reports a save that drops a terminal tab’s tab-bar entry but keeps its row', () => {
    const stored = session([{ id: 'tab-a' }, { id: 'tab-b' }])
    const next = structuredClone(stored)
    next.unifiedTabs![GIT_KEY] = next.unifiedTabs![GIT_KEY]!.filter((tab) => tab.id !== 'tab-b')

    save(stored, next)

    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({
        workspace: GIT_KEY,
        paths: expect.arrayContaining(['terminal tab-b tab-bar entry removed'])
      })
    )
  })

  it('stays quiet for a save that carries no tab bar for the workspace yet', () => {
    const stored = session([{ id: 'tab-a' }])
    const next = structuredClone(stored)
    delete next.unifiedTabs![GIT_KEY]

    save(stored, next)

    expect(warn).not.toHaveBeenCalled()
  })

  it('reports a pane tree main keeps over the save’s, and still writes the save', () => {
    const stored = session([{ id: 'tab-a' }])
    const incoming = structuredClone(stored)
    incoming.terminalLayoutsByTabId['tab-a'] = {
      ...incoming.terminalLayoutsByTabId['tab-a']!,
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { type: 'leaf', leafId: leaf(1) },
        second: { type: 'leaf', leafId: leaf(2) }
      }
    }
    let current = stored
    writeWindowSaveWatchingLayout(
      () => current,
      'local',
      () => {
        current = windowSaveForMain(current, incoming, 'local')
      },
      'session:set',
      incoming.terminalLayoutsByTabId
    )

    expect(current.terminalLayoutsByTabId['tab-a']?.root).toEqual(
      stored.terminalLayoutsByTabId['tab-a']?.root
    )
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({
        workspace: GIT_KEY,
        paths: ['pane tree tab-a kept over the save’s']
      })
    )
  })

  it('reports a pane tree main keeps for a tab no workspace places', () => {
    const stored = session([{ id: 'tab-a' }])
    const layout = stored.terminalLayoutsByTabId['tab-a']!
    stored.terminalLayoutsByTabId.orphan = { ...layout, root: { type: 'leaf', leafId: leaf(7) } }
    const saved = { orphan: { ...layout, root: { type: 'leaf' as const, leafId: leaf(8) } } }
    writeWindowSaveWatchingLayout(
      () => stored,
      'local',
      () => {},
      'session:set',
      saved
    )

    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({
        workspace: '(no workspace)',
        paths: ['pane tree orphan kept over the save’s']
      })
    )
  })

  it('reports a save that sends no pane tree for a tab main keeps one for', () => {
    const stored = session([{ id: 'tab-a' }])
    const saved = { 'tab-a': { ...stored.terminalLayoutsByTabId['tab-a']!, root: null } }
    writeWindowSaveWatchingLayout(
      () => stored,
      'local',
      () => {},
      'session:set',
      saved
    )

    expect(warn).toHaveBeenCalledWith(
      '[layout-owner] window save changed main layout:',
      'session:set',
      expect.objectContaining({
        workspace: GIT_KEY,
        paths: ['pane tree tab-a kept over the save’s']
      })
    )
  })

  it('stays quiet for a save whose pane trees match main’s', () => {
    const stored = session([{ id: 'tab-a' }])
    const incoming = structuredClone(stored)
    writeWindowSaveWatchingLayout(
      () => stored,
      'local',
      () => {},
      'session:set',
      incoming.terminalLayoutsByTabId
    )

    expect(warn).not.toHaveBeenCalled()
  })

  it('leaves a paired server’s partition alone: its layout is the server’s', () => {
    const next = session([{ id: 'tab-c' }])
    expect(save(session([{ id: 'tab-a' }]), next, 'runtime:env-1')).toBe(next)
    expect(warn).not.toHaveBeenCalled()
  })
})
