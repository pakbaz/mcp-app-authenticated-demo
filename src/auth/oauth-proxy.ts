import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import express from "express";

/**
 * OAuth Proxy for MCP Authorization with Microsoft Entra ID.
 *
 * Since Entra doesn't support Dynamic Client Registration (DCR), this proxy
 * bridges the gap: MCP clients (like VS Code) register via DCR with this proxy,
 * and the proxy handles all OAuth interactions with Entra using the server's
 * pre-registered app credentials.
 *
 * Flow:
 *   1. MCP client discovers PRM → finds this proxy as the authorization server
 *   2. MCP client registers via POST /register → gets a client_id
 *   3. MCP client redirects user to GET /authorize → proxy redirects to Entra
 *   4. Entra redirects back to GET /auth/callback → proxy exchanges code
 *   5. Proxy redirects to MCP client's redirect_uri with a new auth code
 *   6. MCP client exchanges code at POST /token → proxy returns Entra tokens
 *
 * @see https://techcommunity.microsoft.com/blog/azuredevcommunityblog/using-on-behalf-of-flow-for-entra-based-mcp-servers/4486760
 * @see https://gofastmcp.com/servers/auth/oauth-proxy
 */

// ── Configuration helpers ──────────────────────────────────────────────

const entraClientId = () => process.env.ENTRA_CLIENT_ID || "";
const entraClientSecret = () => process.env.ENTRA_CLIENT_SECRET || "";
const entraTenantId = () => process.env.ENTRA_TENANT_ID || "common";
const baseUrl = () =>
  process.env.MCP_SERVER_BASE_URL ||
  `http://localhost:${process.env.PORT || "8000"}`;

const entraAuthority = () =>
  `https://login.microsoftonline.com/${entraTenantId()}`;

// ── In-memory stores (dev only — use persistent storage for production) ─

interface ClientRegistration {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  created_at: number;
}

interface AuthTransaction {
  clientId: string;
  clientRedirectUri: string;
  clientState: string;
  clientCodeChallenge: string;
  clientCodeChallengeMethod: string;
  proxyCodeVerifier: string;
  requestedScope: string;
  createdAt: number;
}

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope: string;
  clientCodeChallenge: string;
  clientCodeChallengeMethod: string;
  createdAt: number;
}

const clientRegistrations = new Map<string, ClientRegistration>();
const authTransactions = new Map<string, AuthTransaction>();
const authCodes = new Map<string, StoredTokens>();

// Clean up expired entries periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  const TRANSACTION_TTL = 10 * 60 * 1000; // 10 minutes
  const CODE_TTL = 5 * 60 * 1000; // 5 minutes

  for (const [key, tx] of authTransactions) {
    if (now - tx.createdAt > TRANSACTION_TTL) authTransactions.delete(key);
  }
  for (const [key, code] of authCodes) {
    if (now - code.createdAt > CODE_TTL) authCodes.delete(key);
  }
}, 5 * 60 * 1000);

// ── Router ─────────────────────────────────────────────────────────────

const router = Router();

// Parse URL-encoded bodies for the /token endpoint
router.use(express.urlencoded({ extended: true }));

// ── Authorization Server Metadata (RFC 8414) ───────────────────────────
// MCP clients fetch this to discover OAuth endpoints.

router.get("/.well-known/oauth-authorization-server", (_req, res) => {
  const base = baseUrl();
  const clientId = entraClientId();

  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_post",
    ],
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: [`api://${clientId}/mcp-access`],
    service_documentation: `${base}/.well-known/oauth-protected-resource`,
  });
});

// ── Dynamic Client Registration (RFC 7591) ─────────────────────────────
// MCP clients call this to register and obtain a client_id.

router.post("/register", (req: Request, res: Response) => {
  const clientId = crypto.randomUUID();

  const registration: ClientRegistration = {
    client_id: clientId,
    client_name: req.body.client_name || "MCP Client",
    redirect_uris: req.body.redirect_uris || [],
    grant_types: req.body.grant_types || [
      "authorization_code",
      "refresh_token",
    ],
    response_types: req.body.response_types || ["code"],
    token_endpoint_auth_method:
      req.body.token_endpoint_auth_method || "none",
    created_at: Date.now(),
  };

  clientRegistrations.set(clientId, registration);

  console.log(
    `📝 Client registered: ${registration.client_name} (${clientId}), redirect_uris: ${registration.redirect_uris.join(", ")}`
  );

  res.status(201).json({
    client_id: registration.client_id,
    client_name: registration.client_name,
    redirect_uris: registration.redirect_uris,
    grant_types: registration.grant_types,
    response_types: registration.response_types,
    token_endpoint_auth_method: registration.token_endpoint_auth_method,
  });
});

