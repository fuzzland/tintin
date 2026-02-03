import type { McpServerInfo } from "./types.js";

export function formatMcpBearerEnvVar(name: string): string {
  const raw = name.trim().toUpperCase();
  const normalized = raw.replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `TINTIN_MCP_BEARER_${normalized || "MCP"}`;
}

export function collectMcpAgentEnv(servers: Map<string, McpServerInfo>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, info] of servers.entries()) {
    const key = info.bearerTokenEnvVar?.trim();
    if (!key) continue;
    if (!info.bearerToken) {
      throw new Error(`[mcp.providers.${name}] bearer token env var configured but token is missing`);
    }
    const existing = env[key];
    if (existing && existing !== info.bearerToken) {
      throw new Error(`[mcp.providers.${name}] bearer token env var conflict for ${key}`);
    }
    env[key] = info.bearerToken;
  }
  return env;
}
