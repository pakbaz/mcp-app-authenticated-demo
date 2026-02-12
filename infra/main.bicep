targetScope = 'subscription'

@description('Name of the environment (e.g., dev, staging, prod)')
param environmentName string

@description('Primary location for all resources')
param location string

@description('Entra app registration client ID (set by auth_init hook)')
param entraClientId string = ''

@description('Entra app registration client secret (set by auth_init hook)')
@secure()
param entraClientSecret string = ''

// ── Derived names ──────────────────────────────────────────────────────

var abbrs = loadJsonContent('./abbreviations.json')
var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var tags = { 'azd-env-name': environmentName }

// ── Resource Group ─────────────────────────────────────────────────────

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: '${abbrs.resourcesResourceGroups}${environmentName}'
  location: location
  tags: tags
}

// ── Log Analytics + Application Insights ───────────────────────────────

module logAnalytics 'core/monitor/loganalytics.bicep' = {
  name: 'loganalytics'
  scope: rg
  params: {
    name: '${abbrs.operationalInsightsWorkspaces}${resourceToken}'
    location: location
    tags: tags
  }
}

module appInsights 'core/monitor/applicationinsights.bicep' = {
  name: 'appinsights'
  scope: rg
  params: {
    name: '${abbrs.insightsComponents}${resourceToken}'
    location: location
    tags: tags
    logAnalyticsWorkspaceId: logAnalytics.outputs.id
  }
}

// ── Azure Cosmos DB (Serverless) ───────────────────────────────────────

module cosmos 'core/database/cosmos.bicep' = {
  name: 'cosmos'
  scope: rg
  params: {
    accountName: '${abbrs.documentDBDatabaseAccounts}${resourceToken}'
    location: location
    tags: tags
    databaseName: 'todo-database'
    containers: [
      {
        name: 'todos'
        partitionKeyPath: '/user_id'
      }
      {
        name: 'oauth-clients'
        partitionKeyPath: '/collection'
      }
    ]
  }
}

// ── Container Apps Environment + Registry ──────────────────────────────

module containerAppsEnv 'core/host/container-apps-environment.bicep' = {
  name: 'container-apps-env'
  scope: rg
  params: {
    name: '${abbrs.appManagedEnvironments}${resourceToken}'
    location: location
    tags: tags
    logAnalyticsWorkspaceId: logAnalytics.outputs.id
  }
}

module containerRegistry 'core/host/container-registry.bicep' = {
  name: 'container-registry'
  scope: rg
  params: {
    name: '${abbrs.containerRegistryRegistries}${resourceToken}'
    location: location
    tags: tags
  }
}

// ── User-Assigned Managed Identity ─────────────────────────────────────

module identity 'core/identity/user-assigned-identity.bicep' = {
  name: 'identity'
  scope: rg
  params: {
    name: '${abbrs.managedIdentityUserAssignedIdentities}${resourceToken}'
    location: location
    tags: tags
  }
}

// ── Cosmos DB Role Assignment (Data Contributor) ───────────────────────

module cosmosRoleAssignment 'core/database/cosmos-role-assignment.bicep' = {
  name: 'cosmos-role-assignment'
  scope: rg
  params: {
    cosmosAccountName: cosmos.outputs.accountName
    principalId: identity.outputs.principalId
  }
}

// ── Container App (MCP Server) ─────────────────────────────────────────

module server 'server.bicep' = {
  name: 'server'
  scope: rg
  params: {
    name: '${abbrs.appContainerApps}server-${resourceToken}'
    location: location
    tags: tags
    containerAppsEnvironmentName: containerAppsEnv.outputs.name
    containerRegistryName: containerRegistry.outputs.name
    identityName: identity.outputs.name
    identityClientId: identity.outputs.clientId
    cosmosEndpoint: cosmos.outputs.endpoint
    cosmosDatabaseName: 'todo-database'
    cosmosContainerName: 'todos'
    cosmosOAuthContainerName: 'oauth-clients'
    appInsightsConnectionString: appInsights.outputs.connectionString
    entraClientId: entraClientId
    entraClientSecret: entraClientSecret
    tenantId: tenant().tenantId
  }
}

// ── Outputs ────────────────────────────────────────────────────────────

output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = containerRegistry.outputs.loginServer
output AZURE_CONTAINER_REGISTRY_NAME string = containerRegistry.outputs.name
output MCP_SERVER_BASE_URL string = server.outputs.uri
output AZURE_COSMOSDB_ENDPOINT string = cosmos.outputs.endpoint
output AZURE_COSMOSDB_DATABASE string = 'todo-database'
output AZURE_TENANT_ID string = tenant().tenantId
