import crypto from "node:crypto";
import type { CloudOAuthProviderSection, CloudSection } from "../config.js";
import type { Db } from "../db.js";
import { createOAuthState, consumeOAuthState, markIdentityOnboarded, upsertConnection } from "./store.js";

function base64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generateCodeVerifier(): string {
  return base64Url(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  const hash = crypto.createHash("sha256").update(verifier).digest();
  return base64Url(hash);
}

function buildAuthorizeUrl(opts: {
  provider: CloudOAuthProviderSection;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams();
  params.set("client_id", opts.provider.client_id);
  params.set("redirect_uri", opts.redirectUri);
  params.set("response_type", "code");
  params.set("state", opts.state);
  if (opts.provider.scopes.length > 0) params.set("scope", opts.provider.scopes.join(" "));
  params.set("code_challenge", opts.codeChallenge);
  params.set("code_challenge_method", "S256");
  return `${opts.provider.authorize_url}?${params.toString()}`;
}

async function exchangeToken(opts: {
  provider: CloudOAuthProviderSection;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<{ accessToken: string; refreshToken: string | null; scope: string | null; expiresIn: number | null }> {
  const params = new URLSearchParams();
  params.set("client_id", opts.provider.client_id);
  params.set("client_secret", opts.provider.client_secret);
  params.set("code", opts.code);
  params.set("grant_type", "authorization_code");
  params.set("redirect_uri", opts.redirectUri);
  params.set("code_verifier", opts.codeVerifier);

  const res = await fetch(opts.provider.token_url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token exchange failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as any;
  return {
    accessToken: data.access_token ?? "",
    refreshToken: data.refresh_token ?? null,
    scope: data.scope ?? null,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : null,
  };
}

function resolveProviderConfig(cloud: CloudSection, provider: string): CloudOAuthProviderSection {
  if (provider === "github" && cloud.oauth.github) return cloud.oauth.github;
  if (provider === "gitlab" && cloud.oauth.gitlab) return cloud.oauth.gitlab;
  if (provider === "local" && cloud.oauth.local) return cloud.oauth.local;
  throw new Error(`OAuth provider not configured: ${provider}`);
}

export async function startOAuthFlow(opts: {
  db: Db;
  cloud: CloudSection;
  provider: string;
  identityId: string;
  redirectBase: string;
  metadataJson?: string | null;
}): Promise<{ authorizeUrl: string }> {
  const cfg = resolveProviderConfig(opts.cloud, opts.provider);
  if (!cfg.client_id || !cfg.client_secret || !cfg.authorize_url || !cfg.token_url) {
    throw new Error(`OAuth provider missing required config: ${opts.provider}`);
  }
  const state = base64Url(crypto.randomBytes(24));
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const redirectUri = `${opts.redirectBase}${opts.cloud.oauth.callback_path}?provider=${encodeURIComponent(opts.provider)}`;
  await createOAuthState(opts.db, {
    provider: opts.provider,
    state,
    codeVerifier: verifier,
    redirectUrl: redirectUri,
    identityId: opts.identityId,
    metadataJson: opts.metadataJson ?? null,
    ttlMs: 10 * 60 * 1000,
  });
  return { authorizeUrl: buildAuthorizeUrl({ provider: cfg, redirectUri, state, codeChallenge: challenge }) };
}

export async function handleOAuthCallback(opts: {
  db: Db;
  cloud: CloudSection;
  provider: string;
  code: string;
  state: string;
}): Promise<{ identityId: string; provider: string; metadataJson: string | null }> {
  const cfg = resolveProviderConfig(opts.cloud, opts.provider);
  const saved = await consumeOAuthState(opts.db, opts.provider, opts.state);
  if (!saved) throw new Error("Invalid or expired OAuth state");
  const token = await exchangeToken({
    provider: cfg,
    redirectUri: saved.redirect_url,
    code: opts.code,
    codeVerifier: saved.code_verifier,
  });
  if (!saved.identity_id) throw new Error("OAuth state missing identity");
  const connectionType = opts.provider === "github" ? "github_oauth" : opts.provider;
  await upsertConnection(opts.db, {
    identityId: saved.identity_id,
    type: connectionType,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    scope: token.scope,
    tokenExpiresAt: token.expiresIn ? Date.now() + token.expiresIn * 1000 : null,
    metadataJson: saved.metadata_json ?? null,
  });
  await markIdentityOnboarded(opts.db, saved.identity_id);
  return { identityId: saved.identity_id, provider: opts.provider, metadataJson: saved.metadata_json ?? null };
}
