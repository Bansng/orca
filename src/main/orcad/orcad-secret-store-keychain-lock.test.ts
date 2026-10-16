import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isIntegrationCredentialDecryptionError } from '../../shared/integration-credential-errors'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import { CredentialDecryptionError } from '../integration-credential-file'
import {
  integrationCredentialKeychainFields,
  recoverIntegrationCredentialKey
} from '../integration-credential-keychain'
import { createIntegrationTokenFileCache } from '../integration-token-file-cache'
import type { OrcadKeyringLookup, OrcadOsKeyring } from './orcad-os-keyring'
import { orcadSecretStateFileName } from './orcad-secret-key-record'
import { createOrcadSecretStore } from './orcad-secret-store'

const MACHINE = '0123456789abcdef0123456789abcdef'
const LOCKED: OrcadKeyringLookup = {
  kind: 'locked',
  reason: 'exited 36: User interaction is not allowed.'
}

function fakeKeychain(): OrcadOsKeyring & { items: Map<string, string>; locked: boolean } {
  const keyring = {
    label: 'the test Keychain',
    items: new Map<string, string>(),
    locked: false,
    async lookup(account: string): Promise<OrcadKeyringLookup> {
      if (keyring.locked) {
        return LOCKED
      }
      const value = keyring.items.get(account)
      return value ? { kind: 'found', value } : { kind: 'missing' }
    },
    async store(account: string, value: string): Promise<boolean> {
      keyring.items.set(account, value)
      return true
    }
  }
  return keyring
}

