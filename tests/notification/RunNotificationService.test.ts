import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { RunNotificationService } from "../../src/runtime/notification/RunNotificationService.js";
import type { PlatformSender } from "../../src/runtime/notification/senders/types.js";
import type { Logger } from "../../src/runtime/log.js";
import type { NotificationTarget, RunSummaryCard } from "../../src/runtime/notification/types.js";
import type { Db } from "../../src/runtime/db.js";

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe("RunNotificationService", () => {
  describe("notifyRunCompleted", () => {
    it("should skip if identity has no group", async () => {
      const getGroupIdFn = mock.fn(async (_id: string) => null);
      const listOtherFn = mock.fn(async (_g: string, _e: string): Promise<NotificationTarget[]> => []);

      const mockGroupStore = {
        getGroupIdForIdentity: getGroupIdFn,
        listOtherIdentitiesInGroup: listOtherFn,
      };

      const service = new RunNotificationService({
        groupStore: mockGroupStore as any,
        cardBuilder: null,
        senders: [],
        logger: createMockLogger(),
      });

      await service.notifyRunCompleted("run-1", "identity-1");

      assert.strictEqual(getGroupIdFn.mock.callCount(), 1);
      assert.strictEqual(listOtherFn.mock.callCount(), 0);
    });

    it("should skip if no other identities in group", async () => {
      const getGroupIdFn = mock.fn(async (_id: string) => "group-1");
      const listOtherFn = mock.fn(async (_g: string, _e: string): Promise<NotificationTarget[]> => []);

      const mockGroupStore = {
        getGroupIdForIdentity: getGroupIdFn,
        listOtherIdentitiesInGroup: listOtherFn,
      };

      const service = new RunNotificationService({
        groupStore: mockGroupStore as any,
        cardBuilder: null,
        senders: [],
        logger: createMockLogger(),
      });

      await service.notifyRunCompleted("run-1", "identity-1");

      assert.strictEqual(getGroupIdFn.mock.callCount(), 1);
      assert.strictEqual(listOtherFn.mock.callCount(), 1);
    });

    it("should send to all targets when card is available", async () => {
      const targets: NotificationTarget[] = [
        { identityId: "id-tg", platform: "telegram", userId: "tg123", workspaceId: null },
        { identityId: "id-slack", platform: "slack", userId: "slack456", workspaceId: "W123" },
      ];

      const getGroupIdFn = mock.fn(async (_id: string) => "group-1");
      const listOtherFn = mock.fn(async (_g: string, _e: string) => targets);

      const mockGroupStore = {
        getGroupIdForIdentity: getGroupIdFn,
        listOtherIdentitiesInGroup: listOtherFn,
      };

      const mockCard: RunSummaryCard = {
        runId: "run-1",
        status: "completed",
        title: "Fix bug",
        prompt: "Fix the bug",
        diffStats: { filesChanged: 2, additions: 10, deletions: 5 },
        screenshotUrl: null,
        viewUrl: "https://example.com/run/run-1",
        vscodeUrl: null,
        initiatorPlatform: "websocket",
        finishedAt: Date.now(),
      };

      const buildFromRunFn = mock.fn(async (_db: Db, _runId: string) => mockCard);
      const mockCardBuilder = { buildFromRun: buildFromRunFn };

      const tgSendMock = mock.fn(async (_t: NotificationTarget, _c: RunSummaryCard) => true);
      const slackSendMock = mock.fn(async (_t: NotificationTarget, _c: RunSummaryCard) => true);

      const mockTgSender: PlatformSender = {
        platform: "telegram",
        send: tgSendMock,
      };

      const mockSlackSender: PlatformSender = {
        platform: "slack",
        send: slackSendMock,
      };

      const service = new RunNotificationService({
        groupStore: mockGroupStore as any,
        cardBuilder: mockCardBuilder as any,
        senders: [mockTgSender, mockSlackSender],
        logger: createMockLogger(),
      });

      // Pass a mock db
      await service.notifyRunCompleted("run-1", "identity-initiator", {} as Db);

      assert.strictEqual(tgSendMock.mock.callCount(), 1);
      assert.strictEqual(slackSendMock.mock.callCount(), 1);

      // Verify correct target was passed to each sender
      const tgCall = tgSendMock.mock.calls[0];
      assert.ok(tgCall);
      assert.strictEqual((tgCall.arguments[0] as NotificationTarget).platform, "telegram");

      const slackCall = slackSendMock.mock.calls[0];
      assert.ok(slackCall);
      assert.strictEqual((slackCall.arguments[0] as NotificationTarget).platform, "slack");
    });

    it("should skip platform if no sender configured", async () => {
      const targets: NotificationTarget[] = [
        { identityId: "id-tg", platform: "telegram", userId: "tg123", workspaceId: null },
        { identityId: "id-ws", platform: "websocket", userId: "ws789", workspaceId: null },
      ];

      const getGroupIdFn = mock.fn(async (_id: string) => "group-1");
      const listOtherFn = mock.fn(async (_g: string, _e: string) => targets);

      const mockGroupStore = {
        getGroupIdForIdentity: getGroupIdFn,
        listOtherIdentitiesInGroup: listOtherFn,
      };

      const mockCard: RunSummaryCard = {
        runId: "run-1",
        status: "completed",
        title: "Fix bug",
        prompt: "Fix the bug",
        diffStats: null,
        screenshotUrl: null,
        viewUrl: "https://example.com/run/run-1",
        vscodeUrl: null,
        initiatorPlatform: "slack",
        finishedAt: Date.now(),
      };

      const buildFromRunFn = mock.fn(async (_db: Db, _runId: string) => mockCard);
      const mockCardBuilder = { buildFromRun: buildFromRunFn };

      const tgSendMock = mock.fn(async (_t: NotificationTarget, _c: RunSummaryCard) => true);

      // Only telegram sender, no websocket sender
      const mockTgSender: PlatformSender = {
        platform: "telegram",
        send: tgSendMock,
      };

      const service = new RunNotificationService({
        groupStore: mockGroupStore as any,
        cardBuilder: mockCardBuilder as any,
        senders: [mockTgSender],
        logger: createMockLogger(),
      });

      await service.notifyRunCompleted("run-1", "identity-initiator", {} as Db);

      // Only telegram should be called
      assert.strictEqual(tgSendMock.mock.callCount(), 1);
    });

    it("should continue sending even if one sender fails", async () => {
      const targets: NotificationTarget[] = [
        { identityId: "id-tg", platform: "telegram", userId: "tg123", workspaceId: null },
        { identityId: "id-slack", platform: "slack", userId: "slack456", workspaceId: null },
      ];

      const getGroupIdFn = mock.fn(async (_id: string) => "group-1");
      const listOtherFn = mock.fn(async (_g: string, _e: string) => targets);

      const mockGroupStore = {
        getGroupIdForIdentity: getGroupIdFn,
        listOtherIdentitiesInGroup: listOtherFn,
      };

      const mockCard: RunSummaryCard = {
        runId: "run-1",
        status: "error",
        title: "Build failed",
        prompt: "Fix the bug",
        diffStats: null,
        screenshotUrl: null,
        viewUrl: "https://example.com/run/run-1",
        vscodeUrl: null,
        initiatorPlatform: "websocket",
        finishedAt: Date.now(),
      };

      const buildFromRunFn = mock.fn(async (_db: Db, _runId: string) => mockCard);
      const mockCardBuilder = { buildFromRun: buildFromRunFn };

      const tgSendMock = mock.fn(async (_t: NotificationTarget, _c: RunSummaryCard): Promise<boolean> => {
        throw new Error("Telegram API error");
      });
      const slackSendMock = mock.fn(async (_t: NotificationTarget, _c: RunSummaryCard) => true);

      const mockTgSender: PlatformSender = {
        platform: "telegram",
        send: tgSendMock,
      };

      const mockSlackSender: PlatformSender = {
        platform: "slack",
        send: slackSendMock,
      };

      const service = new RunNotificationService({
        groupStore: mockGroupStore as any,
        cardBuilder: mockCardBuilder as any,
        senders: [mockTgSender, mockSlackSender],
        logger: createMockLogger(),
      });

      // Should not throw
      await service.notifyRunCompleted("run-1", "identity-initiator", {} as Db);

      // Both should be called even though telegram fails
      assert.strictEqual(tgSendMock.mock.callCount(), 1);
      assert.strictEqual(slackSendMock.mock.callCount(), 1);
    });
  });
});
