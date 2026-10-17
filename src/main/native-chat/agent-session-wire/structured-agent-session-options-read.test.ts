// A chat's options at rest come from the host catalog without waiting on a listing.

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from '../agent-model-catalog/agent-model-catalog-store'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { readStructuredAgentSessionOptions } from './structured-agent-session-options-read'
import { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const SESSION = 'session-1'

function restingRecord(): AgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read and the catalog key touch only these fields.
  return {
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/homes/a' },
    location: { executionHostId: 'local', wslDistro: null },
    options: {}
  } as unknown as AgentSessionRecord
}

describe('options at rest', () => {
  it('keeps the account model for an older client when the starting child has no folder default', async () => {
    const record = restingRecord()
    const read = vi.fn(async (params: { inSessionWorkspace?: true }) => ({
      origin: 'probe' as const,
      models: [
        {
          id: params.inSessionWorkspace ? 'gpt-folder' : 'gpt-account',
          label: 'Model',
          isDefault: !params.inSessionWorkspace,
          efforts: []
        }
      ],
      fetchedAt: 1
    }))
    const starting = {
      child: { phase: 'starting' },
      params: { provider: 'codex' },
      journal: { threadGoal: () => null, context: { floor: () => null } }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read touches only the declared context fields.
    const context = {
      deps: {
        adapter: {},
        agents: NO_STRUCTURED_AGENTS,
        store: { getRecord: () => record },
        modelCatalog: { read }
      },
      serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
      openConversation: async () => starting,
      conversation: async () => starting
    } as unknown as StructuredAgentSessionMutationContext

    const current = await readStructuredAgentSessionOptions(context, SESSION, {
      readsWithoutModel: true
    })
    expect(current.current).toEqual({ permissionMode: 'ask' })
    expect(read).toHaveBeenCalledTimes(1)
    const older = await readStructuredAgentSessionOptions(context, SESSION, {
      readsWithoutModel: false
    })
    expect(older.current).toEqual({ model: 'gpt-account', permissionMode: 'ask' })
    expect(read).toHaveBeenLastCalledWith({ agent: 'codex', sessionId: SESSION, savedOnly: true })
  })

  it.each(['codex', 'omp', 'grok', 'opencode'] as const)(
    'omits an unknown model for %s while the catalog is unavailable',
    async (provider) => {
      const record = { ...restingRecord(), provider }
      const probe = vi.fn(() => new Promise<AgentModelCatalogSuccess>(() => {}))
      const modelCatalog = createAgentModelCatalogService({
        store: new AgentModelCatalogStore(),
        getRecord: () => record,
        drivesRecord: () => true,
        resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: '/homes/a' }),
        probes: { codex: probe }
      })
      const resting = {
        child: null,
        params: { provider: 'codex' },
        journal: { threadGoal: () => null, context: { floor: () => null } }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read touches only these members.
      const context = {
        deps: {
          adapter: {},
          agents: NO_STRUCTURED_AGENTS,
          store: { getRecord: () => record },
          modelCatalog
        },
        serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
        openConversation: async () => resting,
        conversation: async () => resting
      } as unknown as StructuredAgentSessionMutationContext

      const result = await readStructuredAgentSessionOptions(context, SESSION, {
        readsWithoutModel: true
      })
      expect(probe).not.toHaveBeenCalled()
      expect(result.models).toEqual([])
      expect(result.current).not.toHaveProperty('model')
      record.options = { model: 'later-model', effort: 'off' }
      // Only Codex is registered here, and a mode is stated only for a registered agent's chat.
      expect(
        (await readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true }))
          .current
      ).toEqual({
        model: 'later-model',
        effort: 'off',
        ...(provider === 'codex' ? { permissionMode: 'ask' } : {})
      })
    }
  )
})

