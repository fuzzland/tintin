import crypto from "node:crypto";
import { URLSearchParams } from "node:url";
import type { AppConfig, ChatgptOAuthSection } from "../config.js";
import type { Db } from "../db.js";
import { decryptSecret, encryptSecret } from "../cloud/secrets.js";
import { nowMs } from "../util.js";
import {
  consumeChatgptOAuthState,
  deleteChatgptAccount,
  getChatgptAccount,
  getChatgptOAuthStateForIdentity,
  replaceChatgptOAuthState,
  upsertChatgptAccount,
} from "./store.js";

const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const SCOPE = "openid profile email offline_access";
const STATE_BYTES = 16;
const PKCE_VERIFIER_BYTES = 32;
const STATE_TTL_MS = 10 * 60 * 1000;
export const CHATGPT_AUTH_ERROR_PREFIX = "ChatGPT auth missing or expired";

export interface ChatgptAccount {
  identityId: string;
  chatgptUserId: string;
  email: string | null;
  workspaceId: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string | null;
}

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(crypto.randomBytes(PKCE_VERIFIER_BYTES));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function createState(): string {
  return base64Url(crypto.randomBytes(STATE_BYTES));
}

function requireChatgptConfig(config: AppConfig): ChatgptOAuthSection {
  const cfg = config.chatgpt_oauth;
  if (!cfg) throw new Error("ChatGPT OAuth is not configured");
  return cfg;
}

function requireSecretsKey(config: AppConfig): string {
  const key = config.cloud?.secrets_key ?? "";
  if (!key) throw new Error("cloud.secrets_key is required for ChatGPT OAuth");
  return key;
}

function buildAuthorizeUrl(cfg: ChatgptOAuthSection, opts: { state: string; codeChallenge: string }): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", cfg.redirect_uri);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", opts.state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");
  return url.toString();
}

async function exchangeCodeForTokens(cfg: ChatgptOAuthSection, opts: {
  code: string;
  codeVerifier: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; scope: string | null }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: opts.code,
      code_verifier: opts.codeVerifier,
      redirect_uri: cfg.redirect_uri,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ChatGPT OAuth token exchange failed (${res.status}): ${text || "no body"}`);
  }
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("ChatGPT OAuth token response missing required fields");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: nowMs() + json.expires_in * 1000,
    scope: json.scope ?? null,
  };
}

async function refreshTokens(cfg: ChatgptOAuthSection, refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string | null;
}> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ChatGPT OAuth refresh failed (${res.status}): ${text || "no body"}`);
  }
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("ChatGPT OAuth refresh response missing required fields");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: nowMs() + json.expires_in * 1000,
    scope: json.scope ?? null,
  };
}

function decodeJwt(token: string): Record<string, any> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1]!;
    const json = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, any>;
  } catch {
    return null;
  }
}

function extractChatgptClaims(accessToken: string): { chatgptUserId: string; workspaceId: string | null; email: string | null } {
  const payload = decodeJwt(accessToken);
  if (!payload) throw new Error("Invalid ChatGPT access token (unable to decode JWT)");
  const authClaims = (payload as any)[JWT_CLAIM_PATH] as Record<string, any> | undefined;
  const chatgptUserId = (authClaims as any)?.chatgpt_account_id || (authClaims as any)?.account_id || null;
  if (!chatgptUserId || typeof chatgptUserId !== "string") {
    throw new Error("ChatGPT access token missing chatgpt_account_id");
  }
  const workspaceId = typeof (authClaims as any)?.workspace_id === "string" ? (authClaims as any).workspace_id : null;
  const email = typeof (payload as any)?.email === "string" ? (payload as any).email : null;
  return { chatgptUserId, workspaceId, email };
}

export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = (input ?? "").trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    /* ignore */
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
  }
  return { code: value };
}

export async function startChatgptOAuth(opts: {
  db: Db;
  config: AppConfig;
  identityId: string;
  metadataJson?: string | null;
}): Promise<{ authorizeUrl: string; state: string }> {
  const cfg = requireChatgptConfig(opts.config);
  const pkce = generatePkcePair();
  const state = createState();
  await replaceChatgptOAuthState(opts.db, {
    identityId: opts.identityId,
    state,
    codeVerifier: pkce.verifier,
    redirectUri: cfg.redirect_uri,
    metadataJson: opts.metadataJson ?? null,
    ttlMs: STATE_TTL_MS,
  });
  return { authorizeUrl: buildAuthorizeUrl(cfg, { state, codeChallenge: pkce.challenge }), state };
}

export async function completeChatgptOAuth(opts: {
  db: Db;
  config: AppConfig;
  code: string;
  state: string;
  expectedIdentityId?: string;
  logger?: { warn: (msg: string, err?: unknown) => void; error: (msg: string, err?: unknown) => void };
}): Promise<ChatgptAccount & { metadataJson: string | null }> {
  const cfg = requireChatgptConfig(opts.config);
  const secretsKey = requireSecretsKey(opts.config);
  const saved = await consumeChatgptOAuthState(opts.db, opts.state);
  if (!saved) throw new Error("Invalid or expired ChatGPT OAuth state");
  if (opts.expectedIdentityId && saved.identity_id !== opts.expectedIdentityId) {
    throw new Error("ChatGPT OAuth state does not belong to this user");
  }
  const token = await exchangeCodeForTokens(cfg, { code: opts.code, codeVerifier: saved.code_verifier });
  const claims = extractChatgptClaims(token.accessToken);
  const encryptedAccess = encryptSecret(token.accessToken, secretsKey);
  const encryptedRefresh = encryptSecret(token.refreshToken, secretsKey);
  const accountRow = await upsertChatgptAccount(opts.db, {
    identityId: saved.identity_id,
    chatgptUserId: claims.chatgptUserId,
    email: claims.email,
    accessToken: encryptedAccess,
    refreshToken: encryptedRefresh,
    expiresAt: token.expiresAt,
    scope: token.scope,
    workspaceId: claims.workspaceId,
  });
  return {
    identityId: saved.identity_id,
    chatgptUserId: accountRow!.chatgpt_user_id,
    email: accountRow!.email,
    workspaceId: accountRow!.workspace_id,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    scope: token.scope,
    metadataJson: saved.metadata_json ?? null,
  };
}

