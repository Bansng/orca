// Answers are fenced to the prompt and process so late keys cannot reach a replacement shell.
import { createHash } from 'node:crypto'
import { readAgentPromptAnswers, type PendingPrompt } from '../../shared/agent-pending-prompt'
import { readTerminalSendAcknowledgment } from '../../shared/terminal-send-acknowledgment'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { OrcaRuntimeService } from './orca-runtime'
import type { AgentPromptExpectedBinding } from './runtime-terminal-contracts'

export type TerminalAgentPromptAnswerRuntime = Pick<
  OrcaRuntimeService,
  'getTerminalHandleForPaneKey' | 'getTerminalPromptRequestBinding' | 'sendTerminal'
>

export type PanePromptTarget = {
  paneKey: string
  agent: string
  /** The agent's status hooks are on, so its rows say what it waits on. */
  answerable: boolean
}

type PanePrompt = {
  prompt: PendingPrompt
  keysByOption: ReadonlyMap<string, string>
  handle: string
  binding: AgentPromptExpectedBinding
}

export type PromptAnswerOutcome =
  | { outcome: 'accepted' }
  | {
      outcome: 'refused'
      reason:
        | 'prompt_not_pending'
        | 'prompt_unsupported'
        | 'option_not_offered'
        | 'agent_not_reachable'
    }
  | { outcome: 'unknown' }

/** One prompt occurrence in one process: a later prompt, or the same one in a new process, differs. */
function promptIdentity(binding: AgentPromptExpectedBinding, row: AgentStatusIpcPayload): string {
  const facts = [
    binding.ptyId,
    binding.processIncarnation,
    row.stateStartedAt,
    row.interactivePrompt ?? '',
    row.toolName ?? ''
  ]
  return `p_${createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 20)}`
}

class PromptNoLongerPendingError extends Error {
  constructor() {
    super('prompt_not_pending')
  }
}

/**
 * Answers prompts on this host. Remembers what it answered, so a second answer to one prompt
 * refuses even while the agent has not yet reported moving on.
 */
export class TerminalAgentPromptAnswers {
  private readonly answered = new Map<string, string>()

  constructor(private readonly readHookRow: (paneKey: string) => AgentStatusIpcPayload | null) {}

  pending(
    runtime: TerminalAgentPromptAnswerRuntime,
    target: PanePromptTarget
  ): PendingPrompt | null {
    return this.read(runtime, target)?.prompt ?? null
  }

  async answer(
    runtime: TerminalAgentPromptAnswerRuntime,
    target: PanePromptTarget,
    answer: {
      promptId: string
      optionId: string
      /** The caller's own check before the keys go in (its agent-in-front guard). */
      beforeWrite?: (ptyId: string) => Promise<void>
      signal: AbortSignal
    }
  ): Promise<PromptAnswerOutcome> {
    const asked = this.read(runtime, target)
    if (!asked || asked.prompt.promptId !== answer.promptId) {
      return { outcome: 'refused', reason: 'prompt_not_pending' }
    }
    if (asked.prompt.kind === 'unsupported') {
      return { outcome: 'refused', reason: 'prompt_unsupported' }
    }
    const keys = asked.keysByOption.get(answer.optionId)
    if (keys === undefined) {
      return { outcome: 'refused', reason: 'option_not_offered' }
    }
    let claimed = false
    try {
      const sent = await runtime.sendTerminal(
        asked.handle,
        { text: keys, enter: false },
        {
          inputKind: 'driving',
          signal: answer.signal,
          requireWriteSettlement: true,
          beforeWrite: async (ptyId) => {
            await answer.beforeWrite?.(ptyId)
            // Last and synchronous, so nothing moves between this read and the write.
            const now = this.read(runtime, target)
            if (
              ptyId !== asked.binding.ptyId ||
              now?.prompt.promptId !== answer.promptId ||
              now.binding.processIncarnation !== asked.binding.processIncarnation
            ) {
              throw new PromptNoLongerPendingError()
            }
            this.answered.set(target.paneKey, answer.promptId)
            claimed = true
          }
        }
      )
      const settlement = readTerminalSendAcknowledgment({ send: sent })
      if (settlement === 'accepted') {
        return { outcome: 'accepted' }
      }
      if (settlement === 'refused') {
        if (this.answered.get(target.paneKey) === answer.promptId) {
          this.answered.delete(target.paneKey)
        }
        return { outcome: 'refused', reason: 'agent_not_reachable' }
      }
      return { outcome: 'unknown' }
    } catch (error) {
      if (claimed) {
        return { outcome: 'unknown' }
      }
      return {
        outcome: 'refused',
        reason:
          error instanceof PromptNoLongerPendingError ? 'prompt_not_pending' : 'agent_not_reachable'
      }
    }
  }

  private read(
    runtime: TerminalAgentPromptAnswerRuntime,
    target: PanePromptTarget
  ): PanePrompt | null {
    const handle = runtime.getTerminalHandleForPaneKey(target.paneKey)
    const row = handle ? this.readHookRow(target.paneKey) : null
    if (!handle || !row) {
      return null
    }
    let binding: AgentPromptExpectedBinding
    try {
      const { ptyId, processIncarnation } = runtime.getTerminalPromptRequestBinding(handle)
      binding = { ptyId, processIncarnation }
    } catch {
      return null
    }
    const promptId = promptIdentity(binding, row)
    if (this.answered.get(target.paneKey) === promptId) {
      return null
    }
    const read = readAgentPromptAnswers(row, target.agent, promptId, target.answerable)
    return read ? { ...read, handle, binding } : null
  }
}