// ── Authorization Endpoint ─────────────────────────────────────────────
// MCP client redirects the user here. We redirect to Entra.

router.get("/authorize", (req: Request, res: Response) => {
  const {
    client_id,
    redirect_uri,
    scope,
    state,
    code_challenge,
    code_challenge_method,
    response_type,
  } = req.query as Record<string, string>;

  if (response_type !== "code") {
    res.status(400).json({
      error: "unsupported_response_type",
      error_description: "Only 'code' response type is supported",
    });
    return;
  }

  // Generate proxy state to link this transaction
  const proxyState = crypto.randomUUID();

  // Generate our own PKCE code verifier for the Entra request
  const proxyCodeVerifier = crypto.randomBytes(32).toString("base64url");
  const proxyCodeChallenge = crypto
    .createHash("sha256")
    .update(proxyCodeVerifier)
    .digest("base64url");

  // Store the transaction so we can map Entra's callback back to the client
  const transaction: AuthTransaction = {
    clientId: client_id,
    clientRedirectUri: redirect_uri,
    clientState: state,
    clientCodeChallenge: code_challenge || "",
    clientCodeChallengeMethod: code_challenge_method || "S256",
    proxyCodeVerifier,
    requestedScope: scope || "",
    createdAt: Date.now(),
  };
  authTransactions.set(proxyState, transaction);

  // Build the Entra authorize URL
  const entraAuthUrl = new URL(
    `${entraAuthority()}/oauth2/v2.0/authorize`
  );
  entraAuthUrl.searchParams.set("client_id", entraClientId());
  entraAuthUrl.searchParams.set("response_type", "code");
  entraAuthUrl.searchParams.set(
    "redirect_uri",
    `${baseUrl()}/auth/callback`
  );

  // Request our API scope + standard OIDC scopes
  const entraScopes = [
    `api://${entraClientId()}/mcp-access`,
    "openid",
    "profile",
    "email",
    "offline_access",
  ].join(" ");
  entraAuthUrl.searchParams.set("scope", entraScopes);
  entraAuthUrl.searchParams.set("state", proxyState);
  entraAuthUrl.searchParams.set("code_challenge", proxyCodeChallenge);
  entraAuthUrl.searchParams.set("code_challenge_method", "S256");

  console.log(`🔐 Redirecting to Entra for authorization (client: ${client_id})`);
  res.redirect(entraAuthUrl.toString());
});

// ── OAuth Callback (from Entra) ────────────────────────────────────────
// Entra redirects here after user authenticates. We exchange the code
// with Entra, then redirect to the MCP client with a new proxy code.

