import type { PlaywrightMcpHyperbrowserSection } from "../config.js";
import { fetchWithProxy } from "../httpClient.js";

export interface HyperbrowserSessionInfo {
  id: string;
  wsEndpoint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseSessionResponse(payload: unknown): HyperbrowserSessionInfo {
  if (!payload || typeof payload !== "object") {
    throw new Error("Hyperbrowser session response is not an object");
  }
  const data = payload as Record<string, unknown>;
  const id = getString(data.id) ?? getString(data.sessionId) ?? getString(data.session_id);
  const wsEndpoint =
    getString(data.wsEndpoint) ?? getString(data.ws_endpoint) ?? getString(data.websocketEndpoint);
  if (!id || !wsEndpoint) {
    throw new Error("Hyperbrowser session response missing id/wsEndpoint");
  }
  return { id, wsEndpoint };
}

export async function createHyperbrowserSession(opts: {
  config: PlaywrightMcpHyperbrowserSection;
}): Promise<HyperbrowserSessionInfo> {
  const cfg = opts.config;
  if (!cfg.api_key) {
    throw new Error("Hyperbrowser config requires api_key.");
  }
  const base = normalizeBaseUrl(cfg.api_base_url ?? "https://api.hyperbrowser.ai");
  const body = isRecord(cfg.session_params) ? { ...cfg.session_params } : {};
  if (!("solveCaptchas" in body)) {
    body.solveCaptchas = true;
  }
  if (!("useStealth" in body)) {
    body.useStealth = true;
  }
  const res = await fetchWithProxy(`${base}/api/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.api_key,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Hyperbrowser session create failed: ${res.status} ${text}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Hyperbrowser session response invalid JSON: ${text}`);
  }
  return parseSessionResponse(parsed);
}

export async function stopHyperbrowserSession(opts: {
  config: PlaywrightMcpHyperbrowserSection;
  sessionId: string;
}): Promise<void> {
  const cfg = opts.config;
  if (!cfg.api_key) {
    throw new Error("Hyperbrowser config requires api_key.");
  }
  const base = normalizeBaseUrl(cfg.api_base_url ?? "https://api.hyperbrowser.ai");
  const res = await fetchWithProxy(`${base}/api/session/${encodeURIComponent(opts.sessionId)}/stop`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.api_key,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Hyperbrowser session stop failed: ${res.status} ${text}`);
  }
}
