import type { PlaywrightMcpBrowserbaseSection } from "../config.js";
import { fetchWithProxy } from "../httpClient.js";

export interface BrowserbaseSessionInfo {
  id: string;
  connectUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function buildSessionPayload(
  cfg: PlaywrightMcpBrowserbaseSection,
  userMetadata?: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    projectId: cfg.project_id,
    keepAlive: cfg.keep_alive,
  };
  if (cfg.region) body.region = cfg.region;
  if (cfg.proxies !== undefined) body.proxies = cfg.proxies;
  if (cfg.extension_id) body.extensionId = cfg.extension_id;
  if (cfg.context_id) body.contextId = cfg.context_id;

  const browserSettings: Record<string, unknown> = cfg.browser_settings ? { ...cfg.browser_settings } : {};
  if (typeof cfg.timeout_sec === "number" && !("timeout" in browserSettings)) {
    browserSettings.timeout = cfg.timeout_sec;
  }
  if (Object.keys(browserSettings).length > 0) body.browserSettings = browserSettings;

  if (userMetadata && Object.keys(userMetadata).length > 0) {
    body.userMetadata = userMetadata;
  }
  return body;
}

function parseSessionResponse(payload: unknown): BrowserbaseSessionInfo {
  if (!payload || typeof payload !== "object") {
    throw new Error("Browserbase session response is not an object");
  }
  const data = payload as Record<string, unknown>;
  const sessionObj = isRecord(data.session) ? data.session : null;
  const id =
    getString(data.id) ??
    getString(data.session_id) ??
    (sessionObj ? getString(sessionObj.id) ?? getString(sessionObj.session_id) : null);
  const connectUrl =
    getString(data.connectUrl) ??
    getString(data.connect_url) ??
    (sessionObj ? getString(sessionObj.connectUrl) ?? getString(sessionObj.connect_url) : null);
  if (!id || !connectUrl) {
    throw new Error("Browserbase session response missing id/connectUrl");
  }
  return { id, connectUrl };
}

export async function createBrowserbaseSession(opts: {
  config: PlaywrightMcpBrowserbaseSection;
  userMetadata?: Record<string, unknown>;
}): Promise<BrowserbaseSessionInfo> {
  const cfg = opts.config;
  if (!cfg.api_key || !cfg.project_id) {
    throw new Error("Browserbase config requires api_key and project_id.");
  }
  const body = buildSessionPayload(cfg, opts.userMetadata);
  const res = await fetchWithProxy("https://api.browserbase.com/v1/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BB-API-Key": cfg.api_key,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Browserbase session create failed: ${res.status} ${text}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Browserbase session response invalid JSON: ${text}`);
  }
  return parseSessionResponse(parsed);
}

export async function releaseBrowserbaseSession(opts: { config: PlaywrightMcpBrowserbaseSection; sessionId: string }): Promise<void> {
  const cfg = opts.config;
  if (!cfg.api_key || !cfg.project_id) {
    throw new Error("Browserbase config requires api_key and project_id.");
  }
  const url = `https://api.browserbase.com/v1/sessions/${encodeURIComponent(opts.sessionId)}`;
  const res = await fetchWithProxy(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BB-API-Key": cfg.api_key,
    },
    body: JSON.stringify({ projectId: cfg.project_id, status: "REQUEST_RELEASE" }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Browserbase session release failed: ${res.status} ${text}`);
  }
}
