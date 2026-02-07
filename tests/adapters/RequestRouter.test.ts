import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { RequestRouter, createRequestRouter } from "../../src/runtime/adapters/RequestRouter.js";
import type { RouterDeps, RoutingContext } from "../../src/runtime/adapters/RequestRouter.js";
import type { Logger } from "../../src/runtime/log.js";

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as Logger;
}

function createRoutingContext(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    platform: "telegram",
    chatId: "chat-123",
    spaceId: null,
    userId: "user-456",
    hasActiveWizard: false,
    activeSession: null,
    cloudEnabled: true,
    ...overrides,
  };
}

describe("RequestRouter", () => {
  let router: RequestRouter;
  let deps: RouterDeps;

  beforeEach(() => {
    deps = { logger: createMockLogger() };
    router = createRequestRouter(deps);
  });

  describe("detectIntent - wizard commands", () => {
    it("should detect /start as wizard start", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/start", ctx);

      assert.strictEqual(result.type, "wizard");
      if (result.type === "wizard") {
        assert.strictEqual(result.action, "start");
        assert.strictEqual(result.agent, undefined);
      }
    });

    it("should detect /codex as wizard start with codex agent", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/codex", ctx);

      assert.strictEqual(result.type, "wizard");
      if (result.type === "wizard") {
        assert.strictEqual(result.action, "start");
        assert.strictEqual(result.agent, "codex");
      }
    });

    it("should detect /cc as wizard start with claude_code agent", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/cc", ctx);

      assert.strictEqual(result.type, "wizard");
      if (result.type === "wizard") {
        assert.strictEqual(result.action, "start");
        assert.strictEqual(result.agent, "claude_code");
      }
    });

    it("should detect /claude as wizard start with claude_code agent", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/claude", ctx);

      assert.strictEqual(result.type, "wizard");
      if (result.type === "wizard") {
        assert.strictEqual(result.action, "start");
        assert.strictEqual(result.agent, "claude_code");
      }
    });
  });

  describe("detectIntent - local commands", () => {
    it("should detect /sessions command", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/sessions", ctx);

      assert.strictEqual(result.type, "command");
      if (result.type === "command") {
        assert.strictEqual(result.command.kind, "sessions");
      }
    });

    it("should detect /sessions with page number", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/sessions 2", ctx);

      assert.strictEqual(result.type, "command");
      if (result.type === "command" && result.command.kind === "sessions") {
        assert.strictEqual(result.command.intent.page, 2);
      }
    });

    it("should detect /sessions with status filter", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/sessions running", ctx);

      assert.strictEqual(result.type, "command");
      if (result.type === "command" && result.command.kind === "sessions") {
        assert.deepStrictEqual(result.command.intent.statuses, ["running"]);
      }
    });

    it("should detect /settings command", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/settings", ctx);

      assert.strictEqual(result.type, "command");
      if (result.type === "command") {
        assert.strictEqual(result.command.kind, "settings");
      }
    });

    it("should detect /settings set command", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/settings set agent codex", ctx);

      assert.strictEqual(result.type, "command");
      if (result.type === "command" && result.command.kind === "settings") {
        assert.deepStrictEqual(result.command.command, {
          kind: "set",
          target: "agent",
          value: "codex",
        });
      }
    });

    it("should detect /lang command", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/lang", ctx);

      assert.strictEqual(result.type, "command");
      if (result.type === "command") {
        assert.strictEqual(result.command.kind, "lang");
      }
    });

    it("should detect /lang with target", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/lang zh", ctx);

      assert.strictEqual(result.type, "command");
      if (result.type === "command" && result.command.kind === "lang") {
        assert.strictEqual(result.command.target, "zh");
      }
    });

    it("should detect /help command", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/help", ctx);

      assert.strictEqual(result.type, "command");
      if (result.type === "command") {
        assert.strictEqual(result.command.kind, "help");
      }
    });

    it("should detect /kill command", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/kill", ctx);

      assert.strictEqual(result.type, "command");
      if (result.type === "command") {
        assert.strictEqual(result.command.kind, "kill");
      }
    });

    it("should detect /stop as kill command", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/stop session-123", ctx);

      assert.strictEqual(result.type, "command");
      if (result.type === "command" && result.command.kind === "kill") {
        assert.strictEqual(result.command.sessionId, "session-123");
      }
    });
  });

  describe("detectIntent - cloud commands", () => {
    it("should detect /run command", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/run fix the bug", ctx);

      assert.strictEqual(result.type, "cloud");
      if (result.type === "cloud") {
        assert.strictEqual(result.command.kind, "action_run");
        if (result.command.kind === "action_run") {
          assert.strictEqual(result.command.prompt, "fix the bug");
        }
      }
    });

    it("should detect /repos command", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/repos", ctx);

      assert.strictEqual(result.type, "cloud");
      if (result.type === "cloud") {
        assert.strictEqual(result.command.kind, "repos");
      }
    });

    it("should detect /repo select command", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/repo 3", ctx);

      assert.strictEqual(result.type, "cloud");
      if (result.type === "cloud") {
        assert.strictEqual(result.command.kind, "repo_select");
        if (result.command.kind === "repo_select") {
          assert.strictEqual(result.command.target, "3");
        }
      }
    });

    it("should detect /connect command", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/connect github", ctx);

      assert.strictEqual(result.type, "cloud");
      if (result.type === "cloud") {
        assert.strictEqual(result.command.kind, "connect");
        if (result.command.kind === "connect") {
          assert.strictEqual(result.command.provider, "github");
        }
      }
    });

    it("should detect /secrets command", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/secrets", ctx);

      assert.strictEqual(result.type, "cloud");
      if (result.type === "cloud") {
        assert.strictEqual(result.command.kind, "secrets_list");
      }
    });

    it("should detect /secrets set command", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/secrets set API_KEY=abc123", ctx);

      assert.strictEqual(result.type, "cloud");
      if (result.type === "cloud") {
        assert.strictEqual(result.command.kind, "secrets_set");
        if (result.command.kind === "secrets_set") {
          assert.strictEqual(result.command.name, "API_KEY");
          assert.strictEqual(result.command.value, "abc123");
        }
      }
    });

    it("should not detect cloud commands when cloud disabled", async () => {
      const ctx = createRoutingContext({ cloudEnabled: false });
      const result = await router.detectIntent("/run fix bug", ctx);

      assert.strictEqual(result.type, "unknown");
    });
  });

  describe("detectIntent - session messages", () => {
    it("should detect session message when active session exists", async () => {
      const ctx = createRoutingContext({
        activeSession: {
          id: "session-123",
          status: "running",
          platform: "telegram",
          chatId: "chat-123",
          createdByUserId: "user-456",
          workspaceId: null,
          spaceId: null,
          language: "en",
        },
      });
      const result = await router.detectIntent("add unit tests", ctx);

      assert.strictEqual(result.type, "session");
      if (result.type === "session") {
        assert.strictEqual(result.prompt, "add unit tests");
      }
    });

    it("should return unknown when no session and not a command", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("random text", ctx);

      assert.strictEqual(result.type, "unknown");
    });
  });

  describe("detectIntent - wizard continuation", () => {
    it("should detect wizard continue when in wizard mode", async () => {
      const ctx = createRoutingContext({ hasActiveWizard: true });
      const result = await router.detectIntent("some input", ctx);

      assert.strictEqual(result.type, "wizard");
      if (result.type === "wizard") {
        assert.strictEqual(result.action, "continue");
      }
    });

    it("should detect project selection in wizard mode", async () => {
      const ctx = createRoutingContext({ hasActiveWizard: true });
      const result = await router.detectIntent("2", ctx);

      assert.strictEqual(result.type, "wizard");
      if (result.type === "wizard") {
        assert.strictEqual(result.action, "project_select");
        assert.strictEqual(result.projectId, "2");
      }
    });

    it("should detect path input in wizard mode", async () => {
      const ctx = createRoutingContext({ hasActiveWizard: true });
      const result = await router.detectIntent("/path/to/project", ctx);

      assert.strictEqual(result.type, "wizard");
      if (result.type === "wizard") {
        assert.strictEqual(result.action, "path_input");
        assert.strictEqual(result.path, "/path/to/project");
      }
    });
  });

  describe("edge cases", () => {
    it("should handle empty string", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("", ctx);

      assert.strictEqual(result.type, "unknown");
    });

    it("should handle whitespace only", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("   ", ctx);

      assert.strictEqual(result.type, "unknown");
    });

    it("should handle case insensitive commands", async () => {
      const ctx = createRoutingContext();
      const result = await router.detectIntent("/SESSIONS", ctx);

      assert.strictEqual(result.type, "command");
      if (result.type === "command") {
        assert.strictEqual(result.command.kind, "sessions");
      }
    });
  });
});
