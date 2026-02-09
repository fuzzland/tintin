import type { McpProviderConfig, McpProviderType } from "./config.js";
import type { IMcpProvider } from "./types.js";
import { HttpMcpProvider } from "./providers/http.js";
import { GitHubMcpProvider } from "./providers/github.js";
import { PlaywrightMcpProvider } from "./providers/playwright/index.js";
import { StdioMcpProvider } from "./providers/stdio.js";

type ProviderFactory = (name: string, config: McpProviderConfig) => IMcpProvider;

const PROVIDER_FACTORIES: Record<McpProviderType, ProviderFactory> = {
  stdio: (name) => new StdioMcpProvider(name),
  http: (name) => new HttpMcpProvider(name, "http"),
  sse: (name) => new HttpMcpProvider(name, "sse"),
  playwright: (name) => new PlaywrightMcpProvider(name),
  github: (name) => new GitHubMcpProvider(name),
  notion: (name) => new HttpMcpProvider(name, "http"),
  exa: (name) => new HttpMcpProvider(name, "http"),
  parallel: (name) => new HttpMcpProvider(name, "http"),
};

export function createMcpProvider(name: string, config: McpProviderConfig): IMcpProvider {
  const factory = PROVIDER_FACTORIES[config.type];
  if (!factory) {
    throw new Error(`Unknown MCP provider type: ${(config as { type?: string }).type ?? "unknown"}`);
  }
  return factory(name, config);
}
