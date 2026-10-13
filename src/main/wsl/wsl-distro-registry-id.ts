/**
 * A distro's registration GUID (`HKCU\...\Lxss\{guid}`): stable across a rename and changed by an
 * unregister + re-import, so it tells "the same distro" from "a new one with the old name".
 */
import { runProcess } from '@orca/process-host'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'

const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'
const REG_QUERY_TIMEOUT_MS = 5_000
const GUID_SUBKEY = /\\(\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\})\s*$/i
const DISTRIBUTION_NAME_VALUE = /^\s+DistributionName\s+REG_\w+\s+(.+?)\s*$/

export type WslDistroRegistration = { id: string; distro: string }

/** Parses `reg query <Lxss> /s /v DistributionName`; matched by shape, since the footer is localized. */
export function parseWslDistroRegistrations(output: string): WslDistroRegistration[] {
  const registrations: WslDistroRegistration[] = []
  let currentId: string | null = null
  for (const line of output.split(/\r?\n/)) {
    const key = GUID_SUBKEY.exec(line)
    if (key?.[1] && /^HKEY_/i.test(line)) {
      currentId = key[1].toLowerCase()
      continue
    }
    const name = DISTRIBUTION_NAME_VALUE.exec(line)
    if (name?.[1] && currentId) {
      registrations.push({ id: currentId, distro: name[1] })
      currentId = null
    }
  }
  return registrations
}

export type RegQuery = (args: string[]) => Promise<{ code: number | null; stdout: string }>

const defaultRegQuery: RegQuery = (args) =>
  // One reg.exe per lookup, as `openssh-default-shell` reads the registry; never powershell.exe.
  runProcess({
    program: windowsSystem32Binary('reg.exe'),
    args,
    timeoutMs: REG_QUERY_TIMEOUT_MS
  })

/** The distro's registration GUID (lowercase, braced), or null when it is not registered or unreadable. */
export async function readWslDistroRegistryId(
  distro: string,
  query: RegQuery = defaultRegQuery
): Promise<string | null> {
  if (process.platform !== 'win32' && query === defaultRegQuery) {
    return null
  }
  let result: { code: number | null; stdout: string }
  try {
    result = await query(['query', LXSS_KEY, '/s', '/v', 'DistributionName'])
  } catch {
    return null
  }
  if (result.code !== 0) {
    return null
  }
  // WSL treats distro names case-insensitively.
  const wanted = distro.trim().toLowerCase()
  const matches = parseWslDistroRegistrations(result.stdout).filter(
    (registration) => registration.distro.toLowerCase() === wanted
  )
  return matches.length === 1 ? matches[0].id : null
}
