@description('Cosmos DB account name')
param cosmosAccountName string

@description('Principal ID to assign the Data Contributor role')
param principalId string

// Built-in Cosmos DB Data Contributor role
var dataContributorRoleId = '00000000-0000-0000-0000-000000000002'

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-02-15-preview' existing = {
  name: cosmosAccountName
}

resource roleAssignment 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-02-15-preview' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, principalId, dataContributorRoleId)
  properties: {
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/${dataContributorRoleId}'
    principalId: principalId
    scope: cosmosAccount.id
  }
}
