import { ManagedRuntimeInstallRow } from '@/components/managed-runtime/ManagedRuntimeInstallRow'
import { translate } from '@/i18n/i18n'
import {
  useManagedRuntimeInstall,
  type ManagedRuntimeInstallObservation
} from '@/runtime/use-managed-runtime-install'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** What a chat's input slot holds for the program its host must install first. */
export type NativeChatInstallSlotState =
  | { kind: 'none' }
  /** The first status read is out: the composer stays, its sends held until the host answers. */
  | { kind: 'reserved' }
  | { kind: 'install'; observation: Extract<ManagedRuntimeInstallObservation, { kind: 'active' }> }

const NONE: NativeChatInstallSlotState = { kind: 'none' }
const RESERVED: NativeChatInstallSlotState = { kind: 'reserved' }

/** Install takes the composer's place while the chat's host has nothing to run, its install
 *  included; anything runnable, or a status the host could not report, leaves the composer. Until
 *  the host says whether it provides the program, the composer stays but sends nothing. */
export function useNativeChatInstallSlot(
  target: RuntimeClientTarget,
  agent: string,
  shown: boolean,
  agentLabel: string
): { slot: NativeChatInstallSlotState; sendBlockedReason: string | null } {
  const slot = installSlotState(useManagedRuntimeInstall(target, agent, shown))
  return { slot, sendBlockedReason: installSlotSendBlockedReason(slot, agentLabel) }
}

function installSlotState(
  observation: ManagedRuntimeInstallObservation
): NativeChatInstallSlotState {
  if (observation.kind === 'inactive') {
    return NONE
  }
  if (observation.kind === 'pending') {
    return RESERVED
  }
  const { snapshot } = observation
  if (snapshot.kind === 'readFailed') {
    return NONE
  }
  if (snapshot.kind === 'unknown') {
    return RESERVED
  }
  return snapshot.state.source === null ? { kind: 'install', observation } : NONE
}

/** Send stays held until the host says it can run this agent. */
function installSlotSendBlockedReason(
  slot: NativeChatInstallSlotState,
  agentLabel: string
): string | null {
  return slot.kind === 'none'
    ? null
    : translate(
        'components.native-chat.install.checking',
        'Checking whether {{agent}} is ready on this host…',
        { agent: agentLabel }
      )
}

export function NativeChatInstallSlot(props: {
  slot: NativeChatInstallSlotState
  agentLabel: string
}): React.JSX.Element | null {
  const { slot } = props
  if (slot.kind !== 'install') {
    return null
  }
  return (
    <div className="min-h-0 shrink overflow-hidden bg-chat-canvas">
      <div className="mx-auto w-full max-w-(--chat-content-max-width) px-3 pt-2 pb-1 sm:px-4">
        <ManagedRuntimeInstallRow
          observation={slot.observation}
          agentLabel={props.agentLabel}
          surface="chat"
        />
      </div>
    </div>
  )
}
