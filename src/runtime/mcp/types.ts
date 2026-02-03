import type { Logger } from "../log.js";

export type McpTransport = "stdio" | "http" | "sse";
export type McpServerStatus = "starting" | "running" | "error" | "stopped";

export interface McpServerInfo {
  id: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  bearerTokenEnvVar?: string;
  bearerToken?: string;
  status: McpServerStatus;
  startupTimeoutSec?: number;
}

export interface McpProviderContext {
  logger: Logger;
  workspaceDir: string;
  globalConfig: Record<string, unknown>;
}

export interface IMcpProvider<TConfig = unknown> {
  readonly type: string;
  readonly name: string;

  init(config: TConfig, context: McpProviderContext): Promise<void>;
  bootstrap?(): Promise<void>;
  start(): Promise<McpServerInfo>;
  stop(): Promise<void>;
  destroy?(): Promise<void>;
  getServerInfo(): McpServerInfo;
}

export interface McpScreenshotProvider {
  takeScreenshot(opts: { sessionId: string; callId?: string; tool?: string }): Promise<{
    savedPath?: string;
    mimeType?: string;
  } | null>;
}
