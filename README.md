# MCP Todo App - Authenticated Demo

A Model Context Protocol (MCP) server implementation showcasing user-specific todo lists with **Entra ID OAuth 2.0 authentication** and **Azure Cosmos DB** storage.

## 🌟 Features

- **Interactive Web UI**: Fully-featured todo list interface with real-time updates
- **MCP Protocol**: Exposes todos via MCP tools for AI assistant integration
- **OAuth 2.0 Authentication**: Secure sign-in with Microsoft Entra ID (Azure AD)
- **User Isolation**: Each user has their own private todo list
- **Cloud Native**: Deployed on Azure Container Apps with Cosmos DB
- **Serverless Database**: Azure Cosmos DB with consumption-based pricing
- **Managed Identity**: Secure authentication to Azure resources without connection strings

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Browser                            │
└────────────┬────────────────────────────────────────────────────┘
             │
             ├─── HTTPS ────▶  Azure Container Apps
             │                      │
             │                      ├─── Web UI (/)
             │                      ├─── OAuth (/auth/*)
             │                      └─── MCP Endpoint (/mcp)
             │                              │
             │                              │ Managed Identity
             │                              ▼
             │                      Azure Cosmos DB
             │                      (todo-database)
             │                              │
             │                              ├─── todos container
             │                              └─── oauth-clients container
             │
             └─── OAuth ───▶  Microsoft Entra ID
                                 (Azure AD)
```

## 🔐 Security Features

- **No Secrets in Code**: All secrets parameterized via environment variables
- **Managed Identity**: Container app accesses Cosmos DB without connection strings
- **Secure Parameters**: Bicep uses `@secure()` decorator for sensitive data
- **HTTPS Only**: All traffic encrypted in transit
- **OAuth 2.0**: Industry-standard authentication with Microsoft Entra ID
- **User Isolation**: Row-level security via partition keys in Cosmos DB

See [SECURITY-AUDIT.md](SECURITY-AUDIT.md) for complete security audit.

## 🚀 Quick Start

### Prerequisites

- Azure subscription with permissions to create resources
- Azure CLI installed (`az --version`)
- Docker installed (`docker --version`)
- Node.js 18+ installed (`node --version`)

### Deploy to Azure

```bash
# 1. Clone the repository
git clone https://github.com/pakbaz/mcp-app-authenticated-demo.git
cd mcp-app-authenticated-demo

# 2. Login to Azure
az login

# 3. Run deployment (creates all resources)
./deploy.sh

# 4. Test deployment
./test-deployment.sh
```

The deployment script will:
1. ✅ Create Entra ID app registration
2. ✅ Deploy Azure infrastructure (Container Apps, Cosmos DB, Container Registry, etc.)
3. ✅ Build and push Docker image
4. ✅ Deploy container app
5. ✅ Generate .env files for local development

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed deployment guide.

## 💻 Local Development

After deployment, run locally:

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Open browser
open http://localhost:8000
```

The `.env` file is automatically generated during deployment with all necessary configuration.

## 📝 Usage

### Web UI

1. Navigate to your deployed URL (e.g., `https://ca-server-xxx.azurecontainerapps.io`)
2. Click **"Sign In with Microsoft"**
3. Authenticate with your Azure AD account
4. Create, complete, and delete todos in the web interface

### MCP Protocol

The MCP endpoint at `/mcp` exposes the following tools:

- **`get_todos`**: List all todos for the authenticated user
- **`create_todo`**: Create a new todo item
- **`update_todo`**: Update todo completion status
- **`delete_todo`**: Delete a todo item

Example with MCP Inspector:

```bash
npm install -g @modelcontextprotocol/inspector
mcp-inspector https://your-app-url.azurecontainerapps.io/mcp
```

## 🧪 Testing

```bash
# Test deployed application
./test-deployment.sh

# Build TypeScript
npm run build

# Run in watch mode
npm run build:watch

# Start production server
npm start
```

## 📁 Project Structure

```
.
├── src/
│   ├── server.ts           # Express server & MCP setup
│   ├── tools.ts            # MCP tool definitions
│   ├── auth/               # OAuth & JWT validation
│   ├── store/              # Cosmos DB integration
│   └── ui/                 # Web UI components
├── infra/
│   ├── main.bicep          # Main infrastructure template
│   ├── server.bicep        # Container App definition
│   └── core/               # Reusable Bicep modules
├── deploy.sh               # Automated deployment script
├── test-deployment.sh      # Deployment testing script
├── Dockerfile              # Multi-stage production build
├── DEPLOYMENT.md           # Detailed deployment guide
└── SECURITY-AUDIT.md       # Security audit report
```

## 🛠️ Technology Stack

- **Runtime**: Node.js 22 (TypeScript)
- **Framework**: Express.js
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Authentication**: `@azure/msal-node`, `jsonwebtoken`, `jwks-rsa`
- **Database**: Azure Cosmos DB (`@azure/cosmos`)
- **Identity**: Azure Managed Identity (`@azure/identity`)
- **Infrastructure**: Azure Bicep (IaC)
- **Hosting**: Azure Container Apps

## 🌍 Azure Resources Created

The deployment creates the following Azure resources:

| Resource | Purpose |
|----------|---------|
| **Resource Group** | Container for all resources |
| **Container Apps Environment** | Serverless container runtime |
| **Container Registry** | Stores Docker images |
| **Container App** | Runs the MCP server |
| **Cosmos DB Account** | Serverless NoSQL database |
| **Log Analytics Workspace** | Centralized logging |
| **Application Insights** | Monitoring and telemetry |
| **Managed Identity** | Secure access to Azure resources |
| **Entra ID App Registration** | OAuth 2.0 configuration |

## 🔧 Configuration

### Environment Variables

All configuration is via environment variables (never committed to git):

```bash
# Entra ID / Azure AD
ENTRA_CLIENT_ID=xxx
ENTRA_CLIENT_SECRET=xxx
ENTRA_TENANT_ID=xxx

# Azure Cosmos DB
AZURE_COSMOSDB_ENDPOINT=https://xxx.documents.azure.com:443/
AZURE_COSMOSDB_DATABASE=todo-database
AZURE_COSMOSDB_CONTAINER=todos
AZURE_COSMOSDB_OAUTH_CONTAINER=oauth-clients

# Runtime
RUNNING_IN_PRODUCTION=false
AZURE_CLIENT_ID=xxx  # Managed Identity (production only)
PORT=8000
```

### Regional Configuration

If you encounter capacity issues in a region, specify a different region for Cosmos DB:

```bash
export AZURE_LOCATION="eastus"
export AZURE_COSMOS_LOCATION="westus2"
./deploy.sh
```

## 🐛 Troubleshooting

### Deployment Fails with "Service Unavailable"

If Cosmos DB deployment fails in East US due to capacity:

```bash
export AZURE_COSMOS_LOCATION="westus2"
./deploy.sh
```

### Authentication Errors

Grant admin consent in Azure Portal:
1. Go to **Entra ID** → **App Registrations**
2. Find your app (MCP Todo App)
3. Go to **API permissions**
4. Click **Grant admin consent**

### Container App Won't Start

Check logs:

```bash
az containerapp logs show \
  --name ca-server-mcp-todo-dev \
  --resource-group rg-mcp-todo-dev \
  --follow
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for more troubleshooting tips.

## 🧹 Cleanup

To delete all Azure resources:

```bash
# Delete resource group (removes all resources)
az group delete --name rg-mcp-todo-dev --yes

# Delete Entra app registration
ENTRA_CLIENT_ID=$(cat .azure/mcp-todo-dev/.env | grep ENTRA_CLIENT_ID | cut -d'=' -f2)
OBJECT_ID=$(az ad app list --filter "appId eq '$ENTRA_CLIENT_ID'" --query "[0].id" -o tsv)
az ad app delete --id "$OBJECT_ID"

# Clean local files
rm -rf .azure/
rm .env
```

## 📄 License

This is a demo project for educational purposes.

## 🤝 Contributing

This is a demo application. For production use, consider:

- Storing secrets in Azure Key Vault
- Implementing automated secret rotation
- Using private endpoints for network isolation
- Setting up CI/CD pipelines
- Configuring custom domains with SSL
- Implementing comprehensive monitoring and alerting

## 📚 Resources

- [MCP Protocol Specification](https://spec.modelcontextprotocol.io/)
- [Azure Container Apps Documentation](https://learn.microsoft.com/azure/container-apps/)
- [Azure Cosmos DB Documentation](https://learn.microsoft.com/azure/cosmos-db/)
- [Microsoft Entra ID Documentation](https://learn.microsoft.com/entra/identity/)
- [Azure Managed Identity](https://learn.microsoft.com/azure/active-directory/managed-identities-azure-resources/)

## 🎯 Next Steps

- [ ] Set up CI/CD pipeline with GitHub Actions
- [ ] Configure custom domain
- [ ] Enable Cosmos DB backup
- [ ] Set up monitoring alerts
- [ ] Create staging environment
- [ ] Implement rate limiting
- [ ] Add comprehensive unit tests
- [ ] Configure autoscaling rules

---

**Built with ❤️ using the Model Context Protocol**
