import type { Logger } from "../../log.js";

export type NotionDiscoveryResult = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  authorizationServer: string;
};

const DEFAULT_RESOURCE_BASE = "https://mcp.notion.com/mcp";
let cached: { value: NotionDiscoveryResult; ts: number } | null = null;

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion discovery failed (${res.status}): ${text}`);
  }
  return (await res.json()) as any;
}

export async function discoverNotionEndpoints(opts?: {
  resourceBaseUrl?: string;
  logger?: Logger;
  cacheTtlMs?: number;
}): Promise<NotionDiscoveryResult> {
  const ttl = opts?.cacheTtlMs ?? 10 * 60 * 1000;
  if (cached && Date.now() - cached.ts < ttl) return cached.value;
  const resourceBase = opts?.resourceBaseUrl ?? DEFAULT_RESOURCE_BASE;
  opts?.logger?.info(`[notion][discovery] start resource=${resourceBase}`);

  // RFC 9470: Protected Resource Metadata is at the ORIGIN, not the resource path
  // e.g., for "https://mcp.notion.com/mcp", the metadata is at "https://mcp.notion.com/.well-known/oauth-protected-resource"
  const resourceUrl = new URL(resourceBase);
  const protectedMetadataUrl = `${resourceUrl.origin}/.well-known/oauth-protected-resource`;

  let authServer = "";
  try {
    const data = await fetchJson(protectedMetadataUrl);
    opts?.logger?.info(`[notion][discovery] protected-resource ok url=${protectedMetadataUrl}`);
    if (Array.isArray(data.authorization_servers) && data.authorization_servers.length > 0) {
      authServer = String(data.authorization_servers[0] ?? "");
    } else if (typeof data.authorization_server === "string") {
      authServer = data.authorization_server;
    }
  } catch (err) {
    opts?.logger?.warn(`[notion][discovery] protected-resource lookup failed url=${protectedMetadataUrl}: ${String(err)}`);
  }

  if (!authServer) {
    throw new Error("Notion discovery missing authorization server");
  }
  const authMetaUrl = `${authServer.replace(/\/+$/g, "")}/.well-known/oauth-authorization-server`;
  const meta = await fetchJson(authMetaUrl);
  opts?.logger?.info(`[notion][discovery] authorization-server ok url=${authMetaUrl}`);
  const authorizationEndpoint = String(meta.authorization_endpoint ?? "");
  const tokenEndpoint = String(meta.token_endpoint ?? "");
  const registrationEndpoint = String(meta.registration_endpoint ?? "");
  if (!authorizationEndpoint || !tokenEndpoint || !registrationEndpoint) {
    throw new Error("Notion discovery missing required OAuth endpoints");
  }
  const result: NotionDiscoveryResult = {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    authorizationServer: authServer,
  };
  cached = { value: result, ts: Date.now() };
  return result;
}
