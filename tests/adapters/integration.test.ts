/**
 * Integration tests for adapter flows.
 *
 * These tests verify that the new adapter architecture handles
 * key user scenarios correctly.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { TelegramAdapter } from "../../src/runtime/adapters/TelegramAdapter.js";
import { SlackAdapter } from "../../src/runtime/adapters/SlackAdapter.js";
import { RequestRouter } from "../../src/runtime/adapters/RequestRouter.js";
import type { SessionOrchestrator } from "../../src/runtime/orchestrator/SessionOrchestrator.js";
import type { WizardOrchestrator } from "../../src/runtime/orchestrator/WizardOrchestrator.js";
import type { CommandOrchestrator, CommandContext, CommandType } from "../../src/runtime/orchestrator/CommandOrchestrator.js";
import type { TelegramClient, TelegramUpdate } from "../../src/runtime/platform/telegram.js";
import type { SlackClient } from "../../src/runtime/platform/slack.js";
import type { SessionInfo, SessionAction, ActionContext } from "../../src/runtime/orchestrator/types.js";
import type { Logger } from "../../src/runtime/log.js";

// Mock logger
const mockLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Mock Telegram client
function createMockTelegramClient(): TelegramClient {
  return {
    sendMessage: mock.fn(async () => 123),
    editMessageText: mock.fn(async () => {}),
    answerCallbackQuery: mock.fn(async () => {}),
    getUpdates: mock.fn(async () => []),
    deleteMessage: mock.fn(async () => {}),
    setWebhook: mock.fn(async () => {}),
    getMe: mock.fn(async () => ({ id: 123, is_bot: true, first_name: "Bot", username: "test_bot" })),
    createForumTopic: mock.fn(async () => ({ message_thread_id: 1 })),
    editForumTopic: mock.fn(async () => {}),
    pinChatMessage: mock.fn(async () => {}),
    unpinChatMessage: mock.fn(async () => {}),
  } as unknown as TelegramClient;
}

// Mock Slack client
function createMockSlackClient(): SlackClient {
  return {
    postMessage: mock.fn(async () => "1234567890.123456"),
    postEphemeral: mock.fn(async () => {}),
    updateMessage: mock.fn(async () => {}),
    openModal: mock.fn(async () => {}),
    registerWorkspaceForChannel: mock.fn(() => {}),
  } as unknown as SlackClient;
}

// Mock session info
const mockSession: SessionInfo = {
  id: "session-123",
  status: "running",
  platform: "telegram",
  chatId: "12345",
  createdByUserId: "user-1",
  workspaceId: null,
  spaceId: null,
  language: "en",
};

describe("TelegramAdapter Integration", () => {
  describe("command routing", () => {
    it("should route /sessions command through CommandOrchestrator", async () => {
      let capturedCtx: CommandContext | undefined;
      let capturedCmd: CommandType | undefined;
      const handleMock = mock.fn(async (ctx: CommandContext, cmd: CommandType) => {
        capturedCtx = ctx;
        capturedCmd = cmd;
        return { text: "No sessions found", success: true };
      });

      const telegram = createMockTelegramClient();
      const router = new RequestRouter({ logger: mockLogger });

      const adapter = new TelegramAdapter({
        telegram,
        logger: mockLogger,
        router,
        orchestrator: {
          handleSessionMessage: mock.fn(async () => ({ success: true, sessionId: "session-123" })),
          handleAction: mock.fn(async () => ({ handled: true })),
          getSession: mock.fn(async () => null),
          isSessionBusy: () => false,
          isSessionTerminal: () => false,
        } as unknown as SessionOrchestrator,
        commandOrchestrator: { handle: handleMock } as unknown as CommandOrchestrator,
        getUserLanguage: async () => "en",
        findActiveSession: async () => null,
        hasActiveWizard: async () => false,
        cloudEnabled: false,
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          date: Date.now(),
          chat: { id: 12345, type: "private" },
          from: { id: 67890, first_name: "Test" },
          text: "/sessions",
        },
      };

      const result = await adapter.handleUpdate(update);

      assert.equal(result.handled, true);
      assert.equal(handleMock.mock.callCount(), 1);
      assert.ok(capturedCtx);
      assert.ok(capturedCmd);
      assert.equal(capturedCtx.platform, "telegram");
      assert.equal(capturedCmd.kind, "sessions");
    });

    it("should route /lang command through CommandOrchestrator", async () => {
      let capturedCmd: CommandType | undefined;
      const handleMock = mock.fn(async (_ctx: CommandContext, cmd: CommandType) => {
        capturedCmd = cmd;
        return { text: "Language changed", success: true, showLanguageKeyboard: false };
      });

      const telegram = createMockTelegramClient();
      const router = new RequestRouter({ logger: mockLogger });

      const adapter = new TelegramAdapter({
        telegram,
        logger: mockLogger,
        router,
        orchestrator: {
          handleSessionMessage: mock.fn(async () => ({ success: true, sessionId: "session-123" })),
          handleAction: mock.fn(async () => ({ handled: true })),
          getSession: mock.fn(async () => null),
          isSessionBusy: () => false,
          isSessionTerminal: () => false,
        } as unknown as SessionOrchestrator,
        commandOrchestrator: { handle: handleMock } as unknown as CommandOrchestrator,
        getUserLanguage: async () => "en",
        findActiveSession: async () => null,
        hasActiveWizard: async () => false,
        cloudEnabled: false,
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          date: Date.now(),
          chat: { id: 12345, type: "private" },
          from: { id: 67890, first_name: "Test" },
          text: "/lang zh",
        },
      };

      const result = await adapter.handleUpdate(update);

      assert.equal(result.handled, true);
      assert.equal(handleMock.mock.callCount(), 1);
      assert.ok(capturedCmd);
      assert.equal(capturedCmd.kind, "lang");
      if (capturedCmd.kind === "lang") {
        assert.equal(capturedCmd.target, "zh");
      }
    });
  });

  describe("session message routing", () => {
    it("should route session messages through SessionOrchestrator", async () => {
      const handleSessionMessageMock = mock.fn(async () => ({
        success: true,
        sessionId: "session-123",
        statusMessage: "Message sent",
      }));

      const telegram = createMockTelegramClient();
      const router = new RequestRouter({ logger: mockLogger });

      const adapter = new TelegramAdapter({
        telegram,
        logger: mockLogger,
        router,
        orchestrator: {
          handleSessionMessage: handleSessionMessageMock,
          handleAction: mock.fn(async () => ({ handled: true })),
          getSession: mock.fn(async () => mockSession),
          isSessionBusy: () => true,
          isSessionTerminal: () => false,
        } as unknown as SessionOrchestrator,
        getUserLanguage: async () => "en",
        findActiveSession: async () => mockSession,
        hasActiveWizard: async () => false,
        cloudEnabled: false,
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          date: Date.now(),
          chat: { id: 12345, type: "private" },
          from: { id: 67890, first_name: "Test" },
          text: "Please fix the bug",
        },
      };

      const result = await adapter.handleUpdate(update);

      assert.equal(result.handled, true);
      assert.equal(handleSessionMessageMock.mock.callCount(), 1);
    });
  });

  describe("callback query handling", () => {
    it("should handle lang callback through CommandOrchestrator", async () => {
      let capturedCmd: CommandType | undefined;
      const handleMock = mock.fn(async (_ctx: CommandContext, cmd: CommandType) => {
        capturedCmd = cmd;
        return { text: "Language set to Chinese", success: true };
      });

      const telegram = createMockTelegramClient();
      const router = new RequestRouter({ logger: mockLogger });

      const adapter = new TelegramAdapter({
        telegram,
        logger: mockLogger,
        router,
        commandOrchestrator: { handle: handleMock } as unknown as CommandOrchestrator,
        getUserLanguage: async () => "en",
        findActiveSession: async () => null,
        hasActiveWizard: async () => false,
        cloudEnabled: false,
      });

      const update: TelegramUpdate = {
        update_id: 1,
        callback_query: {
          id: "callback-123",
          from: { id: 67890, first_name: "Test" },
          data: "lang:zh",
          message: {
            message_id: 1,
            date: Date.now(),
            chat: { id: 12345, type: "private" },
          },
        },
      };

      const result = await adapter.handleUpdate(update);

      assert.equal(result.handled, true);
      assert.equal(handleMock.mock.callCount(), 1);
      assert.ok(capturedCmd);
      assert.equal(capturedCmd.kind, "lang");
      if (capturedCmd.kind === "lang") {
        assert.equal(capturedCmd.target, "zh");
      }
    });

    it("should handle kill callback through SessionOrchestrator", async () => {
      let capturedAction: SessionAction | undefined;
      const handleActionMock = mock.fn(async (action: SessionAction, _ctx: ActionContext) => {
        capturedAction = action;
        return { handled: true, response: "Session stopped" };
      });

      const telegram = createMockTelegramClient();
      const router = new RequestRouter({ logger: mockLogger });

      const adapter = new TelegramAdapter({
        telegram,
        logger: mockLogger,
        router,
        orchestrator: {
          handleSessionMessage: mock.fn(async () => ({ success: true, sessionId: "session-123" })),
          handleAction: handleActionMock,
          getSession: mock.fn(async () => mockSession),
          isSessionBusy: () => true,
          isSessionTerminal: () => false,
        } as unknown as SessionOrchestrator,
        getUserLanguage: async () => "en",
        findActiveSession: async () => null,
        hasActiveWizard: async () => false,
        cloudEnabled: false,
      });

      const update: TelegramUpdate = {
        update_id: 1,
        callback_query: {
          id: "callback-123",
          from: { id: 67890, first_name: "Test" },
          data: "kill:session-123",
          message: {
            message_id: 1,
            date: Date.now(),
            chat: { id: 12345, type: "private" },
          },
        },
      };

      const result = await adapter.handleUpdate(update);

      assert.equal(result.handled, true);
      assert.equal(handleActionMock.mock.callCount(), 1);
      assert.ok(capturedAction);
      assert.equal(capturedAction.kind, "kill");
      if (capturedAction.kind === "kill") {
        assert.equal(capturedAction.sessionId, "session-123");
      }
    });
  });

  describe("wizard flow", () => {
    it("should route /start to WizardOrchestrator", async () => {
      const startMock = mock.fn(async () => ({
        state: "await_project" as const,
        message: "Select a project",
        showProjectKeyboard: true,
      }));

      const telegram = createMockTelegramClient();
      const router = new RequestRouter({ logger: mockLogger });

      const adapter = new TelegramAdapter({
        telegram,
        logger: mockLogger,
        router,
        orchestrator: {
          handleSessionMessage: mock.fn(async () => ({ success: true, sessionId: "session-123" })),
          handleAction: mock.fn(async () => ({ handled: true })),
          getSession: mock.fn(async () => null),
          isSessionBusy: () => false,
          isSessionTerminal: () => false,
        } as unknown as SessionOrchestrator,
        wizardOrchestrator: {
          start: startMock,
          handleProjectSelect: mock.fn(async () => ({ state: "await_initial_prompt" as const, message: "Enter prompt" })),
          handleCustomPath: mock.fn(async () => ({ state: "await_initial_prompt" as const, message: "Enter prompt" })),
          handlePrompt: mock.fn(async () => ({ state: "completed" as const, message: "Started", sessionId: "new-session" })),
          continue: mock.fn(async () => ({ state: "await_project" as const, message: "Select project" })),
          getState: mock.fn(async () => null),
          clear: mock.fn(async () => {}),
        } as unknown as WizardOrchestrator,
        getUserLanguage: async () => "en",
        findActiveSession: async () => null,
        hasActiveWizard: async () => false,
        getProjects: () => [{ id: "proj1", name: "Project 1", path: "/path", allowCustomPath: false }],
        cloudEnabled: false,
      });

      const update: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 1,
          date: Date.now(),
          chat: { id: 12345, type: "private" },
          from: { id: 67890, first_name: "Test" },
          text: "/start",
        },
      };

      const result = await adapter.handleUpdate(update);

      assert.equal(result.handled, true);
      assert.equal(startMock.mock.callCount(), 1);
    });
  });
});

describe("SlackAdapter Integration", () => {
  describe("interaction routing", () => {
    it("should route lang button through CommandOrchestrator", async () => {
      let capturedCmd: CommandType | undefined;
      const handleMock = mock.fn(async (_ctx: CommandContext, cmd: CommandType) => {
        capturedCmd = cmd;
        return { text: "Language changed", success: true };
      });

      const slack = createMockSlackClient();
      const router = new RequestRouter({ logger: mockLogger });

      const adapter = new SlackAdapter({
        slack,
        logger: mockLogger,
        router,
        commandOrchestrator: { handle: handleMock } as unknown as CommandOrchestrator,
        getUserLanguage: async () => "en",
        findActiveSession: async () => null,
        hasActiveWizard: async () => false,
        cloudEnabled: false,
      });

      const payload = {
        type: "block_actions",
        actions: [{ action_id: "switch_language", value: "zh" }],
        channel: { id: "C12345" },
        user: { id: "U67890" },
        team: { id: "T11111" },
        message: { ts: "1234567890.123456" },
      };

      const result = await adapter.handleInteractionPayload(payload);

      assert.equal(result.handled, true);
      assert.equal(handleMock.mock.callCount(), 1);
      assert.ok(capturedCmd);
      assert.equal(capturedCmd.kind, "lang");
      if (capturedCmd.kind === "lang") {
        assert.equal(capturedCmd.target, "zh");
      }
    });

    it("should route kill button through SessionOrchestrator", async () => {
      const handleActionMock = mock.fn(async () => ({
        handled: true,
        response: "Session stopped",
      }));

      const slack = createMockSlackClient();
      const router = new RequestRouter({ logger: mockLogger });

      const adapter = new SlackAdapter({
        slack,
        logger: mockLogger,
        router,
        orchestrator: {
          handleSessionMessage: mock.fn(async () => ({ success: true, sessionId: "session-123" })),
          handleAction: handleActionMock,
          getSession: mock.fn(async () => mockSession),
          isSessionBusy: () => true,
          isSessionTerminal: () => false,
        } as unknown as SessionOrchestrator,
        getUserLanguage: async () => "en",
        findActiveSession: async () => null,
        hasActiveWizard: async () => false,
        cloudEnabled: false,
      });

      const ctx = {
        channelId: "C12345",
        userId: "U67890",
        workspaceId: "T11111",
        actionId: "kill_session",
        value: "session-123",
        messageTs: "1234567890.123456",
        language: "en" as const,
      };

      const result = await adapter.handleInteraction(ctx);

      assert.equal(result.handled, true);
      assert.equal(handleActionMock.mock.callCount(), 1);
    });
  });

  describe("message event routing", () => {
    it("should route command messages through CommandOrchestrator", async () => {
      const handleMock = mock.fn(async () => ({
        text: "Help text",
        success: true,
      }));

      const slack = createMockSlackClient();
      const router = new RequestRouter({ logger: mockLogger });

      const adapter = new SlackAdapter({
        slack,
        logger: mockLogger,
        router,
        orchestrator: {
          handleSessionMessage: mock.fn(async () => ({ success: true, sessionId: "session-123" })),
          handleAction: mock.fn(async () => ({ handled: true })),
          getSession: mock.fn(async () => null),
          isSessionBusy: () => false,
          isSessionTerminal: () => false,
        } as unknown as SessionOrchestrator,
        commandOrchestrator: { handle: handleMock } as unknown as CommandOrchestrator,
        getUserLanguage: async () => "en",
        findActiveSession: async () => null,
        hasActiveWizard: async () => false,
        cloudEnabled: false,
      });

      const body = {
        type: "event_callback",
        team_id: "T11111",
        event: {
          type: "message",
          channel: "D12345", // DM channel
          user: "U67890",
          text: "/help",
          ts: "1234567890.123456",
        },
      };

      const result = await adapter.handleEvent(body);

      assert.equal(result.handled, true);
      assert.equal(handleMock.mock.callCount(), 1);
    });
  });
});

describe("RequestRouter Integration", () => {
  it("should detect all command types correctly", async () => {
    const router = new RequestRouter({ logger: mockLogger });

    const testCases = [
      { text: "/sessions", expectedKind: "sessions" },
      { text: "/settings", expectedKind: "settings" },
      { text: "/lang", expectedKind: "lang" },
      { text: "/help", expectedKind: "help" },
      { text: "/kill session-123", expectedKind: "kill" },
      { text: "/version", expectedKind: "version" },
    ];

    for (const { text, expectedKind } of testCases) {
      const result = await router.detectIntent(text, {
        platform: "telegram",
        chatId: "12345",
        spaceId: null,
        userId: "67890",
        hasActiveWizard: false,
        activeSession: null,
        cloudEnabled: false,
      });

      assert.equal(result.type, "command", `Expected command for "${text}"`);
      if (result.type === "command") {
        assert.equal(result.command.kind, expectedKind, `Expected kind ${expectedKind} for "${text}"`);
      }
    }
  });

  it("should detect cloud commands when cloud is enabled", async () => {
    const router = new RequestRouter({ logger: mockLogger });

    const testCases = [
      { text: "/run fix bug", expectedKind: "action_run" },
      { text: "/repos", expectedKind: "repos" },
      { text: "/connect github", expectedKind: "connect" },
      { text: "/secrets", expectedKind: "secrets_list" },
    ];

    for (const { text, expectedKind } of testCases) {
      const result = await router.detectIntent(text, {
        platform: "telegram",
        chatId: "12345",
        spaceId: null,
        userId: "67890",
        hasActiveWizard: false,
        activeSession: null,
        cloudEnabled: true,
      });

      assert.equal(result.type, "cloud", `Expected cloud for "${text}"`);
      if (result.type === "cloud") {
        assert.equal(result.command.kind, expectedKind, `Expected kind ${expectedKind} for "${text}"`);
      }
    }
  });
});
