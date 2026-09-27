/**
 * Hands a structured session's command to the CLI the session named, when a different Orca CLI was
 * the one invoked.
 *
 * Orca puts the absolute launcher of its own CLI in a structured session's `ORCA_CLI_COMMAND`, and
 * the JS entry that launcher runs in `ORCA_SESSION_CLI_ENTRY`. The agent may still reach another
 * install — a login shell reorders PATH behind a global `orca`, a helper script hardcodes `orca`, a
 * user types `/usr/local/bin/orca` — and that CLI can be older than the session's identity or dial a
 * different instance. So a current CLI whose own entry is not the session's re-runs the command
 * through the named launcher, once, and exits with its status. Which binary answers stops depending
 * on the agent following instructions, and any launcher of the same app (a shim, a global symlink)
 * runs the same entry, so it never hands off.
 *
 * Only a process carrying the injected session id qualifies: the handoff exists to deliver that
 * identity. Anywhere else — a terminal, a script — the CLI the user ran is the one that answers.
 * `ORCA_CLI_REEXEC=1` bounds the handoff to one hop and is also the escape hatch; it is consumed
 * here so nothing the CLI starts inherits a disabled handoff.
 *
 * A relative command (a WSL guest name, the SSH relay's `orca`) never qualifies, and is never
 * resolved against the working directory.
 */

import { realpathSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { posix, resolve, win32 } from 'node:path'
import {
  ORCA_SESSION_CLI_ENTRY_ENV,
  readInjectedAgentSessionId
} from '../shared/agent-session-caller-env'

export const ORCA_CLI_REEXEC_ENV = 'ORCA_CLI_REEXEC'

/** Set by the launcher that started this process; the next launcher sets them again itself. */
const LAUNCHER_OWNED_ENV = ['ELECTRON_RUN_AS_NODE', 'ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER'] as const
/** Stashed by every launcher so Electron's node bootstrap never sees them; the next one re-stashes. */
const LAUNCHER_STASHED_ENV = [
  ['ORCA_NODE_OPTIONS', 'NODE_OPTIONS'],
  ['ORCA_NODE_REPL_EXTERNAL_MODULE', 'NODE_REPL_EXTERNAL_MODULE']
] as const

export type SessionCliReexec = {
  target: string
  argv: readonly string[]
  env: NodeJS.ProcessEnv
}

type ReexecOptions = {
  env?: NodeJS.ProcessEnv
  /** This process's argv; `[1]` is the CLI entry its launcher ran. */
  argv?: readonly string[]
  platform?: NodeJS.Platform
}

/** The CLI entry: hand off to the session's own CLI when this is a different one, else `run`. */
export async function runAsSessionCli(
  run: () => Promise<void>,
  options: ReexecOptions & { exit?: (code: number) => never } = {}
): Promise<void> {
  const reexec = takeSessionCliReexec(options)
  if (reexec) {
    await runSessionCliReexec(reexec, options.exit)
  }
  applyPackagedWindowsCliCommand(options.env ?? process.env)
  await run()
}

/**
 * The command name the packaged Windows launcher used to write over `ORCA_CLI_COMMAND` itself; it
 * now runs after the handoff decision, which needs a session's absolute launcher.
 */
function applyPackagedWindowsCliCommand(env: NodeJS.ProcessEnv): void {
  if (env.ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER === '1') {
    env.ORCA_CLI_COMMAND = env.ORCA_CLI_COMMAND === 'orca-ide' ? 'orca-ide' : 'orca'
  }
}

/**
 * Consumes the one-hop guard and returns the re-exec this process owes, or null when it already runs
 * the session's CLI entry, cannot tell, or is itself the one hop.
 */
export function takeSessionCliReexec(options: ReexecOptions = {}): SessionCliReexec | null {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const processArgv = options.argv ?? process.argv
  const alreadyHandedOff = env[ORCA_CLI_REEXEC_ENV] === '1'
  delete env[ORCA_CLI_REEXEC_ENV]
  if (alreadyHandedOff || !readInjectedAgentSessionId(env)) {
    return null
  }
  const isAbsolute = (platform === 'win32' ? win32 : posix).isAbsolute
  const named = env.ORCA_CLI_COMMAND?.trim()
  const sessionEntry = env[ORCA_SESSION_CLI_ENTRY_ENV]?.trim()
  const ownEntry = processArgv[1]
  if (!named || !sessionEntry || !ownEntry || !isAbsolute(named) || !isAbsolute(sessionEntry)) {
    return null
  }
  const sessionEntryPath = tryRealpath(sessionEntry)
  const ownEntryPath = tryRealpath(ownEntry)
  if (
    sessionEntryPath === null ||
    ownEntryPath === null ||
    samePath(sessionEntryPath, ownEntryPath, platform) ||
    tryRealpath(named) === null
  ) {
    return null
  }
  return {
    target: named,
    argv: processArgv.slice(2),
    env: buildHandoffEnv(env)
  }
}

/** The environment the invoked launcher was given, plus the one-hop guard. */
function buildHandoffEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const handoff: NodeJS.ProcessEnv = { ...env }
  for (const key of LAUNCHER_OWNED_ENV) {
    delete handoff[key]
  }
  for (const [stash, original] of LAUNCHER_STASHED_ENV) {
    const value = handoff[stash]
    delete handoff[stash]
    if (value) {
      handoff[original] = value
    }
  }
  handoff[ORCA_CLI_REEXEC_ENV] = '1'
  return handoff
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(resolve(path))
  } catch {
    return null
  }
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Runs the handoff and exits with its status. Returns only when the named CLI could not be started,
 * so the command still runs here — the behavior before the handoff existed — rather than failing.
 */
export async function runSessionCliReexec(
  reexec: SessionCliReexec,
  exit: (code: number) => never = process.exit
): Promise<void> {
  const { runProcessSync } = await import('../shared/child-process/run-process.js')
  let result: { code: number | null; signal: NodeJS.Signals | null }
  try {
    result = runProcessSync({
      program: reexec.target,
      args: reexec.argv,
      env: reexec.env,
      stdio: 'inherit',
      timeoutMs: null
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `orca: could not run this session's CLI (${reexec.target}): ${reason}. Running this one.\n`
    )
    return
  }
  exit(result.code ?? (result.signal ? 128 + (osConstants.signals[result.signal] ?? 0) : 1))
}
