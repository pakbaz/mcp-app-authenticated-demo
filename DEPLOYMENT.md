# MCP Todo App - Azure Deployment Guide

This guide walks you through deploying the MCP Todo App to Azure.

## Prerequisites

Before you begin, ensure you have:

1. **Azure CLI** installed and configured
   ```bash
   az --version
   ```

2. **Docker** installed
   ```bash
   docker --version
   ```

3. **Node.js and npm** installed
   ```bash
   node --version
   npm --version
   ```

4. **Azure subscription** with appropriate permissions:
   - Create resource groups
   - Create Azure Container Apps
   - Create Azure Cosmos DB
   - Create Azure Container Registry
   - Create Entra ID app registrations

## Security Notice

⚠️ **IMPORTANT**: This repository is configured to keep secrets secure:

- `.env` files are in `.gitignore` and will NOT be committed
- `.azure/` directory is in `.gitignore` and will NOT be committed
- Secrets are passed as secure parameters in Bicep templates
- Client secrets are stored only in Azure Key Vault or local `.env` files

**Never commit secrets to the repository!**

## Deployment Steps

### 1. Login to Azure

```bash
az login
```

Select your subscription:

```bash
az account set --subscription <subscription-id>
```

### 2. Set Environment Variables

```bash
export AZURE_ENV_NAME="mcp-todo-dev"        # Environment name (dev, staging, prod)
export AZURE_LOCATION="eastus"              # Primary location for resources
export AZURE_COSMOS_LOCATION="westus2"      # Cosmos DB location (use alternate if eastus has capacity issues)
```

### 3. Run Deployment Script

The deployment script handles everything:

```bash
./deploy.sh
```

This script will:
1. ✅ Check Azure CLI login
2. ✅ Create/check Entra ID app registration
3. ✅ Deploy Azure infrastructure (Resource Group, Container Registry, Cosmos DB, Container Apps, etc.)
4. ✅ Update Entra redirect URIs with production URL
5. ✅ Build and push Docker image
6. ✅ Deploy container app
7. ✅ Write `.env` files for local development

### 4. Verify Deployment

After deployment completes, you'll see output like:

```
========================================
🎉 Deployment Complete!
========================================

Environment: mcp-todo-dev
Resource Group: rg-mcp-todo-dev
MCP Server URL: https://ca-server-mcp-todo-dev.azurecontainerapps.io
```

## Testing the Deployment

### Test the MCP Server

1. **Open the web UI**:
   ```bash
   # The URL is shown in deployment output
   open https://ca-server-mcp-todo-dev.azurecontainerapps.io
   ```

2. **Test OAuth flow**:
   - Click "Sign In with Microsoft"
   - Authenticate with your Azure AD account
   - You should be redirected back and see your todo list

3. **Check container app logs**:
   ```bash
   az containerapp logs show \
     --name ca-server-mcp-todo-dev \
     --resource-group rg-mcp-todo-dev \
     --follow
   ```

### Test MCP Protocol

1. **Install MCP Inspector** (optional):
   ```bash
   npm install -g @modelcontextprotocol/inspector
   ```

2. **Connect to MCP endpoint**:
   ```bash
   mcp-inspector https://ca-server-mcp-todo-dev.azurecontainerapps.io/mcp
   ```

## Local Development

After deployment, you can run the app locally:

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Use the generated `.env` file**:
   The deployment script creates a `.env` file with all necessary configuration.

3. **Run locally**:
   ```bash
   npm run dev
   ```

4. **Access locally**:
   - Web UI: http://localhost:8000
   - MCP endpoint: http://localhost:8000/mcp

## Troubleshooting

### Cosmos DB Deployment Fails

If you get "Service Unavailable" error for Cosmos DB in East US:

```bash
# Use a different region for Cosmos DB
export AZURE_COSMOS_LOCATION="westus2"
# or
export AZURE_COSMOS_LOCATION="centralus"

# Re-run deployment
./deploy.sh
```

### Entra App Permission Issues

If you see "Need admin approval" when signing in:

1. Go to Azure Portal → Entra ID → App Registrations
2. Find your app (MCP Todo App)
3. Go to "API permissions"
4. Click "Grant admin consent for [Your Tenant]"

### Container App Doesn't Start

Check the logs:

```bash
az containerapp logs show \
  --name ca-server-mcp-todo-dev \
  --resource-group rg-mcp-todo-dev \
  --follow
```

Common issues:
- Missing environment variables
- Cosmos DB connection issues
- Entra ID configuration issues

## Cleanup

To delete all resources:

```bash
# Delete the resource group (this deletes everything)
az group delete --name rg-mcp-todo-dev --yes

# Delete the Entra app registration
ENTRA_CLIENT_ID=$(cat .azure/mcp-todo-dev/.env | grep ENTRA_CLIENT_ID | cut -d'=' -f2)
OBJECT_ID=$(az ad app list --filter "appId eq '$ENTRA_CLIENT_ID'" --query "[0].id" -o tsv)
az ad app delete --id "$OBJECT_ID"

# Clean up local files
rm -rf .azure/
rm .env
```

## Architecture

The deployed infrastructure includes:

- **Azure Container Apps**: Hosts the MCP server
- **Azure Container Registry**: Stores Docker images
- **Azure Cosmos DB**: Serverless database for todos and OAuth state
- **Azure Application Insights**: Monitoring and logging
- **Azure Log Analytics**: Log aggregation
- **Managed Identity**: Secure access to Azure resources
- **Entra ID App Registration**: OAuth 2.0 authentication

## Security Considerations

1. **Managed Identity**: The container app uses managed identity to access Cosmos DB (no connection strings needed)
2. **Key Vault**: Consider storing secrets in Azure Key Vault for production
3. **Private Endpoints**: For production, use private endpoints for Cosmos DB and Container Registry
4. **HTTPS Only**: Container Apps enforce HTTPS by default
5. **Authentication**: OAuth 2.0 with Entra ID ensures secure user authentication

## Next Steps

- Configure custom domain for production
- Set up CI/CD pipeline
- Enable monitoring alerts
- Configure backup for Cosmos DB
- Set up staging environment
- Review and adjust scaling configuration
