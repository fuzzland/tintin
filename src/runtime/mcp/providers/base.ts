import type { Logger } from "../../log.js";
import type { IMcpProvider, McpProviderContext, McpServerInfo } from "../types.js";

export abstract class BaseMcpProvider<TConfig> implements IMcpProvider<TConfig> {
  abstract readonly type: string;
  readonly name: string;

  protected config!: TConfig;
  protected context!: McpProviderContext;
  protected logger!: Logger;
  protected info: McpServerInfo;

  constructor(name: string, info: McpServerInfo) {
    this.name = name;
    this.info = info;
  }

  async init(config: TConfig, context: McpProviderContext): Promise<void> {
    this.config = config;
    this.context = context;
    this.logger = context.logger;
  }

  abstract start(): Promise<McpServerInfo>;
  abstract stop(): Promise<void>;

  getServerInfo(): McpServerInfo {
    return this.info;
  }

  protected setInfo(update: Partial<McpServerInfo>): void {
    this.info = { ...this.info, ...update };
  }
}
