#!/bin/bash
# ────────────────────────────────────────────────────────────────────────
# Azure Deployment Script for MCP Todo App
# This script deploys the MCP Todo App to Azure using Azure CLI
# ────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Starting Azure Deployment for MCP Todo App${NC}"

# ── Configuration ──────────────────────────────────────────────────────
AZURE_ENV_NAME="${AZURE_ENV_NAME:-mcp-todo-dev}"
AZURE_LOCATION="${AZURE_LOCATION:-eastus}"
AZURE_COSMOS_LOCATION="${AZURE_COSMOS_LOCATION:-westus2}"  # Use West US 2 as fallback for Cosmos

echo ""
echo "Configuration:"
echo "  Environment Name: $AZURE_ENV_NAME"
echo "  Primary Location: $AZURE_LOCATION"
echo "  Cosmos DB Location: $AZURE_COSMOS_LOCATION"
echo ""

# ── Step 1: Login Check ────────────────────────────────────────────────
echo -e "${YELLOW}📋 Step 1: Checking Azure CLI login...${NC}"
if ! az account show &>/dev/null; then
    echo -e "${RED}❌ Not logged in to Azure CLI${NC}"
    echo "Please run: az login"
    exit 1
fi

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
echo -e "${GREEN}✅ Logged in to Azure (Subscription: $SUBSCRIPTION_ID)${NC}"

# ── Step 2: Create Entra ID App ────────────────────────────────────────
echo ""
echo -e "${YELLOW}📋 Step 2: Creating/Checking Entra ID App Registration...${NC}"

# Check if we already have an app registered
if [ -f .azure/${AZURE_ENV_NAME}/.env ]; then
    source .azure/${AZURE_ENV_NAME}/.env
    if [ -n "${ENTRA_CLIENT_ID:-}" ]; then
        echo -e "${GREEN}✅ Found existing Entra app: $ENTRA_CLIENT_ID${NC}"
    fi
fi

# If no app exists, create one
if [ -z "${ENTRA_CLIENT_ID:-}" ]; then
    echo "Creating new Entra ID app registration..."
    
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
    
    ENTRA_CLIENT_ID=$(echo "$APP_JSON" | jq -r '.appId')
    OBJECT_ID=$(echo "$APP_JSON" | jq -r '.id')
    
    echo "   App ID: $ENTRA_CLIENT_ID"
    echo "   Object ID: $OBJECT_ID"
    
    # Set the identifier URI
    az ad app update --id "$OBJECT_ID" --identifier-uris "api://$ENTRA_CLIENT_ID"
    
    # Add the custom OAuth2 permission scope
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
    
    # Set requested access token version to 2
    az ad app update --id "$OBJECT_ID" --set api.requestedAccessTokenVersion=2
    
    # Create a service principal
    az ad sp create --id "$ENTRA_CLIENT_ID" --output json 2>/dev/null || \
        az ad sp show --id "$ENTRA_CLIENT_ID" --output json >/dev/null
    
    # Create a client secret
    SECRET_JSON=$(az ad app credential reset \
        --id "$OBJECT_ID" \
        --display-name "MCP Todo App Secret" \
        --years 2 \
        --output json)
    
    ENTRA_CLIENT_SECRET=$(echo "$SECRET_JSON" | jq -r '.password')
    
    # Grant admin consent for Microsoft Graph User.Read
    az ad app permission add --id "$OBJECT_ID" \
        --api "00000003-0000-0000-c000-000000000000" \
        --api-permissions "e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope" 2>/dev/null || true
    
    az ad app permission admin-consent --id "$OBJECT_ID" 2>/dev/null || \
        echo "   ⚠️  Admin consent may need to be granted manually in Azure Portal"
    
    echo -e "${GREEN}✅ Entra app registration complete: $ENTRA_CLIENT_ID${NC}"
fi

