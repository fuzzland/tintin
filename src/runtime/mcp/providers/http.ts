import type { HttpMcpProviderConfig } from "../config.js";
import type { McpProviderContext, McpServerInfo } from "../types.js";
import { BaseMcpProvider } from "./base.js";

export class HttpMcpProvider extends BaseMcpProvider<HttpMcpProviderConfig> {
  readonly type: "http" | "sse";

  constructor(name: string, type: "http" | "sse" = "http") {
    super(name, { id: name, transport: type, status: "stopped" });
    this.type = type;
  }

  override async init(config: HttpMcpProviderConfig, context: McpProviderContext): Promise<void> {
    await super.init(config, context);
    this.setInfo({
      transport: config.type,
      url: config.url,
      headers: config.headers,
      bearerTokenEnvVar: config.bearer_token_env_var,
    });
    if (typeof config.startup_timeout_sec === "number") {
      this.setInfo({ startupTimeoutSec: config.startup_timeout_sec });
    }
  }

  override async start(): Promise<McpServerInfo> {
    // HTTP/SSE providers are external; mark as ready for agent connection.
    this.setInfo({ status: "running" });
    return this.getServerInfo();
  }

  override async stop(): Promise<void> {
    this.setInfo({ status: "stopped" });
  }
}
