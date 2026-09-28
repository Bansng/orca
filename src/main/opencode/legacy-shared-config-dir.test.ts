import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { isOpenCodeLegacySharedConfigDir } from './legacy-shared-config-dir'

describe('isOpenCodeLegacySharedConfigDir', () => {
  const userData = join('fixture', 'user-data')

  it('matches only the retired shared dirs of both OpenCode variants', () => {
    expect(
      isOpenCodeLegacySharedConfigDir(join(userData, 'opencode-hooks', 'shared'), userData)
    ).toBe(true)
    expect(
      isOpenCodeLegacySharedConfigDir(join(userData, 'opencode2-hooks', 'shared'), userData)
    ).toBe(true)
    expect(
      isOpenCodeLegacySharedConfigDir(join(userData, 'opencode-hooks', 'mine'), userData)
    ).toBe(false)
    expect(
      isOpenCodeLegacySharedConfigDir(join('other', 'opencode-hooks', 'shared'), userData)
    ).toBe(false)
    expect(isOpenCodeLegacySharedConfigDir(undefined, userData)).toBe(false)
  })
})
