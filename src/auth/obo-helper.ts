import * as msal from "@azure/msal-node";

/**
 * On-Behalf-Of (OBO) helper using MSAL Node.
 *
 * Takes the incoming MCP access token (scoped to `api://{clientId}/mcp-access`)
 * and exchanges it for a downstream token (e.g., Microsoft Graph) using the
 * OBO flow. This avoids storing any user credentials or refresh tokens.
 *
 * @see https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow
 */

let ccaInstance: msal.ConfidentialClientApplication | null = null;

function getCca(): msal.ConfidentialClientApplication {
  if (ccaInstance) return ccaInstance;

  const clientId = process.env.ENTRA_CLIENT_ID;
  const clientSecret = process.env.ENTRA_CLIENT_SECRET;
  const tenantId = process.env.ENTRA_TENANT_ID;

  if (!clientId || !clientSecret || !tenantId) {
    throw new Error(
      "Missing ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, or ENTRA_TENANT_ID environment variables"
    );
  }

  ccaInstance = new msal.ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  });

  return ccaInstance;
}

export interface UserProfile {
  id: string;
  displayName: string;
  mail: string | null;
  userPrincipalName: string;
}

/**
 * Exchange the incoming MCP access token for a Microsoft Graph token via OBO,
 * then call /me to get the user's profile.
 */
export async function getUserProfile(incomingToken: string): Promise<UserProfile> {
  const cca = getCca();

  const oboResponse = await cca.acquireTokenOnBehalfOf({
    oboAssertion: incomingToken,
    scopes: ["https://graph.microsoft.com/User.Read"],
  });

  if (!oboResponse?.accessToken) {
    throw new Error("OBO token exchange failed — no access token returned");
  }

  const graphResponse = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${oboResponse.accessToken}` },
  });

  if (!graphResponse.ok) {
    const body = await graphResponse.text();
    throw new Error(`Graph API /me failed (${graphResponse.status}): ${body}`);
  }

  return (await graphResponse.json()) as UserProfile;
}

/**
 * Exchange the incoming MCP access token for a downstream API token via OBO.
 * Generic version for any downstream API scope.
 */
export async function acquireTokenOnBehalf(
  incomingToken: string,
  scopes: string[]
): Promise<string> {
  const cca = getCca();

  const oboResponse = await cca.acquireTokenOnBehalfOf({
    oboAssertion: incomingToken,
    scopes,
  });

  if (!oboResponse?.accessToken) {
    throw new Error("OBO token exchange failed — no access token returned");
  }

  return oboResponse.accessToken;
}