describe('orcad secret store with a locked macOS login Keychain', () => {
  let keyDir: string
  let log: ReturnType<typeof vi.fn<(message: string) => void>>

  beforeEach(() => {
    keyDir = mkdtempSync(join(tmpdir(), 'orcad-keychain-lock-'))
    log = vi.fn<(message: string) => void>()
  })

  afterEach(() => {
    _resetSecretStoreForTests()
    rmSync(keyDir, { recursive: true, force: true })
  })

  const prepare = async (keyring: OrcadOsKeyring) => {
    const store = createOrcadSecretStore(log)
    const ready = await store.prepare({
      keyDir,
      platform: 'darwin',
      env: {},
      keyring,
      machineIdentity: () => MACHINE,
      isTemporaryKeyDir: () => false,
      claimSettleMs: 0
    })
    return { store, ready }
  }

  /** A server that sealed a credential, then restarted after a reboot with the Keychain locked. */
  const lockedAfterReboot = async () => {
    const keyring = fakeKeychain()
    const sealed = (await prepare(keyring)).store.encryptString('lin_api_secret')
    keyring.locked = true
    const { store, ready } = await prepare(keyring)
    return { keyring, sealed, store, ready }
  }

  it('reports the lock, logs it once, and fails closed', async () => {
    const { store, ready, sealed } = await lockedAfterReboot()
    expect(ready).toBe(false)
    expect(store.keychainLock?.state()).toBe('locked')
    expect(() => store.decryptString(sealed)).toThrow(/login Keychain that holds its key is locked/)
    expect(() => store.encryptString('x')).toThrow(/locked/)
    expect(log.mock.calls.filter(([line]) => line.startsWith('[secrets]'))).toHaveLength(1)
    expect(await store.keychainLock?.recover()).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('opens the credentials once the Keychain unlocks, without a restart', async () => {
    const { keyring, store, sealed } = await lockedAfterReboot()
    keyring.locked = false
    expect(await store.keychainLock?.recover()).toBe(true)
    expect(store.decryptString(sealed)).toBe('lin_api_secret')
    expect(store.keychainLock?.state()).toBe('unlocked_after_lock')
    // Reported once, so status clears stale failures once.
    expect(await store.keychainLock?.recover()).toBe(false)
  })

  it('retries the Keychain when a credential is used', async () => {
    const { keyring, store, sealed } = await lockedAfterReboot()
    keyring.locked = false
    expect(() => store.decryptString(sealed)).toThrow(/locked/)
    await vi.waitFor(() => expect(store.decryptString(sealed)).toBe('lin_api_secret'))
  })

  it('keeps retrying after a lookup times out while locked', async () => {
    const { keyring, store, sealed } = await lockedAfterReboot()
    const lookup = keyring.lookup
    keyring.lookup = async () => ({ kind: 'unreachable', reason: 'timed out after 5s' })
    expect(await store.keychainLock?.recover()).toBe(false)
    expect(store.keychainLock?.state()).toBe('locked')
    keyring.lookup = lookup
    keyring.locked = false
    expect(await store.keychainLock?.recover()).toBe(true)
    expect(store.decryptString(sealed)).toBe('lin_api_secret')
  })

  it('never moves the key of a host whose Keychain was never seen locked', async () => {
    const { store } = await prepare(fakeKeychain())
    expect(await store.keychainLock?.moveKeyToFile()).toMatchObject({
      ok: false,
      reason: 'not_in_keychain'
    })
    const record = readFileSync(join(keyDir, orcadSecretStateFileName(MACHINE)), 'utf8')
    expect(JSON.parse(record)).toMatchObject({ backend: 'os-keyring' })
  })

  it('moves the key to the file only while unlocked, keeping every credential', async () => {
    const { keyring, store, sealed } = await lockedAfterReboot()
    const statePath = join(keyDir, orcadSecretStateFileName(MACHINE))
    const recordWhileLocked = readFileSync(statePath, 'utf8')
    expect(await store.keychainLock?.moveKeyToFile()).toMatchObject({
      ok: false,
      reason: 'keychain_locked'
    })
    expect(readFileSync(statePath, 'utf8')).toBe(recordWhileLocked)

    keyring.locked = false
    await store.keychainLock?.recover()
    expect(await store.keychainLock?.moveKeyToFile()).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      backend: 'host-file',
      hostBound: false
    })
    expect(store.keychainLock?.state()).toBeNull()
    expect(store.decryptString(sealed)).toBe('lin_api_secret')

    // After the next reboot the Keychain is locked again, and no longer matters.
    keyring.locked = true
    const restarted = await prepare(keyring)
    expect(restarted.ready).toBe(true)
    expect(restarted.store.decryptString(sealed)).toBe('lin_api_secret')
    expect(restarted.store.keychainLock?.state()).toBeNull()
  })

  it('tells clients why Linear and Jira cannot read, then clears it after the unlock', async () => {
    const keyring = fakeKeychain()
    const first = await prepare(keyring)
    const tokenPath = join(keyDir, 'linear-token.enc')
    writeFileSync(tokenPath, first.store.encryptString('lin_api_secret'))
    keyring.locked = true
    const { store } = await prepare(keyring)
    setSecretStore(store)
    const cache = createIntegrationTokenFileCache({ service: 'Linear', filePath: () => tokenPath })

    let failure: unknown
    try {
      cache.read('ws')
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(CredentialDecryptionError)
    // Old clients match on the canonical message; the hint rides along for them.
    expect(isIntegrationCredentialDecryptionError(failure)).toBe(true)
    expect(String(failure)).toContain('macOS login Keychain is locked')
    expect(cache.error('ws')).toBeDefined()
    expect(integrationCredentialKeychainFields({ saved: true, decryptFailed: true })).toEqual({
      credentialErrorReason: 'keychain_locked'
    })
    // Legacy plaintext credentials still read while locked, so nothing is unavailable.
    expect(integrationCredentialKeychainFields({ saved: true, decryptFailed: false })).toEqual({})
    expect(integrationCredentialKeychainFields({ saved: false, decryptFailed: false })).toEqual({})

    keyring.locked = false
    await recoverIntegrationCredentialKey()
    expect(cache.error('ws')).toBeUndefined()
    expect(cache.read('ws')).toBe('lin_api_secret')
    expect(integrationCredentialKeychainFields({ saved: true, decryptFailed: false })).toEqual({
      canMoveCredentialKeyToFile: true
    })
  })

  it('sweeps key-record staging files a crashed write left behind, and nothing else', async () => {
    const record = orcadSecretStateFileName(MACHINE)
    const stale = join(keyDir, `${record}.999999999.0123abcd.staging`)
    const inFlight = join(keyDir, `${record}.${process.ppid}.0123abcd.staging`)
    // Another machine sharing this home: its writer's PID means nothing on this host.
    const unrelated = join(
      keyDir,
      `${orcadSecretStateFileName('fedcba9876543210fedcba9876543210')}.999999999.0123abcd.staging`
    )
    for (const path of [stale, inFlight, unrelated]) {
      writeFileSync(path, '{}', { mode: 0o600 })
    }
    await prepare(fakeKeychain())
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(inFlight)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })
})
