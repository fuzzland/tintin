import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppConfig, ClaudeCodeSection, CodexSection } from "./config.js";
import type { SessionAgent } from "./db.js";
import type { Logger } from "./log.js";
import type { McpServerInfo } from "./mcp/types.js";
import {
  ensureSessionsRootExists,
  findSessionJsonlFiles,
  generateCodexTitle,
  resolveCodexHomeFromSessionsRoot,
  resolveSessionsRoot,
  spawnCodexExec,
  spawnCodexResume,
} from "./codex.js";
import {
  findClaudeSessionJsonlFiles,
  generateClaudeTitle,
  resolveClaudeConfigDirFromSessionsRoot,
  spawnClaudeExec,
  spawnClaudeResume,
} from "./claudeCode.js";

export interface SpawnedAgentProcess {
  child: ChildProcessWithoutNullStreams;
  agentSessionId: Promise<string>;
  debug: {
    kind: string;
    binary: string;
    cwd: string;
    args: string[];
    envOverrides: string[];
    stdoutTail: () => string;
    stderrTail: () => string;
  };
}

export interface AgentAdapter {
  readonly id: SessionAgent;
  readonly displayName: string;
  readonly shortName: string;

  isConfigured(config: AppConfig): boolean;
  requireConfig(config: AppConfig): CodexSection | ClaudeCodeSection;

  pollIntervalMs(config: AppConfig): number;
  timeoutSeconds(config: AppConfig): number;

  resolveSessionsRoot(cwd: string, config: AppConfig): string;
  resolveHomeDir(sessionsRoot: string): string;
  ensureSessionsRootExists(sessionsRoot: string): Promise<void>;

  spawnExec(opts: {
    config: AppConfig;
    logger: Logger;
    cwd: string;
    prompt: string;
    homeDir: string;
    extraEnv?: Record<string, string>;
    extraArgs?: string[];
  }): SpawnedAgentProcess;

  spawnResume(opts: {
    config: AppConfig;
    logger: Logger;
    cwd: string;
    sessionId: string;
    prompt: string;
    homeDir: string;
    extraEnv?: Record<string, string>;
    extraArgs?: string[];
  }): SpawnedAgentProcess;

  findSessionJsonlFiles(opts: {
    sessionsRoot: string;
    homeDir: string;
    cwd: string;
    sessionId: string;
    timeoutMs: number;
    pollMs: number;
  }): Promise<string[]>;

  buildMcpCliArgs(opts: { servers: Map<string, McpServerInfo>; globalTimeout: number }): string[];

  generateTitle(opts: {
    config: AppConfig;
    logger: Logger;
    cwd: string;
    projectName: string;
    initialPrompt: string;
    maxTitleChars: number;
    homeDir: string;
  }): Promise<string | null>;
}

const CodexAgent: AgentAdapter = {
  id: "codex",
  displayName: "Codex",
  shortName: "Codex",

  isConfigured: () => true,
  requireConfig: (config) => config.codex,

  pollIntervalMs: (config) => config.codex.poll_interval_ms,
  timeoutSeconds: (config) => config.codex.timeout_seconds,

  resolveSessionsRoot: (cwd, config) => resolveSessionsRoot(cwd, config.codex.sessions_dir),
  resolveHomeDir: (sessionsRoot) => resolveCodexHomeFromSessionsRoot(sessionsRoot),
  ensureSessionsRootExists: (sessionsRoot) => ensureSessionsRootExists(sessionsRoot),

  spawnExec: (opts) => {
    const spawned = spawnCodexExec({
      config: opts.config,
      logger: opts.logger,
      cwd: opts.cwd,
      prompt: opts.prompt,
      extraEnv: { CODEX_HOME: opts.homeDir, ...(opts.extraEnv ?? {}) },
      extraArgs: opts.extraArgs,
    });
    return { child: spawned.child, agentSessionId: spawned.threadId, debug: spawned.debug };
  },

  spawnResume: (opts) => {
    const spawned = spawnCodexResume({
      config: opts.config,
      logger: opts.logger,
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      prompt: opts.prompt,
      extraEnv: { CODEX_HOME: opts.homeDir, ...(opts.extraEnv ?? {}) },
      extraArgs: opts.extraArgs,
    });
    return { child: spawned.child, agentSessionId: spawned.threadId, debug: spawned.debug };
  },

  findSessionJsonlFiles: async (opts) => {
    return await findSessionJsonlFiles({
      sessionsRoot: opts.sessionsRoot,
      codexSessionId: opts.sessionId,
      timeoutMs: opts.timeoutMs,
      pollMs: opts.pollMs,
    });
  },

  buildMcpCliArgs: (opts) => {
    const args: string[] = [];
    const entries = Array.from(opts.servers.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [name, info] of entries) {
      const prefix = `mcp_servers.${name}`;
      if (info.transport === "stdio") {
        if (info.command) args.push("--config", `${prefix}.command=${JSON.stringify(info.command)}`);
        if (info.args) args.push("--config", `${prefix}.args=${JSON.stringify(info.args)}`);
        if (info.env) args.push("--config", `${prefix}.env=${JSON.stringify(info.env)}`);
      } else if (info.url) {
        args.push("--config", `${prefix}.url=${JSON.stringify(info.url)}`);
      }
      if (info.headers && Object.keys(info.headers).length > 0) {
        args.push("--config", `${prefix}.headers=${JSON.stringify(info.headers)}`);
      }
      args.push("--config", `${prefix}.enabled=true`);
      const timeout = info.startupTimeoutSec ?? opts.globalTimeout;
      if (timeout && Number.isFinite(timeout)) {
        args.push("--config", `${prefix}.startup_timeout_sec=${Math.max(1, Math.floor(timeout))}`);
      }
    }
    return args;
  },

  generateTitle: async (opts) => {
    return await generateCodexTitle({
      config: opts.config,
      logger: opts.logger,
      cwd: opts.cwd,
      projectName: opts.projectName,
      initialPrompt: opts.initialPrompt,
      maxTitleChars: opts.maxTitleChars,
      timeoutMs: 20_000,
    });
  },
};

