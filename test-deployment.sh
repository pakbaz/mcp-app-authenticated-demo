#!/bin/bash
# ────────────────────────────────────────────────────────────────────────
# Test script for MCP Todo App deployment
# This script tests the deployed MCP app functionality
# ────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🧪 Testing MCP Todo App Deployment${NC}"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo -e "${RED}❌ .env file not found. Please run ./deploy.sh first.${NC}"
    exit 1
fi

source .env

# Check required environment variables
if [ -z "${MCP_SERVER_BASE_URL:-}" ]; then
    echo -e "${RED}❌ MCP_SERVER_BASE_URL not set in .env${NC}"
    exit 1
fi

echo "Testing server: $MCP_SERVER_BASE_URL"
echo ""

# ── Test 1: Health Check ────────────────────────────────────────────────
echo -e "${YELLOW}Test 1: Health Check${NC}"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${MCP_SERVER_BASE_URL}/" || echo "000")

if [ "$HTTP_STATUS" == "200" ]; then
    echo -e "${GREEN}✅ Server is responding (HTTP 200)${NC}"
else
    echo -e "${RED}❌ Server returned HTTP $HTTP_STATUS${NC}"
    exit 1
fi
echo ""

# ── Test 2: Web UI ──────────────────────────────────────────────────────
echo -e "${YELLOW}Test 2: Web UI Endpoint${NC}"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${MCP_SERVER_BASE_URL}/" || echo "000")

if [ "$HTTP_STATUS" == "200" ]; then
    CONTENT=$(curl -s "${MCP_SERVER_BASE_URL}/")
    if echo "$CONTENT" | grep -q "MCP Todo App"; then
        echo -e "${GREEN}✅ Web UI is accessible and contains expected content${NC}"
    else
        echo -e "${YELLOW}⚠️  Web UI accessible but content may be different${NC}"
    fi
else
    echo -e "${RED}❌ Web UI endpoint returned HTTP $HTTP_STATUS${NC}"
fi
echo ""

# ── Test 3: Auth Endpoint ───────────────────────────────────────────────
echo -e "${YELLOW}Test 3: OAuth Authorization Endpoint${NC}"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${MCP_SERVER_BASE_URL}/auth/authorize" || echo "000")

if [ "$HTTP_STATUS" == "302" ] || [ "$HTTP_STATUS" == "200" ]; then
    echo -e "${GREEN}✅ Auth endpoint is responding (HTTP $HTTP_STATUS)${NC}"
else
    echo -e "${RED}❌ Auth endpoint returned HTTP $HTTP_STATUS${NC}"
fi
echo ""

# ── Test 4: MCP Endpoint ────────────────────────────────────────────────
echo -e "${YELLOW}Test 4: MCP Protocol Endpoint${NC}"

# Test OPTIONS request (CORS preflight)
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "${MCP_SERVER_BASE_URL}/mcp" || echo "000")

if [ "$HTTP_STATUS" == "200" ] || [ "$HTTP_STATUS" == "204" ]; then
    echo -e "${GREEN}✅ MCP endpoint OPTIONS request successful (HTTP $HTTP_STATUS)${NC}"
else
    echo -e "${YELLOW}⚠️  MCP endpoint OPTIONS returned HTTP $HTTP_STATUS${NC}"
fi
echo ""

# ── Test 5: Security Headers ────────────────────────────────────────────
echo -e "${YELLOW}Test 5: Security Headers${NC}"

HEADERS=$(curl -s -I "${MCP_SERVER_BASE_URL}/" | tr -d '\r')

# Check for HTTPS
if [[ "$MCP_SERVER_BASE_URL" == https://* ]]; then
    echo -e "${GREEN}✅ Using HTTPS${NC}"
else
    echo -e "${YELLOW}⚠️  Using HTTP (HTTPS recommended for production)${NC}"
fi

# Check for security headers
if echo "$HEADERS" | grep -iq "X-Content-Type-Options"; then
    echo -e "${GREEN}✅ X-Content-Type-Options header present${NC}"
else
    echo -e "${YELLOW}⚠️  X-Content-Type-Options header missing${NC}"
fi

echo ""

# ── Test 6: Environment Configuration ───────────────────────────────────
echo -e "${YELLOW}Test 6: Environment Configuration${NC}"

if [ -n "${ENTRA_CLIENT_ID:-}" ]; then
    echo -e "${GREEN}✅ ENTRA_CLIENT_ID is set${NC}"
else
    echo -e "${RED}❌ ENTRA_CLIENT_ID is not set${NC}"
fi

if [ -n "${AZURE_COSMOSDB_ENDPOINT:-}" ]; then
    echo -e "${GREEN}✅ AZURE_COSMOSDB_ENDPOINT is set${NC}"
else
    echo -e "${RED}❌ AZURE_COSMOSDB_ENDPOINT is not set${NC}"
fi

echo ""

# ── Test 7: Cosmos DB Connectivity ──────────────────────────────────────
echo -e "${YELLOW}Test 7: Cosmos DB Connectivity${NC}"

if [ -n "${AZURE_COSMOSDB_ENDPOINT:-}" ]; then
    # Try to resolve Cosmos DB hostname
    COSMOS_HOST=$(echo "$AZURE_COSMOSDB_ENDPOINT" | sed 's|https://||' | sed 's|:443/||' | sed 's|/||')
    
    if nslookup "$COSMOS_HOST" >/dev/null 2>&1; then
        echo -e "${GREEN}✅ Cosmos DB hostname resolves: $COSMOS_HOST${NC}"
        
        # Try to connect to Cosmos DB endpoint
        if timeout 5 bash -c "echo > /dev/tcp/$COSMOS_HOST/443" 2>/dev/null; then
            echo -e "${GREEN}✅ Can connect to Cosmos DB on port 443${NC}"
        else
            echo -e "${YELLOW}⚠️  Cannot connect to Cosmos DB (may be firewall restricted)${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  Cannot resolve Cosmos DB hostname${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  Cosmos DB endpoint not configured${NC}"
fi

echo ""

# ── Summary ─────────────────────────────────────────────────────────────
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}✅ Testing Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Application URL: $MCP_SERVER_BASE_URL"
echo ""
echo "Manual Testing Steps:"
echo "1. Open ${MCP_SERVER_BASE_URL} in a web browser"
echo "2. Click 'Sign In with Microsoft'"
echo "3. Authenticate with your Azure AD account"
echo "4. Try creating, completing, and deleting todos"
echo ""
echo "View logs:"
if [ -n "${RESOURCE_GROUP_NAME:-}" ]; then
    CONTAINER_APP_NAME=$(echo "$RESOURCE_GROUP_NAME" | sed 's/rg-/ca-server-/')
    echo "  az containerapp logs show --name $CONTAINER_APP_NAME --resource-group $RESOURCE_GROUP_NAME --follow"
fi
echo ""
