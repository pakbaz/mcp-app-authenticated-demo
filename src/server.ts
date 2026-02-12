import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TodoStore } from "./store/cosmos-store.js";
import { validateJwt } from "./auth/validate-jwt.js";
import { registerTools } from "./tools.js";

// ── Create MCP Server ──────────────────────────────────────────────────

const server = new McpServer({
  name: "mcp-todo-app",
  version: "1.0.0",
});

const store = new TodoStore();

// Register all tools and UI resources
registerTools(server, store);

// ── Express App ─────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check endpoint for Azure Container Apps probes
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "mcp-todo-app" });
});

// ── MCP Endpoint (POST — stateless) ────────────────────────────────────
// Auth middleware validates the Entra ID Bearer token and sets req.auth.
// The auth info is forwarded to the MCP transport so tools can access it.

app.post("/mcp", validateJwt, async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });

    // Forward auth info to the transport so tools receive it
    // The SDK's NodeStreamableHTTPServerTransport reads req.auth
    if (req.auth) {
      (req as unknown as Record<string, unknown>).auth = req.auth;
    }

    res.on("close", () => {
      transport.close().catch(console.error);
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// ── MCP Endpoint (GET — SSE for streaming) ─────────────────────────────

app.get("/mcp", validateJwt, async (req, res) => {
  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: false,
    });

    if (req.auth) {
      (req as unknown as Record<string, unknown>).auth = req.auth;
    }

    res.on("close", () => {
      transport.close().catch(console.error);
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("MCP SSE error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// ── DELETE for session cleanup ─────────────────────────────────────────

app.delete("/mcp", async (req, res) => {
  res.status(200).json({ status: "session closed" });
});

// ── Protected Resource Metadata (RFC 9728) ─────────────────────────────
// MCP clients check this endpoint to discover the OAuth configuration.
// This tells the client which Entra ID authority and scope to use.

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  const clientId = process.env.ENTRA_CLIENT_ID || "";
  const tenantId = process.env.ENTRA_TENANT_ID || "common";
  const baseUrl = process.env.MCP_SERVER_BASE_URL || `http://localhost:${PORT}`;

  res.json({
    resource: `${baseUrl}/mcp`,
    authorization_servers: [
      `https://login.microsoftonline.com/${tenantId}/v2.0`,
    ],
    scopes_supported: [`api://${clientId}/mcp-access`],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/your-org/mcp-todo-app",
  });
});

// ── Start Server ───────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "8000", 10);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 MCP Todo App server listening on http://0.0.0.0:${PORT}`);
  console.log(`   MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(
    `   OAuth metadata: http://localhost:${PORT}/.well-known/oauth-protected-resource`
  );
  console.log(
    `   Auth: ${process.env.ENTRA_CLIENT_ID ? "Entra ID configured" : "⚠️  No ENTRA_CLIENT_ID — auth disabled"}`
  );
  console.log(
    `   Store: ${process.env.AZURE_COSMOSDB_ENDPOINT ? "Cosmos DB" : "In-memory (dev)"}`
  );
});

export { app };
