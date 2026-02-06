import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { BaseAdapter } from "../../src/runtime/adapters/BaseAdapter.js";
import type { ChatResult, ActionResult } from "../../src/runtime/orchestrator/types.js";
import type { MessageContext, ResponseStrategy } from "../../src/runtime/adapters/types.js";
import type { Logger } from "../../src/runtime/log.js";

function createMockLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: mock.fn(() => {}),
    error: () => {},
  };
}

// Concrete implementation for testing
class TestAdapter extends BaseAdapter {
  readonly platform = "telegram" as const;

  async sendResponse(_ctx: MessageContext, _result: ChatResult): Promise<void> {
    // No-op for testing
  }
}

describe("BaseAdapter", () => {
  let adapter: TestAdapter;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    adapter = new TestAdapter(mockLogger as Logger);
  });

  describe("toChatRequest", () => {
    it("should convert message context to ChatRequest", () => {
      const ctx: MessageContext = {
        platform: "telegram",
        chatId: "123456",
        userId: "user-123",
        language: "en",
        workspaceId: null,
        isDirect: true,
      };
      const result = adapter.toChatRequest(ctx, "Hello world");

      assert.strictEqual(result.platform, "telegram");
      assert.strictEqual(result.chatId, "123456");
      assert.strictEqual(result.userId, "user-123");
      assert.strictEqual(result.prompt, "Hello world");
      assert.strictEqual(result.language, "en");
      assert.strictEqual(result.workspaceId, null);
      assert.strictEqual(result.isDirect, true);
    });
  });

  describe("sendActionResponse", () => {
    it("should do nothing for unhandled action", async () => {
      const sendMessage = mock.fn(async () => {});
      const sendEphemeral = mock.fn(async () => {});
      const responder: ResponseStrategy = {
        sendMessage,
        sendEphemeral,
      };

      await adapter.sendActionResponse({ handled: false }, responder);

      assert.strictEqual(sendMessage.mock.calls.length, 0);
      assert.strictEqual(sendEphemeral.mock.calls.length, 0);
      assert.strictEqual(mockLogger.warn.mock.calls.length, 1);
    });

    it("should send ephemeral for error", async () => {
      const sendMessage = mock.fn(async () => {});
      const sendEphemeral = mock.fn(async () => {});
      const responder: ResponseStrategy = {
        sendMessage,
        sendEphemeral,
      };

      const result: ActionResult = {
        handled: true,
        error: "Something went wrong",
      };

      await adapter.sendActionResponse(result, responder);

      assert.strictEqual(sendEphemeral.mock.calls.length, 1);
      const args = sendEphemeral.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[0], "Something went wrong");
    });

    it("should send ephemeral for ephemeral response", async () => {
      const sendMessage = mock.fn(async () => {});
      const sendEphemeral = mock.fn(async () => {});
      const responder: ResponseStrategy = {
        sendMessage,
        sendEphemeral,
      };

      const result: ActionResult = {
        handled: true,
        response: "Status fetched",
        ephemeral: true,
      };

      await adapter.sendActionResponse(result, responder);

      assert.strictEqual(sendEphemeral.mock.calls.length, 1);
      const args = sendEphemeral.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[0], "Status fetched");
    });

    it("should send regular message for non-ephemeral response", async () => {
      const sendMessage = mock.fn(async () => {});
      const sendEphemeral = mock.fn(async () => {});
      const responder: ResponseStrategy = {
        sendMessage,
        sendEphemeral,
      };

      const result: ActionResult = {
        handled: true,
        response: "Session stopped",
      };

      await adapter.sendActionResponse(result, responder);

      assert.strictEqual(sendMessage.mock.calls.length, 1);
      const args = sendMessage.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[0], "Session stopped");
    });

    it("should do nothing for handled without response", async () => {
      const sendMessage = mock.fn(async () => {});
      const sendEphemeral = mock.fn(async () => {});
      const responder: ResponseStrategy = {
        sendMessage,
        sendEphemeral,
      };

      await adapter.sendActionResponse({ handled: true }, responder);

      assert.strictEqual(sendMessage.mock.calls.length, 0);
      assert.strictEqual(sendEphemeral.mock.calls.length, 0);
    });
  });

  describe("buildStatusMessage (protected)", () => {
    it("should return error when present", () => {
      const message = (adapter as any).buildStatusMessage(
        { success: false, error: "Error message" },
        "en",
      );

      assert.strictEqual(message, "Error message");
    });

    it("should return queued message", () => {
      const message = (adapter as any).buildStatusMessage(
        { success: true, queued: true, pendingCount: 3 },
        "en",
      );

      assert.ok(message.includes("3"));
    });

    it("should return statusMessage", () => {
      const message = (adapter as any).buildStatusMessage(
        { success: true, statusMessage: "Session started" },
        "en",
      );

      assert.strictEqual(message, "Session started");
    });

    it("should return empty string when no message", () => {
      const message = (adapter as any).buildStatusMessage({ success: true }, "en");

      assert.strictEqual(message, "");
    });
  });
});
