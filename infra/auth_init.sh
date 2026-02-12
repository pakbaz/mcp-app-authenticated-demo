#!/bin/bash
# ────────────────────────────────────────────────────────────────────────
# Pre-provision hook: Create Entra ID app registration for the MCP server.
#
# This script uses the Azure CLI to create an app registration with:
# - A custom API scope (api://{clientId}/mcp-access)
# - Redirect URIs for local dev + VS Code + production
# - Admin consent for Graph API User.Read scope
#
# It stores ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET in the azd env.
# ────────────────────────────────────────────────────────────────────────

set -euo pipefail

echo "🔐 Checking Entra ID app registration..."

# Check if already registered
EXISTING_CLIENT_ID=$(azd env get-value ENTRA_CLIENT_ID 2>/dev/null || echo "")

if [ -n "$EXISTING_CLIENT_ID" ] && [ "$EXISTING_CLIENT_ID" != "" ]; then
    echo "✅ Entra app already registered: $EXISTING_CLIENT_ID"
    exit 0
fi

echo "📝 Creating new Entra ID app registration..."

RANDOM_ID=$(openssl rand -hex 4)
DISPLAY_NAME="MCP Todo App ${RANDOM_ID}"
SCOPE_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

# Create the app registration
APP_JSON=$(az ad app create \
    --display-name "$DISPLAY_NAME" \
    --sign-in-audience "AzureADMyOrg" \
    --web-redirect-uris \
        "http://localhost:8000/auth/callback" \
        "https://vscode.dev/redirect" \
        "http://127.0.0.1:33418" \
        "http://127.0.0.1:33419" \
        "http://127.0.0.1:33420" \
        "http://127.0.0.1:33421" \
        "http://127.0.0.1:33422" \
        "http://127.0.0.1:33423" \
        "http://127.0.0.1:33424" \
        "http://127.0.0.1:33425" \
        "http://127.0.0.1:33426" \
        "http://127.0.0.1:33427" \
    --enable-access-token-issuance true \
    --enable-id-token-issuance true \
    --output json)

CLIENT_ID=$(echo "$APP_JSON" | jq -r '.appId')
OBJECT_ID=$(echo "$APP_JSON" | jq -r '.id')

echo "   App ID: $CLIENT_ID"
echo "   Object ID: $OBJECT_ID"

# Set the identifier URI
az ad app update --id "$OBJECT_ID" --identifier-uris "api://$CLIENT_ID"

# Add the custom OAuth2 permission scope (mcp-access)
az ad app update --id "$OBJECT_ID" --set api.oauth2PermissionScopes="[{
    \"adminConsentDescription\": \"Access MCP Todo App on behalf of the user\",
    \"adminConsentDisplayName\": \"Access MCP Todo App\",
    \"id\": \"$SCOPE_ID\",
    \"isEnabled\": true,
    \"type\": \"User\",
    \"userConsentDescription\": \"Allow access to MCP Todo App on your behalf\",
    \"userConsentDisplayName\": \"Access MCP Todo App\",
    \"value\": \"mcp-access\"
}]"

# Set requested access token version to 2 (required for MCP OAuth)
az ad app update --id "$OBJECT_ID" --set api.requestedAccessTokenVersion=2

# Create a service principal
SP_JSON=$(az ad sp create --id "$CLIENT_ID" --output json 2>/dev/null || \
    az ad sp show --id "$CLIENT_ID" --output json)
SP_ID=$(echo "$SP_JSON" | jq -r '.id')

echo "   Service Principal ID: $SP_ID"

# Create a client secret
SECRET_JSON=$(az ad app credential reset \
    --id "$OBJECT_ID" \
    --display-name "MCP Todo App Secret" \
    --years 2 \
    --output json)

CLIENT_SECRET=$(echo "$SECRET_JSON" | jq -r '.password')

# Grant admin consent for Microsoft Graph User.Read
# Find Microsoft Graph service principal
GRAPH_SP_ID=$(az ad sp list --filter "displayName eq 'Microsoft Graph'" --query "[0].id" -o tsv 2>/dev/null || echo "")

if [ -n "$GRAPH_SP_ID" ]; then
    echo "   Granting admin consent for Graph API (User.Read)..."
    az ad app permission add --id "$OBJECT_ID" \
        --api "00000003-0000-0000-c000-000000000000" \
        --api-permissions "e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope" 2>/dev/null || true

    az ad app permission admin-consent --id "$OBJECT_ID" 2>/dev/null || \
        echo "   ⚠️  Admin consent may need to be granted manually in Azure Portal"
fi

# Store in azd env
azd env set ENTRA_CLIENT_ID "$CLIENT_ID"
azd env set ENTRA_CLIENT_SECRET "$CLIENT_SECRET"

TENANT_ID=$(az account show --query "tenantId" -o tsv)
azd env set ENTRA_TENANT_ID "$TENANT_ID"

echo ""
echo "✅ Entra app registration complete!"
echo "   Display Name: $DISPLAY_NAME"
echo "   Client ID: $CLIENT_ID"
echo "   Scope: api://$CLIENT_ID/mcp-access"
echo ""
