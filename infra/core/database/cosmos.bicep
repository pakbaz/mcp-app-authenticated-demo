@description('Cosmos DB account name')
param accountName string

@description('Location')
param location string

@description('Tags')
param tags object

@description('Database name')
param databaseName string

@description('Containers to create')
param containers array

@description('Override location for Cosmos DB (if primary region has capacity issues)')
param cosmosLocation string = location

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-02-15-preview' = {
  name: accountName
  location: cosmosLocation
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    locations: [
      {
        locationName: cosmosLocation
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    capabilities: [
      {
        name: 'EnableServerless'
      }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    enableMultipleWriteLocations: false
    enableFreeTier: false
    disableLocalAuth: false
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-02-15-preview' = {
  parent: cosmosAccount
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
  }
}

@batchSize(1)
resource container 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-02-15-preview' = [
  for c in containers: {
    parent: database
    name: c.name
    properties: {
      resource: {
        id: c.name
        partitionKey: {
          paths: [c.partitionKeyPath]
          kind: 'Hash'
        }
      }
    }
  }
]

output endpoint string = cosmosAccount.properties.documentEndpoint
output accountName string = cosmosAccount.name
output accountId string = cosmosAccount.id
