import crypto from "node:crypto";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db.js";
import type { Logger } from "../../log.js";
import { consumeOAuthState, createOAuthState } from "../store.js";
import { encryptSecret } from "../secrets.js";
import { generateCodeChallenge, generateCodeVerifier } from "../oauth.js";
import { getLatestNotionMcpClient, getNotionMcpClientByClientId, upsertNotionMcpToken } from "../store.js";
import { getOrRegisterNotionClient } from "./registration.js";

function buildAuthorizeUrl(opts: {
  authorizeEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string[];
}): string {
  const params = new URLSearchParams();
  params.set("client_id", opts.clientId);
  params.set("redirect_uri", opts.redirectUri);
  params.set("response_type", "code");
  params.set("state", opts.state);
  if (opts.scopes && opts.scopes.length > 0) params.set("scope", opts.scopes.join(" "));
  params.set("code_challenge", opts.codeChallenge);
  params.set("code_challenge_method", "S256");
  return `${opts.authorizeEndpoint}?${params.toString()}`;
}

async function exchangeToken(opts: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<any> {
  const params = new URLSearchParams();
  params.set("client_id", opts.clientId);
  if (opts.clientSecret) params.set("client_secret", opts.clientSecret);
  params.set("code", opts.code);
  params.set("grant_type", "authorization_code");
  params.set("redirect_uri", opts.redirectUri);
  params.set("code_verifier", opts.codeVerifier);
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
    throw new Error(`Notion token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as any;
}

export async function startNotionFlow(opts: {
  db: Db;
  config: AppConfig;
  identityId: string;
  metadataJson?: string | null;
  logger?: Logger;
}): Promise<{ authorizeUrl: string }> {
  const cloud = opts.config.cloud;
  if (!cloud?.enabled) throw new Error("Cloud mode is required for Notion OAuth.");
  if (!cloud.public_base_url) throw new Error("cloud.public_base_url is required for Notion OAuth.");
  if (!cloud.oauth?.callback_path) throw new Error("cloud.oauth.callback_path is required for Notion OAuth.");
  const redirectUri = `${cloud.public_base_url}${cloud.oauth.callback_path}?provider=notion`;
  opts.logger?.info(`[notion][oauth] start identity=${opts.identityId} redirect=${redirectUri}`);
  const client = await getOrRegisterNotionClient({ db: opts.db, redirectUri, logger: opts.logger });
  const state = crypto.randomBytes(24).toString("base64url");
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  let metadata: Record<string, unknown> = {};
  if (opts.metadataJson) {
    try {
      metadata = JSON.parse(opts.metadataJson) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  metadata.notion_client_id = client.clientId;
  await createOAuthState(opts.db, {
    provider: "notion",
    state,
    codeVerifier: verifier,
    redirectUrl: redirectUri,
    identityId: opts.identityId,
    metadataJson: JSON.stringify(metadata),
    ttlMs: 10 * 60 * 1000,
  });
  opts.logger?.info(
    `[notion][oauth] state saved identity=${opts.identityId} client_id=${client.clientId} redirect=${redirectUri}`,
  );
  return {
    authorizeUrl: buildAuthorizeUrl({
      authorizeEndpoint: client.authEndpoint,
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
    }),
  };
}

export async function handleNotionCallback(opts: {
  db: Db;
  config: AppConfig;
  code: string;
  state: string;
  logger?: Logger;
}): Promise<{ identityId: string; provider: "notion"; metadataJson: string | null }> {
  const saved = await consumeOAuthState(opts.db, "notion", opts.state);
  if (!saved) throw new Error("Invalid or expired OAuth state");
  let client = null;
  let metadata: Record<string, unknown> | null = null;
  if (saved.metadata_json) {
    try {
      metadata = JSON.parse(saved.metadata_json) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  const notionClientId = metadata && typeof metadata.notion_client_id === "string" ? metadata.notion_client_id : "";
  client = notionClientId ? await getNotionMcpClientByClientId(opts.db, notionClientId) : null;
  if (!client) client = await getLatestNotionMcpClient(opts.db);
  if (!client) throw new Error("Notion OAuth client not registered");
  opts.logger?.info(
    `[notion][oauth] callback state ok identity=${saved.identity_id ?? "-"} client_id=${client.client_id}`,
  );
  const token = await exchangeToken({
    tokenEndpoint: client.token_endpoint,
    clientId: client.client_id,
    clientSecret: client.client_secret || null,
    redirectUri: saved.redirect_url,
    code: opts.code,
    codeVerifier: saved.code_verifier,
  });
  const tokenSummary = {
    hasAccessToken: typeof token.access_token === "string" && token.access_token.length > 0,
    hasRefreshToken: typeof token.refresh_token === "string" && token.refresh_token.length > 0,
    expiresIn: typeof token.expires_in === "number" ? token.expires_in : null,
    botId: typeof token.bot_id === "string" ? token.bot_id : null,
    workspaceId: typeof token.workspace_id === "string" ? token.workspace_id : null,
    workspaceName: typeof token.workspace_name === "string" ? token.workspace_name : null,
  };
  opts.logger?.info(`[notion][oauth] token received ${JSON.stringify(tokenSummary)}`);
  const identityId = saved.identity_id;
  if (!identityId) throw new Error("OAuth state missing identity");
  const secretKey = opts.config.cloud?.secrets_key ?? "";
  const accessToken = String(token.access_token ?? "");
  const refreshToken = String(token.refresh_token ?? "");
  if (!accessToken || !refreshToken) {
    throw new Error("Notion OAuth missing access/refresh token");
  }
  const expiresIn = typeof token.expires_in === "number" ? token.expires_in : null;
  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : null;
  await upsertNotionMcpToken(opts.db, {
    identityId,
    clientId: client.id,
    encryptedAccessToken: encryptSecret(accessToken, secretKey),
    encryptedRefreshToken: encryptSecret(refreshToken, secretKey),
    expiresAt,
    botId: typeof token.bot_id === "string" ? token.bot_id : null,
    workspaceName: typeof token.workspace_name === "string" ? token.workspace_name : null,
    workspaceIcon: typeof token.workspace_icon === "string" ? token.workspace_icon : null,
  });
  return { identityId, provider: "notion", metadataJson: saved.metadata_json ?? null };
}
