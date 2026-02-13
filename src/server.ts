import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TodoStore } from "./store/cosmos-store.js";
import { validateJwt, validateJwtOptional } from "./auth/validate-jwt.js";
import { oauthProxyRouter } from "./auth/oauth-proxy.js";
import { registerTools } from "./tools.js";

// ── Create MCP Server ──────────────────────────────────────────────────

const store = new TodoStore();

// ── Session Management ─────────────────────────────────────────────────
// Map of session IDs → { transport, server } for stateful MCP sessions.
// Each MCP client session gets its own McpServer + transport pair.

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

const sessions = new Map<string, Session>();

function createSessionServer(): McpServer {
  const srv = new McpServer({
    name: "mcp-todo-app",
    version: "1.0.0",
  });
  registerTools(srv, store);
  return srv;
}

// ── Express App ─────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Debug: log ALL incoming requests
app.use((req, _res, next) => {
  if (req.path !== "/health") {
    console.log(`🌐 [REQ] ${req.method} ${req.path} session=${req.headers["mcp-session-id"] || "none"}`);
  }
  next();
});

// Mount the OAuth proxy routes (DCR, authorize, callback, token)
app.use(oauthProxyRouter);

// Health check endpoint for Azure Container Apps probes
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "mcp-todo-app" });
});

// ── MCP Endpoint (POST) ────────────────────────────────────────────────
// Handles initialization (creates session) and subsequent messages.
// Auth middleware validates the Entra ID Bearer token and sets req.auth.

app.post("/mcp", validateJwt, async (req, res) => {
  try {
    // Debug: log incoming MCP requests
    const body = req.body;
    if (body?.method === "initialize") {
      console.log("🔍 [DEBUG] Client initialize request:");
      console.log("   Protocol version:", body.params?.protocolVersion);
      console.log("   Client capabilities:", JSON.stringify(body.params?.capabilities, null, 2));
    } else if (body?.method) {
      console.log(`📨 [DEBUG] MCP method: ${body.method}`);
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (session) {
      // Existing session — forward auth and handle request
      if (req.auth) {
        (req as unknown as Record<string, unknown>).auth = req.auth;
      }
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — create transport + per-session McpServer
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    });

    const srv = createSessionServer();

    // Store session when the transport assigns a session ID
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
        console.log(`🗑️  Session closed: ${sid}`);
      }
    };

    if (req.auth) {
      (req as unknown as Record<string, unknown>).auth = req.auth;
    }

    await srv.connect(transport);

    // Intercept the response to log server capabilities
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    let responseBody = "";
    res.write = function(chunk: any, ...args: any[]) {
      if (typeof chunk === "string") responseBody += chunk;
      else if (Buffer.isBuffer(chunk)) responseBody += chunk.toString();
      return origWrite(chunk, ...args);
    } as any;
    const origEndFn = res.end;
    res.end = function(chunk?: any, ...args: any[]) {
      if (chunk) {
        if (typeof chunk === "string") responseBody += chunk;
        else if (Buffer.isBuffer(chunk)) responseBody += chunk.toString();
      }
      try {
        const parsed = JSON.parse(responseBody);
        if (parsed?.result?.serverInfo || parsed?.result?.capabilities) {
          console.log("🔍 [DEBUG] Server initialize response:");
          console.log("   Server info:", JSON.stringify(parsed.result.serverInfo));
          console.log("   Server capabilities:", JSON.stringify(parsed.result.capabilities, null, 2));
        }
      } catch {}
      return (origEndFn as Function).apply(res, [chunk, ...args]);
    } as any;

    await transport.handleRequest(req, res, req.body);

    // After handling the initialize request, the transport has a sessionId
    if (transport.sessionId) {
      sessions.set(transport.sessionId, { transport, server: srv });
      console.log(`📌 Session created: ${transport.sessionId}`);
    }
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// ── MCP Endpoint (GET — SSE for server-to-client notifications) ────────

app.get("/mcp", validateJwtOptional, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;

  if (!session) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No active session" },
      id: null,
    });
    return;
  }

  try {
    if (req.auth) {
      (req as unknown as Record<string, unknown>).auth = req.auth;
    }
    await session.transport.handleRequest(req, res);
  } catch (err) {
    console.error("MCP SSE error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// ── DELETE for session cleanup ─────────────────────────────────────────

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;

  if (session) {
    await session.transport.close();
    sessions.delete(sessionId!);
    console.log(`🗑️  Session deleted: ${sessionId}`);
  }

  res.status(200).json({ status: "session closed" });
});

// ── Protected Resource Metadata (RFC 9728) ─────────────────────────────
// MCP clients check this endpoint to discover the OAuth configuration.
// This tells the client which Entra ID authority and scope to use.

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  const clientId = process.env.ENTRA_CLIENT_ID || "";
  const serverBaseUrl = process.env.MCP_SERVER_BASE_URL || `http://localhost:${PORT}`;

  // Point to THIS server as the authorization server (OAuth proxy pattern).
  // The proxy handles DCR and bridges to Entra for actual authentication.
  res.json({
    resource: `${serverBaseUrl}/mcp`,
    authorization_servers: [serverBaseUrl],
    scopes_supported: [`api://${clientId}/mcp-access`],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/your-org/mcp-todo-app",
  });
});

// ── Start Server ───────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "80", 10);

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
