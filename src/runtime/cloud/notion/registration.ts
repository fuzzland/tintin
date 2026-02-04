import type { Db } from "../../db.js";
import type { Logger } from "../../log.js";
import { discoverNotionEndpoints } from "./discovery.js";
import { getLatestNotionMcpClient, upsertNotionMcpClient } from "../store.js";

type RegistrationResult = {
  clientId: string;
  clientSecret: string | null;
  registrationUri?: string | null;
  authEndpoint: string;
  tokenEndpoint: string;
};

export async function getOrRegisterNotionClient(opts: {
  db: Db;
  redirectUri: string;
  logger?: Logger;
}): Promise<RegistrationResult> {
  const existing = await getLatestNotionMcpClient(opts.db);
  if (existing) {
    opts.logger?.info(
      `[notion][registration] reuse client_id=${existing.client_id} token_endpoint=${existing.token_endpoint}`,
    );
    return {
      clientId: existing.client_id,
      clientSecret: existing.client_secret,
      registrationUri: existing.registration_uri,
      authEndpoint: existing.auth_endpoint,
      tokenEndpoint: existing.token_endpoint,
    };
  }

  const discovery = await discoverNotionEndpoints({ logger: opts.logger });
  opts.logger?.info(
    `[notion][registration] register start auth_endpoint=${discovery.authorizationEndpoint} token_endpoint=${discovery.tokenEndpoint}`,
  );
  const payload = {
    redirect_uris: [opts.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    client_name: "Tintin Notion MCP",
    application_type: "web",
  };
  const res = await fetch(discovery.registrationEndpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion registration failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as any;
  const clientId = String(data.client_id ?? "");
  const clientSecret = typeof data.client_secret === "string" ? data.client_secret : null;
  if (!clientId) {
    throw new Error("Notion registration missing client credentials");
  }
  opts.logger?.info(`[notion][registration] register ok client_id=${clientId}`);
  const registrationUri = typeof data.registration_client_uri === "string" ? data.registration_client_uri : null;
  await upsertNotionMcpClient(opts.db, {
    clientId,
    clientSecret: clientSecret ?? "",
    registrationUri,
    authEndpoint: discovery.authorizationEndpoint,
    tokenEndpoint: discovery.tokenEndpoint,
  });
  return {
    clientId,
    clientSecret,
    registrationUri,
    authEndpoint: discovery.authorizationEndpoint,
    tokenEndpoint: discovery.tokenEndpoint,
  };
}
