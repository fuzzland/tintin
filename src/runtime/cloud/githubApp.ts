import crypto from "node:crypto";
import type { CloudGithubAppSection, CloudSection } from "../config.js";
import type { ConnectionsTable, Db } from "../db.js";
import { nowMs } from "../util.js";
import { createOAuthState, consumeOAuthState, markIdentityOnboarded, upsertConnection } from "./store.js";

const STATE_PROVIDER = "github_app";
const TOKEN_REFRESH_BUFFER_MS = 60_000;

export interface GithubAppMetadata {
  installation_id: number;
  account_login?: string;
  account_type?: string;
}

function base64Url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizePrivateKey(key: string): string {
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

function buildGithubAppJwt(cfg: CloudGithubAppSection): string {
  if (!cfg.app_id || !cfg.private_key) {
    throw new Error("GitHub App config missing app_id or private_key.");
  }
  const now = Math.floor(Date.now() / 1000);
  const appIdNum = Number(cfg.app_id);
  const issuer = Number.isFinite(appIdNum) ? appIdNum : cfg.app_id;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: now - 30, exp: now + 9 * 60, iss: issuer }));
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(normalizePrivateKey(cfg.private_key));
  return `${signingInput}.${base64Url(signature)}`;
}

function buildInstallUrl(cfg: CloudGithubAppSection, state: string): string {
  const base = cfg.app_base_url.replace(/\/+$/, "");
  const slug = encodeURIComponent(cfg.app_slug);
  const params = new URLSearchParams({ state });
  return `${base}/apps/${slug}/installations/new?${params.toString()}`;
}

async function fetchJson(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string }) {
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: opts.headers,
    body: opts.body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API failed: ${res.status} ${text}`);
  }
  return (await res.json()) as any;
}

async function fetchInstallationInfo(cfg: CloudGithubAppSection, installationId: number) {
  const url = `${cfg.api_base_url.replace(/\/+$/, "")}/app/installations/${installationId}`;
  return await fetchJson(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${buildGithubAppJwt(cfg)}`,
    },
  });
}

async function createInstallationToken(cfg: CloudGithubAppSection, installationId: number): Promise<{ token: string; expiresAt: number | null }> {
  const url = `${cfg.api_base_url.replace(/\/+$/, "")}/app/installations/${installationId}/access_tokens`;
  const data = await fetchJson(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${buildGithubAppJwt(cfg)}`,
    },
  });
  const token = typeof data.token === "string" ? data.token : "";
  if (!token) throw new Error("GitHub App token missing in response");
  const expiresAt = typeof data.expires_at === "string" ? Date.parse(data.expires_at) : null;
  return { token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
}

export function parseGithubAppMetadata(metadataJson: string | null): GithubAppMetadata | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as any;
    const installationRaw = parsed?.installation_id;
    const installation_id = typeof installationRaw === "number" ? installationRaw : Number(installationRaw);
    if (!Number.isFinite(installation_id)) return null;
    const account_login = typeof parsed?.account_login === "string" ? parsed.account_login : undefined;
    const account_type = typeof parsed?.account_type === "string" ? parsed.account_type : undefined;
    return { installation_id, account_login, account_type };
  } catch {
    return null;
  }
}

export async function ensureGithubAppToken(opts: {
  db: Db;
  config: CloudGithubAppSection;
  connection: ConnectionsTable;
  forceRefresh?: boolean;
}): Promise<{ token: string; expiresAt: number | null }> {
  const now = nowMs();
  if (
    !opts.forceRefresh &&
    opts.connection.access_token &&
    opts.connection.token_expires_at &&
    opts.connection.token_expires_at > now + TOKEN_REFRESH_BUFFER_MS
  ) {
    return { token: opts.connection.access_token, expiresAt: opts.connection.token_expires_at };
  }
  const metadata = parseGithubAppMetadata(opts.connection.metadata_json);
  if (!metadata) throw new Error("GitHub App connection missing installation metadata");
  const token = await createInstallationToken(opts.config, metadata.installation_id);
  await opts.db
    .updateTable("connections")
    .set({ access_token: token.token, token_expires_at: token.expiresAt, updated_at: nowMs() })
    .where("id", "=", opts.connection.id)
    .execute();
  return token;
}

export async function createGithubPullRequest(opts: {
  db: Db;
  config: CloudGithubAppSection;
  connection: ConnectionsTable;
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string | null;
}): Promise<{ url: string | null; number: number | null }> {
  const token = await ensureGithubAppToken({ db: opts.db, config: opts.config, connection: opts.connection });
  const apiBase = opts.config.api_base_url.replace(/\/+$/, "");
  const payload: Record<string, any> = {
    title: opts.title,
    head: opts.head,
    base: opts.base,
  };
  if (opts.body) payload.body = opts.body;
  const data = await fetchJson(`${apiBase}/repos/${opts.owner}/${opts.repo}/pulls`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token.token}`,
    },
    body: JSON.stringify(payload),
  });
  const url = typeof data.html_url === "string" ? data.html_url : typeof data.url === "string" ? data.url : null;
  const number = typeof data.number === "number" ? data.number : Number.isFinite(Number(data.number)) ? Number(data.number) : null;
  return { url, number };
}

