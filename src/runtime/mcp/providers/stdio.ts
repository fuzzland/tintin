import type { StdioMcpProviderConfig } from "../config.js";
import type { McpProviderContext, McpServerInfo } from "../types.js";
import { BaseMcpProvider } from "./base.js";

export class StdioMcpProvider extends BaseMcpProvider<StdioMcpProviderConfig> {
  readonly type = "stdio";

  constructor(name: string) {
    super(name, { id: name, transport: "stdio", status: "stopped" });
  }

  override async init(config: StdioMcpProviderConfig, context: McpProviderContext): Promise<void> {
    await super.init(config, context);
    this.setInfo(
      {
        command: config.command,
        args: config.args,
        env: config.env,
      },
    );
    if (typeof config.startup_timeout_sec === "number") {
      this.setInfo({ startupTimeoutSec: config.startup_timeout_sec });
    }
  }

  override async start(): Promise<McpServerInfo> {
    // Stdio providers are agent-spawned; mark as ready for agent connection.
    this.setInfo({ status: "running" });
    return this.getServerInfo();
  }

  override async stop(): Promise<void> {
    this.setInfo({ status: "stopped" });
  }
}
