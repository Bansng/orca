import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_CLI_REEXEC_ENV, runAsSessionCli, takeSessionCliReexec } from './session-cli-reexec'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-session-cli-reexec-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function writeScript(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/usr/bin/env bash\n${body}`)
  chmodSync(path, 0o755)
  return path
}

function writeEntry(name: string): string {
  const path = join(dir, name)
  writeFileSync(path, '')
  return path
}

/** The argv a launcher gives the CLI: the runtime, the entry it ran, then the command. */
function argvFor(entry: string, ...args: string[]): string[] {
  return ['/electron', entry, ...args]
}

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

function exitSpy(): (code: number) => never {
  return (code: number) => {
    throw new Exited(code)
  }
}

/** A structured session's own child, which names its launcher and the entry that launcher runs. */
function sessionEnv(launcher: string, entry: string): NodeJS.ProcessEnv {
  return {
    ORCA_AGENT_SESSION_ID: 'session-1',
    ORCA_CLI_COMMAND: launcher,
    ORCA_SESSION_CLI_ENTRY: entry
  }
}

describe('takeSessionCliReexec', () => {
  it("hands off when the invoked CLI runs another entry than the session's", () => {
    const named = writeScript('session-orca', 'exit 0\n')
    const env: NodeJS.ProcessEnv = {
      ...sessionEnv(named, writeEntry('session-index.js')),
      ELECTRON_RUN_AS_NODE: '1',
      ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER: '1',
      ORCA_NODE_OPTIONS: '--max-old-space-size=4096',
      ORCA_NODE_REPL_EXTERNAL_MODULE: ''
    }

    const reexec = takeSessionCliReexec({
      env,
      argv: argvFor(writeEntry('global-index.js'), 'orchestration', 'check')
    })

    expect(reexec).toEqual({
      target: named,
      argv: ['orchestration', 'check'],
      // What the invoked launcher was handed, so the named one sees the caller's own environment.
      env: {
        ...sessionEnv(named, join(dir, 'session-index.js')),
        NODE_OPTIONS: '--max-old-space-size=4096',
        [ORCA_CLI_REEXEC_ENV]: '1'
      }
    })
  })

  it('stays when another launcher of the same app ran the same entry, through a symlink', () => {
    // A shim or a global symlink in front of the session's launcher runs the session's own CLI.
    const entry = writeEntry('index.js')
    const link = join(dir, 'linked-index.js')
    symlinkSync(entry, link)

    expect(
      takeSessionCliReexec({
        env: sessionEnv(writeScript('session-orca', 'exit 0\n'), entry),
        argv: argvFor(link, 'orchestration', 'check')
      })
    ).toBeNull()
  })

  it('runs the invoked CLI without a session id', () => {
    // A terminal, a script, or a marker-only child of an older host gets the CLI the user ran: a
    // beta or ad hoc Orca's `orca`, and its --version, must not silently become another install's.
    const env = sessionEnv(writeScript('session-orca', 'exit 0\n'), writeEntry('session-index.js'))
    delete env.ORCA_AGENT_SESSION_ID
    env.ORCA_STRUCTURED_SESSION = '1'

    expect(takeSessionCliReexec({ env, argv: argvFor(writeEntry('beta-index.js')) })).toBeNull()
  })

  it('makes at most one hop, and consumes the guard so no child inherits it', () => {
    const env: NodeJS.ProcessEnv = {
      ...sessionEnv(writeScript('session-orca', 'exit 0\n'), writeEntry('session-index.js')),
      [ORCA_CLI_REEXEC_ENV]: '1'
    }

    expect(takeSessionCliReexec({ env, argv: argvFor(writeEntry('global-index.js')) })).toBeNull()
    expect(env).not.toHaveProperty(ORCA_CLI_REEXEC_ENV)
  })

  it('stays when the session names no entry: a child of a host that predates it', () => {
    const env = sessionEnv(writeScript('session-orca', 'exit 0\n'), '')

    expect(takeSessionCliReexec({ env, argv: argvFor(writeEntry('global-index.js')) })).toBeNull()
  })

  it.each([
    ['a WSL guest command name', 'orca-ide'],
    ["the SSH host's relay command", 'orca']
  ])('never resolves %s against the working directory', (_label, command) => {
    writeScript(command, 'exit 0\n')
    vi.spyOn(process, 'cwd').mockReturnValue(dir)

    expect(
      takeSessionCliReexec({
        env: sessionEnv(command, writeEntry('session-index.js')),
        argv: argvFor(writeEntry('global-index.js'))
      })
    ).toBeNull()
  })

  it('stays when the named launcher no longer exists', () => {
    expect(
      takeSessionCliReexec({
        env: sessionEnv(join(dir, 'gone', 'orca'), writeEntry('session-index.js')),
        argv: argvFor(writeEntry('global-index.js'))
      })
    ).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('runAsSessionCli', () => {
  it("runs the command through the session's launcher and exits with its status", async () => {
    const report = join(dir, 'report')
    const named = writeScript(
      'session-orca',
      `printf '%s|%s|%s' "$*" "$ORCA_CLI_REEXEC" "\${NODE_OPTIONS-}" > '${report}'\nexit 7\n`
    )
    const run = vi.fn(async () => {})

    await expect(
      runAsSessionCli(run, {
        env: {
          ...process.env,
          ...sessionEnv(named, writeEntry('session-index.js')),
          ORCA_NODE_OPTIONS: '--no-warnings'
        },
        argv: argvFor(writeEntry('global-index.js'), 'orchestration', 'check', '--wait'),
        exit: exitSpy()
      })
    ).rejects.toEqual(new Exited(7))

    expect(readFileSync(report, 'utf8')).toBe('orchestration check --wait|1|--no-warnings')
    expect(run).not.toHaveBeenCalled()
  })

  it("runs the command here when it already runs the session's entry", async () => {
    const entry = writeEntry('index.js')
    const run = vi.fn(async () => {})

    await runAsSessionCli(run, {
      env: sessionEnv(writeScript('session-orca', 'exit 0\n'), entry),
      argv: argvFor(entry),
      exit: exitSpy()
    })

    expect(run).toHaveBeenCalledOnce()
  })

  it('runs the command here, and says so, when the named CLI cannot start', async () => {
    const named = join(dir, 'not-executable')
    writeFileSync(named, 'not a program')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const run = vi.fn(async () => {})

    await runAsSessionCli(run, {
      env: sessionEnv(named, writeEntry('session-index.js')),
      argv: argvFor(writeEntry('global-index.js')),
      exit: exitSpy()
    })

    expect(run).toHaveBeenCalledOnce()
    expect(String(stderr.mock.calls[0]?.[0])).toContain("could not run this session's CLI")
  })
})

describe('packaged Windows launcher command name', () => {
  it.each([
    ['a terminal with none', {}, 'orca'],
    ['a WSL-registered name', { ORCA_CLI_COMMAND: 'orca-ide' }, 'orca-ide'],
    [
      "a session's launcher once it is the named CLI",
      {
        ORCA_AGENT_SESSION_ID: 'session-1',
        ORCA_CLI_COMMAND: 'C:\\Orca\\resources\\bin\\orca.exe'
      },
      'orca'
    ]
  ])('names %s as the launcher did before the handoff existed', async (_label, extra, expected) => {
    const env: NodeJS.ProcessEnv = { ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER: '1', ...extra }
    let seen: string | undefined
    await runAsSessionCli(
      async () => {
        seen = env.ORCA_CLI_COMMAND
      },
      { env, argv: argvFor('C:\\Orca\\index.js'), platform: 'win32', exit: exitSpy() }
    )

    expect(seen).toBe(expected)
  })

  it("leaves every other launcher's command alone", async () => {
    const env: NodeJS.ProcessEnv = { ORCA_CLI_COMMAND: '/opt/Orca/resources/bin/orca' }
    await runAsSessionCli(async () => {}, {
      env,
      argv: argvFor('/opt/Orca/index.js'),
      exit: exitSpy()
    })

    expect(env.ORCA_CLI_COMMAND).toBe('/opt/Orca/resources/bin/orca')
  })
})
