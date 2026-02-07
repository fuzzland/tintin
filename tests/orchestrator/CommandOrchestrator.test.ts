import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import {
  CommandOrchestrator,
  createCommandOrchestrator,
} from "../../src/runtime/orchestrator/CommandOrchestrator.js";
import type {
  CommandOrchestratorDeps,
  CommandContext,
  CommandType,
} from "../../src/runtime/orchestrator/CommandOrchestrator.js";
import type { Logger } from "../../src/runtime/log.js";
import type { AppConfig } from "../../src/runtime/config.js";

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as Logger;
}

function createMockConfig(): AppConfig {
  return {
    config_dir: "/tmp",
    bot: {
      name: "test-bot",
      host: "localhost",
      port: 8080,
      data_dir: "/tmp",
      github_repos_dir: "/tmp/repos",
      log_level: "info",
      message_verbosity: 2,
    },
    db: {
      url: "sqlite://:memory:",
      echo: false,
    },
    security: {
      restrict_paths: false,
      allow_roots: [],
      deny_globs: [],
      max_sessions_per_chat: 10,
      max_concurrent_sessions_per_chat: 3,
      telegram_allow_user_ids: [],
      telegram_allow_chat_ids: [],
      telegram_require_admin: false,
      slack_allow_user_ids: [],
      slack_allow_channel_ids: [],
      slack_allow_workspace_ids: [],
    },
    projects: [],
    codex: {
      binary: "codex",
      sessions_dir: "/tmp/sessions",
      timeout_seconds: 300,
      poll_interval_ms: 500,
      max_catchup_lines: 100,
      full_auto: false,
      dangerously_bypass_approvals_and_sandbox: false,
      skip_git_repo_check: false,
      env: {},
    },
    claude_code: {
      binary: "claude",
      sessions_dir: "/tmp/sessions",
      timeout_seconds: 300,
      poll_interval_ms: 500,
      max_catchup_lines: 100,
      full_auto: false,
      dangerously_bypass_approvals_and_sandbox: false,
      skip_git_repo_check: false,
      env: {},
    },
  } as AppConfig;
}

function createMockDeps(overrides: Partial<CommandOrchestratorDeps> = {}): CommandOrchestratorDeps {
  return {
    logger: createMockLogger(),
    config: createMockConfig(),
    db: {} as any,
    listSessions: mock.fn(async () => ({
      sessions: [],
      page: 1,
      limit: 10,
      hasMore: false,
    })),
    getOrCreateIdentity: mock.fn(async () => ({
      id: "identity-123",
      keepalive_minutes: null,
      message_verbosity: null,
      branch_name_rule: null,
      git_user_name: null,
      git_user_email: null,
    })),
    setUserLanguage: mock.fn(async () => {}),
    getDefaultAgent: mock.fn(() => "codex" as const),
    getVersion: mock.fn(() => "1.0.0"),
    ...overrides,
  };
}

function createCommandContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    platform: "telegram",
    chatId: "chat-123",
    userId: "user-456",
    language: "en",
    workspaceId: null,
    ...overrides,
  };
}

