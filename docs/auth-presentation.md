---
marp: true
theme: default
paginate: true
style: |
  section {
    font-family: 'Segoe UI', sans-serif;
    background: #f8f9fa;
    color: #1a1a2e;
  }
  section.title h1 { font-size: 2.2em; margin-bottom: 0.2em; }
  section.title p  { font-size: 1.1em; opacity: 0.9; }
  section.danger { background: #fdf0f0; border-left: 6px solid #d13438; }
  section.options { background: #f0f4ff; border-left: 6px solid #0078d4; }
  section.win { background: #f0faf0; border-left: 6px solid #107c10; }
  section.flow { background: #fffaf0; border-left: 6px solid #ff8c00; }
  h2 { color: #0078d4; }
  code { background: #e8f0fe; border-radius: 4px; padding: 2px 6px; }
  table { font-size: 0.85em; }
  th { background: #0078d4; color: white; }
  blockquote { border-left: 4px solid #0078d4; padding-left: 1em; color: #555; }
---

# 🔐 Authenticated MCP
## How this Todo App secures its MCP server
### with Microsoft Entra ID + OAuth Proxy + OBO Flow

---

<!-- What auth unlocks -->

## What Authenticated MCP Enables

```
Unauthenticated world          Authenticated world
──────────────────             ────────────────────────────────────
  Anyone calls tools           Only signed-in users call tools
  All users share data         Per-user data isolation (userId = oid)
  No downstream APIs           OBO flow → Graph, SharePoint, Cosmos
  No audit trail               Entra sign-in logs every call
```

### This demo app delivers all four ✅

- Validates every MCP request with a **signed Entra JWT**
- Scopes todos to the user's **Entra Object ID** (`oid`)
- Exchanges MCP tokens for **Graph API tokens** via OBO
- Every call is logged through **Application Insights**

<!--
Speaker notes:
- The `oid` claim is a stable, tenant-scoped user identifier — perfect as a database partition key.
- OBO (On-Behalf-Of) is what lets the server act on the user's behalf with other Microsoft APIs.
- Application Insights + Entra sign-in logs give you a full audit trail with zero extra code.
- This is the architecture you want for any MCP server that handles real user data.
-->

---

<!-- Options overview -->
<!-- _class: options -->

## Options for Authenticated MCP Servers

MCP auth is built on **OAuth 2.1**. Every MCP client is an OAuth client; every MCP server is a resource server.

| Approach | How it works | Entra supports? |
|---|---|---|
| **Pre-registered clients only** | Explicit app reg per MCP client | ✅ Yes — but inflexible |
| **Dynamic Client Registration (DCR)** | Auth server registers new clients on the fly (RFC 7591) | ❌ Not natively |
| **Client ID Metadata Documents (CIMD)** | Auth server fetches a metadata doc from the client | ❌ Not natively |

For **arbitrary MCP clients** (VS Code, Claude, bots ...), DCR or CIMD is required.
For **known clients only**, pre-registration works and is the production recommendation.

<!--
Speaker notes:
- The MCP authorization spec (2025-11-25) mandates OAuth 2.1 with PKCE.
- MCP clients like VS Code expect to register dynamically — they generate a fresh client_id the first time they meet a new server.
- Entra only supports pre-registered app registrations, so neither DCR nor CIMD work out of the box.
- If your server will only be used with VS Code (pre-known client), pre-registration is fine — and recommended for production.
- If you want *any* MCP client to be able to connect, you need DCR or CIMD bridging.
-->

---

<!-- OAuth Proxy architecture -->
<!-- _class: win -->

## The OAuth Proxy Pattern

The MCP server itself acts as the **OAuth authorization server**, proxying to Entra:

```
MCP Client          OAuth Proxy (this server)         Entra ID
──────────          ─────────────────────────         ────────
POST /register  →   Issue proxy client_id         
GET /authorize  →   Store PKCE₁, gen PKCE₂    →   /oauth2/v2.0/authorize
                                               ←   User signs in
GET /auth/callback  ←   Exchange code, store tokens ←
POST /token     →   Verify PKCE₁, return Entra tokens
POST /mcp       →   Validate JWT (JWKS)
                →   Call tools, OBO for Graph
```


<!--
Speaker notes:
- The proxy sits between the MCP client and Entra. From the client's perspective, the proxy *is* the authorization server.
- Dual PKCE is the clever part: the client generates PKCE₁ for its relationship with the proxy; the proxy generates a fresh PKCE₂ for its relationship with Entra. Both are S256.
- The proxy stores the Entra tokens in a session map (keyed by proxy_code) and returns a short-lived proxy_code to the client.
- When the client exchanges the proxy_code for tokens (POST /token), the proxy verifies PKCE₁ and returns the actual Entra JWT — so the client ends up holding a real Entra token.
- This real Entra token is what gets validated on every POST /mcp call.
-->

---

<!-- Full DCR flow walkthrough -->
<!-- _class: flow -->

## Full OAuth Flow: Step by Step

**Phase 1 — Discovery**
1. Client POSTs to `/mcp` → gets `401` + `WWW-Authenticate` header pointing to `/.well-known/oauth-protected-resource`
2. Client fetches PRM → finds `authorization_servers` and required `scopes`
3. Client fetches `/.well-known/oauth-authorization-server` → gets all endpoint URLs

**Phase 2 — Dynamic Client Registration**
4. `POST /register` → gets proxy `client_id`

**Phase 3 — Authorization Code + PKCE**
5. Client generates PKCE₁, GETs `/authorize?code_challenge=₁`
6. Proxy generates PKCE₂, redirects to Entra login
7. User signs in → Entra redirects to `/auth/callback`
8. Proxy exchanges code+PKCE₂ with Entra, stores tokens, issues `proxy_code` back to client

**Phase 4 — Token Exchange**
9. `POST /token` with `proxy_code` + `code_verifier₁` → proxy verifies, returns real **Entra JWT**

**Phase 5 — Authenticated MCP calls**
10. Every `POST /mcp` includes `Authorization: Bearer <Entra JWT>` — validated on each request

<!--
Speaker notes:
- This flow happens automatically in VS Code — the user just sees a browser sign-in window.
- Phases 1-4 happen once per new server. After that, VS Code silently refreshes tokens.
- The 401 in step 1 is intentional — it's the MCP spec's mechanism for triggering the auth flow. The WWW-Authenticate header is the key discovery signal.
- PKCE (S256) prevents authorization code interception attacks — both legs are protected.
- After step 9, the client holds a genuine Entra-signed JWT. The proxy is no longer in the loop for MCP calls — it only validates the token.
-->

---

<!-- JWT validation -->

## JWT Validation on Every MCP Request

`src/auth/validate-jwt.ts` — middleware that protects the `/mcp` endpoint:

```typescript
// 1. Extract Bearer token from Authorization header
// 2. Fetch Entra's JWKS (cached) to get public signing keys
// 3. Verify: issuer, audience, signature (RS256), expiry
// 4. Attach user claims to req.auth

Expected claims:
  iss  = https://login.microsoftonline.com/{tenantId}/v2.0
  aud  = api://{CLIENT_ID}
  scp  = mcp-access
  oid  = <user's stable Entra Object ID>
```

**If the token is missing or invalid:**
```
HTTP 401
WWW-Authenticate: Bearer resource_metadata="/.well-known/oauth-protected-resource"
```
→ This header triggers VS Code to restart the OAuth flow automatically.

<!--
Speaker notes:
- JWKS caching is important: fetching the public keys on every request would be slow and rate-limited. The middleware caches the JWKS response.
- The audience check (aud = api://CLIENT_ID) is critical — it prevents token confusion attacks where a token issued for one API is replayed against another.
- The scp (scope) check ensures the token was specifically issued for MCP access, not just any Entra token for this app.
- The oid claim is the most important one for the application — it's the stable, unique identifier used as the database partition key for per-user data isolation.
-->

---

<!-- OBO flow -->
<!-- _class: win -->

## On-Behalf-Of (OBO): Calling Graph API as the User

The `get_user_info` tool needs to call **Microsoft Graph** — but the incoming token is scoped to `api://CLIENT_ID`, not Graph.

**OBO Flow in `src/auth/obo-helper.ts`:**

```
Incoming MCP token  →  Entra Token Service  →  Graph token
  aud: api://CLIENT_ID    (OBO exchange)         aud: graph.microsoft.com
  scp: mcp-access                                scp: User.Read
```

MSAL Node handles the exchange:
```typescript
const result = await confidentialClient.acquireTokenOnBehalfOf({
  oboAssertion: incomingAccessToken,   // the user's MCP token
  scopes: ['https://graph.microsoft.com/User.Read'],
});
// result.accessToken → call Graph /v1.0/me
```

**Admin consent** is granted at deployment time — no user consent dialog needed for OBO.

<!--
Speaker notes:
- OBO is defined in RFC 7523 and supported natively by Entra. MSAL abstracts away all the HTTP details.
- The server uses a ConfidentialClientApplication — it needs a client secret (or certificate) to prove it's allowed to exchange tokens.
- Admin consent is required because the OBO scopes (User.Read) need to be pre-approved for the service principal.
- Without admin consent, Entra would require each user to consent to Graph access during the initial login — which isn't possible here since the MCP client drives the auth flow, not the server.
- You can extend OBO to other APIs: OneDrive, SharePoint, Azure DevOps — anything accessible via Graph or other Entra-registered APIs.
-->

---

<!-- Per-user isolation -->

## Per-User Data Isolation

Every tool call carries the user's `oid` claim — used as the **Cosmos DB partition key**:

```typescript
// After JWT validation, req.auth is set:
const userId = req.auth.oid;   // e.g. "a3b2c1d0-..."

// All store operations are scoped to this user:
await todoStore.listTodos(userId);
await todoStore.addTodo(userId, { title, description });
await todoStore.deleteTodo(userId, todoId);
```

**What users see:** Only their own todos — even if they share the same Cosmos DB container.

**What attackers can't do:** Read another user's todos, even with a valid token for a different user.

```
Container: todos
  └── partition: "user-oid-alice"   → Alice's todos only
  └── partition: "user-oid-bob"     → Bob's todos only
```

<!--
Speaker notes:
- The oid (object identifier) is issued by Entra and is stable across sessions — it's the right key to use for multi-tenant data stores.
- Using oid (not sub or email) is important: email can change, sub can vary by client, but oid is stable for the lifetime of the Entra account.
- Cosmos DB's partition key model makes this isolation nearly free — no JOIN queries, no WHERE clauses; the partition boundary IS the security boundary.
- The fallback in-memory store also uses userId as the map key, so the isolation model works identically for local development.
-->

---

## Security Properties Summary

| Property | How it's enforced |
|---|---|
| **No unauthenticated access** | JWT validation middleware on every `/mcp` request |
| **No stored passwords** | Server only handles Entra-signed JWTs; user credentials never touch the server |
| **Per-user isolation** | All data scoped to `oid` claim from validated JWT |
| **Minimal permissions** | OBO tokens scoped to `User.Read` only |
| **PKCE everywhere** | S256 PKCE on both client↔proxy and proxy↔Entra legs |
| **Token confusion prevention** | `aud` and `iss` validated on every request |
| **Sandboxed UI** | HTML panel in a CSP-restricted iframe; no external network calls |
| **Audit trail** | Entra sign-in logs + Application Insights |

> "No stored credentials — the server uses Entra tokens; user passwords never touch the server."

<!--
Speaker notes:
- This table is a useful checklist for security reviews. Each row maps to a specific piece of code.
- PKCE prevents authorization code interception — critical for public clients (VS Code) that can't keep secrets.
- The sandboxed UI is important: the ext-apps SDK is inlined specifically to avoid loading external scripts, which would violate VS Code's Content Security Policy.
- Application Insights captures every tool call with the user's oid, giving you a complete audit trail without any extra logging code.
- In production, consider also adding token revocation checking (CAE — Continuous Access Evaluation) so that revoked tokens are rejected mid-session.
-->

---
<!-- _class: title -->

## Summary

```
MCP Client  →  401 + discovery  →  OAuth Proxy  →  Entra sign-in
           ←  proxy code        ←  stores tokens   ←
           →  POST /token (PKCE verify)  →  Entra JWT
           →  POST /mcp (Bearer JWT)  →  validate → tools
                                                  ↓
                                            OBO → Graph API
                                            oid  → Cosmos DB
```

**Three big ideas:**
1. **DCR Proxy** — bridges Entra's pre-registration model with MCP's dynamic-client world
2. **JWT validation** — every request validated against Entra's JWKS; `oid` scopes all data
3. **OBO Flow** — lets the server call Graph and other APIs on behalf of the signed-in user

**Resources:**
- [MCP Auth Spec](https://spec.modelcontextprotocol.io/) · [RFC 7591 DCR](https://datatracker.ietf.org/doc/html/rfc7591) · [Entra OBO Flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow)
- [Tech Community Blog — OBO for Entra MCP Servers](https://techcommunity.microsoft.com/blog/azuredevcommunityblog/using-on-behalf-of-flow-for-entra-based-mcp-servers/4486760)

<!--
Speaker notes:
- The proxy pattern is the key insight of this app. Without it, you'd have to pre-register every MCP client (VS Code, Claude Desktop, etc.) in Entra manually.
- The three ideas build on each other: DCR gets the client in the door; JWT validation keeps the door locked on every subsequent call; OBO lets the server act on the user's behalf beyond the MCP boundary.
- Watch for Entra to add CIMD support — when that lands, the proxy pattern for DCR becomes optional for clients that publish their own CIMD documents.
- For production deployments today: use pre-registered clients + direct Entra validation (no proxy needed). The proxy is a dev/test convenience.
-->
