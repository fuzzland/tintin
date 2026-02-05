import type { CloudGithubAppSection } from "../config.js";
import type { Db } from "../db.js";
import { getGithubMcpToken, listGithubInstallationsForIdentity } from "./store.js";
import { decryptSecret } from "./secrets.js";
import { ensureGithubAppTokenForInstallation } from "./githubApp.js";

/**
 * Resolve a GitHub token for the given identity.
 *
 * 1. Try the explicit `github_mcp_tokens` table (set via OAuth or manual command).
 * 2. Fall back to a GitHub App installation token if one is linked to the identity.
 * 3. Throw if neither source is available.
 */
export async function resolveGithubToken(opts: {
  db: Db;
  identityId: string;
  secretKey: string;
  githubAppConfig?: CloudGithubAppSection | null;
}): Promise<string> {
  const { db, identityId, secretKey, githubAppConfig } = opts;

  if (!secretKey) {
    throw new Error("cloud.secrets_key is required to use GitHub MCP tokens.");
  }

  // 1. Try explicit MCP token
  const row = await getGithubMcpToken(db, identityId);
  if (row?.encrypted_token) {
    return decryptSecret(row.encrypted_token, secretKey);
  }

  // 2. Fall back to GitHub App installation token
  if (githubAppConfig) {
    const installations = await listGithubInstallationsForIdentity(db, identityId);
    const active = installations.find((i) => i.status === "active");
    if (active) {
      const result = await ensureGithubAppTokenForInstallation({
        db,
        config: githubAppConfig,
        secretKey,
        installationId: active.installation_id,
      });
      return result.token;
    }
  }

  throw new Error('No GitHub token available. Connect GitHub or set token with "/mcp github token set <token>".');
}
