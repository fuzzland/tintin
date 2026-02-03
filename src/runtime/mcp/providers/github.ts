import type { GitHubMcpProviderConfig } from "../config.js";
import type { IMcpProvider, McpProviderContext, McpServerInfo } from "../types.js";
import { BaseMcpProvider } from "./base.js";
import { HttpMcpProvider } from "./http.js";
import { StdioMcpProvider } from "./stdio.js";

export class GitHubMcpProvider extends BaseMcpProvider<GitHubMcpProviderConfig> {
  readonly type = "github";
  private delegate: IMcpProvider | null = null;

  constructor(name: string) {
    super(name, { id: name, transport: "stdio", status: "stopped" });
  }

  override async init(config: GitHubMcpProviderConfig, context: McpProviderContext): Promise<void> {
    await super.init(config, context);
    const token = config.token.trim();
    if (!token) {
      throw new Error(`[mcp.providers.${this.name}] token is required`);
    }

    const built = this.buildDelegate(config, token);
    this.delegate = built.provider;
    await this.delegate.init(built.config, context);
    this.setInfo(this.delegate.getServerInfo());
  }

  override async start(): Promise<McpServerInfo> {
    if (!this.delegate) throw new Error("GitHub MCP provider not initialized");
    const info = await this.delegate.start();
    this.setInfo(info);
    return info;
  }

  override async stop(): Promise<void> {
    if (this.delegate) await this.delegate.stop();
    if (this.delegate) this.setInfo(this.delegate.getServerInfo());
  }

  override getServerInfo(): McpServerInfo {
    return this.delegate ? this.delegate.getServerInfo() : this.info;
  }

  private baseEnv(token: string, config: GitHubMcpProviderConfig): Record<string, string> {
    const env: Record<string, string> = {
      GITHUB_PERSONAL_ACCESS_TOKEN: token,
    };
    if (config.github_host) {
      env.GITHUB_HOST = config.github_host;
    }
    if (config.toolsets && config.toolsets.length > 0) {
      env.GITHUB_TOOLSETS = config.toolsets.join(",");
    }
    return env;
  }

  private buildDelegate(
    config: GitHubMcpProviderConfig,
    token: string,
  ): {
    provider: IMcpProvider;
    config: Parameters<StdioMcpProvider["init"]>[0] | Parameters<HttpMcpProvider["init"]>[0];
  } {
    switch (config.mode) {
      case "docker":
        return this.buildDockerDelegate(config, token);
      case "binary":
        return this.buildBinaryDelegate(config, token);
      case "remote":
        return this.buildRemoteDelegate(config, token);
      default: {
        const unreachable: never = config.mode;
        throw new Error(`Unsupported GitHub MCP mode: ${String(unreachable)}`);
      }
    }
  }

  private buildDockerDelegate(
    config: GitHubMcpProviderConfig,
    token: string,
  ): { provider: StdioMcpProvider; config: Parameters<StdioMcpProvider["init"]>[0] } {
    const image = config.docker_image ?? "ghcr.io/github/github-mcp-server";
    const args = ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN"];
    if (config.github_host) {
      args.push("-e", "GITHUB_HOST");
    }
    if (config.toolsets && config.toolsets.length > 0) {
      args.push("-e", "GITHUB_TOOLSETS");
    }
    if (config.docker_args && config.docker_args.length > 0) {
      args.push(...config.docker_args);
    }
    args.push(image);

    const provider = new StdioMcpProvider(this.name);
    return {
      provider,
      config: {
        enabled: config.enabled,
        type: "stdio",
        command: "docker",
        args,
        env: this.baseEnv(token, config),
        startup_timeout_sec: config.startup_timeout_sec,
      },
    };
  }

  private buildBinaryDelegate(
    config: GitHubMcpProviderConfig,
    token: string,
  ): { provider: StdioMcpProvider; config: Parameters<StdioMcpProvider["init"]>[0] } {
    if (!config.binary_path) {
      throw new Error(`[mcp.providers.${this.name}] binary_path is required when mode="binary"`);
    }
    const args = (config.binary_args && config.binary_args.length > 0) ? config.binary_args : ["stdio"];
    const provider = new StdioMcpProvider(this.name);
    return {
      provider,
      config: {
        enabled: config.enabled,
        type: "stdio",
        command: config.binary_path,
        args,
        env: this.baseEnv(token, config),
        startup_timeout_sec: config.startup_timeout_sec,
      },
    };
  }

  private buildRemoteDelegate(
    config: GitHubMcpProviderConfig,
    token: string,
  ): { provider: HttpMcpProvider; config: Parameters<HttpMcpProvider["init"]>[0] } {
    const url = config.url ?? "https://api.githubcopilot.com/mcp/";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (config.github_host) {
      headers["X-GitHub-Host"] = config.github_host;
    }
    if (config.toolsets && config.toolsets.length > 0) {
      headers["X-GitHub-Toolsets"] = config.toolsets.join(",");
    }

    const provider = new HttpMcpProvider(this.name, "http");
    return {
      provider,
      config: {
        enabled: config.enabled,
        type: "http",
        url,
        headers,
        startup_timeout_sec: config.startup_timeout_sec,
      },
    };
  }
}