describe('live Codex option reads', () => {
  it('keeps newer saved picks after a cold live listing waits without holding the session lane', async () => {
    const listing = Promise.withResolvers<void>()
    const queue = new StructuredAgentSessionTaskQueue()
    const child = { fence: 7 }
    const record = restingRecord()
    const apply = vi.fn(() => ({
      models: [{ id: 'gpt-live', label: 'GPT Live', efforts: [] }],
      current: { model: 'gpt-live', effort: 'high', confirmed: ['model', 'effort'] as const }
    }))
    const prepareReadOptions = vi.fn(async () => {
      await listing.promise
      return apply
    })
    const live = {
      child,
      params: { provider: 'codex' },
      journal: { threadGoal: () => null, contextUsage: () => null, context: { floor: () => null } }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read touches only the declared context fields.
    const context = {
      deps: {
        adapter: { prepareReadOptions },
        agents: NO_STRUCTURED_AGENTS,
        store: { getRecord: () => record }
      },
      serialize: (sessionId: string, task: () => Promise<unknown>) =>
        queue.serialize(sessionId, task),
      openConversation: async () => live,
      conversation: async () => live
    } as unknown as StructuredAgentSessionMutationContext

    const reading = readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
    await vi.waitFor(() =>
      expect(prepareReadOptions).toHaveBeenCalledWith({ sessionId: SESSION, fence: 7 })
    )
    await expect(queue.serialize(SESSION, async () => 'delivery can proceed')).resolves.toBe(
      'delivery can proceed'
    )
    expect(apply).not.toHaveBeenCalled()
    record.options = { model: 'gpt-next', effort: 'low' }
    listing.resolve()
    await expect(reading).resolves.toMatchObject({
      current: { model: 'gpt-next', effort: 'low', confirmed: [] }
    })
    expect(apply).toHaveBeenCalledOnce()
  })

  it('keeps a listing failure visible to the picker', async () => {
    const queue = new StructuredAgentSessionTaskQueue()
    const live = {
      child: { fence: 7 },
      params: { provider: 'codex' },
      journal: { threadGoal: () => null, context: { floor: () => null } }
    }
    const failure = new Error('model/list unavailable')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the failed read ends before touching the remaining context fields.
    const context = {
      deps: {
        adapter: {
          prepareReadOptions: async () => {
            throw failure
          }
        },
        agents: NO_STRUCTURED_AGENTS,
        store: { getRecord: () => restingRecord() }
      },
      serialize: (sessionId: string, task: () => Promise<unknown>) =>
        queue.serialize(sessionId, task),
      openConversation: async () => live
    } as unknown as StructuredAgentSessionMutationContext

    await expect(
      readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
    ).rejects.toBe(failure)
    await expect(queue.serialize(SESSION, async () => 'Stop can proceed')).resolves.toBe(
      'Stop can proceed'
    )
  })

  it('does not apply a listing to a replaced child', async () => {
    const listing = Promise.withResolvers<void>()
    const queue = new StructuredAgentSessionTaskQueue()
    const apply = vi.fn(() => ({ models: [], current: { model: 'stale' } }))
    const prepareReadOptions = vi.fn(async () => {
      await listing.promise
      return apply
    })
    const live = {
      child: { fence: 7 },
      params: { provider: 'codex' },
      journal: { threadGoal: () => null, context: { floor: () => null } }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read touches only the declared context fields.
    const context = {
      deps: {
        adapter: { prepareReadOptions },
        agents: NO_STRUCTURED_AGENTS,
        store: { getRecord: () => restingRecord() }
      },
      serialize: (sessionId: string, task: () => Promise<unknown>) =>
        queue.serialize(sessionId, task),
      openConversation: async () => live,
      conversation: async () => live
    } as unknown as StructuredAgentSessionMutationContext

    const reading = readStructuredAgentSessionOptions(context, SESSION, { readsWithoutModel: true })
    await vi.waitFor(() => expect(prepareReadOptions).toHaveBeenCalledOnce())
    await queue.serialize(SESSION, async () => {
      live.child = { fence: 8 }
    })
    listing.resolve()
    expect((await reading).current).not.toHaveProperty('model')
    expect(apply).not.toHaveBeenCalled()
  })
})
