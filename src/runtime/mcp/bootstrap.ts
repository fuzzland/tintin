import type {
  GitHubMcpProviderConfig,
  McpConfig,
  McpProviderConfig,
  McpProviderType,
  PlaywrightMcpProviderConfig,
} from "./config.js";
import type { McpLogLevel } from "./schemas.js";

export interface McpBootstrapConfig {
  global_timeout_sec: number;
  log_level: McpLogLevel;
  providers: Record<string, McpProviderConfig>;
}

type BootstrapSelector = (name: string, provider: McpProviderConfig) => McpProviderConfig | null;

const selectPlaywrightBootstrap: BootstrapSelector = (_name, provider) => {
  if (provider.type !== "playwright") return null;
  const cfg = provider as PlaywrightMcpProviderConfig;
  return cfg.provider === "local"
    ? {
        ...cfg,
        port_end: cfg.port_start,
      }
    : null;
};

const BOOTSTRAP_SELECTORS: Record<McpProviderType, BootstrapSelector> = {
  stdio: () => null,
  http: () => null,
  sse: () => null,
  playwright: selectPlaywrightBootstrap,
  github: (name, provider) => {
    if (provider.type !== "github") return null;
    return null;
  },
};

export function buildMcpBootstrapConfig(mcp: McpConfig | null | undefined): McpBootstrapConfig | null {
  if (!mcp) return null;
  const providers: Record<string, McpProviderConfig> = {};
  for (const [name, provider] of Object.entries(mcp.providers)) {
    if (!provider.enabled) continue;
    const selector = BOOTSTRAP_SELECTORS[provider.type];
    const selected = selector ? selector(name, provider) : null;
    if (selected) providers[name] = selected;
  }
  if (Object.keys(providers).length === 0) return null;
  return {
    global_timeout_sec: mcp.global_timeout_sec,
    log_level: mcp.log_level,
    providers,
  };
}

export function encodeMcpBootstrapConfig(config: McpBootstrapConfig): string {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64");
}