describe("CommandOrchestrator", () => {
  let deps: CommandOrchestratorDeps;
  let orchestrator: CommandOrchestrator;

  beforeEach(() => {
    deps = createMockDeps();
    orchestrator = createCommandOrchestrator(deps);
  });

  describe("handle - sessions command", () => {
    it("should list sessions with empty result", async () => {
      const ctx = createCommandContext();
      const command: CommandType = {
        kind: "sessions",
        intent: { page: 1 },
      };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, true);
      assert.ok(result.text);
    });

    it("should list sessions with filter", async () => {
      const ctx = createCommandContext();
      const command: CommandType = {
        kind: "sessions",
        intent: { statuses: ["running"], page: 1 },
      };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, true);
    });

    it("should list sessions with page", async () => {
      const ctx = createCommandContext();
      const command: CommandType = {
        kind: "sessions",
        intent: { page: 2 },
      };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, true);
    });
  });

  describe("handle - settings command", () => {
    it("should return settings list", async () => {
      const ctx = createCommandContext();
      const command: CommandType = {
        kind: "settings",
        command: { kind: "list" },
      };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, true);
      assert.ok(result.text.includes("codex"));
    });

    it("should handle settings set command", async () => {
      const ctx = createCommandContext();
      const command: CommandType = {
        kind: "settings",
        command: { kind: "set", target: "codex.timeout_seconds", value: "600" },
      };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, true);
    });
  });

  describe("handle - lang command", () => {
    it("should show language selection when no target", async () => {
      const ctx = createCommandContext();
      const command: CommandType = {
        kind: "lang",
      };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.showLanguageKeyboard, true);
    });

    it("should switch to English", async () => {
      const ctx = createCommandContext({ language: "zh" });
      const command: CommandType = {
        kind: "lang",
        target: "en",
      };

      // Mock db.updateTable
      deps.db = {
        updateTable: () => ({
          set: () => ({
            where: () => ({
              where: () => ({
                where: () => ({
                  execute: async () => {},
                }),
              }),
            }),
          }),
        }),
      } as any;

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, true);
      assert.ok(result.text.includes("English"));
    });

    it("should switch to Chinese", async () => {
      const ctx = createCommandContext();
      const command: CommandType = {
        kind: "lang",
        target: "zh",
      };

      deps.db = {
        updateTable: () => ({
          set: () => ({
            where: () => ({
              where: () => ({
                where: () => ({
                  execute: async () => {},
                }),
              }),
            }),
          }),
        }),
      } as any;

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, true);
      assert.ok(result.text.includes("Chinese") || result.text.includes("中文"));
    });

    it("should reject invalid language", async () => {
      const ctx = createCommandContext();
      const command: CommandType = {
        kind: "lang",
        target: "invalid",
      };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.showLanguageKeyboard, true);
    });
  });

  describe("handle - help command", () => {
    it("should return help text without cloud", async () => {
      const ctx = createCommandContext();
      const command: CommandType = { kind: "help" };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, true);
      assert.ok(result.text);
    });

    it("should return cloud help when cloud enabled", async () => {
      const cloudConfig = createMockConfig();
      cloudConfig.cloud = { enabled: true } as any;
      deps = createMockDeps({ config: cloudConfig });
      orchestrator = createCommandOrchestrator(deps);

      const ctx = createCommandContext();
      const command: CommandType = { kind: "help" };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, true);
      assert.ok(result.text.includes("Cloud") || result.text.includes("run"));
    });
  });

  describe("handle - version command", () => {
    it("should return version", async () => {
      const ctx = createCommandContext();
      const command: CommandType = { kind: "version" };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, true);
      assert.ok(result.text.includes("1.0.0"));
    });
  });

  describe("handle - kill command", () => {
    it("should return error when no session ID", async () => {
      const ctx = createCommandContext();
      const command: CommandType = { kind: "kill" };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, false);
    });

    it("should return error when kill not available", async () => {
      const ctx = createCommandContext();
      const command: CommandType = { kind: "kill", sessionId: "session-123" };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, false);
    });

    it("should return error when session not found", async () => {
      deps = createMockDeps({
        killSession: mock.fn(async () => false),
        findSession: mock.fn(async () => null),
      });
      orchestrator = createCommandOrchestrator(deps);

      const ctx = createCommandContext();
      const command: CommandType = { kind: "kill", sessionId: "session-123" };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, false);
    });

    it("should kill session successfully", async () => {
      deps = createMockDeps({
        killSession: mock.fn(async () => true),
        findSession: mock.fn(async () => ({
          id: "session-123",
          platform: "telegram",
          chat_id: "chat-123",
        })),
      });
      orchestrator = createCommandOrchestrator(deps);

      const ctx = createCommandContext();
      const command: CommandType = { kind: "kill", sessionId: "session-123" };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, true);
    });

    it("should reject kill for session in different chat", async () => {
      deps = createMockDeps({
        killSession: mock.fn(async () => true),
        findSession: mock.fn(async () => ({
          id: "session-123",
          platform: "telegram",
          chat_id: "different-chat",
        })),
      });
      orchestrator = createCommandOrchestrator(deps);

      const ctx = createCommandContext();
      const command: CommandType = { kind: "kill", sessionId: "session-123" };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, false);
    });
  });

  describe("Slack platform", () => {
    it("should handle sessions command for Slack", async () => {
      const ctx = createCommandContext({ platform: "slack", workspaceId: "W123" });
      const command: CommandType = {
        kind: "sessions",
        intent: { page: 1 },
      };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, true);
    });

    it("should show Slack-specific help", async () => {
      const ctx = createCommandContext({ platform: "slack" });
      const command: CommandType = { kind: "help" };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.success, true);
    });
  });
});