const ClaudeCodeAgent: AgentAdapter = {
  id: "claude_code",
  displayName: "Claude Code",
  shortName: "CC",

  isConfigured: (config) => Boolean(config.claude_code),
  requireConfig: (config) => {
    const cc = config.claude_code;
    if (!cc) throw new Error("Claude Code is not configured. Add a [claude_code] section to config.toml.");
    return cc;
  },

  pollIntervalMs: (config) => (config.claude_code ? config.claude_code.poll_interval_ms : config.codex.poll_interval_ms),
  timeoutSeconds: (config) => (config.claude_code ? config.claude_code.timeout_seconds : config.codex.timeout_seconds),

  resolveSessionsRoot: (cwd, config) => {
    const cc = config.claude_code;
    const sessionsDir = cc ? cc.sessions_dir : ".claude/sessions";
    return resolveSessionsRoot(cwd, sessionsDir);
  },
  resolveHomeDir: (sessionsRoot) => resolveClaudeConfigDirFromSessionsRoot(sessionsRoot),
  ensureSessionsRootExists: (sessionsRoot) => ensureSessionsRootExists(sessionsRoot),

  spawnExec: (opts) => {
    const claude = ClaudeCodeAgent.requireConfig(opts.config);
    const sessionId = crypto.randomUUID();
    const spawned = spawnClaudeExec({
      claude,
      logger: opts.logger,
      cwd: opts.cwd,
      sessionId,
      prompt: opts.prompt,
      extraEnv: { CLAUDE_CONFIG_DIR: opts.homeDir, ...(opts.extraEnv ?? {}) },
      extraArgs: opts.extraArgs,
    });
    return { child: spawned.child, agentSessionId: spawned.sessionId, debug: spawned.debug };
  },

  spawnResume: (opts) => {
    const claude = ClaudeCodeAgent.requireConfig(opts.config);
    const spawned = spawnClaudeResume({
      claude,
      logger: opts.logger,
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      prompt: opts.prompt,
      extraEnv: { CLAUDE_CONFIG_DIR: opts.homeDir, ...(opts.extraEnv ?? {}) },
      extraArgs: opts.extraArgs,
    });
    return { child: spawned.child, agentSessionId: spawned.sessionId, debug: spawned.debug };
  },

  findSessionJsonlFiles: async (opts) => {
    return await findClaudeSessionJsonlFiles({
      configDir: opts.homeDir,
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      timeoutMs: opts.timeoutMs,
      pollMs: opts.pollMs,
    });
  },

  buildMcpCliArgs: (opts) => {
    const mcpServers: Record<string, Record<string, unknown>> = {};
    for (const [name, info] of opts.servers.entries()) {
      if (info.transport === "stdio") {
        if (!info.command) continue;
        mcpServers[name] = {
          type: "stdio",
          command: info.command,
          args: info.args ?? [],
          env: info.env ?? {},
        };
        continue;
      }
      if (!info.url) continue;
      mcpServers[name] = {
        type: info.transport,
        url: info.url,
      };
      if (info.headers && Object.keys(info.headers).length > 0) {
        mcpServers[name].headers = info.headers;
      }
    }
    const cfg = JSON.stringify({ mcpServers });
    return ["--mcp-config", cfg];
  },

  generateTitle: async (opts) => {
    const claude = ClaudeCodeAgent.requireConfig(opts.config);
    return await generateClaudeTitle({
      claude,
      logger: opts.logger,
      cwd: opts.cwd,
      projectName: opts.projectName,
      initialPrompt: opts.initialPrompt,
      maxTitleChars: opts.maxTitleChars,
      configDir: opts.homeDir,
      timeoutMs: 20_000,
    });
  },
};

const AGENTS: Record<SessionAgent, AgentAdapter> = {
  codex: CodexAgent,
  claude_code: ClaudeCodeAgent,
};

export function getAgentAdapter(agent: SessionAgent): AgentAdapter {
  return AGENTS[agent];
}
