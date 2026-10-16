import { useState } from 'react'
import { toast } from 'sonner'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { runtimeTargetForContextKey } from '@/lib/provider-runtime-context'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import type { IntegrationCredentialErrorReason } from '../../../../shared/integration-credential-errors'
import type { SecretStoreKeyMoveResult } from '../../../../shared/secret-store'

/**
 * Why this exists: a macOS host reached only over SSH keeps a locked login Keychain after a
 * reboot, so its server cannot open Linear or Jira credentials. The generic "reconnect" text
 * would send the user to re-enter a token that is fine.
 */
export type KeychainCredentialStatus = {
  credentialErrorReason?: IntegrationCredentialErrorReason
  canMoveCredentialKeyToFile?: boolean
}

type CredentialService = 'Linear' | 'Jira'

export function keychainLockedCredentialMessage(service: CredentialService, host: string): string {
  return translate(
    'auto.components.settings.keychainCredentialNotice.locked',
    '{{service}} is unavailable on {{host}}: its macOS login Keychain is locked. This happens after a reboot when you only sign in over SSH. Sign in to that Mac at its screen once. Orca then offers to switch the host to file storage so this stops happening.',
    { service, host }
  )
}

/** The host a provider status was read from (its context key); read only when `needed`. */
export function useCredentialHostName(statusContextKey: string | null, needed: boolean): string {
  const name = useAppStore((state) => {
    if (!needed || !statusContextKey) {
      return null
    }
    const target = runtimeTargetForContextKey(statusContextKey)
    return target.kind === 'environment'
      ? (state.runtimeEnvironments.find((environment) => environment.id === target.environmentId)
          ?.name ?? null)
      : null
  })
  return (
    name ??
    translate('auto.components.settings.keychainCredentialNotice.unnamedHost', 'the remote server')
  )
}

export function KeychainCredentialNotice({
  service,
  status,
  statusContextKey
}: {
  service: CredentialService
  status: KeychainCredentialStatus
  /** The provider context `status` was read from; the move goes to that host, its owner. */
  statusContextKey: string | null
}): React.JSX.Element | null {
  return statusContextKey &&
    (status.credentialErrorReason === 'keychain_locked' || status.canMoveCredentialKeyToFile) ? (
    <KeychainCredentialNoticeBody
      service={service}
      status={status}
      statusContextKey={statusContextKey}
    />
  ) : null
}

function KeychainCredentialNoticeBody({
  service,
  status,
  statusContextKey
}: {
  service: CredentialService
  status: KeychainCredentialStatus
  statusContextKey: string
}): React.JSX.Element | null {
  const host = useCredentialHostName(statusContextKey, true)
  const checkLinearConnection = useAppStore((state) => state.checkLinearConnection)
  const checkJiraConnection = useAppStore((state) => state.checkJiraConnection)
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)

  if (status.credentialErrorReason === 'keychain_locked') {
    return (
      <div
        role="alert"
        className="flex items-start gap-2.5 rounded-lg border border-status-warning-border bg-status-warning-background px-3 py-2 text-status-warning"
      >
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <p className="min-w-0 text-xs leading-snug">
          {keychainLockedCredentialMessage(service, host)}
        </p>
      </div>
    )
  }
  // Why the status's own host: it reported the flag. A paired browser's local target reaches its
  // server; desktop never sets the flag.
  const target = runtimeTargetForContextKey(statusContextKey)
  if (!status.canMoveCredentialKeyToFile) {
    return null
  }

  const handleMove = async (): Promise<void> => {
    setMoving(true)
    setMoveError(null)
    try {
      const result = await callRuntimeRpc<SecretStoreKeyMoveResult>(
        target,
        'integrationCredentials.moveKeyToFile',
        undefined,
        { timeoutMs: 15_000 }
      )
      if (result.ok) {
        toast.success(
          translate(
            'auto.components.settings.keychainCredentialNotice.moved',
            'Switched {{host}} to file storage',
            { host }
          )
        )
      } else {
        setMoveError(result.message)
      }
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : String(error))
    } finally {
      setMoving(false)
      // Why both: the key is host-wide, so both providers' status changes.
      void checkLinearConnection(true)
      void checkJiraConnection()
    }
  }

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-status-warning-border bg-status-warning-background px-3 py-2 text-status-warning">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-xs leading-snug">
          {translate(
            'auto.components.settings.keychainCredentialNotice.offerMove',
            '{{host}} keeps its credential key in its macOS login Keychain, which was locked after a reboot. Switch to file storage to keep Linear and Jira working when you only sign in over SSH. The key then sits in a file only this account can read, which protects it less than the Keychain: it is not tied to this machine, so a backup or shared copy of ~/.orca can open the credentials.',
            { host }
          )}
        </p>
        {moveError ? <p className="text-xs leading-snug text-destructive">{moveError}</p> : null}
        <Button variant="outline" size="sm" disabled={moving} onClick={() => void handleMove()}>
          {translate(
            'auto.components.settings.keychainCredentialNotice.moveAction',
            'Switch to file storage'
          )}
        </Button>
      </div>
    </div>
  )
}
