# Post-provision hook: Update Entra app redirect URIs (Windows)

$ErrorActionPreference = "Stop"

$serverUrl = azd env get-value MCP_SERVER_BASE_URL 2>$null
$clientId = azd env get-value ENTRA_CLIENT_ID 2>$null

if (-not $serverUrl -or -not $clientId) {
    Write-Host "⚠️  MCP_SERVER_BASE_URL or ENTRA_CLIENT_ID not set — skipping"
    exit 0
}

$objectId = (az ad app list --filter "appId eq '$clientId'" --query "[0].id" -o tsv)
$prodRedirect = "$serverUrl/auth/callback"

$currentUris = (az ad app show --id $objectId --query "web.redirectUris" -o json | ConvertFrom-Json)
if ($currentUris -contains $prodRedirect) {
    Write-Host "✅ Production redirect URI already configured"
    exit 0
}

$allUris = $currentUris + @($prodRedirect)
az ad app update --id $objectId --web-redirect-uris @allUris
azd env set MCP_SERVER_BASE_URL $serverUrl

Write-Host "✅ Added production redirect URI: $prodRedirect"
