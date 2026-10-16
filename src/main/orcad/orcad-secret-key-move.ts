/**
 * Moves orcad's master key out of the macOS Keychain into the owner-only key record, for a host
 * reached only over SSH whose login Keychain stays locked after a reboot.
 *
 * Why the same master key, unbound: Keychain-backed keys derive with no machine binding, so an
 * unbound file record derives the identical sealing key and every sealed credential still opens.
 * Re-sealing each credential under a new key would risk losing one halfway through.
 */
import type { SecretStoreKeyMoveResult } from '../../shared/secret-store'
import type { OrcadKeyLocation } from './orcad-secret-key-resolution'
import { decodeMasterKey, readStoredRecord, replaceRecord } from './orcad-secret-key-record'
import { deriveOrcadSealingKey, orcadSealingKeyCheck } from './orcad-secret-sealing'

type MoveFailure = Extract<SecretStoreKeyMoveResult, { ok: false }>

export type OrcadKeyMoveOutcome = { ok: true; key: Buffer } | MoveFailure

export async function moveOrcadKeyToFile(location: OrcadKeyLocation): Promise<OrcadKeyMoveOutcome> {
  const existing = readStoredRecord(location.statePath)
  if (existing.kind !== 'record' || existing.stored.backend !== 'os-keyring') {
    return {
      ok: false,
      reason: 'not_in_keychain',
      message: 'This server does not keep its credential key in the Keychain.'
    }
  }
  const { keyring } = location
  if (!keyring) {
    return {
      ok: false,
      reason: 'failed',
      message: 'The Keychain that holds the credential key is not reachable.'
    }
  }
  const { account, check } = existing.stored
  // Why read the Keychain again: the store holds only the derived key, and the record needs the
  // master key; reading it also proves the Keychain is unlocked right now.
  const found = await keyring.lookup(account)
  if (found.kind === 'locked') {
    return { ok: false, reason: 'keychain_locked', message: 'The macOS login Keychain is locked.' }
  }
  const master = found.kind === 'found' ? decodeMasterKey(found.value) : null
  const key = master ? deriveOrcadSealingKey(master, '') : null
  if (!master || !key || orcadSealingKeyCheck(key) !== check) {
    return {
      ok: false,
      reason: 'failed',
      message: 'The Keychain did not return the credential key this server seals with.'
    }
  }
  const replaced = replaceRecord(
    location.statePath,
    { version: 1, backend: 'host-file', key: master.toString('base64'), hostBound: false, check },
    check
  )
  if (replaced !== 'replaced') {
    return { ok: false, reason: 'failed', message: `The key could not be moved: ${replaced}.` }
  }
  return { ok: true, key }
}