export async function startGithubAppFlow(opts: {
  db: Db;
  cloud: CloudSection;
  identityId: string;
  redirectBase: string;
  metadataJson?: string | null;
}): Promise<{ authorizeUrl: string }> {
  const cfg = opts.cloud.github_app;
  if (!cfg) throw new Error("Missing [cloud].github_app configuration.");
  if (!cfg.app_id || !cfg.app_slug || !cfg.private_key) {
    throw new Error("GitHub App config missing app_id, app_slug, or private_key.");
  }
  const state = base64Url(crypto.randomBytes(24));
  const verifier = base64Url(crypto.randomBytes(32));
  const redirectUri = `${opts.redirectBase}${opts.cloud.oauth.callback_path}`;
  await createOAuthState(opts.db, {
    provider: STATE_PROVIDER,
    state,
    codeVerifier: verifier,
    redirectUrl: redirectUri,
    identityId: opts.identityId,
    metadataJson: opts.metadataJson ?? null,
    ttlMs: 10 * 60 * 1000,
  });
  return { authorizeUrl: buildInstallUrl(cfg, state) };
}

export async function handleGithubAppCallback(opts: {
  db: Db;
  cloud: CloudSection;
  installationId: string;
  state: string;
}): Promise<{ identityId: string; provider: string; metadataJson: string | null }> {
  const cfg = opts.cloud.github_app;
  if (!cfg) throw new Error("Missing [cloud].github_app configuration.");
  const saved = await consumeOAuthState(opts.db, STATE_PROVIDER, opts.state);
  if (!saved) throw new Error("Invalid or expired GitHub App state");
  if (!saved.identity_id) throw new Error("GitHub App state missing identity");
  const installationId = Number(opts.installationId);
  if (!Number.isFinite(installationId)) throw new Error("Invalid installation id");
  let account_login: string | undefined;
  let account_type: string | undefined;
  try {
    const installation = await fetchInstallationInfo(cfg, installationId);
    account_login = typeof installation?.account?.login === "string" ? installation.account.login : undefined;
    account_type = typeof installation?.account?.type === "string" ? installation.account.type : undefined;
  } catch {
    // If lookup fails, still allow connect with installation id only.
  }
  const token = await createInstallationToken(cfg, installationId);
  const metadata: GithubAppMetadata = {
    installation_id: installationId,
    account_login,
    account_type,
  };
  await upsertConnection(opts.db, {
    identityId: saved.identity_id,
    type: "github",
    accessToken: token.token,
    refreshToken: null,
    scope: null,
    tokenExpiresAt: token.expiresAt,
    metadataJson: JSON.stringify(metadata),
  });
  await markIdentityOnboarded(opts.db, saved.identity_id);
  return { identityId: saved.identity_id, provider: "github", metadataJson: saved.metadata_json ?? null };
}
