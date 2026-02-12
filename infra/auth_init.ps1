# Pre-provision hook: Create Entra ID app registration (Windows)

$ErrorActionPreference = "Stop"

Write-Host "🔐 Checking Entra ID app registration..."

$existingClientId = azd env get-value ENTRA_CLIENT_ID 2>$null
if ($existingClientId) {
    Write-Host "✅ Entra app already registered: $existingClientId"
    exit 0
}

Write-Host "📝 Creating new Entra ID app registration..."

$randomId = -join ((65..90) + (97..122) | Get-Random -Count 8 | ForEach-Object { [char]$_ })
$displayName = "MCP Todo App $randomId"
$scopeId = [guid]::NewGuid().ToString()

$redirectUris = @(
    "http://localhost:8000/auth/callback",
    "https://vscode.dev/redirect"
) + (33418..33427 | ForEach-Object { "http://127.0.0.1:$_" })

$appJson = az ad app create `
    --display-name $displayName `
    --sign-in-audience "AzureADMyOrg" `
    --web-redirect-uris @redirectUris `
    --enable-access-token-issuance true `
    --enable-id-token-issuance true `
    --output json | ConvertFrom-Json

$clientId = $appJson.appId
$objectId = $appJson.id

az ad app update --id $objectId --identifier-uris "api://$clientId"

$scopeJson = @"
[{"adminConsentDescription":"Access MCP Todo App on behalf of the user","adminConsentDisplayName":"Access MCP Todo App","id":"$scopeId","isEnabled":true,"type":"User","userConsentDescription":"Allow access to MCP Todo App on your behalf","userConsentDisplayName":"Access MCP Todo App","value":"mcp-access"}]
"@

az ad app update --id $objectId --set "api.oauth2PermissionScopes=$scopeJson"
az ad app update --id $objectId --set api.requestedAccessTokenVersion=2

$spJson = az ad sp create --id $clientId --output json 2>$null
if (-not $spJson) { $spJson = az ad sp show --id $clientId --output json }

$secretJson = az ad app credential reset --id $objectId --display-name "MCP Todo App Secret" --years 2 --output json | ConvertFrom-Json
$clientSecret = $secretJson.password

az ad app permission add --id $objectId --api "00000003-0000-0000-c000-000000000000" --api-permissions "e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope" 2>$null
az ad app permission admin-consent --id $objectId 2>$null

azd env set ENTRA_CLIENT_ID $clientId
azd env set ENTRA_CLIENT_SECRET $clientSecret

$tenantId = (az account show --query "tenantId" -o tsv)
azd env set ENTRA_TENANT_ID $tenantId

Write-Host "✅ Entra app registration complete! Client ID: $clientId"
