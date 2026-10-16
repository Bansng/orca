# How the headless server stores credentials

The desktop app seals saved credentials (Linear, Jira, Bitbucket, API keys) with Electron's
`safeStorage`, which uses the OS keychain. The headless server (`orcad`, the managed SSH server)
has no Electron, so it seals them itself, on the machine it runs on
(`src/main/orcad/orcad-secret-store.ts`).

## Where the key lives

Each credential is encrypted with AES-256-GCM. The master key is created on first start and
stored in one of two places. The choice is recorded in `~/.orca/orcad-secret-store-<machine>.json`.
That is the directory the credentials live in, whatever `ORCA_USER_DATA` says, so the key lasts
exactly as long as the credentials it seals. There is one record per machine, so hosts that share
a home each keep their own key.

| Host                      | Where the key goes                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS                     | The login Keychain (through `/usr/bin/security`) if the server can reach it on first start                                                                    |
| Linux                     | The Secret Service keyring (`secret-tool`) if the session has a D-Bus session bus and a keyring answers                                                       |
| Otherwise, and on Windows | the record file itself, mode `0600` (an owner-only ACL on Windows), mixed with the machine ID (`/etc/machine-id`, macOS hardware UUID, Windows `MachineGuid`) |

The keyring is never used for a key directory under the system temp directory or `/tmp` (tests),
or when `ORCA_HEADLESS_SECRET_STORE=file` is set. That setting suits a macOS host reached only
over SSH, where the login Keychain is often locked.

A server started with `ORCA_USER_DATA` under a temporary directory (tests, smoke launchers)
keeps the old behavior. It stores credentials unencrypted and never creates a key in the real
`~/.orca`, or re-seals what is there.

Windows does not use DPAPI. Reaching it from Node takes PowerShell or a native addon, and running
PowerShell for each operation is an EDR signal.

## A locked macOS login Keychain

The login Keychain is unlocked when you sign in at the Mac's screen. After a reboot, a Mac you
only reach over SSH keeps it locked. The server's key lookup (`security find-generic-password`)
then exits 36 (`errSecInteractionNotAllowed`: locked, and the session may not show an unlock
prompt). The server does not treat that like a missing or broken key:

- It fails closed as usual, and logs one `[secrets]` line saying the Keychain is locked.
- Linear and Jira status carry `credentialErrorReason: 'keychain_locked'`. The app then names the
  host and the cause in the integration settings and on the task page, instead of asking you to
  reconnect. The canonical decrypt error also gets an English hint, for clients too old to read
  the field.
- It looks the key up again whenever a credential is used (at most every 2 seconds) and before
  each Linear or Jira status read. So once the Keychain opens, credentials work again without a
  server restart.

To unlock it, sign in to the Mac at its screen once. Running `security unlock-keychain` in a
separate SSH login may not help: the server was started from an earlier SSH login, and macOS can
track Keychain unlock state per login session. This has not yet been checked on a real headless
Mac.

Once the key has loaded again after a lock, status sets `canMoveCredentialKeyToFile`, and
Settings offers **Switch to file storage** (RPC `integrationCredentials.moveKeyToFile`). This reads
the master key from the Keychain, then replaces the record with an owner-only (`0600`) key-file
record that holds the same key, not bound to the machine ID. Keychain keys are never machine-bound,
so every sealed credential still opens and nothing is re-sealed. The Keychain item stays where it
is. The switch is refused while the Keychain is locked, because the key can't be read then. After
the switch, the key file's limitations below apply. In particular, the moved key is not bound to
the machine ID, so a backup of `~/.orca`, or a copy on a shared (NFS) home, can open the
credentials on another machine.

On startup the server also deletes key-record staging files (`*.staging`) that a crashed write
left in the credential directory. It deletes only this machine's record's staging files owned by
this user, and only when the process that wrote them has exited.

## Limitations

- **The key file is weaker than a keychain.** The key sits next to the credentials, and the
  machine ID it is mixed with is not secret. Profile-state records include it, for example. So the
  key file mainly stops a single credential file from opening on another machine. Anyone who can
  read this account's files, or a backup of `~/.orca`, can unseal the credentials. Treat the key
  file like the credentials themselves. The server logs this gap once with the `[secrets]` prefix.
  A keychain does not protect against other processes running as the same unlocked user either.
- **The key belongs to the host.** If the recorded keyring is locked or can't be reached, or the
  record is unreadable, the server does not fall back to plaintext. It leaves the saved credentials
  alone and refuses new saves until the key loads again. If the key is gone for good, deleting the
  record starts over, and every integration has to be connected again. A new machine ID counts as
  a new machine, so it gets a new key, and credentials sealed under the old one have to be
  connected again.
- **Shared home directories.** Integration credentials live in `~/.orca` under the login home.
  Hosts that share that home (over NFS, for example), or a desktop app on the same machine, each
  seal with their own key, so a credential one of them saves can't be read by the others. To keep
  the old shared plaintext behavior on such hosts, set `ORCA_HEADLESS_SECRET_STORE=plaintext`.
- **Rolling back to an older server.** A server from before this change can't read credentials a
  newer one sealed. An SSH or WSL rollback restores profile state, not `~/.orca`, so after a
  rollback the old server shows "Could not decrypt saved Linear credential… reconnect Linear".
  Connect each integration again on that server. Plaintext copies are deliberately not kept for
  rollback.
- **GitHub and GitLab** tokens are not stored by Orca at all. `gh` and `glab` keep them, under
  their own storage settings.

## Migration

On startup, once the key loads, the server seals every credential that an older version stored in
plaintext. Each file is rewritten only after the new value has been decrypted and checked, and
only if no other process changed the file in the meantime. A file that can't be sealed is left as
it was. Readers still accept the legacy plaintext form, so no credential is lost.
