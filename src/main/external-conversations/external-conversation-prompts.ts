import type { PendingPrompt } from '../../shared/agent-pending-prompt'
import type { AgentStatusHooksSettings } from '../../shared/agent-status-hooks-setting'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { ExternalConversationLink } from '../../shared/external-conversation-link'
import {
  createLaunchedAgentWriteGuard,
  type LaunchedAgentWriteGuardRuntime
} from '../runtime/launched-agent-write-guard'
import {
  TerminalAgentPromptAnswers,
  type PanePromptTarget,
  type TerminalAgentPromptAnswerRuntime
} from '../runtime/terminal-agent-prompt-answer'
import { admitConnectorAgent } from './connector-agents'
import type { Delivery } from './external-conversation-types'

export type PromptTerminal = TerminalAgentPromptAnswerRuntime & LaunchedAgentWriteGuardRuntime

/**
 * A linked agent's pending prompt and its answer, through the host's shared prompt answers. Not on
 * the conversation's queue: a follow-up held behind an approval waits for exactly this answer.
 */
export class ConversationPrompts {
  private readonly answers: TerminalAgentPromptAnswers

  constructor(
    private readonly readSettings: () => AgentStatusHooksSettings,
    readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  ) {
    this.answers = new TerminalAgentPromptAnswers(readHookRow)
  }

  pending(terminal: PromptTerminal, link: ExternalConversationLink): PendingPrompt | null {
    return this.answers.pending(terminal, this.target(link))
  }

  async answer(
    terminal: PromptTerminal,
    link: ExternalConversationLink,
    answer: { promptId: string; optionId: string; signal: AbortSignal }
  ): Promise<Delivery> {
    // Keys typed at a shell that replaced the agent would run as a command.
    const guard = createLaunchedAgentWriteGuard(terminal, link.agent, {
      unprovableHost: 'write-unless-shell'
    })
    try {
      const outcome = await this.answers.answer(terminal, this.target(link), {
        ...answer,
        beforeWrite: (ptyId) => guard.beforeWrite(ptyId)
      })
      return outcome.outcome === 'unknown'
        ? { outcome: 'unknown', reason: 'writer_failed' }
        : outcome
    } finally {
      guard.dispose()
    }
  }

  private target(link: ExternalConversationLink): PanePromptTarget {
    return {
      paneKey: link.paneKey,
      agent: link.agent,
      answerable: admitConnectorAgent(this.readSettings(), link.agent)
    }
  }
}
