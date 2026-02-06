import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { SlackAdapter } from "../../src/runtime/adapters/SlackAdapter.js";
import type { SlackAdapterDeps } from "../../src/runtime/adapters/SlackAdapter.js";
import type { SlackMessageContext, SlackInteractionContext } from "../../src/runtime/adapters/types.js";
import type { Logger } from "../../src/runtime/log.js";

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as Logger;
}

interface MockSlack {
  postMessage: ReturnType<typeof mock.fn>;
  postEphemeral: ReturnType<typeof mock.fn>;
}

function createMockSlack(): MockSlack {
  return {
    postMessage: mock.fn(async () => {}),
    postEphemeral: mock.fn(async () => {}),
  };
}

function createMessageContext(overrides: Partial<SlackMessageContext> = {}): SlackMessageContext {
  return {
    platform: "slack",
    chatId: "C123456",
    userId: "U123456",
    language: "en",
    workspaceId: "T123456",
    threadTs: undefined,
    ...overrides,
  };
}

function createInteractionContext(overrides: Partial<SlackInteractionContext> = {}): SlackInteractionContext {
  return {
    channelId: "C123456",
    userId: "U123456",
    workspaceId: "T123456",
    actionId: "kill_session",
    value: "session-abc",
    language: "en",
    ...overrides,
  };
}

describe("SlackAdapter", () => {
  let adapter: SlackAdapter;
  let mockSlack: MockSlack;
  let mockLogger: Logger;

  beforeEach(() => {
    mockSlack = createMockSlack();
    mockLogger = createMockLogger();
    const deps: SlackAdapterDeps = {
      slack: mockSlack as any,
      logger: mockLogger,
    };
    adapter = new SlackAdapter(deps);
  });

  describe("toChatRequest", () => {
    it("should convert message context to ChatRequest", () => {
      const ctx = createMessageContext();
      const result = adapter.toChatRequest(ctx, "Hello world");

      assert.strictEqual(result.platform, "slack");
      assert.strictEqual(result.chatId, "C123456");
      assert.strictEqual(result.userId, "U123456");
      assert.strictEqual(result.prompt, "Hello world");
      assert.strictEqual(result.language, "en");
      assert.strictEqual(result.workspaceId, "T123456");
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

      assert.strictEqual(mockSlack.postMessage.mock.calls.length, 1);
      const args = mockSlack.postMessage.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[0].channel, "C123456");
      assert.strictEqual(args[0].text, "Session started");
    });

    it("should include thread_ts when provided", async () => {
      const ctx = createMessageContext({ threadTs: "1234567890.123456" });
      await adapter.sendResponse(ctx, {
        success: true,
        statusMessage: "Test",
      });

      const args = mockSlack.postMessage.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[0].thread_ts, "1234567890.123456");
    });

    it("should not send if no message", async () => {
      const ctx = createMessageContext();
      await adapter.sendResponse(ctx, { success: true });

      assert.strictEqual(mockSlack.postMessage.mock.calls.length, 0);
    });

    it("should not send if slack is null", async () => {
      const deps: SlackAdapterDeps = {
        slack: null,
        logger: mockLogger,
      };
      const nullAdapter = new SlackAdapter(deps);
      const ctx = createMessageContext();

      await nullAdapter.sendResponse(ctx, {
        success: true,
        statusMessage: "Test",
      });
      // Should not throw
    });
  });

  describe("parseInteraction", () => {
    it("should parse kill_session action", () => {
      const result = adapter.parseInteraction("kill_session", "session-123");
      assert.deepStrictEqual(result, { kind: "kill", sessionId: "session-123" });
    });

    it("should parse review_session action", () => {
      const result = adapter.parseInteraction("review_session", "session-456");
      assert.deepStrictEqual(result, { kind: "review", sessionId: "session-456" });
    });

    it("should return null for unknown action", () => {
      const result = adapter.parseInteraction("unknown_action", "value");
      assert.strictEqual(result, null);
    });
  });

  describe("createInteractionResponder", () => {
    it("should create responder with sendMessage", async () => {
      const ctx = createInteractionContext();
      const responder = adapter.createInteractionResponder(ctx);

      await responder.sendMessage("Test message");

      assert.strictEqual(mockSlack.postMessage.mock.calls.length, 1);
    });

    it("should create responder with sendEphemeral", async () => {
      const ctx = createInteractionContext();
      const responder = adapter.createInteractionResponder(ctx);

      await responder.sendEphemeral("Ephemeral message");

      assert.strictEqual(mockSlack.postEphemeral.mock.calls.length, 1);
      const args = mockSlack.postEphemeral.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[0].channel, "C123456");
      assert.strictEqual(args[0].user, "U123456");
      assert.strictEqual(args[0].text, "Ephemeral message");
    });
  });

  describe("toActionContext", () => {
    it("should convert interaction context to ActionContext", () => {
      const ctx = createInteractionContext({ messageTs: "1234567890.123456" });
      const result = adapter.toActionContext(ctx);

      assert.strictEqual(result.platform, "slack");
      assert.strictEqual(result.chatId, "C123456");
      assert.strictEqual(result.userId, "U123456");
      assert.strictEqual(result.language, "en");
      assert.strictEqual(result.workspaceId, "T123456");
      assert.strictEqual(result.messageId, "1234567890.123456");
    });
  });
});
