/**
 * orcad's SecretStore: credentials are sealed on the execution host, with a master key the
 * host owns — in the OS keyring when one is reachable when the key is first created, else in
 * a private file beside the credentials in `~/.orca`, mixed with the machine ID.
 *
 * Why always "available": answering false makes every credential writer fall back to plaintext.
 * When the recorded key cannot be loaded (locked keyring, changed machine), seal and unseal
 * throw instead, so saves fail closed and existing sealed files are left untouched.
 */
import type { SecretStore, SecretStoreKeychainLockState } from '../../shared/secret-store'
import { moveOrcadKeyToFile } from './orcad-secret-key-move'
import { sweepStaleRecordStaging } from './orcad-secret-key-record'
import {
  resolveKeyLocation,
  resolveState,
  type OrcadSecretStorePrepareOptions,
  type StoreState
} from './orcad-secret-key-resolution'
import { describeOrcadHostKeyGap } from './orcad-secret-protection-gap'
import { openOrcadSecret, sealOrcadSecret } from './orcad-secret-sealing'

export type { OrcadSecretStorePrepareOptions } from './orcad-secret-key-resolution'

export type OrcadSecretStore = SecretStore & {
  /** Resolves whether sealing works now, i.e. the key loaded. */
  prepare(options: OrcadSecretStorePrepareOptions): Promise<boolean>
}

// Why throttle: a renderer refresh can read many credentials at once, each one a retry.
const LOCKED_RETRY_INTERVAL_MS = 2_000

export function createOrcadSecretStore(
  log: (message: string) => void = (message) => console.warn(message)
): OrcadSecretStore {
  let state: StoreState = { kind: 'pending' }
  let options: OrcadSecretStorePrepareOptions | null = null
  let sawLock = false
  let recoveredSinceAck = false
  let retry: Promise<void> | null = null
  let lastRetryAt = 0
  // Why a generation: a prepare() or key move that lands during a retry owns the newer state.
  let generation = 0

  const isLocked = (): boolean => state.kind === 'unavailable' && state.keychainLocked === true
  const adopt = (next: StoreState): void => {
    if (next.kind === 'unavailable' && next.keychainLocked && !sawLock) {
      sawLock = true
      log(`[secrets] ${next.message}`)
    } else if (next.kind === 'ready' && isLocked()) {
      recoveredSinceAck = true
      log('[secrets] The macOS login Keychain is unlocked; saved credentials are readable again.')
    }
    state = next
  }
  const retryLockedKey = (): Promise<void> => {
    if (!retry && options) {
      const prepared = options
      const startedAt = generation
      lastRetryAt = Date.now()
      retry = resolveState(prepared)
        .then((next) => {
          // Why ignore other failures: a timed-out lookup must not end retries while still locked.
          const settled =
            next.kind === 'ready' || (next.kind === 'unavailable' && next.keychainLocked)
          if (startedAt === generation && isLocked() && settled) {
            adopt(next)
          }
        })
        .catch((error: unknown) => log(`[secrets] Keychain retry failed: ${String(error)}`))
        .finally(() => {
          retry = null
        })
    }
    return retry ?? Promise.resolve()
  }
  const readyKey = (): Buffer => {
    if (state.kind === 'ready') {
      return state.key
    }
    // Why retry on use: an unlock must take effect without restarting the server.
    if (isLocked() && Date.now() - lastRetryAt >= LOCKED_RETRY_INTERVAL_MS) {
      void retryLockedKey()
    }
    throw new Error(
      state.kind === 'unavailable'
        ? state.message
        : 'orcad_secret_store_not_prepared — the headless secret store has not loaded its key yet'
    )
  }
  return {
    isEncryptionAvailable: () => state.kind !== 'plaintext',
    encryptString: (plainText) => sealOrcadSecret(readyKey(), plainText),
    decryptString: (cipher) => openOrcadSecret(readyKey(), cipher),
    describeProtectionGap: () => {
      switch (state.kind) {
        case 'ready':
          return state.gap
        case 'unavailable':
          return state.message
        case 'plaintext':
          return state.reason
        case 'pending':
          return "Orca's headless server has not loaded its credential key yet."
      }
    },
    keychainLock: {
      state: (): SecretStoreKeychainLockState | null => {
        if (isLocked()) {
          return 'locked'
        }
        return state.kind === 'ready' && state.inKeychain && sawLock ? 'unlocked_after_lock' : null
      },
      async recover() {
        // Why a fresh lookup after the in-flight one: that one may predate the unlock.
        await retry
        if (isLocked()) {
          await retryLockedKey()
        }
        const recovered = recoveredSinceAck
        recoveredSinceAck = false
        return recovered
      },
      async moveKeyToFile() {
        if (isLocked()) {
          return {
            ok: false,
            reason: 'keychain_locked',
            message: 'The macOS login Keychain is locked.'
          }
        }
        // Why only after a lock: the file is weaker, so no caller may downgrade a host that never needed it.
        if (state.kind !== 'ready' || !state.inKeychain || !sawLock || !options) {
          return {
            ok: false,
            reason: 'not_in_keychain',
            message: 'This server does not keep its credential key in the Keychain.'
          }
        }
        const location = resolveKeyLocation(options)
        const moved = await moveOrcadKeyToFile(location)
        if (!moved.ok) {
          return moved
        }
        generation += 1
        state = {
          kind: 'ready',
          key: moved.key,
          gap: describeOrcadHostKeyGap(location.platform, false),
          inKeychain: false
        }
        log('[secrets] Moved the credential key from the macOS Keychain to the key file.')
        return { ok: true }
      }
    },
    async prepare(next) {
      options = next
      sweepStaleRecordStaging(resolveKeyLocation(next).statePath)
      generation += 1
      adopt(await resolveState(next))
      return state.kind === 'ready'
    }
  }
}
