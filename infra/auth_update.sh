#!/bin/bash
# ────────────────────────────────────────────────────────────────────────
# Post-provision hook: Update Entra app redirect URIs with deployed URL.
#
# After the Container App is deployed, this adds the production callback
# URL to the app registration's redirect URIs.
# ────────────────────────────────────────────────────────────────────────

set -euo pipefail

echo "🔗 Updating Entra app redirect URIs with deployed URL..."

MCP_SERVER_URL=$(azd env get-value MCP_SERVER_BASE_URL 2>/dev/null || echo "")
CLIENT_ID=$(azd env get-value ENTRA_CLIENT_ID 2>/dev/null || echo "")

if [ -z "$MCP_SERVER_URL" ] || [ -z "$CLIENT_ID" ]; then
    echo "⚠️  MCP_SERVER_BASE_URL or ENTRA_CLIENT_ID not set — skipping"
    exit 0
fi

OBJECT_ID=$(az ad app list --filter "appId eq '$CLIENT_ID'" --query "[0].id" -o tsv)

if [ -z "$OBJECT_ID" ]; then
    echo "⚠️  Could not find app registration for $CLIENT_ID — skipping"
    exit 0
fi

PRODUCTION_REDIRECT="${MCP_SERVER_URL}/auth/callback"

# Get current redirect URIs
CURRENT_URIS=$(az ad app show --id "$OBJECT_ID" --query "web.redirectUris" -o json)

# Check if already added
if echo "$CURRENT_URIS" | jq -e "index(\"$PRODUCTION_REDIRECT\")" > /dev/null 2>&1; then
    echo "✅ Production redirect URI already configured"
    exit 0
fi

# Add the production redirect URI
NEW_URIS=$(echo "$CURRENT_URIS" | jq ". + [\"$PRODUCTION_REDIRECT\"]")
az ad app update --id "$OBJECT_ID" --web-redirect-uris $(echo "$NEW_URIS" | jq -r '.[]')

# Also update the MCP_SERVER_BASE_URL in azd env for the server to use
azd env set MCP_SERVER_BASE_URL "$MCP_SERVER_URL"

echo "✅ Added production redirect URI: $PRODUCTION_REDIRECT"
