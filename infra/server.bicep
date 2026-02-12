@description('Name of the Container App')
param name string

@description('Location for the resource')
param location string

@description('Resource tags')
param tags object

@description('Name of the Container Apps Environment')
param containerAppsEnvironmentName string

@description('Name of the Container Registry')
param containerRegistryName string

@description('Name of the user-assigned managed identity')
param identityName string

@description('Client ID of the managed identity')
param identityClientId string

@description('Cosmos DB endpoint')
param cosmosEndpoint string

@description('Cosmos DB database name')
param cosmosDatabaseName string

@description('Cosmos DB container name')
param cosmosContainerName string

@description('Cosmos DB OAuth container name')
param cosmosOAuthContainerName string

@description('Application Insights connection string')
param appInsightsConnectionString string

@description('Entra app client ID')
param entraClientId string

@description('Entra app client secret')
@secure()
param entraClientSecret string

@description('Azure tenant ID')
param tenantId string

// ── References ─────────────────────────────────────────────────────────

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: containerAppsEnvironmentName
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

// ── Container App ──────────────────────────────────────────────────────

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  tags: union(tags, { 'azd-service-name': 'server' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8000
        transport: 'http'
        corsPolicy: {
          allowedOrigins: ['*']
          allowedHeaders: ['*']
          allowedMethods: ['GET', 'POST', 'DELETE', 'OPTIONS']
        }
      }
      registries: [
        {
          server: containerRegistry.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          name: 'entra-client-secret'
          value: entraClientSecret
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'server'
          image: 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'PORT', value: '8000' }
            { name: 'RUNNING_IN_PRODUCTION', value: 'true' }
            { name: 'AZURE_CLIENT_ID', value: identityClientId }
            { name: 'AZURE_COSMOSDB_ENDPOINT', value: cosmosEndpoint }
            { name: 'AZURE_COSMOSDB_DATABASE', value: cosmosDatabaseName }
            { name: 'AZURE_COSMOSDB_CONTAINER', value: cosmosContainerName }
            { name: 'AZURE_COSMOSDB_OAUTH_CONTAINER', value: cosmosOAuthContainerName }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            { name: 'ENTRA_CLIENT_ID', value: entraClientId }
            { name: 'ENTRA_CLIENT_SECRET', secretRef: 'entra-client-secret' }
            { name: 'ENTRA_TENANT_ID', value: tenantId }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 3
        rules: [
          {
            name: 'http-scaler'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}

output uri string = 'https://${app.properties.configuration.ingress.fqdn}'
output name string = app.name
