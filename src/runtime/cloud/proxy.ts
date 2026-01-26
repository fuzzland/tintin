import crypto from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import type { AppConfig } from "../config.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import { fetchWithProxy } from "../httpClient.js";
import { writeAuditEvent } from "../store.js";
import { nowMs } from "../util.js";

function base64Url(input: string | Buffer): string {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return raw.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(normalized, "base64").toString("utf8");
}

export function createProxyToken(secret: string, identityId: string, ttlMs: number): string {
  const exp = Date.now() + Math.max(1_000, ttlMs);
  const payload = base64Url(JSON.stringify({ id: identityId, exp }));
  const sig = base64Url(crypto.createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

export interface VerifyResult {
  identityId: string;
  exp: number;
}

export interface VerifyFailure {
  reason: string;
  details?: Record<string, unknown>;
}

export function verifyProxyToken(secret: string, token: string): VerifyResult | null;
export function verifyProxyToken(secret: string, token: string, debug: true): { result: VerifyResult | null; failure?: VerifyFailure };
export function verifyProxyToken(secret: string, token: string, debug?: boolean): VerifyResult | null | { result: VerifyResult | null; failure?: VerifyFailure } {
  const fail = (reason: string, details?: Record<string, unknown>): VerifyResult | null | { result: null; failure: VerifyFailure } => {
    if (debug) return { result: null, failure: { reason, details } };
    return null;
  };

  if (!token) {
    return fail("no_token");
  }

  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) {
    return fail("no_dot_separator", { tokenLength: token.length, tokenPrefix: token.slice(0, 30) });
  }

  const [payload, sig] = token.split(".");
  if (!payload || !sig) {
    return fail("invalid_format", { hasPayload: !!payload, hasSig: !!sig });
  }

  const expected = base64Url(crypto.createHmac("sha256", secret).update(payload).digest());
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(sig);

  if (expectedBuf.length !== sigBuf.length) {
    return fail("sig_length_mismatch", {
      expectedLength: expectedBuf.length,
      actualLength: sigBuf.length,
      expectedPrefix: expected.slice(0, 20),
      actualPrefix: sig.slice(0, 20),
    });
  }

  const ok = crypto.timingSafeEqual(expectedBuf, sigBuf);
  if (!ok) {
    return fail("sig_mismatch", {
      expectedPrefix: expected.slice(0, 20),
      actualPrefix: sig.slice(0, 20),
    });
  }

  try {
    const decoded = base64UrlDecode(payload);
    const parsed = JSON.parse(decoded) as { id?: string; exp?: number };
    if (!parsed?.id || typeof parsed.exp !== "number") {
      return fail("invalid_payload_structure", { parsed, decoded });
    }
    const now = Date.now();
    if (parsed.exp < now - 5_000) {
      return fail("token_expired", { exp: parsed.exp, now, diffMs: now - parsed.exp });
    }
    const result = { identityId: parsed.id, exp: parsed.exp };
    if (debug) return { result };
    return result;
  } catch (e) {
    return fail("payload_parse_error", { error: String(e) });
  }
}

function extractProxyToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
  const token = req.headers["x-tintin-proxy-token"];
  if (typeof token === "string" && token.trim()) return token.trim();
  return null;
}

function shouldSkipHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "host" ||
    lower === "content-length" ||
    lower === "connection" ||
    lower === "authorization" ||
    lower === "x-api-key" ||
    lower === "x-tintin-proxy-token"
  );
}

async function readRequestBuffer(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err) => reject(err));
  });
}

function buildTargetUrl(opts: { baseUrl: string; path: string; search: string }): string {
  const baseUrlObj = new URL(opts.baseUrl);
  const basePath = baseUrlObj.pathname.replace(/\/$/, ""); // Remove trailing slash
  let path = opts.path;

  // If path starts with basePath, remove the duplicate prefix
  // e.g.: basePath="/v1", path="/v1/models" -> path="/models"
  if (basePath && basePath !== "/" && path.startsWith(basePath)) {
    path = path.slice(basePath.length) || "/";
  }

  const base = opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(normalizedPath, base);
  url.search = opts.search;
  return url.toString();
}

