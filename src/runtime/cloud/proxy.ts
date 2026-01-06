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

export function verifyProxyToken(secret: string, token: string): { identityId: string; exp: number } | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = base64Url(crypto.createHmac("sha256", secret).update(payload).digest());
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(sig);
  if (expectedBuf.length !== sigBuf.length) return null;
  const ok = crypto.timingSafeEqual(expectedBuf, sigBuf);
  if (!ok) return null;
  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as { id?: string; exp?: number };
    if (!parsed?.id || typeof parsed.exp !== "number") return null;
    if (parsed.exp < Date.now() - 5_000) return null;
    return { identityId: parsed.id, exp: parsed.exp };
  } catch {
    return null;
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
  const base = opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`;
  const path = opts.path.startsWith("/") ? opts.path.slice(1) : opts.path;
  const url = new URL(path, base);
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
  const verified = token ? verifyProxyToken(proxy.shared_secret, token) : null;
  if (!verified) {
    opts.res.statusCode = 401;
    opts.res.end("unauthorized");
    return;
  }

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
      opts.res.statusCode = 502;
      opts.res.end("openai proxy not configured");
      return;
    }
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
    const upstream = await fetchWithProxy(target, {
      method: opts.req.method ?? "POST",
      headers,
      body: body.length > 0 ? body : undefined,
    });

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
