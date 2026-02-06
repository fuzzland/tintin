import { describe, it } from "node:test";
import assert from "node:assert";
import type {
  ChatRequest,
  ChatResult,
  SessionAction,
  ActionContext,
  ActionResult,
  SessionInfo,
  SessionStatus,
} from "../../src/runtime/orchestrator/types.js";

describe("Orchestrator Types", () => {
  describe("ChatRequest", () => {
    it("should have required fields", () => {
      const request: ChatRequest = {
        platform: "telegram",
        chatId: "123",
        userId: "456",
        prompt: "Hello",
        language: "en",
      };
      assert.strictEqual(request.platform, "telegram");
      assert.strictEqual(request.chatId, "123");
      assert.strictEqual(request.userId, "456");
      assert.strictEqual(request.prompt, "Hello");
      assert.strictEqual(request.language, "en");
    });

    it("should support optional fields", () => {
      const request: ChatRequest = {
        platform: "slack",
        chatId: "123",
        userId: "456",
        prompt: "Hello",
        language: "zh",
        workspaceId: "workspace-123",
        isDirect: true,
        repoIds: ["repo-1", "repo-2"],
        agent: "claude_code",
        restoreSnapshotId: "snapshot-123",
      };
      assert.strictEqual(request.workspaceId, "workspace-123");
      assert.strictEqual(request.isDirect, true);
      assert.deepStrictEqual(request.repoIds, ["repo-1", "repo-2"]);
      assert.strictEqual(request.agent, "claude_code");
      assert.strictEqual(request.restoreSnapshotId, "snapshot-123");
    });
  });

  describe("ChatResult", () => {
    it("should represent successful result", () => {
      const result: ChatResult = {
        success: true,
        sessionId: "session-123",
        statusMessage: "Session started",
      };
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.sessionId, "session-123");
    });

    it("should represent queued result", () => {
      const result: ChatResult = {
        success: true,
        sessionId: "session-123",
        queued: true,
        pendingCount: 3,
        statusMessage: "Message queued",
      };
      assert.strictEqual(result.queued, true);
      assert.strictEqual(result.pendingCount, 3);
    });

    it("should represent error result", () => {
      const result: ChatResult = {
        success: false,
        error: "Something went wrong",
      };
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, "Something went wrong");
    });
  });

  describe("SessionAction", () => {
    it("should support stop action", () => {
      const action: SessionAction = { kind: "stop", sessionId: "session-123" };
      assert.strictEqual(action.kind, "stop");
      assert.strictEqual(action.sessionId, "session-123");
    });

    it("should support review action", () => {
      const action: SessionAction = { kind: "review", sessionId: "session-123" };
      assert.strictEqual(action.kind, "review");
    });

    it("should support commit action", () => {
      const action: SessionAction = { kind: "commit", sessionId: "session-123" };
      assert.strictEqual(action.kind, "commit");
    });

    it("should support run_status action", () => {
      const action: SessionAction = { kind: "run_status", runId: "run-123" };
      assert.strictEqual(action.kind, "run_status");
      assert.strictEqual(action.runId, "run-123");
    });

    it("should support stop_sandbox action", () => {
      const action: SessionAction = { kind: "stop_sandbox", sessionId: "session-123" };
      assert.strictEqual(action.kind, "stop_sandbox");
    });
  });

  describe("SessionInfo", () => {
    it("should have required fields", () => {
      const session: SessionInfo = {
        id: "session-123",
        status: "running",
        platform: "telegram",
        chatId: "chat-456",
        createdByUserId: "user-789",
        workspaceId: null,
        spaceId: null,
        language: "en",
      };
      assert.strictEqual(session.id, "session-123");
      assert.strictEqual(session.status, "running");
      assert.strictEqual(session.platform, "telegram");
    });

    it("should support all session statuses", () => {
      const statuses: SessionStatus[] = [
        "wizard",
        "starting",
        "running",
        "finished",
        "error",
        "killed",
      ];
      statuses.forEach((status) => {
        const session: SessionInfo = {
          id: "session-123",
          status,
          platform: "telegram",
          chatId: "chat-456",
          createdByUserId: "user-789",
          workspaceId: null,
          spaceId: null,
          language: "en",
        };
        assert.strictEqual(session.status, status);
      });
    });
  });

  describe("ActionContext", () => {
    it("should have required fields", () => {
      const context: ActionContext = {
        platform: "slack",
        chatId: "channel-123",
        userId: "user-456",
        language: "zh",
      };
      assert.strictEqual(context.platform, "slack");
      assert.strictEqual(context.chatId, "channel-123");
      assert.strictEqual(context.userId, "user-456");
      assert.strictEqual(context.language, "zh");
    });

    it("should support optional fields", () => {
      const context: ActionContext = {
        platform: "telegram",
        chatId: "chat-123",
        userId: "user-456",
        language: "en",
        workspaceId: "workspace-789",
        messageId: "msg-123",
        messageText: "Original message",
        interactionId: "callback-123",
        threadTs: "1234567890.123456",
      };
      assert.strictEqual(context.workspaceId, "workspace-789");
      assert.strictEqual(context.messageId, "msg-123");
      assert.strictEqual(context.interactionId, "callback-123");
    });
  });

  describe("ActionResult", () => {
    it("should represent handled action", () => {
      const result: ActionResult = {
        handled: true,
        response: "Session stopped",
      };
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.response, "Session stopped");
    });

    it("should represent ephemeral response", () => {
      const result: ActionResult = {
        handled: true,
        response: "Status fetched",
        ephemeral: true,
      };
      assert.strictEqual(result.ephemeral, true);
    });

    it("should represent error", () => {
      const result: ActionResult = {
        handled: true,
        error: "Failed to stop session",
      };
      assert.ok(result.error);
    });

    it("should represent unhandled action", () => {
      const result: ActionResult = {
        handled: false,
        error: "Unknown action",
      };
      assert.strictEqual(result.handled, false);
    });
  });
});
