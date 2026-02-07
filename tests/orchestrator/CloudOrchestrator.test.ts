import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import {
  CloudOrchestrator,
  createCloudOrchestrator,
} from "../../src/runtime/orchestrator/CloudOrchestrator.js";
import type {
  CloudOrchestratorDeps,
  CloudContext,
} from "../../src/runtime/orchestrator/CloudOrchestrator.js";
import type { Logger } from "../../src/runtime/log.js";
import type { AppConfig } from "../../src/runtime/config.js";
import type { CloudCommand } from "../../src/runtime/controller/commands.js";

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as Logger;
}

function createMockConfig(cloudEnabled: boolean = true): AppConfig {
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
    cloud: cloudEnabled ? { enabled: true } as AppConfig["cloud"] : undefined,
  } as AppConfig;
}

function createMockDeps(overrides: Partial<CloudOrchestratorDeps> = {}): CloudOrchestratorDeps {
  return {
    logger: createMockLogger(),
    config: createMockConfig(true),
    db: {} as any,
    cloudManager: overrides.cloudManager === null ? null : (overrides.cloudManager || {} as any),
    telegram: null,
    slack: null,
    sendPlatformMessage: mock.fn(async () => {}),
    resolveUserLanguage: mock.fn(async () => "en" as const),
    ...overrides,
  };
}

function createCloudContext(overrides: Partial<CloudContext> = {}): CloudContext {
  return {
    platform: "telegram",
    chatId: "chat-123",
    userId: "user-456",
    language: "en",
    workspaceId: null,
    isDirect: true,
    spaceId: "chat-123",
    ...overrides,
  };
}

describe("CloudOrchestrator", () => {
  let deps: CloudOrchestratorDeps;
  let orchestrator: CloudOrchestrator;

  beforeEach(() => {
    deps = createMockDeps();
    orchestrator = createCloudOrchestrator(deps);
  });

  describe("isEnabled", () => {
    it("should return true when cloud is enabled and cloudManager exists", () => {
      assert.strictEqual(orchestrator.isEnabled(), true);
    });

    it("should return false when cloudManager is null", () => {
      deps = createMockDeps({ cloudManager: null });
      orchestrator = createCloudOrchestrator(deps);
      assert.strictEqual(orchestrator.isEnabled(), false);
    });

    it("should return false when cloud config is disabled", () => {
      deps = createMockDeps({ config: createMockConfig(false) });
      orchestrator = createCloudOrchestrator(deps);
      assert.strictEqual(orchestrator.isEnabled(), false);
    });
  });

  describe("handle - when cloud disabled", () => {
    it("should return error when cloud is not enabled", async () => {
      deps = createMockDeps({ cloudManager: null });
      orchestrator = createCloudOrchestrator(deps);

      const ctx = createCloudContext();
      const command: CloudCommand = { kind: "repos" };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes("not enabled"));
    });
  });

  describe("handle - repos command", () => {
    it("should delegate to CloudHandler for repos command", async () => {
      const ctx = createCloudContext();
      const command: CloudCommand = { kind: "repos" };

      // This will fail because we don't have a real CloudHandler setup
      // but we can verify it doesn't throw and returns a result
      const result = await orchestrator.handle(ctx, command);

      // CloudHandler will return true (handled) but may not succeed due to mock setup
      assert.strictEqual(result.handled, true);
    });
  });

  describe("handle - run command", () => {
    it("should delegate to CloudHandler for run command", async () => {
      const ctx = createCloudContext();
      const command: CloudCommand = { kind: "action_run", prompt: "fix bug", repoIds: [] };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.handled, true);
    });
  });

  describe("handle - connect command", () => {
    it("should delegate to CloudHandler for connect command", async () => {
      const ctx = createCloudContext();
      const command: CloudCommand = { kind: "connect", provider: "github" };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.handled, true);
    });
  });

  describe("handle - secrets command", () => {
    it("should delegate to CloudHandler for secrets list", async () => {
      const ctx = createCloudContext();
      const command: CloudCommand = { kind: "secrets_list" };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.handled, true);
    });
  });

  describe("handle - snapshots command", () => {
    it("should delegate to CloudHandler for snapshot list", async () => {
      const ctx = createCloudContext();
      const command: CloudCommand = { kind: "snapshot_list" };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.handled, true);
    });
  });

  describe("Slack platform", () => {
    it("should handle cloud command for Slack", async () => {
      const ctx = createCloudContext({ platform: "slack", workspaceId: "W123" });
      const command: CloudCommand = { kind: "repos" };

      const result = await orchestrator.handle(ctx, command);

      assert.strictEqual(result.handled, true);
    });
  });

  describe("factory function", () => {
    it("createCloudOrchestrator should create instance", () => {
      const instance = createCloudOrchestrator(deps);
      assert.ok(instance instanceof CloudOrchestrator);
    });
  });
});
