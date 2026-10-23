import type { ConnectorSource } from '../../shared/external-conversation-link'

export type ConversationKey = { source: ConnectorSource; externalId: string }

/** Why the seam declined before any byte left it. */
export type ConnectorRefusal =
  | 'connectors_disabled'
  | 'agent_not_reachable'
  | 'unsupported_agent'
  | 'delivery_id_reused'

/**
 * The connector's own answer, weaker than a `WriteSettlement`: `accepted` means the writer
 * returned, never that the agent read it.
 */
export type Delivery =
  | { outcome: 'accepted' }
  | { outcome: 'refused'; reason: ConnectorRefusal }
  | {
      outcome: 'unknown'
      reason: 'launch_outcome_unknown' | 'writer_failed' | 'replayed_after_restart'
    }

export type ConversationStart = { conversation: ConversationKey; initial: Delivery }

export function refused(reason: ConnectorRefusal): Delivery {
  return { outcome: 'refused', reason }
}

/** One string per conversation, unambiguous for any id text. */
export function conversationId(key: ConversationKey): string {
  return JSON.stringify([key.source, key.externalId])
}
