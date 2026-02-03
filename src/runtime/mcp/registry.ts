import type { Logger } from "../log.js";
import type { McpConfig, McpProviderConfig } from "./config.js";
import type { IMcpProvider, McpProviderContext, McpServerInfo } from "./types.js";
import { McpLifecycleManager } from "./lifecycle.js";
import { createMcpProvider } from "./factory.js";

type ProviderEntry = {
  config: McpProviderConfig;
  provider: IMcpProvider;
  startPromise: Promise<McpServerInfo> | null;
};

export class McpRegistry {
  private readonly providers = new Map<string, ProviderEntry>();

  constructor(
    private readonly logger: Logger,
    private readonly lifecycle: McpLifecycleManager = new McpLifecycleManager(),
  ) {}

  async loadFromConfig(config: McpConfig | null, context: McpProviderContext): Promise<void> {
    if (this.providers.size > 0) {
      await this.stopAll();
      this.providers.clear();
    }
    if (!config) return;

    for (const [name, providerConfig] of Object.entries(config.providers)) {
      if (!providerConfig.enabled) continue;
      if (providerConfig.type === "github") continue;
      const provider = createMcpProvider(name, providerConfig);
      await this.lifecycle.initProvider(provider, providerConfig, context);
      this.providers.set(name, {
        config: providerConfig,
        provider,
        startPromise: null,
      });
    }
  }

  getProvider(name: string): IMcpProvider | null {
    return this.providers.get(name)?.provider ?? null;
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  getServerInfo(name: string): McpServerInfo | null {
    const entry = this.providers.get(name);
    if (!entry) return null;
    return entry.provider.getServerInfo();
  }

  async ensureStarted(name: string): Promise<McpServerInfo | null> {
    const entry = this.providers.get(name);
    if (!entry) return null;
    if (entry.startPromise) return await entry.startPromise;
    const startPromise = this.lifecycle
      .startProvider(entry.provider)
      .then((info) => {
        entry.startPromise = null;
        return info;
      })
      .catch((err) => {
        entry.startPromise = null;
        throw err;
      });
    entry.startPromise = startPromise;
    return await startPromise;
  }

  async startAll(): Promise<Map<string, McpServerInfo>> {
    const results = await Promise.all(
      Array.from(this.providers.keys()).map(async (name) => [name, await this.ensureStarted(name)] as const),
    );
    const map = new Map<string, McpServerInfo>();
    for (const [name, info] of results) {
      if (info) map.set(name, info);
    }
    return map;
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      Array.from(this.providers.entries()).map(async ([name, entry]) => {
        try {
          await this.lifecycle.stopProvider(entry.provider);
        } catch (err) {
          this.logger.warn(`[mcp] provider stop failed name=${name}: ${String(err)}`);
        }
        try {
          await this.lifecycle.destroyProvider(entry.provider);
        } catch (err) {
          this.logger.warn(`[mcp] provider destroy failed name=${name}: ${String(err)}`);
        }
        entry.startPromise = null;
      }),
    );
  }
}
