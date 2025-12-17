import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppConfig, ClaudeCodeSection, CodexSection } from "./config.js";
import type { SessionAgent } from "./db.js";
import type { Logger } from "./log.js";
import type { PlaywrightServerInfo } from "./playwrightMcp.js";
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
    extraArgs?: string[];
  }): SpawnedAgentProcess;

  spawnResume(opts: {
    config: AppConfig;
    logger: Logger;
    cwd: string;
    sessionId: string;
    prompt: string;
    homeDir: string;
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

  buildPlaywrightCliArgs(opts: { server: PlaywrightServerInfo; playwrightStartupTimeoutSec: number }): string[];

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
      extraEnv: { CODEX_HOME: opts.homeDir },
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
      extraEnv: { CODEX_HOME: opts.homeDir },
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

  buildPlaywrightCliArgs: (opts) => {
    return [
      "--config",
      `mcp_servers.playwright.url="${opts.server.url}"`,
      "--config",
      `mcp_servers.playwright.enabled=true`,
      "--config",
      `mcp_servers.playwright.startup_timeout_sec=${Math.max(1, Math.floor(opts.playwrightStartupTimeoutSec))}`,
    ];
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
      extraEnv: { CLAUDE_CONFIG_DIR: opts.homeDir },
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
      extraEnv: { CLAUDE_CONFIG_DIR: opts.homeDir },
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

  buildPlaywrightCliArgs: (opts) => {
    const cfg = JSON.stringify({
      mcpServers: {
        playwright: {
          type: "http",
          url: opts.server.url,
        },
      },
    });
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

