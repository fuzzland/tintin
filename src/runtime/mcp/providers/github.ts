import type { GitHubMcpProviderConfig } from "../config.js";
import type { McpProviderContext, McpServerInfo } from "../types.js";
import { BaseMcpProvider } from "./base.js";

export class GitHubMcpProvider extends BaseMcpProvider<GitHubMcpProviderConfig> {
  readonly type = "github";

  constructor(name: string) {
    super(name, { id: name, transport: "http", status: "stopped" });
  }

  override async init(config: GitHubMcpProviderConfig, context: McpProviderContext): Promise<void> {
    await super.init(config, context);
    const url = "https://api.githubcopilot.com/mcp/";
    const headers: Record<string, string> = {};
    if (config.github_host) {
      headers["X-GitHub-Host"] = config.github_host;
    }
    if (config.toolsets && config.toolsets.length > 0) {
      headers["X-MCP-Toolsets"] = config.toolsets.join(",");
    }
    this.setInfo({
      transport: "http",
      url,
      headers,
    });
  }

  override async start(): Promise<McpServerInfo> {
    throw new Error(
      `[mcp.providers.${this.name}] GitHub MCP uses per-user tokens. Configure tokens with "/mcp github token set <token>".`,
    );
  }

  override async stop(): Promise<void> {
    this.setInfo({ status: "stopped" });
  }

  override getServerInfo(): McpServerInfo {
    return this.info;
  }
}