# ── Step 3: Deploy Infrastructure ──────────────────────────────────────
echo ""
echo -e "${YELLOW}📋 Step 3: Deploying Azure Infrastructure...${NC}"

RESOURCE_GROUP_NAME="rg-${AZURE_ENV_NAME}"
DEPLOYMENT_NAME="mcp-todo-${AZURE_ENV_NAME}-$(date +%s)"

# Create resource group
echo "Creating resource group: $RESOURCE_GROUP_NAME"
az group create \
    --name "$RESOURCE_GROUP_NAME" \
    --location "$AZURE_LOCATION" \
    --tags "azd-env-name=$AZURE_ENV_NAME" \
    --output none

echo -e "${GREEN}✅ Resource group created${NC}"

# Deploy Bicep template
echo "Deploying infrastructure..."
DEPLOYMENT_OUTPUT=$(az deployment sub create \
    --name "$DEPLOYMENT_NAME" \
    --location "$AZURE_LOCATION" \
    --template-file infra/main.bicep \
    --parameters environmentName="$AZURE_ENV_NAME" \
    --parameters location="$AZURE_LOCATION" \
    --parameters cosmosLocation="$AZURE_COSMOS_LOCATION" \
    --parameters entraClientId="$ENTRA_CLIENT_ID" \
    --parameters entraClientSecret="$ENTRA_CLIENT_SECRET" \
    --output json)

# Extract outputs
AZURE_CONTAINER_REGISTRY_NAME=$(echo "$DEPLOYMENT_OUTPUT" | jq -r '.properties.outputs.AZURE_CONTAINER_REGISTRY_NAME.value')
AZURE_CONTAINER_REGISTRY_ENDPOINT=$(echo "$DEPLOYMENT_OUTPUT" | jq -r '.properties.outputs.AZURE_CONTAINER_REGISTRY_ENDPOINT.value')
AZURE_COSMOSDB_ENDPOINT=$(echo "$DEPLOYMENT_OUTPUT" | jq -r '.properties.outputs.AZURE_COSMOSDB_ENDPOINT.value')
MCP_SERVER_BASE_URL=$(echo "$DEPLOYMENT_OUTPUT" | jq -r '.properties.outputs.MCP_SERVER_BASE_URL.value')

echo -e "${GREEN}✅ Infrastructure deployed${NC}"
echo "   Container Registry: $AZURE_CONTAINER_REGISTRY_ENDPOINT"
echo "   Cosmos DB: $AZURE_COSMOSDB_ENDPOINT"
echo "   MCP Server URL: $MCP_SERVER_BASE_URL"

# ── Step 4: Update Redirect URIs ───────────────────────────────────────
echo ""
echo -e "${YELLOW}📋 Step 4: Updating Entra redirect URIs with production URL...${NC}"

OBJECT_ID=$(az ad app list --filter "appId eq '$ENTRA_CLIENT_ID'" --query "[0].id" -o tsv)

# Get existing redirect URIs
EXISTING_URIS=$(az ad app show --id "$OBJECT_ID" --query "web.redirectUris" -o json)

# Add production URL if not already present
PRODUCTION_CALLBACK="${MCP_SERVER_BASE_URL}/auth/callback"

if echo "$EXISTING_URIS" | jq -e ". | index(\"$PRODUCTION_CALLBACK\")" >/dev/null; then
    echo "Production callback URI already registered"
else
    echo "Adding production callback URI: $PRODUCTION_CALLBACK"
    UPDATED_URIS=$(echo "$EXISTING_URIS" | jq ". + [\"$PRODUCTION_CALLBACK\"]")
    az ad app update --id "$OBJECT_ID" --web-redirect-uris $(echo "$UPDATED_URIS" | jq -r '.[]')
fi

echo -e "${GREEN}✅ Redirect URIs updated${NC}"

# ── Step 5: Build and Push Docker Image ────────────────────────────────
echo ""
echo -e "${YELLOW}📋 Step 5: Building and pushing Docker image...${NC}"

