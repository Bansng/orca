import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import { agentMainAgentVerdict } from '../../shared/agent-main-agent-verdict'
import type { PendingPrompt } from '../../shared/agent-pending-prompt'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { hookRowAgentPhase } from '../../shared/agent-transitions'
import type { AgentTurnOutcome } from '../../shared/agent-turn-outcome'
import type {
  ConnectorAgent,
  ExternalConversationLink
} from '../../shared/external-conversation-link'
import { judgeIdleAgentTurn } from '../agent-turn-idle-verdict'
import {
  TerminalAgentTurnNews,
  type TerminalAgentTurnNewsItem
} from '../runtime/terminal-agent-turn-news'
import {
  allLinks,
  type ExternalConversationLinkStore,
  type LinkedConversation
} from './external-conversation-links'
import type { ConversationKey } from './external-conversation-types'

type ConversationPane = { conversation: ConversationKey; worktreeId: string; paneKey: string }

export type ConversationEvent =
  | (ConversationPane & { kind: 'linked'; agent: ConnectorAgent })
  | (ConversationPane & { kind: 'prompt'; prompt: PendingPrompt })
  | (ConversationPane & { kind: 'turn-started'; at: number })
  | (ConversationPane & {
      kind: 'turn-ended'
      /** The host's recorded verdict on the turn; null when it recorded none. */
      stopReason: AgentTurnOutcome | null
      lastAssistantMessage?: string
      at: number
    })

export type ConversationSnapshot = {
  kind: 'snapshot'
  conversations: (ConversationPane & {
    agent: ConnectorAgent
    working: boolean
    prompt: PendingPrompt | null
  })[]
}

export type ConversationWatchListener = (event: ConversationSnapshot | ConversationEvent) => void

export type ConversationEventsDeps = {
  store: ExternalConversationLinkStore
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  /** The detector's pane changes; returns the release. */
  onAgentPaneChange: (listener: (change: AgentPaneChange) => void) => () => void
  pendingPrompt: (link: ExternalConversationLink) => PendingPrompt | null
  setTimer: (run: () => void, delayMs: number) => { cancel: () => void }
  now: () => number
}

/**
 * Linked agents' turns and prompts for connector watchers. Turn news is the phone push's own
 * (`TerminalAgentTurnNews`), and a finish counts only when the idle verdict automations use agrees.
 * Subscribed only while someone watches.
 */
export class ConversationEvents {
  private readonly listeners = new Set<ConversationWatchListener>()
  private readonly turnStartedAt = new Map<string, number>()
  private release: (() => void) | null = null

  constructor(private readonly deps: ConversationEventsDeps) {}

  watch(listener: ConversationWatchListener): () => void {
    if (!this.release) {
      const news = new TerminalAgentTurnNews<TerminalAgentTurnNewsItem>({
        readHookRow: (paneKey) => this.deps.readHookRow(paneKey),
        prepare: (item) => item,
        deliver: (item) => this.told(item),
        setTimer: (run, delayMs) => this.deps.setTimer(run, delayMs),
        started: (item) => this.started(item),
        stopped: (item) => this.ended(item, agentMainAgentVerdict(item.row))
      })
      const unsubscribe = this.deps.onAgentPaneChange((change) => news.observe(change))
      this.release = () => {
        unsubscribe()
        news.dispose()
      }
    }
    this.listeners.add(listener)
    // After subscribing, so a change while the snapshot is read is not missed.
    listener(this.snapshot())
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.dispose()
      }
    }
  }

  linked({ workspace, link }: LinkedConversation): void {
    this.emit({
      kind: 'linked',
      ...pane(link, workspace.worktreeId),
      agent: link.agent
    })
  }

  dispose(): void {
    this.release?.()
    this.release = null
    this.listeners.clear()
    this.turnStartedAt.clear()
  }

  private snapshot(): ConversationSnapshot {
    return {
      kind: 'snapshot',
      conversations: [...allLinks(this.deps.store)].map(({ workspace, link }) => {
        const row = this.deps.readHookRow(link.paneKey)
        return {
          ...pane(link, workspace.worktreeId),
          agent: link.agent,
          working: row ? hookRowAgentPhase(row) === 'working' : false,
          prompt: this.deps.pendingPrompt(link)
        }
      })
    }
  }

  private started(item: TerminalAgentTurnNewsItem): void {
    const link = this.linkFor(item.paneKey)
    if (!link) {
      return
    }
    const at = item.row.turnStartedAt ?? item.row.stateStartedAt
    this.turnStartedAt.set(item.paneKey, at)
    this.emit({ kind: 'turn-started', ...pane(link, item.worktreeId), at })
  }

  private told(item: TerminalAgentTurnNewsItem): void {
    const link = this.linkFor(item.paneKey)
    if (!link) {
      return
    }
    if (hookRowAgentPhase(item.row) === 'needs-you') {
      const prompt = this.deps.pendingPrompt(link)
      if (prompt) {
        this.emit({ kind: 'prompt', ...pane(link, item.worktreeId), prompt })
      }
      return
    }
    // A hook-reported `done` since this turn began; a reused pane's earlier one is not this turn's.
    const verdict = judgeIdleAgentTurn(
      {
        rows: [item.row],
        sentAt: this.turnStartedAt.get(item.paneKey) ?? 0,
        tail: [],
        readAgentCommands: () => []
      },
      this.deps.now()
    )
    if (verdict.kind === 'completed') {
      this.ended(item, agentMainAgentVerdict(item.row))
    }
  }

  private ended(item: TerminalAgentTurnNewsItem, stopReason: AgentTurnOutcome | null): void {
    const link = this.linkFor(item.paneKey)
    if (!link) {
      return
    }
    this.turnStartedAt.delete(item.paneKey)
    const message = item.row.lastAssistantMessage
    this.emit({
      kind: 'turn-ended',
      ...pane(link, item.worktreeId),
      stopReason,
      ...(message ? { lastAssistantMessage: message } : {}),
      at: item.row.stateStartedAt
    })
  }

  private linkFor(paneKey: string): ExternalConversationLink | null {
    for (const { link } of allLinks(this.deps.store)) {
      if (link.paneKey === paneKey) {
        return link
      }
    }
    return null
  }

  private emit(event: ConversationEvent): void {
    for (const listener of this.listeners) {
      // One watcher's failure must not cost the others the event.
      try {
        listener(event)
      } catch (error) {
        console.error('[connector] watch listener threw', error)
      }
    }
  }
}

function pane(link: ExternalConversationLink, worktreeId: string): ConversationPane {
  return {
    conversation: { source: link.source, externalId: link.externalId },
    worktreeId,
    paneKey: link.paneKey
  }
}
