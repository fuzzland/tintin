import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { WebSocketAdapter } from "../../src/runtime/adapters/WebSocketAdapter.js";
import type { WebSocketAdapterDeps } from "../../src/runtime/adapters/WebSocketAdapter.js";
import type { WebSocketMessageContext } from "../../src/runtime/adapters/types.js";
import type { Logger } from "../../src/runtime/log.js";

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as Logger;
}

interface MockWsManager {
  sendToConnection: ReturnType<typeof mock.fn>;
  subscribeToSession: ReturnType<typeof mock.fn>;
  broadcastToSession: ReturnType<typeof mock.fn>;
}

function createMockWsManager(): MockWsManager {
  return {
    sendToConnection: mock.fn(() => {}),
    subscribeToSession: mock.fn(() => {}),
    broadcastToSession: mock.fn(() => {}),
  };
}

function createMessageContext(overrides: Partial<WebSocketMessageContext> = {}): WebSocketMessageContext {
  return {
    platform: "websocket",
    chatId: "chat-123",
    userId: "ws:user-123",
    language: "en",
    connId: "conn-abc",
    ...overrides,
  };
}

describe("WebSocketAdapter", () => {
  let adapter: WebSocketAdapter;
  let mockWsManager: MockWsManager;
  let mockLogger: Logger;

  beforeEach(() => {
    mockWsManager = createMockWsManager();
    mockLogger = createMockLogger();
    const deps: WebSocketAdapterDeps = {
      wsManager: mockWsManager as any,
      logger: mockLogger,
    };
    adapter = new WebSocketAdapter(deps);
  });

  describe("toChatRequest", () => {
    it("should convert message context to ChatRequest", () => {
      const ctx = createMessageContext();
      const result = adapter.toChatRequest(ctx, "Hello world");

      assert.strictEqual(result.platform, "websocket");
      assert.strictEqual(result.chatId, "chat-123");
      assert.strictEqual(result.userId, "ws:user-123");
      assert.strictEqual(result.prompt, "Hello world");
      assert.strictEqual(result.language, "en");
      assert.strictEqual(result.isDirect, true);
    });

    it("should include options when provided", () => {
      const ctx = createMessageContext();
      const result = adapter.toChatRequest(ctx, "Hello", {
        repoIds: ["repo-1", "repo-2"],
        agent: "claude_code",
        restoreSnapshotId: "snapshot-123",
      });

      assert.deepStrictEqual(result.repoIds, ["repo-1", "repo-2"]);
      assert.strictEqual(result.agent, "claude_code");
      assert.strictEqual(result.restoreSnapshotId, "snapshot-123");
    });
  });

  describe("sendResponse", () => {
    it("should send error for failed result", async () => {
      const ctx = createMessageContext();
      await adapter.sendResponse(ctx, {
        success: false,
        error: "Session not found",
      });

      assert.strictEqual(mockWsManager.sendToConnection.mock.calls.length, 1);
      const args = mockWsManager.sendToConnection.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[0], "conn-abc");
      assert.strictEqual(args[1].type, "error");
      assert.strictEqual(args[1].message, "Session not found");
    });

    it("should send run_status for queued result", async () => {
      const ctx = createMessageContext();
      await adapter.sendResponse(ctx, {
        success: true,
        queued: true,
        statusMessage: "Message queued",
      });

      assert.strictEqual(mockWsManager.sendToConnection.mock.calls.length, 1);
      const args = mockWsManager.sendToConnection.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[1].type, "run_status");
      assert.strictEqual(args[1].status, "preparing");
    });

    it("should send run_status for started session", async () => {
      const ctx = createMessageContext();
      await adapter.sendResponse(ctx, {
        success: true,
        sessionId: "session-123",
        statusMessage: "Session started",
      });

      assert.strictEqual(mockWsManager.sendToConnection.mock.calls.length, 1);
      const args = mockWsManager.sendToConnection.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[1].type, "run_status");
      assert.strictEqual(args[1].status, "running");
    });
  });

  describe("createResponder", () => {
    it("should create responder with sendMessage", async () => {
      const ctx = createMessageContext();
      const responder = adapter.createResponder(ctx);

      await responder.sendMessage("Test message");

      assert.strictEqual(mockWsManager.sendToConnection.mock.calls.length, 1);
      const args = mockWsManager.sendToConnection.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[1].type, "chunk");
      assert.strictEqual(args[1].content, "Test message");
    });

    it("should create responder with sendEphemeral", async () => {
      const ctx = createMessageContext();
      const responder = adapter.createResponder(ctx);

      await responder.sendEphemeral("Info message");

      assert.strictEqual(mockWsManager.sendToConnection.mock.calls.length, 1);
      const args = mockWsManager.sendToConnection.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[1].type, "chunk");
    });
  });

  describe("toActionContext", () => {
    it("should convert message context to ActionContext", () => {
      const ctx = createMessageContext();
      const result = adapter.toActionContext(ctx);

      assert.strictEqual(result.platform, "websocket");
      assert.strictEqual(result.chatId, "chat-123");
      assert.strictEqual(result.userId, "ws:user-123");
      assert.strictEqual(result.language, "en");
      assert.strictEqual(result.workspaceId, null);
    });
  });

  describe("subscribeToSession", () => {
    it("should subscribe connection to session", () => {
      adapter.subscribeToSession("conn-abc", "session-123");

      assert.strictEqual(mockWsManager.subscribeToSession.mock.calls.length, 1);
      const args = mockWsManager.subscribeToSession.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[0], "conn-abc");
      assert.strictEqual(args[1], "session-123");
    });
  });

  describe("sendError", () => {
    it("should send error message", () => {
      adapter.sendError("conn-abc", "SESSION_ERROR", "Something went wrong");

      assert.strictEqual(mockWsManager.sendToConnection.mock.calls.length, 1);
      const args = mockWsManager.sendToConnection.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[1].type, "error");
      assert.strictEqual(args[1].code, "SESSION_ERROR");
      assert.strictEqual(args[1].message, "Something went wrong");
    });
  });

  describe("sendRunStatus", () => {
    it("should send run status update", () => {
      adapter.sendRunStatus("conn-abc", "chat-123", "running", "Run started");

      assert.strictEqual(mockWsManager.sendToConnection.mock.calls.length, 1);
      const args = mockWsManager.sendToConnection.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[1].type, "run_status");
      assert.strictEqual(args[1].chatId, "chat-123");
      assert.strictEqual(args[1].status, "running");
      assert.strictEqual(args[1].message, "Run started");
    });
  });

  describe("sendDone", () => {
    it("should send done message", () => {
      adapter.sendDone("conn-abc", "chat-123");

      assert.strictEqual(mockWsManager.sendToConnection.mock.calls.length, 1);
      const args = mockWsManager.sendToConnection.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[1].type, "done");
      assert.strictEqual(args[1].chatId, "chat-123");
    });

    it("should include stopped flag", () => {
      adapter.sendDone("conn-abc", "chat-123", true);

      const args = mockWsManager.sendToConnection.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[1].stopped, true);
    });
  });

  describe("sendBrowserSession", () => {
    it("should send browser session info", () => {
      adapter.sendBrowserSession(
        "conn-abc",
        "session-123",
        "ws://cdp.example.com",
        "https://live.example.com",
      );

      assert.strictEqual(mockWsManager.sendToConnection.mock.calls.length, 1);
      const args = mockWsManager.sendToConnection.mock.calls[0]?.arguments as any[];
      assert.strictEqual(args[1].type, "browser_session");
      assert.strictEqual(args[1].sessionId, "session-123");
      assert.strictEqual(args[1].cdpUrl, "ws://cdp.example.com");
      assert.strictEqual(args[1].liveViewUrl, "https://live.example.com");
      assert.strictEqual(args[1].provider, "hyperbrowser");
    });
  });
});
