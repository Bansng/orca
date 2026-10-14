// @vitest-environment happy-dom

import {
  deferred,
  editState,
  flushPromises,
  initialSource,
  initialSourceContextKey,
  jiraIssue,
  otherIssue,
  runtimeMocks,
  saveTitle,
  selectIssue,
  selectSource,
  store,
  StoreBackedWorkspace
} from './__mocks__/jira-issue-workspace-edit-fixture'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraMutationResult } from '../../../shared/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { getDefaultSettings } from '../../../shared/constants'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import JiraIssueWorkspace from './JiraIssueWorkspace'

describe('JiraIssueWorkspace optimistic edits', () => {
  it.each([true, false])(
    'captures the default host when a save settles after navigation (%s)',
    async (ok) => {
      const oldSave = deferred<JiraMutationResult>()
      runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(oldSave.promise)
      const contextKey = getProviderRuntimeContextKey(editState.settings)
      const view = render(
        <TooltipProvider>
          <JiraIssueWorkspace issue={jiraIssue('Old title')} onUse={vi.fn()} onClose={vi.fn()} />
        </TooltipProvider>
      )
      await flushPromises()
      saveTitle('Old title', 'Local edit')
      await flushPromises()
      editState.settings = { ...getDefaultSettings(''), activeRuntimeEnvironmentId: 'remote-1' }
      runtimeMocks.jiraGetIssueForTarget.mockImplementation(async (source: RuntimeClientTarget) =>
        jiraIssue(source.kind === 'environment' ? 'Remote title' : 'Local edit')
      )
      view.rerender(
        <TooltipProvider>
          <JiraIssueWorkspace issue={jiraIssue('Remote title')} onUse={vi.fn()} onClose={vi.fn()} />
        </TooltipProvider>
      )
      await flushPromises()
      await act(async () =>
        oldSave.resolve(ok ? { ok: true } : { ok: false, error: 'Local edit rejected' })
      )
      await flushPromises()

      expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledWith(
        { kind: 'local' },
        'ENG-1',
        { title: 'Local edit' },
        'site-1'
      )
      expect(runtimeMocks.jiraGetIssueForTarget).toHaveBeenLastCalledWith(
        ok ? { kind: 'local' } : { kind: 'environment', environmentId: 'remote-1' },
        'ENG-1',
        'site-1'
      )
      expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
        'ENG-1',
        expect.objectContaining({ title: ok ? 'Local edit' : 'Old title' }),
        expect.objectContaining({ contextKey, siteId: 'site-1' })
      )
      expect(screen.getByDisplayValue('Remote title')).toBeDefined()
    }
  )

  it('keeps loaded and submitted comments while a title save patches the shared cache', async () => {
    runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(deferred<{ ok: true }>().promise)
    runtimeMocks.jiraIssueCommentsForTarget.mockResolvedValue([
      { id: 'server', body: 'Existing comment', createdAt: '2026-09-01' }
    ])
    runtimeMocks.jiraAddIssueCommentForTarget.mockResolvedValue({ ok: true, id: 'added' })
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    fireEvent.change(screen.getByPlaceholderText('Add a Jira comment...'), {
      target: { value: 'New comment' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await flushPromises()
    saveTitle('Old title', 'New title')
    await flushPromises()
    expect(screen.getByText('Existing comment')).toBeDefined()
    expect(screen.getByText('New comment')).toBeDefined()
    expect(runtimeMocks.jiraIssueCommentsForTarget).toHaveBeenCalledTimes(1)
  })

  it('reloads when the same issue moves to another source account on the same host', async () => {
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    await act(async () => selectSource({ ...initialSource, accountLabel: 'other-account' }))
    await flushPromises()
    expect(runtimeMocks.jiraGetIssueForTarget).toHaveBeenCalledTimes(2)
    expect(runtimeMocks.jiraGetIssueForTarget).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'ENG-1',
      'site-1'
    )
  })

  it('keeps the new title on screen while the save is in flight', async () => {
    const update = deferred<{ ok: true }>()
    runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(update.promise)
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    saveTitle('Old title', 'New title')
    await flushPromises()

    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(1)
    expect(screen.getByDisplayValue('New title')).toBeDefined()
    expect(runtimeMocks.jiraGetIssueForTarget).toHaveBeenCalledTimes(1)

    editState.serverTitle = 'New title'
    await act(async () => update.resolve({ ok: true }))
    await flushPromises()

    expect(runtimeMocks.jiraGetIssueForTarget).toHaveBeenCalledTimes(2)
    expect(screen.getByDisplayValue('New title')).toBeDefined()
  })

  it('restores the previous title when the save fails', async () => {
    runtimeMocks.jiraUpdateIssueForTarget.mockResolvedValue({ ok: false, error: 'Nope' })
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    saveTitle('Old title', 'New title')
    await flushPromises()

    await waitFor(() => expect(screen.getByDisplayValue('Old title')).toBeDefined())
  })

  it('keeps a cleared priority cleared when an older detail load arrives', async () => {
    const initialLoad = deferred<JiraIssue>()
    const initial = jiraIssue('Old title', { priority: { id: '1', name: 'High' } })
    runtimeMocks.jiraGetIssueForTarget.mockReturnValue(initialLoad.promise)
    runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(deferred<{ ok: true }>().promise)
    render(<StoreBackedWorkspace initial={initial} />)
    await flushPromises()
    fireEvent.click(screen.getByRole('button', { name: 'High' }))
    fireEvent.click(await screen.findByRole('button', { name: 'No priority' }))
    await act(async () => initialLoad.resolve(initial))
    await flushPromises()
    expect(screen.queryByRole('button', { name: 'High' })).toBeNull()
    expect(runtimeMocks.jiraGetIssueForTarget).toHaveBeenCalledTimes(1)
    expect(runtimeMocks.jiraIssueCommentsForTarget).toHaveBeenCalledTimes(1)
  })

  it('keeps fields hydrated during a failed title save', async () => {
    const initialLoad = deferred<JiraIssue>()
    const update = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraGetIssueForTarget.mockReturnValue(initialLoad.promise)
    runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(update.promise)
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'New title')
    await act(async () => initialLoad.resolve(jiraIssue('Old title', { labels: ['backend'] })))
    await flushPromises()
    await act(async () => update.resolve({ ok: false, error: 'Rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('Old title')).toBeDefined()
    expect(screen.getByDisplayValue('backend')).toBeDefined()
  })

  it('allows editing a newly opened issue while an earlier save is still pending', async () => {
    const oldSave = deferred<{ ok: true }>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockResolvedValue({ ok: true })
    runtimeMocks.jiraGetIssueForTarget.mockImplementation(
      async (_settings: unknown, key: string) =>
        key === 'ENG-2' ? otherIssue : jiraIssue(editState.serverTitle)
    )
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'New title')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    saveTitle('Other issue', 'Other updated')
    await flushPromises()
    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(2)
    await act(async () => oldSave.resolve({ ok: true }))
    await flushPromises()
    expect(screen.getByText('ENG-2')).toBeDefined()
  })

  it('offers the new status transitions after a status change', async () => {
    // Why: Jira only allows transitions out of the current status, so the menu
    // must be reloaded once the issue has moved.
    const inProgress = {
      id: '3',
      name: 'In Progress',
      categoryKey: 'indeterminate',
      categoryName: 'In Progress'
    }
    const done = { id: '4', name: 'Done', categoryKey: 'done', categoryName: 'Done' }
    runtimeMocks.jiraListTransitionsForTarget
      .mockResolvedValueOnce([{ id: '11', name: 'Start progress', to: inProgress }])
      .mockResolvedValue([{ id: '21', name: 'Finish', to: done }])
    runtimeMocks.jiraUpdateIssueForTarget.mockResolvedValue({ ok: true })
    runtimeMocks.jiraGetIssueForTarget
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValue(jiraIssue('Old title', { status: inProgress }))
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    fireEvent.click(screen.getByRole('button', { name: 'Change status: To Do' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Start progress' }))
    await flushPromises()

    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledWith(
      { kind: 'local' },
      'ENG-1',
      { transitionId: '11' },
      'site-1'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Change status: In Progress' }))
    expect(screen.queryByRole('button', { name: 'Start progress' })).toBeNull()
    expect(await screen.findByRole('button', { name: 'Finish' })).toBeDefined()
  })

  it('still hydrates fields the user did not edit when the initial load lands late', async () => {
    const initialLoad = deferred<JiraIssue>()
    runtimeMocks.jiraGetIssueForTarget.mockImplementationOnce(() => initialLoad.promise)
    runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(deferred<{ ok: true }>().promise)
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    saveTitle('Old title', 'New title')
    await flushPromises()
    await act(async () => initialLoad.resolve(jiraIssue('Old title', { labels: ['backend'] })))
    await flushPromises()

    expect(screen.getByDisplayValue('New title')).toBeDefined()
    expect(screen.getByDisplayValue('backend')).toBeDefined()
  })

  it.each([
    ['succeeds', { ok: true }],
    ['fails', { ok: false, error: 'Nope' }]
  ] as const)(
    'stays on the newly opened issue when a save for the previous one %s',
    async (_, outcome) => {
      // Why: the task page keeps one workspace instance across selections, so a
      // save that finishes after switching must not write the old issue back.
      const update = deferred<typeof outcome>()
      runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(update.promise)
      runtimeMocks.jiraGetIssueForTarget.mockImplementation(
        async (_settings: unknown, key: string) =>
          key === 'ENG-2' ? otherIssue : jiraIssue(editState.serverTitle)
      )
      render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
      await flushPromises()

      saveTitle('Old title', 'New title')
      await flushPromises()
      await act(async () => selectIssue(otherIssue))
      await flushPromises()
      expect(screen.getByText('ENG-2')).toBeDefined()
      editState.serverTitle = 'New title'
      await act(async () => update.resolve(outcome))
      await flushPromises()

      expect(screen.getByText('ENG-2')).toBeDefined()
      expect(screen.queryByText('ENG-1')).toBeNull()
      expect(screen.getByDisplayValue('Other issue')).toBeDefined()
    }
  )

  it('does not let a slow initial load overwrite a title saved meanwhile', async () => {
    const initialLoad = deferred<JiraIssue>()
    runtimeMocks.jiraGetIssueForTarget
      .mockImplementationOnce(() => initialLoad.promise)
      .mockImplementation(async () => jiraIssue(editState.serverTitle))
    runtimeMocks.jiraUpdateIssueForTarget.mockImplementation(async () => {
      editState.serverTitle = 'New title'
      return { ok: true }
    })
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    saveTitle('Old title', 'New title')
    await flushPromises()
    await act(async () => initialLoad.resolve(jiraIssue('Old title')))
    await flushPromises()

    expect(screen.getByDisplayValue('New title')).toBeDefined()
  })

  it('keeps a newer reopened-issue edit when an earlier save fails', async () => {
    const oldSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValue(deferred<{ ok: true }>().promise)
    runtimeMocks.jiraGetIssueForTarget.mockImplementation(
      async (_settings: unknown, key: string) =>
        key === 'ENG-2' ? otherIssue : jiraIssue('Old title')
    )
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('Old title')))
    await flushPromises()
    saveTitle('First edit', 'Latest edit')
    await flushPromises()
    await act(async () => oldSave.resolve({ ok: false, error: 'First save rejected' }))
    await flushPromises()
    expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
      'ENG-1',
      expect.objectContaining({ title: 'Latest edit' }),
      { sourceContext: initialSource, siteId: 'site-1', contextKey: initialSourceContextKey }
    )
    expect(screen.getByDisplayValue('Latest edit')).toBeDefined()
  })

  it('keeps a newer reopened-issue edit when an earlier refresh returns late', async () => {
    const oldSave = deferred<{ ok: true }>()
    const oldRefresh = deferred<JiraIssue>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValue(deferred<{ ok: true }>().promise)
    runtimeMocks.jiraGetIssueForTarget
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockReturnValueOnce(oldRefresh.promise)
      .mockImplementation(async (_settings: unknown, key: string) =>
        key === 'ENG-2' ? otherIssue : jiraIssue('Old title')
      )
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => oldSave.resolve({ ok: true }))
    await flushPromises()
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('Old title')))
    await flushPromises()
    saveTitle('First edit', 'Latest edit')
    await flushPromises()
    await act(async () => oldRefresh.resolve(jiraIssue('First edit')))
    await flushPromises()
    expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
      'ENG-1',
      expect.objectContaining({ title: 'Latest edit' }),
      { sourceContext: initialSource, siteId: 'site-1', contextKey: initialSourceContextKey }
    )
    expect(screen.getByDisplayValue('Latest edit')).toBeDefined()
  })

  it('restores confirmed values when both reopened title saves fail', async () => {
    const oldSave = deferred<{ ok: false; error: string }>()
    const newerSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newerSave.promise)
    runtimeMocks.jiraGetIssueForTarget
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValueOnce(otherIssue)
      .mockReturnValue(deferred<JiraIssue>().promise)
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('First edit')))
    await flushPromises()
    saveTitle('First edit', 'Latest edit')
    await flushPromises()
    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(1)
    await act(async () => oldSave.resolve({ ok: false, error: 'First save rejected' }))
    await flushPromises()
    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(2)
    expect(screen.getByDisplayValue('Latest edit')).toBeDefined()
    await act(async () => newerSave.resolve({ ok: false, error: 'Second save rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('Old title')).toBeDefined()
    expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
      'ENG-1',
      { title: 'Old title' },
      { sourceContext: initialSource, siteId: 'site-1', contextKey: initialSourceContextKey }
    )
  })

  it('rolls back a failed title while preserving a newer edit to another field', async () => {
    const oldSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValue(deferred<{ ok: true }>().promise)
    const high = { id: '1', name: 'High' }
    const low = { id: '2', name: 'Low' }
    runtimeMocks.jiraListPrioritiesForTarget.mockResolvedValue([high, low])
    runtimeMocks.jiraGetIssueForTarget
      .mockResolvedValueOnce(jiraIssue('Old title', { priority: high }))
      .mockResolvedValueOnce(otherIssue)
      .mockReturnValue(deferred<JiraIssue>().promise)
    render(<StoreBackedWorkspace initial={jiraIssue('Old title', { priority: high })} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('First edit', { priority: high })))
    await flushPromises()
    fireEvent.click(screen.getByRole('button', { name: 'High' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Low' }))
    await flushPromises()
    await act(async () => oldSave.resolve({ ok: false, error: 'Title rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('Old title')).toBeDefined()
    expect(
      screen
        .getAllByRole('button', { name: 'Low' })
        .some((button) => button.hasAttribute('disabled'))
    ).toBe(true)
    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'ENG-1',
      { priorityId: '2' },
      'site-1'
    )
  })

  it('preserves mutation order when the workspace unmounts and remounts', async () => {
    const oldSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValue(deferred<{ ok: true }>().promise)
    const mounted = render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    mounted.unmount()
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('First edit', 'Latest edit')
    await flushPromises()
    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(1)
    await act(async () => oldSave.resolve({ ok: false, error: 'First save rejected' }))
    await flushPromises()
    expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(2)
    expect(screen.getByDisplayValue('Latest edit')).toBeDefined()
    expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
      'ENG-1',
      { title: 'Latest edit' },
      { sourceContext: initialSource, siteId: 'site-1', contextKey: initialSourceContextKey }
    )
  })

  it.each(['account', 'host', 'site'] as const)(
    'keeps saves independent when the same issue key moves to another %s',
    async (kind) => {
      runtimeMocks.jiraGetIssueForTarget.mockImplementation(
        async (_owner: RuntimeClientTarget, _key: string, siteId?: string | null) =>
          jiraIssue('Old title', { siteId: siteId ?? undefined })
      )
      const oldSave = deferred<{ ok: false; error: string }>()
      runtimeMocks.jiraUpdateIssueForTarget
        .mockReturnValueOnce(oldSave.promise)
        .mockReturnValue(deferred<{ ok: true }>().promise)
      render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
      await flushPromises()
      saveTitle('Old title', 'First edit')
      await act(async () => {
        if (kind === 'site') {
          selectIssue(jiraIssue('Old title', { siteId: 'site-2' }))
        } else {
          selectSource({
            ...initialSource,
            ...(kind === 'account'
              ? { accountLabel: 'other-account' }
              : { hostId: 'runtime:other-host' })
          })
        }
      })
      await flushPromises()
      saveTitle('Old title', 'Latest edit')
      await flushPromises()
      expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenCalledTimes(2)
      expect(runtimeMocks.jiraUpdateIssueForTarget).toHaveBeenLastCalledWith(
        kind === 'host' ? { kind: 'environment', environmentId: 'other-host' } : { kind: 'local' },
        'ENG-1',
        { title: 'Latest edit' },
        kind === 'site' ? 'site-2' : 'site-1'
      )
      await act(async () => oldSave.resolve({ ok: false, error: 'First save rejected' }))
      await flushPromises()
      expect(screen.getByDisplayValue('Latest edit')).toBeDefined()
      expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
        'ENG-1',
        { title: 'Old title' },
        { sourceContext: initialSource, siteId: 'site-1', contextKey: initialSourceContextKey }
      )
    }
  )

  it('preserves a replayed save across reopened hydration and synchronizes the title draft', async () => {
    const oldSave = deferred<{ ok: true }>()
    const reopenedLoad = deferred<JiraIssue>()
    runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(oldSave.promise)
    runtimeMocks.jiraGetIssueForTarget
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValueOnce(otherIssue)
      .mockReturnValueOnce(reopenedLoad.promise)
      .mockResolvedValue(jiraIssue('First edit'))
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('Old title')))
    await flushPromises()
    expect(screen.getByDisplayValue('First edit')).toBeDefined()
    await act(async () => oldSave.resolve({ ok: true }))
    await flushPromises()
    await act(async () => reopenedLoad.resolve(jiraIssue('Old title')))
    await flushPromises()
    expect(screen.getByDisplayValue('First edit')).toBeDefined()
    expect(screen.queryByDisplayValue('Old title')).toBeNull()
  })

  it.each([
    ['succeeds', { ok: true }],
    ['fails', { ok: false, error: 'Title rejected' }]
  ] as const)(
    'preserves an unsaved title draft when an older reopened save %s',
    async (_, outcome) => {
      const oldSave = deferred<typeof outcome>()
      runtimeMocks.jiraUpdateIssueForTarget.mockReturnValue(oldSave.promise)
      runtimeMocks.jiraGetIssueForTarget
        .mockResolvedValueOnce(jiraIssue('Old title'))
        .mockResolvedValueOnce(otherIssue)
        .mockResolvedValueOnce(jiraIssue('Old title'))
        .mockResolvedValue(jiraIssue('First edit'))
      render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
      await flushPromises()
      saveTitle('Old title', 'First edit')
      await act(async () => selectIssue(otherIssue))
      await flushPromises()
      await act(async () => selectIssue(jiraIssue('Old title')))
      await flushPromises()
      fireEvent.change(screen.getByDisplayValue('First edit'), {
        target: { value: 'Unsubmitted draft' }
      })
      await act(async () => oldSave.resolve(outcome))
      await flushPromises()
      expect(screen.getByDisplayValue('Unsubmitted draft')).toBeDefined()
      expect(
        screen.getAllByRole('heading', { name: outcome.ok ? 'First edit' : 'Old title' }).length
      ).toBeGreaterThan(0)
    }
  )

  it('uses newly hydrated values as the rollback baseline for a different field', async () => {
    const oldSave = deferred<{ ok: false; error: string }>()
    const newerSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newerSave.promise)
    runtimeMocks.jiraGetIssueForTarget
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValueOnce(otherIssue)
      .mockResolvedValue(jiraIssue('Old title', { labels: ['backend'] }))
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('First edit')))
    await flushPromises()
    const labels = screen.getByDisplayValue('backend')
    fireEvent.change(labels, { target: { value: 'new' } })
    const save = labels.parentElement?.querySelector('button')
    if (!(save instanceof HTMLButtonElement)) {
      throw new Error('Missing labels save button')
    }
    fireEvent.click(save)
    await flushPromises()
    await act(async () => oldSave.resolve({ ok: false, error: 'Title rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('new')).toBeDefined()
    await act(async () => newerSave.resolve({ ok: false, error: 'Labels rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('Old title')).toBeDefined()
    expect(screen.getByDisplayValue('backend')).toBeDefined()
  })

  it('keeps a newer hydrated rollback baseline when an older refresh returns stale fields', async () => {
    const oldSave = deferred<{ ok: true }>()
    const oldRefresh = deferred<JiraIssue>()
    const newerSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssueForTarget
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newerSave.promise)
    runtimeMocks.jiraGetIssueForTarget
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockReturnValueOnce(oldRefresh.promise)
      .mockResolvedValueOnce(otherIssue)
      .mockResolvedValue(jiraIssue('First edit', { labels: ['backend'] }))
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => oldSave.resolve({ ok: true }))
    await flushPromises()
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('First edit')))
    await flushPromises()
    const labels = screen.getByDisplayValue('backend')
    fireEvent.change(labels, { target: { value: 'new' } })
    const save = labels.parentElement?.querySelector('button')
    if (!(save instanceof HTMLButtonElement)) {
      throw new Error('Missing labels save button')
    }
    fireEvent.click(save)
    await flushPromises()
    await act(async () => oldRefresh.resolve(jiraIssue('First edit')))
    await flushPromises()
    await act(async () => newerSave.resolve({ ok: false, error: 'Labels rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('backend')).toBeDefined()
  })
})
