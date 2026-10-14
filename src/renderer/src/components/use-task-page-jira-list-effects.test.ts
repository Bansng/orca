// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskPageLinearCollectionEffectsModel } from './use-task-page-linear-collection-effects'
import { useTaskPageJiraListEffects } from './use-task-page-jira-list-effects'

const listJiraIssues = vi.fn().mockResolvedValue([])
const searchJiraIssues = vi.fn().mockResolvedValue([])

function createModel(): TaskPageLinearCollectionEffectsModel {
  const model = {
    settings: null,
    setTaskResumeState: vi.fn(),
    searchJiraIssues,
    listJiraIssues,
    jiraConnected: true,
    selectedJiraSiteId: 'site-1',
    taskSource: 'jira',
    jiraTaskSourceContext: null,
    jiraHasWorkspace: false,
    linkedJiraIssueRefs: [],
    linkedJiraIssueRefsSignature: '[]',
    jiraTaskSourceScopeKey: 'fixture',
    jiraSearchPersistReadyRef: { current: true },
    taskResumeApplied: true,
    selectedJiraIssueKey: null,
    setSelectedJiraIssueKey: vi.fn(),
    selectedJiraIssueFallback: null,
    setSelectedJiraIssueFallback: vi.fn(),
    setJiraIssues: vi.fn(),
    setJiraLoading: vi.fn(),
    setJiraError: vi.fn(),
    setJiraErrorDetailsOpen: vi.fn(),
    setJiraJqlRejection: vi.fn(),
    jiraSearchInput: '',
    appliedJiraSearch: '',
    setAppliedJiraSearch: vi.fn(),
    activeJiraPreset: 'assigned',
    jiraCurrentSprint: false,
    jiraRefreshNonce: 0,
    jiraActiveSavedFilterId: null,
    jiraSavedFilters: [],
    jiraSavedFiltersLoading: false,
    selectedJiraStatuses: [],
    jiraQuickFiltersLoading: false,
    setJiraStatusCatalog: vi.fn(),
    setJiraProjectStatusOrder: vi.fn(),
    displayedJiraIssues: []
  }
  // SAFETY: the hook only reads the Jira fields above; the preceding pipeline model is intentionally not constructed in this isolated wiring test.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the partial fixture intentionally models only fields read by this hook.
  return model as unknown as TaskPageLinearCollectionEffectsModel
}

