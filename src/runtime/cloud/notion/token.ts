import type { Db } from "../../db.js";
import type { Logger } from "../../log.js";
import { decryptSecret, encryptSecret } from "../secrets.js";
import { deleteNotionMcpToken, getNotionMcpClientById, getNotionMcpToken, upsertNotionMcpToken } from "../store.js";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

async function refreshNotionToken(opts: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  refreshToken: string;
}): Promise<any> {
  const params = new URLSearchParams();
  params.set("client_id", opts.clientId);
  if (opts.clientSecret) params.set("client_secret", opts.clientSecret);
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", opts.refreshToken);
  const res = await fetch(opts.tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion token refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as any;
}

export async function ensureNotionToken(opts: {
  db: Db;
  identityId: string;
  secretKey: string;
  logger?: Logger;
}): Promise<string> {
  const row = await getNotionMcpToken(opts.db, opts.identityId);
  if (!row) throw new Error("Notion MCP token is not set. Use /mcp notion connect.");
  const accessToken = decryptSecret(row.encrypted_access_token, opts.secretKey);
  const refreshToken = decryptSecret(row.encrypted_refresh_token, opts.secretKey);
  const expiresAt = row.expires_at ?? null;
  if (!expiresAt || Date.now() + REFRESH_MARGIN_MS < expiresAt) return accessToken;

  const client = await getNotionMcpClientById(opts.db, row.client_id);
  if (!client) throw new Error("Notion OAuth client not registered.");
  try {
    const token = await refreshNotionToken({
      tokenEndpoint: client.token_endpoint,
      clientId: client.client_id,
      clientSecret: client.client_secret || null,
      refreshToken,
    });
    const newAccess = String(token.access_token ?? "");
    const newRefresh = String(token.refresh_token ?? "");
    if (!newAccess || !newRefresh) throw new Error("Notion refresh response missing tokens");
    const expiresIn = typeof token.expires_in === "number" ? token.expires_in : null;
    const newExpiresAt = expiresIn ? Date.now() + expiresIn * 1000 : null;
    await upsertNotionMcpToken(opts.db, {
      identityId: opts.identityId,
      clientId: client.id,
      encryptedAccessToken: encryptSecret(newAccess, opts.secretKey),
      encryptedRefreshToken: encryptSecret(newRefresh, opts.secretKey),
      expiresAt: newExpiresAt,
      botId: typeof token.bot_id === "string" ? token.bot_id : row.bot_id ?? null,
      workspaceName: typeof token.workspace_name === "string" ? token.workspace_name : row.workspace_name ?? null,
      workspaceIcon: typeof token.workspace_icon === "string" ? token.workspace_icon : row.workspace_icon ?? null,
    });
    return newAccess;
  } catch (err) {
    opts.logger?.warn(`[notion][oauth] refresh failed identity=${opts.identityId}: ${String(err)}`);
    await deleteNotionMcpToken(opts.db, opts.identityId);
    throw err;
  }
}
