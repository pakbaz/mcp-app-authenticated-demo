import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import jwksRsa from "jwks-rsa";

/**
 * Auth info attached to the request after JWT validation.
 * Compatible with the MCP SDK's AuthInfo interface.
 */
export interface McpAuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  claims: {
    oid: string;            // User object ID (unique per tenant)
    name?: string;          // Display name
    preferred_username?: string; // UPN / email
    sub?: string;
    tid?: string;           // Tenant ID
  };
}

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      auth?: McpAuthInfo;
    }
  }
}

const tenantId = () => process.env.ENTRA_TENANT_ID || "common";
const clientId = () => process.env.ENTRA_CLIENT_ID || "";

/**
 * JWKS client for fetching Entra ID signing keys.
 */
const jwksClient = jwksRsa({
  jwksUri: `https://login.microsoftonline.com/${tenantId()}/discovery/v2.0/keys`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600_000, // 10 minutes
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

function getSigningKey(header: jwt.JwtHeader): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!header.kid) {
      return reject(new Error("JWT header missing 'kid'"));
    }
    jwksClient.getSigningKey(header.kid, (err, key) => {
      if (err) return reject(err);
      const signingKey = key?.getPublicKey();
      if (!signingKey) return reject(new Error("No signing key found"));
      resolve(signingKey);
    });
  });
}

/**
 * Express middleware that validates Entra ID Bearer tokens.
 *
 * On success: sets `req.auth` with the decoded claims and raw token.
 * On failure: returns 401 Unauthorized with WWW-Authenticate header,
 * which triggers the MCP client to start the OAuth authorization flow.
 *
 * The WWW-Authenticate header includes the PRM metadata URL so clients
 * can discover the OAuth proxy configuration automatically.
 */
export function validateJwt(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const base =
    process.env.MCP_SERVER_BASE_URL ||
    `http://localhost:${process.env.PORT || "8000"}`;

  // Return 401 if no Bearer token — this triggers the MCP auth flow
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`
      )
      .json({
        error: "unauthorized",
        message: "Bearer token required. Authenticate via the MCP authorization flow.",
      });
    return;
  }

  const token = authHeader.split(" ")[1];

  const verifyOptions: jwt.VerifyOptions = {
    audience: clientId(),
    issuer: `https://login.microsoftonline.com/${tenantId()}/v2.0`,
    algorithms: ["RS256"],
  };

  // Decode header to get kid
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === "string") {
    res.status(401).json({ error: "Invalid token format" });
    return;
  }

  getSigningKey(decoded.header)
    .then((signingKey) => {
      const payload = jwt.verify(token, signingKey, verifyOptions) as jwt.JwtPayload;

      req.auth = {
        token,
        clientId: payload.aud as string || clientId(),
        scopes: (payload.scp as string || "").split(" ").filter(Boolean),
        claims: {
          oid: payload.oid as string,
          name: payload.name as string | undefined,
          preferred_username: payload.preferred_username as string | undefined,
          sub: payload.sub as string | undefined,
          tid: payload.tid as string | undefined,
        },
      };

      next();
    })
    .catch((err) => {
      console.error("JWT validation failed:", err.message);
      res.status(401).json({ error: "Invalid or expired token" });
    });
}

/**
 * Permissive version of validateJwt for endpoints that should work
 * with OR without auth (e.g., GET /mcp for SSE / UI panel connections).
 * If a Bearer token is present it validates it; otherwise falls through.
 */
export function validateJwtOptional(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  // No token → fall through with req.auth = undefined
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    next();
    return;
  }

  // Token present → validate it the same way as the strict middleware
  const token = authHeader.split(" ")[1];

  const verifyOptions: jwt.VerifyOptions = {
    audience: clientId(),
    issuer: `https://login.microsoftonline.com/${tenantId()}/v2.0`,
    algorithms: ["RS256"],
  };

  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === "string") {
    // Bad token format → fall through unauthenticated
    next();
    return;
  }

  getSigningKey(decoded.header)
    .then((signingKey) => {
      const payload = jwt.verify(token, signingKey, verifyOptions) as jwt.JwtPayload;

      req.auth = {
        token,
        clientId: payload.aud as string || clientId(),
        scopes: (payload.scp as string || "").split(" ").filter(Boolean),
        claims: {
          oid: payload.oid as string,
          name: payload.name as string | undefined,
          preferred_username: payload.preferred_username as string | undefined,
          sub: payload.sub as string | undefined,
          tid: payload.tid as string | undefined,
        },
      };

      next();
    })
    .catch(() => {
      // Validation failed → fall through unauthenticated
      next();
    });
}

/**
 * Helper: extract the user ID (oid) from request auth.
 * Returns null if not authenticated.
 */
export function getUserId(req: Request): string | null {
  return req.auth?.claims?.oid ?? null;
}

/**
 * Helper: extract the display name from request auth.
 */
export function getUserDisplayName(req: Request): string | null {
  return req.auth?.claims?.name ?? null;
}