export async function getChatgptAccountForIdentity(opts: {
  db: Db;
  config: AppConfig;
  identityId: string;
}): Promise<ChatgptAccount | null> {
  const cfg = requireChatgptConfig(opts.config);
  const secretsKey = requireSecretsKey(opts.config);
  const row = await getChatgptAccount(opts.db, opts.identityId);
  if (!row) return null;
  try {
    const accessToken = decryptSecret(row.access_token, secretsKey);
    const refreshToken = decryptSecret(row.refresh_token, secretsKey);
    const account: ChatgptAccount = {
      identityId: row.identity_id,
      chatgptUserId: row.chatgpt_user_id,
      email: row.email,
      workspaceId: row.workspace_id,
      accessToken,
      refreshToken,
      expiresAt: row.expires_at,
      scope: row.scope,
    };
    if (account.expiresAt <= nowMs() + cfg.refresh_margin_ms) {
      return await refreshChatgptAccount(opts);
    }
    return account;
  } catch (e) {
    throw new Error(`Failed to decrypt ChatGPT tokens: ${String(e)}`);
  }
}

export async function revokeChatgptAccount(opts: { db: Db; identityId: string }): Promise<void> {
  await deleteChatgptAccount(opts.db, opts.identityId);
  await opts.db.deleteFrom("chatgpt_oauth_states").where("identity_id", "=", opts.identityId).execute();
}

export async function refreshChatgptAccount(opts: {
  db: Db;
  config: AppConfig;
  identityId: string;
}): Promise<ChatgptAccount | null> {
  const cfg = requireChatgptConfig(opts.config);
  const secretsKey = requireSecretsKey(opts.config);
  const row = await getChatgptAccount(opts.db, opts.identityId);
  if (!row) return null;
  const existing: ChatgptAccount = {
    identityId: row.identity_id,
    chatgptUserId: row.chatgpt_user_id,
    email: row.email,
    workspaceId: row.workspace_id,
    accessToken: decryptSecret(row.access_token, secretsKey),
    refreshToken: decryptSecret(row.refresh_token, secretsKey),
    expiresAt: row.expires_at,
    scope: row.scope,
  };
  if (existing.expiresAt > nowMs() + cfg.refresh_margin_ms) return existing;
  try {
    const next = await refreshTokens(cfg, existing.refreshToken);
    const claims = extractChatgptClaims(next.accessToken);
    const encryptedAccess = encryptSecret(next.accessToken, secretsKey);
    const encryptedRefresh = encryptSecret(next.refreshToken, secretsKey);
    await upsertChatgptAccount(opts.db, {
      identityId: existing.identityId,
      chatgptUserId: claims.chatgptUserId,
      email: claims.email,
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
      expiresAt: next.expiresAt,
      scope: next.scope ?? existing.scope,
      workspaceId: claims.workspaceId,
    });
    return {
      identityId: existing.identityId,
      chatgptUserId: claims.chatgptUserId,
      email: claims.email,
      workspaceId: claims.workspaceId,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAt: next.expiresAt,
      scope: next.scope ?? existing.scope,
    };
  } catch (e) {
    await deleteChatgptAccount(opts.db, opts.identityId);
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`${CHATGPT_AUTH_ERROR_PREFIX}: ${reason}`);
  }
}

export async function persistChatgptProxyTokens(opts: {
  db: Db;
  config: AppConfig;
  identityId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string | null;
  expectedAccountId?: string | null;
}): Promise<void> {
  const cfg = requireChatgptConfig(opts.config);
  const secretsKey = requireSecretsKey(opts.config);
  const claims = extractChatgptClaims(opts.accessToken);
  if (opts.expectedAccountId && opts.expectedAccountId !== claims.chatgptUserId) {
    throw new Error("ChatGPT account mismatch during refresh persistence");
  }
  const encryptedAccess = encryptSecret(opts.accessToken, secretsKey);
  const encryptedRefresh = encryptSecret(opts.refreshToken, secretsKey);
  await upsertChatgptAccount(opts.db, {
    identityId: opts.identityId,
    chatgptUserId: claims.chatgptUserId,
    email: claims.email,
    accessToken: encryptedAccess,
    refreshToken: encryptedRefresh,
    expiresAt: opts.expiresAt,
    scope: opts.scope ?? null,
    workspaceId: claims.workspaceId,
  });
}

export async function hasPendingChatgptState(db: Db, identityId: string): Promise<boolean> {
  const row = await getChatgptOAuthStateForIdentity(db, identityId);
  return Boolean(row);
}

export function isAllowedRedirectHost(host: string, cfg: ChatgptOAuthSection): boolean {
  try {
    const redirectHost = new URL(cfg.redirect_uri).host.toLowerCase();
    const target = host.toLowerCase();
    const noPort = target.split(":")[0] ?? target;
    const redirectNoPort = redirectHost.split(":")[0] ?? redirectHost;
    return target === redirectHost || target === redirectNoPort || noPort === redirectHost || noPort === redirectNoPort;
  } catch {
    return false;
  }
}

/**
 * Check if a token should be refreshed (proactive refresh strategy).
 */
export function shouldRefreshToken(expiresAt: number, marginMs: number = 60_000): boolean {
  return expiresAt <= nowMs() + marginMs;
}
