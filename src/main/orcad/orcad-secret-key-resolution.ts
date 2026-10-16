/**
 * How orcad finds or first creates its master key: the record beside the credentials says whether
 * the key is in the OS keyring or in the record itself (see orcad-secret-store.ts).
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import process from 'node:process'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import { resolveOrcadOsKeyring, type OrcadOsKeyring } from './orcad-os-keyring'
import {
  decodeMasterKey,
  isTemporaryKeyDir,
  keyringAccount,
  orcadSecretStateFileName,
  publishRecordExclusively,
  readStoredRecord,
  restrictExistingRecord,
  withdrawRecord,
  type StoredKeyState
} from './orcad-secret-key-record'
import {
  describeOrcadHostKeyGap,
  describeOrcadDisposableProfile,
  describeOrcadKeychainLocked,
  describeOrcadPlaintextOptOut,
  describeOrcadSealingUnavailable,
  ORCAD_PLAINTEXT_SECRETS_ENV
} from './orcad-secret-protection-gap'
import {
  deriveOrcadSealingKey,
  ORCAD_MASTER_KEY_BYTES,
  orcadSealingKeyCheck
} from './orcad-secret-sealing'

export type StoreState =
  | { kind: 'pending' }
  | { kind: 'plaintext'; reason: string }
  | { kind: 'ready'; key: Buffer; gap: string | null; inKeychain: boolean }
  | { kind: 'unavailable'; message: string; keychainLocked?: true }

export type OrcadSecretStorePrepareOptions = {
  /** Orca's credential directory (`~/.orca`), so the key lives exactly as long as what it seals. */
  keyDir: string
  /** A temporary profile keeps the legacy behavior and leaves `keyDir` untouched. */
  userDataPath?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  keyring?: OrcadOsKeyring | null
  machineIdentity?: () => string | null
  isTemporaryKeyDir?: (keyDir: string) => boolean
  /** How long to wait for a concurrent first start to finish storing its keyring key. */
  claimSettleMs?: number
}

// A claimant's keyring store and read-back can each take the full 5s keyring timeout.
const CLAIM_SETTLE_MS = 12_000

type Paths = { statePath: string; unavailable: (reason: string) => StoreState }

type KeyContext = {
  platform: NodeJS.Platform
  keyring: OrcadOsKeyring | null
  machineId: string | null
  claimSettleMs?: number
}

async function loadStoredRecord(
  stored: StoredKeyState,
  paths: Paths,
  context: KeyContext
): Promise<StoreState | 'record-changed'> {
  const { unavailable } = paths
  if (stored.backend === 'os-keyring') {
    const { keyring } = context
    if (!keyring) {
      return unavailable('the OS keyring that holds its key is not reachable from this session')
    }
    let found = await keyring.lookup(stored.account)
    // Why wait: a concurrent first start may have claimed the record and still be storing the key
    // (one keyring store plus one lookup), or may withdraw the claim and switch to the file.
    const deadline = Date.now() + (context.claimSettleMs ?? CLAIM_SETTLE_MS)
    while (found.kind === 'missing' && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
      const current = readStoredRecord(paths.statePath)
      if (current.kind !== 'record' || current.stored.check !== stored.check) {
        return 'record-changed'
      }
      found = await keyring.lookup(stored.account)
    }
    if (found.kind === 'locked') {
      return { kind: 'unavailable', message: describeOrcadKeychainLocked(), keychainLocked: true }
    }
    if (found.kind !== 'found') {
      return unavailable(
        found.kind === 'missing'
          ? `its key is missing from ${keyring.label}`
          : `${keyring.label} is locked or unreachable (${found.reason}); unlock it`
      )
    }
    const master = decodeMasterKey(found.value)
    const key = master ? deriveOrcadSealingKey(master, '') : null
    if (!key || orcadSealingKeyCheck(key) !== stored.check) {
      return unavailable(`the key in ${keyring.label} does not match the one it sealed with`)
    }
    return { kind: 'ready', key, gap: null, inKeychain: true }
  }
  if (!(await restrictExistingRecord(paths.statePath))) {
    return unavailable(`its key record ${paths.statePath} could not be restricted to this user`)
  }
  const master = decodeMasterKey(stored.key)
  const binding = stored.hostBound ? context.machineId : ''
  if (!master || binding === null) {
    return unavailable('this machine no longer reports the machine ID its key is bound to')
  }
  const key = deriveOrcadSealingKey(master, binding)
  if (orcadSealingKeyCheck(key) !== stored.check) {
    return unavailable('its key is bound to a different machine ID')
  }
  return {
    kind: 'ready',
    key,
    gap: describeOrcadHostKeyGap(context.platform, stored.hostBound),
    inKeychain: false
  }
}

export type OrcadKeyLocation = {
  platform: NodeJS.Platform
  keyring: OrcadOsKeyring | null
  machineId: string | null
  statePath: string
}

