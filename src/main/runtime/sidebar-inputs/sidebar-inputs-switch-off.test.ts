// A build without ORCA_SIDEBAR_INPUTS=main (every shipped one) keeps none of main's sidebar inputs.
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { ALL_RPC_METHODS } from '../rpc/methods'

describe('sidebar inputs with the switch off', () => {
  it('builds no producer and registers no sidebarInputs method', () => {
    const runtime = new OrcaRuntimeService()
    expect(runtime.sidebarFacts).toBeNull()
    expect(runtime.pairedServerRows).toBeNull()
    expect(ALL_RPC_METHODS.filter((method) => method.name.startsWith('sidebarInputs.'))).toEqual([])
  })
})
