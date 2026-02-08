import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketChatOrchestrator } from "../../src/runtime/orchestrator/WebSocketChatOrchestrator.js";
import type { WebSocketManager } from "../../src/runtime/websocket/manager.js";
import type { WSConnection } from "../../src/runtime/websocket/types.js";
import type { Logger } from "../../src/runtime/log.js";
import type { Db } from "../../src/runtime/db.js";
import type { AppConfig } from "../../src/runtime/config.js";
import type { SessionManager } from "../../src/runtime/sessionManager.js";
import type { CloudManager } from "../../src/runtime/cloud/manager.js";

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as Logger;
}

function createMockWsManager() {
  const sent: Array<{ connId: string; message: any }> = [];
  const subscribed: Array<{ connId: string; sessionId: string }> = [];
  const broadcasted: Array<{ sessionId: string; message: any }> = [];
  return {
    sendToConnection: (connId: string, message: any) => {
      sent.push({ connId, message });
      return true;
    },
    subscribeToSession: (connId: string, sessionId: string) => {
      subscribed.push({ connId, sessionId });
    },
    broadcastToSession: (sessionId: string, message: any) => {
      broadcasted.push({ sessionId, message });
    },
    _sent: sent,
    _subscribed: subscribed,
    _broadcasted: broadcasted,
  } as unknown as WebSocketManager & {
    _sent: Array<{ connId: string; message: any }>;
    _subscribed: Array<{ connId: string; sessionId: string }>;
    _broadcasted: Array<{ sessionId: string; message: any }>;
  };
}

function createMockDb(
  sessionRow: any,
  opts: { identityId?: string; cloudRun?: any } = {},
) {
  const pendingMessages: any[] = [];
  const identityRow = { id: opts.identityId ?? "identity-123" };
  const cloudRun = opts.cloudRun ?? null;

  const createSelectMock = (result: any) => {
    const api = {
      selectAll: () => api,
      select: () => api,
      where: () => api,
      orderBy: () => api,
      limit: () => api,
      executeTakeFirst: async () => result,
      execute: async () => (Array.isArray(result) ? result : result ? [result] : []),
    };
    return api;
  };

  return {
    selectFrom: (tableName: string) => {
      if (tableName === "sessions") {
        return createSelectMock(sessionRow);
      }
      if (tableName === "session_pending_messages") {
        return createSelectMock({ count: pendingMessages.length });
      }
      if (tableName === "identities") {
        return createSelectMock(identityRow);
      }
      if (tableName === "cloud_runs") {
        return createSelectMock(cloudRun);
      }
      return createSelectMock(null);
    },
    insertInto: (tableName: string) => ({
      values: (row: any) => ({
        execute: async () => {
          if (tableName === "session_pending_messages") {
            pendingMessages.push(row);
          }
        },
      }),
    }),
    _pending: pendingMessages,
  } as unknown as Db & { _pending: any[] };
}

function createMockConnection(identityId = "ws:web:abc"): WSConnection {
  return {
    id: "conn-1",
    ws: null as any,
    identityId,
    authenticated: true,
    subscribedSessions: new Set(),
    lastPingAt: Date.now(),
    lastActivityAt: Date.now(),
    createdAt: Date.now(),
    messageCount: 0,
    sandbox: null,
  };
}

test("WebSocketChatOrchestrator queues message when session is running", async () => {
  const logger = createMockLogger();
  const wsManager = createMockWsManager();

  const sessionRow = {
    id: "session-123",
    platform: "websocket",
    status: "running",
    chat_id: "chat-1",
    created_by_user_id: "ws:web:abc",
    workspace_id: null,
    space_id: "chat-1",
    language: "en",
  };

  const db = createMockDb(sessionRow);
  const config = { cloud: { default_agent: "codex" } } as AppConfig;
  const sessionManager = { resumeSession: async () => {}, killSession: async () => {} } as unknown as SessionManager;
  const cloudManager = {} as CloudManager;

  const orchestrator = new WebSocketChatOrchestrator({
    wsManager,
    logger,
    db,
    config,
    sessionManager,
    cloudManager,
    sandboxLifecycleService: null,
  });

  const conn = createMockConnection();

  await orchestrator.handleChat("conn-1", conn, {
    type: "chat",
    chatId: "chat-1",
    prompt: "hello",
  });

  assert.equal((db as any)._pending.length, 1);
  assert.equal((wsManager as any)._subscribed.length, 1);

  const sent = (wsManager as any)._sent;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.type, "run_status");
  assert.equal(sent[0].message.status, "preparing");
});

test("WebSocketChatOrchestrator interrupt stops active session and starts new run", async () => {
  const logger = createMockLogger();
  const wsManager = createMockWsManager();

  const sessionRow = {
    id: "session-123",
    platform: "websocket",
    status: "running",
    chat_id: "chat-1",
    created_by_user_id: "ws:web:abc",
    workspace_id: null,
    space_id: "chat-1",
    language: "en",
  };

  const cloudRun = {
    id: "run-1",
    session_id: "session-123",
    identity_id: "identity-123",
  };

  const db = createMockDb(sessionRow, { identityId: "identity-123", cloudRun });
  const config = { cloud: { default_agent: "codex" } } as AppConfig;
  const sessionManager = { resumeSession: async () => {}, killSession: async () => {} } as unknown as SessionManager;

  const stopCalls: string[] = [];
  const startCalls: Array<{ chatId: string }> = [];
  const cloudManager = {
    stopCloudRun: async (runId: string) => {
      stopCalls.push(runId);
      return true;
    },
    startRun: async (opts: any) => {
      startCalls.push({ chatId: opts.chatId });
      return { runId: "run-2", sessionId: "session-456", cdpUrl: null };
    },
    getLiveViewUrl: () => null,
    detectLatestSnapshot: async () => null,
  } as unknown as CloudManager;

  const orchestrator = new WebSocketChatOrchestrator({
    wsManager,
    logger,
    db,
    config,
    sessionManager,
    cloudManager,
    sandboxLifecycleService: null,
  });

  const conn = createMockConnection();

  await orchestrator.handleChat("conn-1", conn, {
    type: "chat",
    chatId: "chat-1",
    prompt: "follow-up",
    mode: "interrupt",
  });

  assert.deepEqual(stopCalls, ["run-1"]);
  assert.equal(startCalls.length, 1);
  assert.equal((db as any)._pending.length, 0);
  assert.equal((wsManager as any)._broadcasted.length, 1);
});
