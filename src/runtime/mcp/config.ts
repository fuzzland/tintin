import { McpConfigSchema, type McpLogLevel } from "./schemas.js";
import { normalizePlaywrightMcpSection, type PlaywrightMcpSection } from "./providers/playwright/config.js";

export type McpProviderType = "stdio" | "http" | "sse" | "playwright" | "github" | "notion" | "exa";

export interface BaseMcpProviderConfig {
  enabled: boolean;
  type: McpProviderType;
  startup_timeout_sec?: number;
}

export interface StdioMcpProviderConfig extends BaseMcpProviderConfig {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface HttpMcpProviderConfig extends BaseMcpProviderConfig {
  type: "http" | "sse";
  url: string;
  headers: Record<string, string>;
  bearer_token_env_var?: string;
}

export interface PlaywrightMcpProviderConfig extends BaseMcpProviderConfig, PlaywrightMcpSection {
  type: "playwright";
  startup_timeout_sec: number;
}

export interface GitHubMcpProviderConfig extends BaseMcpProviderConfig {
  type: "github";
  github_host?: string;
  toolsets?: string[];
}

export interface NotionMcpProviderConfig extends BaseMcpProviderConfig {
  type: "notion";
  headers?: Record<string, string>;
  bearer_token_env_var?: string;
}

export interface ExaMcpProviderConfig extends BaseMcpProviderConfig {
  type: "exa";
  api_key: string;
}

export type McpProviderConfig =
  | StdioMcpProviderConfig
  | HttpMcpProviderConfig
  | PlaywrightMcpProviderConfig
  | GitHubMcpProviderConfig
  | NotionMcpProviderConfig
  | ExaMcpProviderConfig;

export interface McpConfig {
  global_timeout_sec: number;
  log_level: McpLogLevel;
  providers: Record<string, McpProviderConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidProviderName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("[mcp.providers] provider name cannot be empty");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(trimmed)) {
    throw new Error(
      `[mcp.providers] invalid provider name "${name}". Use only letters, numbers, "_" or "-", and start with a letter or number.`,
    );
  }
}

function normalizeStartupTimeout(raw: unknown, fallbackMs: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(1, Math.floor(raw));
  return Math.max(1, Math.ceil(fallbackMs / 1000));
}

function normalizeProviderConfig(
  name: string,
  provider: McpProviderConfig,
  opts: { configDir: string; dataDir: string },
): McpProviderConfig {
  if (provider.type !== "playwright") {
    return provider;
  }

  const normalized = normalizePlaywrightMcpSection(provider, opts);
  if (!normalized) throw new Error(`[mcp.providers.${name}] must be a table`);
  const startupTimeout = normalizeStartupTimeout(provider.startup_timeout_sec, normalized.timeout_ms);
  return {
    ...normalized,
    type: "playwright",
    startup_timeout_sec: startupTimeout,
  };
}

export function normalizeMcpSection(
  value: unknown,
  opts: { configDir: string; dataDir: string },
): McpConfig | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error("[mcp] must be a table");

  const rawProviders = isRecord(value.providers) ? value.providers : {};
  const providersWithDefaults: Record<string, unknown> = { ...rawProviders };
  for (const [name, provider] of Object.entries(rawProviders)) {
    if (name !== "notion") continue;
    if (!isRecord(provider)) continue;
    if (typeof provider.type === "string" && provider.type.length > 0) {
      if (provider.type !== "notion") {
        throw new Error(`[mcp.providers.${name}] Notion MCP does not allow type="${provider.type}".`);
      }
      continue;
    }
    providersWithDefaults[name] = { ...provider, type: "notion" };
  }
  for (const [name, provider] of Object.entries(rawProviders)) {
    if (name !== "exa") continue;
    if (!isRecord(provider)) continue;
    if (typeof provider.type === "string" && provider.type.length > 0) {
      if (provider.type !== "exa") {
        throw new Error(`[mcp.providers.${name}] Exa MCP does not allow type="${provider.type}".`);
      }
      continue;
    }
    providersWithDefaults[name] = { ...provider, type: "exa" };
  }
  const parsed = McpConfigSchema.parse({
    ...value,
    providers: providersWithDefaults,
  });
  const providersRaw = parsed.providers as Record<string, McpProviderConfig>;
  const providers: Record<string, McpProviderConfig> = {};
  let enabledPlaywrightProviders = 0;
  for (const [name, raw] of Object.entries(providersRaw)) {
    assertValidProviderName(name);
    if (raw.type === "notion" && name !== "notion") {
      throw new Error(`[mcp.providers.${name}] Notion MCP must be named "notion".`);
    }
    if (raw.type === "exa" && name !== "exa") {
      throw new Error(`[mcp.providers.${name}] Exa MCP must be named "exa".`);
    }
    providers[name] = normalizeProviderConfig(name, raw, opts);
    if (providers[name]?.enabled && providers[name]?.type === "playwright") {
      enabledPlaywrightProviders += 1;
    }
  }
  if (enabledPlaywrightProviders > 1) {
    throw new Error("[mcp.providers] multiple enabled Playwright providers are not supported");
  }

  return {
    global_timeout_sec: parsed.global_timeout_sec,
    log_level: parsed.log_level,
    providers,
  };
}

export function resolvePlaywrightProviderEntry(
  config: McpConfig | null | undefined,
): { name: string; provider: PlaywrightMcpProviderConfig } | null {
  if (!config) return null;
  if (Object.prototype.hasOwnProperty.call(config.providers, "playwright")) {
    const candidate = config.providers.playwright;
    if (!candidate) return null;
    return candidate.type === "playwright" ? { name: "playwright", provider: candidate } : null;
  }
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.type === "playwright") return { name, provider };
  }
  return null;
}

export function resolvePlaywrightProvider(
  config: McpConfig | null | undefined,
): PlaywrightMcpProviderConfig | null {
  return resolvePlaywrightProviderEntry(config)?.provider ?? null;
}

export function listEnabledProviders(config: McpConfig | null | undefined): Array<[string, McpProviderConfig]> {
  if (!config) return [];
  return Object.entries(config.providers).filter((entry) => entry[1].enabled);
}
