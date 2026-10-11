import { describe, expect, it, vi } from 'vitest'
import { resolveRelayPushTarget } from './git-handler-push-target'

type GitArgs = string[]

function gitForConfig(config: {
  branch?: string
  pushRemote?: string | Error
  pushDefault?: string | Error
  branchRemote?: string | Error
  merge?: string
  base?: string | Error
  remotes?: string[]
  remoteUrls?: Record<string, string>
}) {
  const branch = config.branch ?? 'feature/fix'
  const merge = config.merge ?? `refs/heads/${branch}`
  return vi.fn(async (args: GitArgs) => {
    if (args[0] === 'symbolic-ref') {
      return { stdout: `${branch}\n`, stderr: '' }
    }
    if (args[0] === 'config' && args[1] === '--list') {
      const values = [
        [`branch.${branch}.pushremote`, config.pushRemote],
        ['remote.pushdefault', config.pushDefault],
        [`branch.${branch}.remote`, config.branchRemote],
        [`branch.${branch}.merge`, merge],
        [`branch.${branch}.base`, config.base]
      ]
      return {
        stdout: values
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => `${key}\n${value}\0`)
          .join(''),
        stderr: ''
      }
    }
    if (args[0] === 'remote' && args[1] === '-v') {
      return {
        stdout: (config.remotes ?? [])
          .flatMap((name) => {
            const url = config.remoteUrls?.[name] ?? ''
            return [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`]
          })
          .join('\n'),
        stderr: ''
      }
    }
    if (args[0] === 'remote' && args.length === 1) {
      return { stdout: `${config.remotes?.join('\n') ?? ''}\n`, stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const remoteUrl = config.remoteUrls?.[args[2] ?? '']
      if (!remoteUrl) {
        throw new Error('missing remote URL')
      }
      return { stdout: `${remoteUrl}\n`, stderr: '' }
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`)
  })
}

describe('resolveRelayPushTarget', () => {
  it('uses branch pushRemote for a configured review head branch', async () => {
    const git = gitForConfig({
      pushRemote: 'fork',
      branchRemote: 'fork',
      merge: 'refs/heads/contributor/fix'
    })

    await expect(resolveRelayPushTarget(git, '/repo', undefined)).resolves.toEqual({
      remote: 'fork',
      refspec: 'HEAD:contributor/fix'
    })
    expect(git.mock.calls.filter(([args]) => args[0] === 'config')).toEqual([
      [['config', '--list', '-z'], '/repo']
    ])
  })

  it('uses remote.pushDefault when branch pushRemote is missing', async () => {
    const git = gitForConfig({
      pushRemote: new Error('missing pushRemote'),
      pushDefault: 'fork',
      branchRemote: 'origin'
    })

    await expect(resolveRelayPushTarget(git, '/repo', undefined)).resolves.toEqual({
      remote: 'fork',
      refspec: 'HEAD:feature/fix'
    })
  })

  it('uses an explicit push target without reading branch config', async () => {
    const git = vi.fn(async () => ({ stdout: '', stderr: '' }))

    await expect(
      resolveRelayPushTarget(git, '/repo', {
        remoteName: 'fork',
        branchName: 'feature/head'
      })
    ).resolves.toEqual({
      remote: 'fork',
      refspec: 'HEAD:feature/head'
    })
    expect(git).toHaveBeenCalledWith(['check-ref-format', '--branch', 'feature/head'], '/repo')
  })
})