router.get("/auth/callback", async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query as Record<
    string,
    string
  >;

  if (error) {
    console.error(`❌ Entra auth error: ${error} — ${error_description}`);
    res.status(400).json({ error, error_description });
    return;
  }

  // Look up the original transaction
  const transaction = authTransactions.get(state);
  if (!transaction) {
    res.status(400).json({
      error: "invalid_state",
      error_description:
        "Unknown or expired state parameter. Please try again.",
    });
    return;
  }
  authTransactions.delete(state);

  try {
    // Exchange the authorization code with Entra for tokens
    const tokenResponse = await fetch(
      `${entraAuthority()}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: entraClientId(),
          client_secret: entraClientSecret(),
          code,
          redirect_uri: `${baseUrl()}/auth/callback`,
          grant_type: "authorization_code",
          code_verifier: transaction.proxyCodeVerifier,
        }),
      }
    );

    const tokenData = (await tokenResponse.json()) as Record<string, unknown>;

    if (tokenData.error) {
      console.error("❌ Entra token exchange failed:", tokenData);
      res.status(400).json(tokenData);
      return;
    }

    // Generate a new authorization code for the MCP client
    const proxyCode = crypto.randomUUID();
    authCodes.set(proxyCode, {
      accessToken: tokenData.access_token as string,
      refreshToken: tokenData.refresh_token as string | undefined,
      expiresIn: tokenData.expires_in as number,
      scope: tokenData.scope as string,
      clientCodeChallenge: transaction.clientCodeChallenge,
      clientCodeChallengeMethod: transaction.clientCodeChallengeMethod,
      createdAt: Date.now(),
    });

    // Redirect to the MCP client's redirect_uri with the proxy code
    const clientRedirect = new URL(transaction.clientRedirectUri);
    clientRedirect.searchParams.set("code", proxyCode);
    if (transaction.clientState) {
      clientRedirect.searchParams.set("state", transaction.clientState);
    }

    console.log(
      `✅ Auth successful — redirecting to MCP client (${transaction.clientId})`
    );
    res.redirect(clientRedirect.toString());
  } catch (err) {
    console.error("❌ Token exchange error:", err);
    res.status(500).json({
      error: "server_error",
      error_description: "Failed to exchange authorization code",
    });
  }
});

// ── Token Endpoint ─────────────────────────────────────────────────────
// MCP client exchanges its proxy code for tokens, or refreshes tokens.

router.post("/token", async (req: Request, res: Response) => {
  const {
    grant_type,
    code,
    redirect_uri,
    client_id,
    code_verifier,
    refresh_token,
  } = req.body;

  // ── Authorization Code Grant ──────────────────────────────────────

  if (grant_type === "authorization_code") {
    const stored = authCodes.get(code);
    if (!stored) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "Invalid or expired authorization code",
      });
      return;
    }
    authCodes.delete(code);

    // Validate client's PKCE
    if (stored.clientCodeChallenge && code_verifier) {
      let expectedChallenge: string;
      if (stored.clientCodeChallengeMethod === "S256") {
        expectedChallenge = crypto
          .createHash("sha256")
          .update(code_verifier)
          .digest("base64url");
      } else {
        expectedChallenge = code_verifier; // plain
      }

      if (expectedChallenge !== stored.clientCodeChallenge) {
        res.status(400).json({
          error: "invalid_grant",
          error_description: "PKCE verification failed",
        });
        return;
      }
    }

    console.log(`🎟️ Token issued to client ${client_id}`);

    res.json({
      access_token: stored.accessToken,
      token_type: "Bearer",
      expires_in: stored.expiresIn,
      refresh_token: stored.refreshToken,
      scope: stored.scope,
    });
    return;
  }

  // ── Refresh Token Grant ───────────────────────────────────────────

  if (grant_type === "refresh_token") {
    if (!refresh_token) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "Missing refresh_token",
      });
      return;
    }

    try {
      // Proxy the refresh to Entra
      const tokenResponse = await fetch(
        `${entraAuthority()}/oauth2/v2.0/token`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: entraClientId(),
            client_secret: entraClientSecret(),
            refresh_token,
            grant_type: "refresh_token",
            scope: `api://${entraClientId()}/mcp-access openid profile email offline_access`,
          }),
        }
      );

      const tokenData = (await tokenResponse.json()) as Record<
        string,
        unknown
      >;

      if (tokenData.error) {
        console.error("❌ Token refresh failed:", tokenData);
        res.status(400).json(tokenData);
        return;
      }

      console.log(`🔄 Token refreshed for client ${client_id}`);

      res.json({
        access_token: tokenData.access_token,
        token_type: "Bearer",
        expires_in: tokenData.expires_in,
        refresh_token: tokenData.refresh_token,
        scope: tokenData.scope,
      });
    } catch (err) {
      console.error("❌ Refresh error:", err);
      res.status(500).json({
        error: "server_error",
        error_description: "Failed to refresh token",
      });
    }
    return;
  }

  res.status(400).json({
    error: "unsupported_grant_type",
    error_description: `Grant type '${grant_type}' is not supported`,
  });
});

// ── Token Revocation (RFC 7009) ────────────────────────────────────────

router.post("/revoke", (_req: Request, res: Response) => {
  // Accept revocation requests gracefully (no-op for simplicity)
  res.status(200).json({});
});

export { router as oauthProxyRouter };
