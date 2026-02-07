import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { SessionOrchestrator } from "../../src/runtime/orchestrator/SessionOrchestrator.js";
import type {
  OrchestratorDeps,
  ChatRequest,
  SessionInfo,
  ActionContext,
  ResumeResult,
  RestartResult,
} from "../../src/runtime/orchestrator/types.js";
import type { Logger } from "../../src/runtime/log.js";

function createMockDeps(): OrchestratorDeps {
  return {
    enqueueMessage: mock.fn(async () => {}),
    countPendingMessages: mock.fn(async () => 1),
    resumeCloudSession: mock.fn(async (): Promise<ResumeResult> => "resumed"),
    restartCloudSession: mock.fn(async (): Promise<RestartResult> => "restarted"),
    resumeLocalSession: mock.fn(async () => {}),
    isCloudSession: mock.fn(async () => false),
    stopCloudSandbox: mock.fn(async () => {}),
    killLocalSession: mock.fn(async () => {}),
    getSession: mock.fn(async () => null),
    getCloudRunStatus: mock.fn(async () => null),
  };
}

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as Logger;
}

function createSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "session-123",
    status: "running",
    platform: "telegram",
    chatId: "chat-456",
    createdByUserId: "user-789",
    workspaceId: null,
    spaceId: null,
    language: "en",
    ...overrides,
  };
}

function createChatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    platform: "telegram",
    chatId: "chat-456",
    userId: "user-789",
    prompt: "Hello world",
    language: "en",
    ...overrides,
  };
}

function createActionContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    platform: "telegram",
    chatId: "chat-456",
    userId: "user-789",
    language: "en",
    ...overrides,
  };
}

// Helper type for extracting mock from deps
type MockedDeps = OrchestratorDeps & {
  [K in keyof OrchestratorDeps]: OrchestratorDeps[K] & { mock: { calls: Array<{ arguments: unknown[] }> } };
};

