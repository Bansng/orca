import { defineMethod } from '../core'
import { moveIntegrationCredentialKeyToFile } from '../../../integration-credential-keychain'

export const INTEGRATION_CREDENTIAL_KEY_METHODS = [
  // Why no capability flag: clients call it only when status sets canMoveCredentialKeyToFile.
  defineMethod({
    name: 'integrationCredentials.moveKeyToFile',
    permission: 'accounts-admin',
    params: null,
    handler: async () => moveIntegrationCredentialKeyToFile()
  })
]