# Login to ACR
az acr login --name "$AZURE_CONTAINER_REGISTRY_NAME"

# Build and push image
IMAGE_TAG="${AZURE_CONTAINER_REGISTRY_ENDPOINT}/mcp-todo-app:latest"
echo "Building image: $IMAGE_TAG"

docker build -t "$IMAGE_TAG" .
docker push "$IMAGE_TAG"

echo -e "${GREEN}✅ Docker image built and pushed${NC}"

# ── Step 6: Deploy Container App ───────────────────────────────────────
echo ""
echo -e "${YELLOW}📋 Step 6: Deploying container to Azure Container Apps...${NC}"

# The container app should already be created by the Bicep template
# We just need to update it with the new image
CONTAINER_APP_NAME="ca-server-$(echo $RESOURCE_GROUP_NAME | sed 's/rg-//')"

echo "Updating container app: $CONTAINER_APP_NAME"
az containerapp update \
    --name "$CONTAINER_APP_NAME" \
    --resource-group "$RESOURCE_GROUP_NAME" \
    --image "$IMAGE_TAG" \
    --output none

echo -e "${GREEN}✅ Container app deployed${NC}"

# ── Step 7: Write .env file ─────────────────────────────────────────────
echo ""
echo -e "${YELLOW}📋 Step 7: Writing .env file...${NC}"

mkdir -p .azure/${AZURE_ENV_NAME}

cat > .azure/${AZURE_ENV_NAME}/.env << EOF
# Generated by deploy.sh — $(date -u +"%Y-%m-%dT%H:%M:%SZ")

ENTRA_CLIENT_ID=$ENTRA_CLIENT_ID
ENTRA_CLIENT_SECRET=$ENTRA_CLIENT_SECRET
ENTRA_TENANT_ID=$TENANT_ID
AZURE_COSMOSDB_ENDPOINT=$AZURE_COSMOSDB_ENDPOINT
AZURE_COSMOSDB_DATABASE=todo-database
MCP_SERVER_BASE_URL=$MCP_SERVER_BASE_URL
AZURE_CONTAINER_REGISTRY_NAME=$AZURE_CONTAINER_REGISTRY_NAME
AZURE_CONTAINER_REGISTRY_ENDPOINT=$AZURE_CONTAINER_REGISTRY_ENDPOINT
RESOURCE_GROUP_NAME=$RESOURCE_GROUP_NAME
EOF

# Also write to root .env for local development
cat > .env << EOF
# Generated by deploy.sh — $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Entra ID
ENTRA_CLIENT_ID=$ENTRA_CLIENT_ID
ENTRA_CLIENT_SECRET=$ENTRA_CLIENT_SECRET
ENTRA_TENANT_ID=$TENANT_ID

# Cosmos DB
AZURE_COSMOSDB_ENDPOINT=$AZURE_COSMOSDB_ENDPOINT
AZURE_COSMOSDB_DATABASE=todo-database
AZURE_COSMOSDB_CONTAINER=todos
AZURE_COSMOSDB_OAUTH_CONTAINER=oauth-clients

# Server
MCP_SERVER_BASE_URL=$MCP_SERVER_BASE_URL
PORT=8000
RUNNING_IN_PRODUCTION=false
EOF

echo -e "${GREEN}✅ .env files written${NC}"

# ── Summary ─────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}🎉 Deployment Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Environment: $AZURE_ENV_NAME"
echo "Resource Group: $RESOURCE_GROUP_NAME"
echo "MCP Server URL: $MCP_SERVER_BASE_URL"
echo ""
echo "Next steps:"
echo "1. Test the MCP app: $MCP_SERVER_BASE_URL"
echo "2. Check logs: az containerapp logs show --name $CONTAINER_APP_NAME --resource-group $RESOURCE_GROUP_NAME"
echo ""
