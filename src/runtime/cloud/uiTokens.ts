import crypto from "node:crypto";
import type { CloudUiSection } from "../config.js";

export type UiTokenScope = "run" | "identity";

export type UiTokenPayload =
  | { scope: "run"; run_id: string; exp: number }
  | { scope: "identity"; identity_id: string; exp: number };

export type UiTokenCreatePayload =
  | { scope: "run"; run_id: string; ttlMs?: number }
  | { scope: "identity"; identity_id: string; ttlMs?: number };

function base64Url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(input: string): Buffer | null {
  try {
    const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}

function sign(secret: string, payloadB64: string): string {
  return base64Url(crypto.createHmac("sha256", secret).update(payloadB64).digest());
}

export function createUiToken(
  cfg: CloudUiSection,
  payload: UiTokenCreatePayload,
): string {
  const ttlMs = payload.ttlMs && payload.ttlMs > 0 ? payload.ttlMs : cfg.token_ttl_ms;
  const exp = Date.now() + ttlMs;
  const full = { ...payload, exp } as UiTokenPayload;
  const payloadB64 = base64Url(JSON.stringify(full));
  const sig = sign(cfg.token_secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

export function verifyUiToken(cfg: CloudUiSection, token: string): UiTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return null;
  const expected = sign(cfg.token_secret, payloadB64);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  const decoded = decodeBase64Url(payloadB64);
  if (!decoded) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const exp = typeof parsed.exp === "number" ? parsed.exp : null;
  if (!exp || !Number.isFinite(exp) || exp <= Date.now()) return null;
  if (parsed.scope === "run" && typeof parsed.run_id === "string") {
    return { scope: "run", run_id: parsed.run_id, exp };
  }
  if (parsed.scope === "identity" && typeof parsed.identity_id === "string") {
    return { scope: "identity", identity_id: parsed.identity_id, exp };
  }
  return null;
}
