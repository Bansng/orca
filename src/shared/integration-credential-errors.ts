export type IntegrationCredentialService = 'Linear' | 'Jira' | 'Bitbucket'

export function credentialDecryptionMessage(service: IntegrationCredentialService): string {
  return `Could not decrypt saved ${service} credential. Approve Keychain access or reconnect ${service}.`
}

/** Why a decrypt failed, when the host can say; absent on older hosts. */
export type IntegrationCredentialErrorReason = 'keychain_locked'

export function isIntegrationCredentialErrorReason(
  value: unknown
): value is IntegrationCredentialErrorReason {
  return value === 'keychain_locked'
}

/** Appended on the host so a client too old to read the typed reason still sees the cause. */
export function keychainLockedCredentialHint(): string {
  return (
    "This host's macOS login Keychain is locked, which happens after a reboot when you only " +
    'sign in over SSH. Sign in to the Mac at its screen once, or switch the host to file storage.'
  )
}

// Why: decrypt errors cross IPC/RPC boundaries where only the message
// survives serialization, so detection matches on the canonical message.
export function isIntegrationCredentialDecryptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes(credentialDecryptionMessage('Linear')) ||
    message.includes(credentialDecryptionMessage('Jira')) ||
    message.includes(credentialDecryptionMessage('Bitbucket'))
  )
}
