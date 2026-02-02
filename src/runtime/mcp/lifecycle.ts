import type { IMcpProvider, McpServerInfo, McpProviderContext } from "./types.js";

export class McpLifecycleManager {
  async initProvider<TConfig>(provider: IMcpProvider<TConfig>, config: TConfig, context: McpProviderContext): Promise<void> {
    await provider.init(config, context);
    if (provider.bootstrap) await provider.bootstrap();
  }

  async startProvider(provider: IMcpProvider): Promise<McpServerInfo> {
    return await provider.start();
  }

  async stopProvider(provider: IMcpProvider): Promise<void> {
    await provider.stop();
  }

  async destroyProvider(provider: IMcpProvider): Promise<void> {
    if (provider.destroy) {
      await provider.destroy();
    }
  }
}