describe('useTaskPageJiraListEffects refresh wiring', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    listJiraIssues.mockResolvedValue([])
    searchJiraIssues.mockResolvedValue([])
  })
  it('keeps sprint presets on the host list path and composes text queries after classification', async () => {
    const model = createModel()
    model.activeJiraPreset = 'all'
    model.jiraCurrentSprint = true
    model.selectedJiraStatuses = ['Blocked']
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() =>
      expect(listJiraIssues).toHaveBeenCalledWith('all', 50, {
        sourceContext: null,
        force: false,
        filters: { statuses: ['Blocked'], currentSprint: true }
      })
    )
    expect(searchJiraIssues).not.toHaveBeenCalled()
    await act(async () => {
      model.appliedJiraSearch = 'fix login'
      rerender()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(searchJiraIssues).toHaveBeenCalledWith(
        '(text ~ "fix login*") AND sprint in openSprints()',
        50,
        { sourceContext: null, force: false }
      )
    )
  })

  it('adds sprint filtering to exact saved JQL without retrying invalid syntax as text', async () => {
    const model = createModel()
    model.appliedJiraSearch = 'saved-query ORDER BY updated DESC'
    model.jiraActiveSavedFilterId = 'saved'
    model.jiraSavedFilters = [{ id: 'saved', name: 'Saved', jql: model.appliedJiraSearch }]
    model.jiraCurrentSprint = true
    searchJiraIssues.mockRejectedValue(new Error('Error 400: Invalid saved query'))
    renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() =>
      expect(model.setJiraError).toHaveBeenCalledWith(
        expect.objectContaining({ details: 'Invalid saved query' })
      )
    )
    expect(searchJiraIssues).toHaveBeenCalledExactlyOnceWith(
      '(saved-query) AND sprint in openSprints() ORDER BY updated DESC',
      50,
      { sourceContext: null, force: false }
    )
    expect(listJiraIssues).not.toHaveBeenCalled()
  })

  it('reports a saved query that exceeds the request limit after sprint composition', async () => {
    const model = createModel()
    model.appliedJiraSearch = `key in (${Array.from({ length: 1030 }, (_, index) => `APP-${index + 1}`).join(',')})`
    model.jiraActiveSavedFilterId = 'large'
    model.jiraSavedFilters = [{ id: 'large', name: 'Large', jql: model.appliedJiraSearch }]
    model.jiraCurrentSprint = true
    renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() =>
      expect(model.setJiraError).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('too long') })
      )
    )
    expect(searchJiraIssues).not.toHaveBeenCalled()
    expect(listJiraIssues).not.toHaveBeenCalled()
  })

  it('loads linked keys directly and does not reread them for local search text', async () => {
    const model = createModel()
    model.jiraHasWorkspace = true
    model.linkedJiraIssueRefs = [{ key: 'APP-1', siteId: 'site-1' }]
    model.linkedJiraIssueRefsSignature = JSON.stringify(model.linkedJiraIssueRefs)
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(1))
    expect(listJiraIssues).not.toHaveBeenCalled()
    expect(searchJiraIssues).toHaveBeenCalledWith('key = APP-1', 1, {
      sourceContext: null,
      siteId: 'site-1',
      force: false
    })
    model.appliedJiraSearch = 'login'
    rerender()
    await waitFor(() => expect(model.setJiraLoading).toHaveBeenLastCalledWith(false))
    expect(searchJiraIssues).toHaveBeenCalledTimes(1)
    model.jiraRefreshNonce = 1
    rerender()
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(2))
    expect(searchJiraIssues).toHaveBeenLastCalledWith('key = APP-1', 1, {
      sourceContext: null,
      siteId: 'site-1',
      force: true
    })
  })

  it('ignores a linked read that completes after the source changes', async () => {
    const model = createModel()
    model.jiraHasWorkspace = true
    model.linkedJiraIssueRefs = [{ key: 'APP-1', siteId: 'site-1' }]
    model.linkedJiraIssueRefsSignature = JSON.stringify(model.linkedJiraIssueRefs)
    let complete: (value: []) => void = () => {}
    searchJiraIssues.mockImplementationOnce(
      () =>
        new Promise<[]>((resolve) => {
          complete = resolve
        })
    )
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(1))
    model.taskSource = 'linear'
    rerender()
    await act(async () => {
      complete([])
      await Promise.resolve()
    })
    expect(model.setJiraIssues).not.toHaveBeenCalled()
  })

  it('passes force only for a refresh nonce change', async () => {
    const model = createModel()
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))

    await waitFor(() => expect(listJiraIssues).toHaveBeenCalledTimes(1))
    expect(listJiraIssues).toHaveBeenNthCalledWith(1, 'assigned', 50, {
      sourceContext: null,
      force: false
    })

    await act(async () => {
      model.jiraRefreshNonce = 1
      rerender()
      await Promise.resolve()
    })
    await waitFor(() => expect(listJiraIssues).toHaveBeenCalledTimes(2))
    expect(listJiraIssues).toHaveBeenNthCalledWith(2, 'assigned', 50, {
      sourceContext: null,
      force: true
    })

    await act(async () => {
      model.activeJiraPreset = 'reported'
      rerender()
      await Promise.resolve()
    })
    await waitFor(() => expect(listJiraIssues).toHaveBeenCalledTimes(3))
    expect(listJiraIssues).toHaveBeenNthCalledWith(3, 'reported', 50, {
      sourceContext: null,
      force: false
    })
  })

  it('uses the preset list path for status filters and restores it after clearing', async () => {
    const model = createModel()
    model.selectedJiraStatuses = ['In Progress', 'Blocked']
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() => expect(listJiraIssues).toHaveBeenCalledTimes(1))
    expect(listJiraIssues).toHaveBeenLastCalledWith('assigned', 50, {
      sourceContext: null,
      force: false,
      filters: { statuses: ['In Progress', 'Blocked'] }
    })
    expect(searchJiraIssues).not.toHaveBeenCalled()
    await act(async () => {
      model.selectedJiraStatuses = []
      rerender()
    })
    expect(listJiraIssues).toHaveBeenLastCalledWith('assigned', 50, {
      sourceContext: null,
      force: false
    })
  })

  it('keeps manual JQL independent of a persisted status selection', async () => {
    const model = createModel()
    model.selectedJiraStatuses = ['Blocked']
    model.appliedJiraSearch = 'project = APP ORDER BY created ASC'
    renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(1))
    expect(searchJiraIssues).toHaveBeenCalledWith('project = APP ORDER BY created ASC', 50, {
      sourceContext: null,
      force: false
    })
    expect(listJiraIssues).not.toHaveBeenCalled()
  })

  it('passes force through the text-search wrapper on refresh', async () => {
    const model = createModel()
    model.appliedJiraSearch = 'fix login'
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(1))

    await act(async () => {
      model.jiraRefreshNonce = 1
      rerender()
      await Promise.resolve()
    })
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(2))
    expect(searchJiraIssues).toHaveBeenNthCalledWith(2, 'text ~ "fix login*"', 50, {
      sourceContext: null,
      force: true
    })
  })

  it('shows the JQL rejection with its text matches and clears it for the next search', async () => {
    const model = createModel()
    model.appliedJiraSearch = 'project = NOPE'
    searchJiraIssues
      .mockRejectedValueOnce(new Error("Error 400: The value 'NOPE' does not exist."))
      .mockResolvedValueOnce([])
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    const rejection = { reason: "The value 'NOPE' does not exist.", likelyTypo: true }
    await waitFor(() => expect(model.setJiraJqlRejection).toHaveBeenLastCalledWith(rejection))

    // The next search never settles, so only the reset at its start can clear the notice.
    searchJiraIssues.mockReturnValueOnce(new Promise(() => {}))
    await act(async () => {
      model.appliedJiraSearch = 'fix login'
      rerender()
      await Promise.resolve()
    })
    expect(model.setJiraJqlRejection).toHaveBeenLastCalledWith(null)
  })

  it('drops the rejection of a search that was replaced before it finished', async () => {
    const model = createModel()
    model.appliedJiraSearch = 'project = NOPE'
    let rejectJql: (error: Error) => void = () => {}
    searchJiraIssues
      .mockReturnValueOnce(new Promise((_, reject) => (rejectJql = reject)))
      .mockResolvedValue([])
    const { rerender } = renderHook(() => useTaskPageJiraListEffects(model))
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(1))

    await act(async () => {
      model.appliedJiraSearch = 'fix login'
      rerender()
      await Promise.resolve()
    })
    await act(async () => {
      rejectJql(new Error("Error 400: The value 'NOPE' does not exist."))
      await Promise.resolve()
    })
    await waitFor(() => expect(searchJiraIssues).toHaveBeenCalledTimes(3))
    await act(async () => {
      await Promise.resolve()
    })
    expect(model.setJiraJqlRejection).not.toHaveBeenCalledWith(
      expect.objectContaining({ likelyTypo: true })
    )
  })
})