export function resolveKeyLocation(options: OrcadSecretStorePrepareOptions): OrcadKeyLocation {
  const platform = options.platform ?? process.platform
  const keyring =
    options.keyring === undefined
      ? resolveOrcadOsKeyring(platform, options.env ?? process.env)
      : options.keyring
  const machineId = (options.machineIdentity ?? profileStateAccessMachineIdentity)()
  return {
    platform,
    keyring,
    machineId,
    statePath: join(options.keyDir, orcadSecretStateFileName(machineId))
  }
}

export async function resolveState(options: OrcadSecretStorePrepareOptions): Promise<StoreState> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (env[ORCAD_PLAINTEXT_SECRETS_ENV] === 'plaintext') {
    return { kind: 'plaintext', reason: describeOrcadPlaintextOptOut() }
  }
  // Why: a disposable run (tests, smoke launchers) must not create keys in, or re-seal, the
  // user's persistent ~/.orca; credentials it saves would outlive the run unreadable by others.
  if (
    options.userDataPath &&
    (options.isTemporaryKeyDir ?? isTemporaryKeyDir)(options.userDataPath)
  ) {
    return { kind: 'plaintext', reason: describeOrcadDisposableProfile() }
  }
  const { keyring, machineId, statePath } = resolveKeyLocation(options)
  const paths: Paths = {
    statePath,
    unavailable: (reason) => ({
      kind: 'unavailable',
      message: describeOrcadSealingUnavailable(reason, statePath)
    })
  }
  const context: KeyContext = {
    platform,
    keyring,
    machineId,
    claimSettleMs: options.claimSettleMs
  }
  // Why loop: losing an exclusive-create race means another start's record is the one to load.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = readStoredRecord(paths.statePath)
    if (existing.kind === 'record') {
      const loaded = await loadStoredRecord(existing.stored, paths, context)
      if (loaded !== 'record-changed') {
        return loaded
      }
      continue
    }
    if (existing.kind === 'unreadable') {
      return paths.unavailable(existing.reason)
    }
    const created = await createKey(options, paths, context, env)
    if (created !== 'lost-race') {
      return created
    }
  }
  return paths.unavailable('another server kept replacing its key record')
}

async function createKey(
  options: OrcadSecretStorePrepareOptions,
  paths: Paths,
  context: KeyContext,
  env: NodeJS.ProcessEnv
): Promise<StoreState | 'lost-race'> {
  const { keyring, machineId, platform } = context
  const mayUseKeyring =
    env[ORCAD_PLAINTEXT_SECRETS_ENV] !== 'file' &&
    !(options.isTemporaryKeyDir ?? isTemporaryKeyDir)(options.keyDir)
  if (keyring && mayUseKeyring) {
    const account = keyringAccount(options.keyDir, machineId)
    const found = await keyring.lookup(account)
    const adopted = found.kind === 'found' ? decodeMasterKey(found.value) : null
    if (adopted || found.kind === 'missing') {
      const master = adopted ?? randomBytes(ORCAD_MASTER_KEY_BYTES)
      const key = deriveOrcadSealingKey(master, '')
      const record: StoredKeyState = {
        version: 1,
        backend: 'os-keyring',
        account,
        check: orcadSealingKeyCheck(key)
      }
      // Why claim the record first: only the start that wins the claim may write the keyring.
      const claim = publishRecordExclusively(paths.statePath, record)
      if (claim !== 'published') {
        return claim === 'exists' ? 'lost-race' : paths.unavailable(claim)
      }
      if (adopted) {
        return { kind: 'ready', key, gap: null, inKeychain: true }
      }
      const encoded = master.toString('base64')
      // Why read back: `security -i` exits 0 even when its command failed.
      await keyring.store(account, encoded)
      // Why trust only the read-back: a store can time out after it succeeded, and a concurrent
      // start may already have adopted the claimed key.
      const stored = await keyring.lookup(account)
      if (stored.kind === 'found' && stored.value === encoded) {
        return { kind: 'ready', key, gap: null, inKeychain: true }
      }
      if (stored.kind !== 'missing') {
        // Uncertain: the key may be in the keyring and in use, so keep the claim and fail closed.
        return paths.unavailable(`${keyring.label} did not confirm its new key; restart to retry`)
      }
      // Definitely never stored, so nobody can have adopted it: withdraw and use the file.
      withdrawRecord(paths.statePath, record.check)
    }
  }

  const master = randomBytes(ORCAD_MASTER_KEY_BYTES)
  const key = deriveOrcadSealingKey(master, machineId ?? '')
  const record: StoredKeyState = {
    version: 1,
    backend: 'host-file',
    key: master.toString('base64'),
    hostBound: machineId !== null,
    check: orcadSealingKeyCheck(key)
  }
  // Why fail closed: sealing with a key that did not reach disk loses every credential on restart.
  const published = publishRecordExclusively(paths.statePath, record)
  if (published !== 'published') {
    return published === 'exists' ? 'lost-race' : paths.unavailable(published)
  }
  return {
    kind: 'ready',
    key,
    gap: describeOrcadHostKeyGap(platform, record.hostBound),
    inKeychain: false
  }
}
