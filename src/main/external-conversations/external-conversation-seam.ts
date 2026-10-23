import type { AgentStatusHooksSettings } from '../../shared/agent-status-hooks-setting'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { admitConnectorAgent } from './connector-agents'
import { ConversationChain } from './external-conversation-chain'
import { DeliveryReceipts, type DeliveryReceiptDb } from './external-conversation-delivery-receipts'
import {
  findLink,
  writeLink,
  type ExternalConversationLinkStore,
  type LinkedConversation
} from './external-conversation-links'
import { bindPane, deliverFollowUp, type FollowUpTerminal } from './external-conversation-send'
import type { AgentPromptExpectedBinding } from '../runtime/runtime-terminal-contracts'
import {
  launchConversation,
  runtimeConversationLauncher,
  type ConversationLaunchInput,
  type ConversationLauncher
} from './external-conversation-start'
import {
  conversationId,
  refused,
  type ConversationKey,
  type ConversationStart,
  type Delivery
} from './external-conversation-types'

/** What the seam drives on its host: the launch path and the linked terminals. */
export type ExternalConversationHost = {
  launcher: ConversationLauncher
  terminal: FollowUpTerminal
}

export function runtimeConversationHost(runtime: OrcaRuntimeService): ExternalConversationHost {
  return { launcher: runtimeConversationLauncher(runtime), terminal: runtime }
}

export type ExternalConversationSeamDeps = {
  store: ExternalConversationLinkStore
  readSettings: () => AgentStatusHooksSettings
  receiptDb: () => DeliveryReceiptDb
  /** Worktree removals; returns the release. */
  onWorkspaceRemoved: (listener: (worktreeId: string) => void) => () => void
}

type StartInput = Omit<ConversationLaunchInput, 'agent'> & { agent: string }

/**
 * The connector seam for one enabled period. Turning connectors off disposes it: queued work
 * settles `connectors_disabled` at once and running work stops at its next boundary. Turning them
 * on builds a fresh one.
 */
export class ExternalConversationSeam {
  private readonly abort = new AbortController()
  private readonly chain = new ConversationChain(this.abort.signal)
  private readonly receipts: DeliveryReceipts
  /** Conversations this period started, so a second start for one shares its creation. */
  private readonly startedHere = new Set<string>()
  /** Conversations with work sent here, by the workspace their link was on. */
  private readonly linked = new Map<string, { key: ConversationKey; worktreeId: string }>()
  /**
   * The process each lane admitted first, by a launch or a send; its queued work goes there or
   * nowhere. Null: a launch published no process this lane can prove, so queued work goes nowhere.
   */
  private readonly admitted = new WeakMap<AbortSignal, AgentPromptExpectedBinding | null>()
  private readonly releaseRemovals: () => void

  constructor(private readonly deps: ExternalConversationSeamDeps) {
    this.receipts = new DeliveryReceipts(deps.receiptDb)
    // A removed workspace may keep its PTY registered a while; its held and queued sends end now.
    // The event names no host, so a same-path twin's removal is told apart by the link surviving.
    this.releaseRemovals = deps.onWorkspaceRemoved((worktreeId) => {
      for (const [id, { key, worktreeId: linkedTo }] of this.linked) {
        if (linkedTo === worktreeId && !findLink(this.deps.store, key)) {
          this.linked.delete(id)
          this.chain.cancel(id, 'agent_not_reachable')
        }
      }
    })
  }

  /** Deferred work passes this to every effect, so nothing starts or writes after a disable. */
  get signal(): AbortSignal {
    return this.abort.signal
  }

  dispose(reason: 'connectors_disabled'): void {
    this.releaseRemovals()
    this.abort.abort(reason)
  }

  async start(
    host: ExternalConversationHost,
    key: ConversationKey,
    deliveryId: string,
    input: StartInput
  ): Promise<ConversationStart> {
    const initial = await this.receipts.run(
      key,
      deliveryId,
      'connector.start',
      [input.agent, input.target, input.prompt],
      () =>
        this.chain.enqueue(conversationId(key), async (signal) => {
          const { agent } = input
          if (!admitConnectorAgent(this.deps.readSettings(), agent)) {
            return refused('unsupported_agent')
          }
          const linked = findLink(this.deps.store, key)
          if (linked) {
            // A link from before this period cannot say what became of its launch.
            return this.startedHere.has(conversationId(key))
              ? this.deliver(host.terminal, key, linked, deliveryId, input.prompt, signal)
              : { outcome: 'unknown', reason: 'launch_outcome_unknown' }
          }
          return launchConversation(
            host.launcher,
            { ...input, agent },
            signal,
            (workspace, paneKey) => {
              writeLink(this.deps.store, workspace, {
                ...key,
                paneKey,
                agent,
                createdAt: Date.now()
              })
              this.startedHere.add(conversationId(key))
            },
            // Before link resolution or prompt delivery settle, so no follower adopts a successor.
            (paneKey) => {
              this.admitted.set(
                signal,
                (paneKey && bindPane(host.terminal, paneKey)?.binding) || null
              )
            }
          )
        })
    )
    return { conversation: key, initial }
  }

  send(
    host: ExternalConversationHost,
    key: ConversationKey,
    deliveryId: string,
    text: string
  ): Promise<Delivery> {
    const id = conversationId(key)
    return this.receipts.run(key, deliveryId, 'connector.send', [text], () => {
      const queued = findLink(this.deps.store, key)
      if (queued) {
        this.linked.set(id, { key, worktreeId: queued.workspace.worktreeId })
      }
      return this.chain.enqueue(id, async (signal) => {
        const linked = findLink(this.deps.store, key)
        if (!linked) {
          throw new Error('external_conversation_not_found')
        }
        return this.deliver(host.terminal, key, linked, deliveryId, text, signal)
      })
    })
  }

  private async deliver(
    terminal: FollowUpTerminal,
    key: ConversationKey,
    { workspace, link }: LinkedConversation,
    deliveryId: string,
    text: string,
    signal: AbortSignal
  ): Promise<Delivery> {
    const id = conversationId(key)
    this.linked.set(id, { key, worktreeId: workspace.worktreeId })
    const pane = bindPane(terminal, link.paneKey)
    const admitted = this.admitted.has(signal) ? this.admitted.get(signal) : pane?.binding
    if (!pane || !admitted || !sameBinding(pane.binding, admitted)) {
      return this.lost(id, signal)
    }
    this.admitted.set(signal, admitted)
    const delivery = await deliverFollowUp(terminal, {
      handle: pane.handle,
      expectedBinding: admitted,
      agent: link.agent,
      text,
      requestId: JSON.stringify([key.source, key.externalId, deliveryId]),
      signal
    })
    // The admitted process is gone or replaced: queued work must not reach its successor.
    return delivery.outcome === 'refused' && delivery.reason === 'agent_not_reachable'
      ? this.lost(id, signal)
      : delivery
  }

  /** Settles this conversation's queue before it advances; a later send opens a new lane. */
  private lost(id: string, laneSignal: AbortSignal): Delivery {
    this.chain.cancel(id, 'agent_not_reachable', laneSignal)
    return refused('agent_not_reachable')
  }
}

function sameBinding(a: AgentPromptExpectedBinding, b: AgentPromptExpectedBinding): boolean {
  return a.ptyId === b.ptyId && a.processIncarnation === b.processIncarnation
}
