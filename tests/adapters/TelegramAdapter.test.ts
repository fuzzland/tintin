import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { TelegramAdapter } from "../../src/runtime/adapters/TelegramAdapter.js";
import type { TelegramAdapterDeps } from "../../src/runtime/adapters/TelegramAdapter.js";
import type { TelegramMessageContext, TelegramCallbackContext } from "../../src/runtime/adapters/types.js";
import type { Logger } from "../../src/runtime/log.js";

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as Logger;
}

interface MockTelegram {
  sendMessage: ReturnType<typeof mock.fn>;
  answerCallbackQuery: ReturnType<typeof mock.fn>;
  editMessageText: ReturnType<typeof mock.fn>;
}

function createMockTelegram(): MockTelegram {
  return {
    sendMessage: mock.fn(async () => {}),
    answerCallbackQuery: mock.fn(async () => {}),
    editMessageText: mock.fn(async () => {}),
  };
}

function createMessageContext(overrides: Partial<TelegramMessageContext> = {}): TelegramMessageContext {
  return {
    platform: "telegram",
    chatId: "123456",
    userId: "user-123",
    language: "en",
    replyToMessageId: 100,
    messageThreadId: undefined,
    ...overrides,
  };
}

function createCallbackContext(overrides: Partial<TelegramCallbackContext> = {}): TelegramCallbackContext {
  return {
    callbackQueryId: "callback-123",
    chatId: "123456",
    userId: "user-123",
    messageId: 200,
    data: "kill:session-abc",
    language: "en",
    ...overrides,
  };
}