export async function handleProxyRequest(opts: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  config: AppConfig;
  db: Db;
  logger: Logger;
  kind: "openai" | "anthropic";
  pathPrefix: string;
  url: URL;
}): Promise<void> {
  const proxy = opts.config.cloud?.proxy;
  if (!proxy?.enabled) {
    opts.res.statusCode = 404;
    opts.res.end("not found");
    return;
  }
  if (!proxy.shared_secret) {
    opts.res.statusCode = 500;
    opts.res.end("proxy not configured");
    return;
  }
  const token = extractProxyToken(opts.req);
  const verifyResult = token ? verifyProxyToken(proxy.shared_secret, token, true) : null;
  const verified = verifyResult?.result ?? null;
  if (!verified) {
    opts.logger.debug(`[proxy] token verification failed kind=${opts.kind}`);
    opts.logger.debug(`[proxy] auth header: ${opts.req.headers.authorization ? opts.req.headers.authorization.slice(0, 50) + "..." : "(none)"}`);
    opts.logger.debug(`[proxy] x-api-key header: ${opts.req.headers["x-api-key"] ? String(opts.req.headers["x-api-key"]).slice(0, 30) + "..." : "(none)"}`);
    opts.logger.debug(`[proxy] extracted token: ${token ? token.slice(0, 30) + "..." : "(null)"}`);
    opts.logger.debug(`[proxy] token length: ${token?.length ?? 0}`);
    opts.logger.debug(`[proxy] has dot separator: ${token?.includes(".") ?? false}`);
    if (verifyResult?.failure) {
      opts.logger.debug(`[proxy] failure reason: ${verifyResult.failure.reason}`);
      if (verifyResult.failure.details) {
        opts.logger.debug(`[proxy] failure details: ${JSON.stringify(verifyResult.failure.details)}`);
      }
    }
    opts.res.statusCode = 401;
    opts.res.end("unauthorized");
    return;
  }

  opts.logger.debug(`[proxy] request verified identity=${verified.identityId} kind=${opts.kind} path=${opts.url.pathname}`);

  const body = await readRequestBuffer(opts.req);
  const targetBase = opts.kind === "openai" ? proxy.openai_base_url : proxy.anthropic_base_url;
  const targetPath = opts.url.pathname.slice(opts.pathPrefix.length) || "/";

  const target = buildTargetUrl({ baseUrl: targetBase, path: targetPath, search: opts.url.search });

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.req.headers)) {
    if (shouldSkipHeader(key)) continue;
    if (value === undefined) continue;
    headers[key] = Array.isArray(value) ? value.join(",") : value;
  }

  if (opts.kind === "openai") {
    if (!proxy.openai_api_key) {
      opts.logger.warn(`[proxy] openai_api_key not configured`);
      opts.res.statusCode = 502;
      opts.res.end("openai proxy not configured");
      return;
    }
    opts.logger.debug(`[proxy] forwarding to openai baseUrl=${targetBase} hasApiKey=${!!proxy.openai_api_key} apiKeyPrefix=${proxy.openai_api_key.slice(0, 10)}...`);
    headers.authorization = `Bearer ${proxy.openai_api_key}`;
  } else {
    if (!proxy.anthropic_api_key) {
      opts.res.statusCode = 502;
      opts.res.end("anthropic proxy not configured");
      return;
    }
    headers["x-api-key"] = proxy.anthropic_api_key;
    if (!headers["anthropic-version"]) headers["anthropic-version"] = proxy.anthropic_version;
  }

  let responseBytes = 0;
  const start = nowMs();
  try {
    opts.logger.debug(`[proxy] sending upstream request to ${target}`);
    const upstream = await fetchWithProxy(target, {
      method: opts.req.method ?? "POST",
      headers,
      body: body.length > 0 ? body : undefined,
    });

    opts.logger.debug(`[proxy] upstream response status=${upstream.status}`);

    opts.res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "transfer-encoding" || lower === "connection") return;
      opts.res.setHeader(key, value);
    });

    if (upstream.body) {
      const stream = Readable.fromWeb(upstream.body as any);
      stream.on("data", (chunk) => {
        responseBytes += Buffer.byteLength(chunk);
      });
      stream.pipe(opts.res);
    } else {
      opts.res.end();
    }

    opts.res.on("finish", async () => {
      try {
        await writeAuditEvent(opts.db, {
          id: crypto.randomUUID(),
          kind: "cloud_proxy",
          payload_json: JSON.stringify({
            provider: opts.kind,
            status: upstream.status,
            request_bytes: body.length,
            response_bytes: responseBytes,
            path: targetPath,
            duration_ms: nowMs() - start,
          }),
          identity_id: verified.identityId,
          action: "proxy_request",
          metadata_json: JSON.stringify({ provider: opts.kind }),
        });
      } catch (e) {
        opts.logger.warn(`[cloud] failed to write proxy audit: ${String(e)}`);
      }
    });
  } catch (e) {
    opts.logger.warn(`[cloud] proxy error: ${String(e)}`);
    opts.res.statusCode = 502;
    opts.res.end("proxy error");
  }
}