describe("SessionOrchestrator", () => {
  let deps: MockedDeps;
  let logger: Logger;
  let orchestrator: SessionOrchestrator;

  beforeEach(() => {
    deps = createMockDeps() as MockedDeps;
    logger = createMockLogger();
    orchestrator = new SessionOrchestrator(deps, logger);
  });

  describe("handleSessionMessage", () => {
    describe("when session is busy", () => {
      it("should queue message when session is running", async () => {
        const session = createSession({ status: "running" });
        const request = createChatRequest();

        const result = await orchestrator.handleSessionMessage(session, request);

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.queued, true);
        assert.strictEqual(result.pendingCount, 1);
        assert.strictEqual(deps.enqueueMessage.mock.calls.length, 1);
        assert.deepStrictEqual(deps.enqueueMessage.mock.calls[0]!.arguments, [
          "session-123",
          "user-789",
          "Hello world",
        ]);
      });

      it("should queue message when session is starting", async () => {
        const session = createSession({ status: "starting" });
        const request = createChatRequest();

        const result = await orchestrator.handleSessionMessage(session, request);

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.queued, true);
      });

      it("should return correct pending count", async () => {
        deps.countPendingMessages = mock.fn(async () => 5);
        const session = createSession({ status: "running" });
        const request = createChatRequest();

        const result = await orchestrator.handleSessionMessage(session, request);

        assert.strictEqual(result.pendingCount, 5);
      });
    });

    describe("when session is finished (local)", () => {
      it("should resume local session", async () => {
        const session = createSession({ status: "finished" });
        const request = createChatRequest();
        deps.isCloudSession = mock.fn(async () => false);

        const result = await orchestrator.handleSessionMessage(session, request);

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.sessionId, "session-123");
        assert.strictEqual(deps.resumeLocalSession.mock.calls.length, 1);
      });

      it("should return error if local resume fails", async () => {
        const session = createSession({ status: "finished" });
        const request = createChatRequest();
        deps.isCloudSession = mock.fn(async () => false);
        deps.resumeLocalSession = mock.fn(async () => {
          throw new Error("Resume failed");
        });

        const result = await orchestrator.handleSessionMessage(session, request);

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes("Resume failed"));
      });
    });

    describe("when session is finished (cloud)", () => {
      it("should resume cloud session", async () => {
        const session = createSession({ status: "finished" });
        const request = createChatRequest();
        deps.isCloudSession = mock.fn(async () => true) as MockedDeps["isCloudSession"];
        deps.resumeCloudSession = mock.fn(async (): Promise<ResumeResult> => "resumed") as MockedDeps["resumeCloudSession"];

        const result = await orchestrator.handleSessionMessage(session, request);

        assert.strictEqual(result.success, true);
        assert.strictEqual(deps.resumeCloudSession.mock.calls.length, 1);
      });

      it("should restart expired cloud session", async () => {
        const session = createSession({ status: "finished" });
        const request = createChatRequest();
        deps.isCloudSession = mock.fn(async () => true) as MockedDeps["isCloudSession"];
        deps.resumeCloudSession = mock.fn(async (): Promise<ResumeResult> => "expired") as MockedDeps["resumeCloudSession"];
        deps.restartCloudSession = mock.fn(async (): Promise<RestartResult> => "restarted") as MockedDeps["restartCloudSession"];

        const result = await orchestrator.handleSessionMessage(session, request);

        assert.strictEqual(result.success, true);
        assert.strictEqual(deps.restartCloudSession.mock.calls.length, 1);
      });

      it("should return error if restart fails", async () => {
        const session = createSession({ status: "finished" });
        const request = createChatRequest();
        deps.isCloudSession = mock.fn(async () => true) as MockedDeps["isCloudSession"];
        deps.resumeCloudSession = mock.fn(async (): Promise<ResumeResult> => "expired") as MockedDeps["resumeCloudSession"];
        deps.restartCloudSession = mock.fn(async (): Promise<RestartResult> => {
          throw new Error("Restart failed");
        }) as MockedDeps["restartCloudSession"];

        const result = await orchestrator.handleSessionMessage(session, request);

        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes("Restart failed"));
      });

      it("should return error if resume returns not_found", async () => {
        const session = createSession({ status: "finished" });
        const request = createChatRequest();
        deps.isCloudSession = mock.fn(async () => true) as MockedDeps["isCloudSession"];
        deps.resumeCloudSession = mock.fn(async (): Promise<ResumeResult> => "not_found") as MockedDeps["resumeCloudSession"];

        const result = await orchestrator.handleSessionMessage(session, request);

        assert.strictEqual(result.success, false);
      });
    });
  });

  describe("handleAction", () => {
    describe("stop action", () => {
      it("should stop running cloud session", async () => {
        deps.getSession = mock.fn(async () => createSession({ status: "running" }));
        deps.isCloudSession = mock.fn(async () => true);
        const context = createActionContext();

        const result = await orchestrator.handleAction(
          { kind: "kill", sessionId: "session-123" },
          context,
        );

        assert.strictEqual(result.handled, true);
        assert.strictEqual(deps.stopCloudSandbox.mock.calls.length, 1);
      });

      it("should kill running local session", async () => {
        deps.getSession = mock.fn(async () => createSession({ status: "running" }));
        deps.isCloudSession = mock.fn(async () => false);
        const context = createActionContext();

        const result = await orchestrator.handleAction(
          { kind: "kill", sessionId: "session-123" },
          context,
        );

        assert.strictEqual(result.handled, true);
        assert.strictEqual(deps.killLocalSession.mock.calls.length, 1);
      });

      it("should return not found for missing session", async () => {
        deps.getSession = mock.fn(async () => null);
        const context = createActionContext();

        const result = await orchestrator.handleAction(
          { kind: "kill", sessionId: "session-123" },
          context,
        );

        assert.strictEqual(result.handled, true);
        assert.ok(result.response);
      });

      it("should return already finished for terminal session", async () => {
        deps.getSession = mock.fn(async () => createSession({ status: "finished" }));
        const context = createActionContext();

        const result = await orchestrator.handleAction(
          { kind: "kill", sessionId: "session-123" },
          context,
        );

        assert.strictEqual(result.handled, true);
      });

      it("should return error on stop failure", async () => {
        deps.getSession = mock.fn(async () => createSession({ status: "running" }));
        deps.isCloudSession = mock.fn(async () => true);
        deps.stopCloudSandbox = mock.fn(async () => {
          throw new Error("Stop failed");
        });
        const context = createActionContext();

        const result = await orchestrator.handleAction(
          { kind: "kill", sessionId: "session-123" },
          context,
        );

        assert.strictEqual(result.handled, true);
        assert.ok(result.error);
      });
    });

    describe("review action", () => {
      it("should return starting review response", async () => {
        deps.getSession = mock.fn(async () => createSession());
        const context = createActionContext();

        const result = await orchestrator.handleAction(
          { kind: "review", sessionId: "session-123" },
          context,
        );

        assert.strictEqual(result.handled, true);
        assert.ok(result.response);
        assert.strictEqual(result.ephemeral, true);
      });

      it("should return not found for missing session", async () => {
        deps.getSession = mock.fn(async () => null);
        const context = createActionContext();

        const result = await orchestrator.handleAction(
          { kind: "review", sessionId: "session-123" },
          context,
        );

        assert.strictEqual(result.handled, true);
      });
    });

    describe("commit action", () => {
      it("should return committing response", async () => {
        deps.getSession = mock.fn(async () => createSession());
        const context = createActionContext();

        const result = await orchestrator.handleAction(
          { kind: "commit", sessionId: "session-123" },
          context,
        );

        assert.strictEqual(result.handled, true);
        assert.ok(result.response);
        assert.strictEqual(result.ephemeral, true);
      });
    });

    describe("run_status action", () => {
      it("should return run status", async () => {
        deps.getCloudRunStatus = mock.fn(async () => ({
          status: "running",
          message: "Run is in progress",
        }));
        const context = createActionContext();

        const result = await orchestrator.handleAction(
          { kind: "run_status", runId: "run-123" },
          context,
        );

        assert.strictEqual(result.handled, true);
        assert.strictEqual(result.response, "Run is in progress");
      });

      it("should return not found for missing run", async () => {
        deps.getCloudRunStatus = mock.fn(async () => null);
        const context = createActionContext();

        const result = await orchestrator.handleAction(
          { kind: "run_status", runId: "run-123" },
          context,
        );

        assert.strictEqual(result.handled, true);
      });
    });

    describe("stop_sandbox action", () => {
      it("should stop sandbox", async () => {
        const context = createActionContext();

        const result = await orchestrator.handleAction(
          { kind: "stop_sandbox", sessionId: "session-123" },
          context,
        );

        assert.strictEqual(result.handled, true);
        assert.strictEqual(deps.stopCloudSandbox.mock.calls.length, 1);
      });

      it("should return error on failure", async () => {
        deps.stopCloudSandbox = mock.fn(async () => {
          throw new Error("Sandbox error");
        });
        const context = createActionContext();

        const result = await orchestrator.handleAction(
          { kind: "stop_sandbox", sessionId: "session-123" },
          context,
        );

        assert.strictEqual(result.handled, true);
        assert.ok(result.error);
      });
    });
  });

  describe("helper methods", () => {
    it("should correctly identify busy sessions", () => {
      assert.strictEqual(
        orchestrator.isSessionBusy(createSession({ status: "running" })),
        true,
      );
      assert.strictEqual(
        orchestrator.isSessionBusy(createSession({ status: "starting" })),
        true,
      );
      assert.strictEqual(
        orchestrator.isSessionBusy(createSession({ status: "finished" })),
        false,
      );
    });

    it("should correctly identify terminal sessions", () => {
      assert.strictEqual(
        orchestrator.isSessionTerminal(createSession({ status: "finished" })),
        true,
      );
      assert.strictEqual(
        orchestrator.isSessionTerminal(createSession({ status: "error" })),
        true,
      );
      assert.strictEqual(
        orchestrator.isSessionTerminal(createSession({ status: "killed" })),
        true,
      );
      assert.strictEqual(
        orchestrator.isSessionTerminal(createSession({ status: "running" })),
        false,
      );
    });
  });
});