describe("TelegramAdapter", () => {
  let adapter: TelegramAdapter;
  let mockTelegram: MockTelegram;
  let mockLogger: Logger;

  beforeEach(() => {
    mockTelegram = createMockTelegram();
    mockLogger = createMockLogger();
    const deps: TelegramAdapterDeps = {
      telegram: mockTelegram as any,
      logger: mockLogger,
    };
    adapter = new TelegramAdapter(deps);
  });

  describe("toChatRequest", () => {
    it("should convert message context to ChatRequest", () => {
      const ctx = createMessageContext();
      const result = adapter.toChatRequest(ctx, "Hello world");

      assert.strictEqual(result.platform, "telegram");
      assert.strictEqual(result.chatId, "123456");
      assert.strictEqual(result.userId, "user-123");
      assert.strictEqual(result.prompt, "Hello world");
      assert.strictEqual(result.language, "en");
      assert.strictEqual(result.workspaceId, null);
    });

    it("should include isDirect when provided", () => {
      const ctx = createMessageContext({ isDirect: true });
      const result = adapter.toChatRequest(ctx, "Hello");

      assert.strictEqual(result.isDirect, true);
    });
  });

  describe("sendResponse", () => {
    it("should send message for successful result", async () => {
      const ctx = createMessageContext();
      await adapter.sendResponse(ctx, {
        success: true,
        statusMessage: "Session started",
      });

      assert.strictEqual(mockTelegram.sendMessage.mock.calls.length, 1);
      const args = mockTelegram.sendMessage.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[0].chatId, "123456");
      assert.strictEqual(args[0].text, "Session started");
    });

    it("should send error message", async () => {
      const ctx = createMessageContext();
      await adapter.sendResponse(ctx, {
        success: false,
        error: "Session not found",
      });

      assert.strictEqual(mockTelegram.sendMessage.mock.calls.length, 1);
      const args = mockTelegram.sendMessage.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[0].text, "Session not found");
    });

    it("should not send if no message", async () => {
      const ctx = createMessageContext();
      await adapter.sendResponse(ctx, { success: true });

      assert.strictEqual(mockTelegram.sendMessage.mock.calls.length, 0);
    });

    it("should not send if telegram is null", async () => {
      const deps: TelegramAdapterDeps = {
        telegram: null,
        logger: mockLogger,
      };
      const nullAdapter = new TelegramAdapter(deps);
      const ctx = createMessageContext();

      await nullAdapter.sendResponse(ctx, {
        success: true,
        statusMessage: "Test",
      });
      // Should not throw
    });
  });

  describe("parseCallback", () => {
    it("should parse kill action", () => {
      const result = adapter.parseCallback("kill:session-123");
      assert.deepStrictEqual(result, { kind: "kill", sessionId: "session-123" });
    });

    it("should parse review action", () => {
      const result = adapter.parseCallback("review:session-456");
      assert.deepStrictEqual(result, { kind: "review", sessionId: "session-456" });
    });

    it("should return null for unknown action", () => {
      const result = adapter.parseCallback("unknown:value");
      assert.strictEqual(result, null);
    });
  });

  describe("createCallbackResponder", () => {
    it("should create responder with sendMessage", async () => {
      const ctx = createCallbackContext();
      const responder = adapter.createCallbackResponder(ctx);

      await responder.sendMessage("Test message");

      assert.strictEqual(mockTelegram.sendMessage.mock.calls.length, 1);
    });

    it("should create responder with sendEphemeral", async () => {
      const ctx = createCallbackContext();
      const responder = adapter.createCallbackResponder(ctx);

      await responder.sendEphemeral("Toast message");

      assert.strictEqual(mockTelegram.answerCallbackQuery.mock.calls.length, 1);
      const args = mockTelegram.answerCallbackQuery.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[0], "callback-123");
      assert.strictEqual(args[1], "Toast message");
    });

    it("should create responder with updateMessage", async () => {
      const ctx = createCallbackContext();
      const responder = adapter.createCallbackResponder(ctx);

      await responder.updateMessage!("Updated text");

      assert.strictEqual(mockTelegram.editMessageText.mock.calls.length, 1);
    });
  });

  describe("toActionContext", () => {
    it("should convert callback context to ActionContext", () => {
      const ctx = createCallbackContext();
      const result = adapter.toActionContext(ctx);

      assert.strictEqual(result.platform, "telegram");
      assert.strictEqual(result.chatId, "123456");
      assert.strictEqual(result.userId, "user-123");
      assert.strictEqual(result.language, "en");
      assert.strictEqual(result.messageId, "200");
      assert.strictEqual(result.interactionId, "callback-123");
    });
  });

  describe("sendUnknownCallback", () => {
    it("should answer callback with unknown message", async () => {
      const ctx = createCallbackContext();
      await adapter.sendUnknownCallback(ctx);

      assert.strictEqual(mockTelegram.answerCallbackQuery.mock.calls.length, 1);
      const args = mockTelegram.answerCallbackQuery.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[1], "Unknown action");
    });
  });

  describe("handleUpdate", () => {
    it("should return not handled when no telegram client", async () => {
      const deps: TelegramAdapterDeps = {
        telegram: null,
        logger: mockLogger,
      };
      const nullAdapter = new TelegramAdapter(deps);

      const result = await nullAdapter.handleUpdate({ update_id: 1 });

      assert.strictEqual(result.handled, false);
      assert.strictEqual(result.error, "No telegram client");
    });

    it("should return not handled when no router", async () => {
      const deps: TelegramAdapterDeps = {
        telegram: mockTelegram as any,
        logger: mockLogger,
        // No router
      };
      const adapterNoRouter = new TelegramAdapter(deps);

      const result = await adapterNoRouter.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: Date.now(),
          chat: { id: 123, type: "private" },
          from: { id: 456, first_name: "Test" },
          text: "Hello",
        },
      });

      assert.strictEqual(result.handled, false);
    });

    it("should reply for empty message text", async () => {
      const result = await adapter.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: Date.now(),
          chat: { id: 123, type: "private" },
          from: { id: 456, first_name: "Test" },
          text: "",
        },
      });

      assert.strictEqual(result.handled, true);
      assert.strictEqual(mockTelegram.sendMessage.mock.calls.length, 1);
    });

    it("should handle non-text messages with a reply", async () => {
      const deps: TelegramAdapterDeps = {
        telegram: mockTelegram as any,
        logger: mockLogger,
        // No router needed for non-text handling
      };
      const adapterWithClient = new TelegramAdapter(deps);

      const result = await adapterWithClient.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: Date.now(),
          chat: { id: 123, type: "private" },
          from: { id: 456, first_name: "Test" },
          photo: [{ file_id: "abc", file_unique_id: "u", width: 1, height: 1, file_size: 10 }],
        },
      } as any);

      assert.strictEqual(result.handled, true);
      assert.strictEqual(mockTelegram.sendMessage.mock.calls.length, 1);
    });

    it("should return not handled for unknown intent without session", async () => {
      const { createRequestRouter } = await import("../../src/runtime/adapters/RequestRouter.js");
      const router = createRequestRouter({ logger: mockLogger });

      const deps: TelegramAdapterDeps = {
        telegram: mockTelegram as any,
        logger: mockLogger,
        router,
        findActiveSession: async () => null,
        hasActiveWizard: async () => false,
        cloudEnabled: false,
      };
      const adapterWithRouter = new TelegramAdapter(deps);

      const result = await adapterWithRouter.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: Date.now(),
          chat: { id: 123, type: "private" },
          from: { id: 456, first_name: "Test" },
          text: "random text",
        },
      });

      assert.strictEqual(result.handled, false);
    });

    it("should return not handled for wizard intent (not yet implemented)", async () => {
      const { createRequestRouter } = await import("../../src/runtime/adapters/RequestRouter.js");
      const router = createRequestRouter({ logger: mockLogger });

      const deps: TelegramAdapterDeps = {
        telegram: mockTelegram as any,
        logger: mockLogger,
        router,
        findActiveSession: async () => null,
        hasActiveWizard: async () => false,
        cloudEnabled: false,
      };
      const adapterWithRouter = new TelegramAdapter(deps);

      const result = await adapterWithRouter.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: Date.now(),
          chat: { id: 123, type: "private" },
          from: { id: 456, first_name: "Test" },
          text: "/start",
        },
      });

      // Wizard not implemented yet, should fall back
      assert.strictEqual(result.handled, false);
    });

    it("should return not handled for callback without orchestrator", async () => {
      const deps: TelegramAdapterDeps = {
        telegram: mockTelegram as any,
        logger: mockLogger,
        // No orchestrator
      };
      const adapterNoOrch = new TelegramAdapter(deps);

      const result = await adapterNoOrch.handleUpdate({
        update_id: 1,
        callback_query: {
          id: "callback-123",
          from: { id: 456, first_name: "Test" },
          data: "kill:session-123",
        },
      });

      assert.strictEqual(result.handled, false);
    });
  });
});
