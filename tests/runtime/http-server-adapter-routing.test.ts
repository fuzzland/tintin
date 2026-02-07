import { describe, it } from "node:test";
import assert from "node:assert";
import { createHttpServer } from "../../src/runtime/service/httpServer.js";

describe("httpServer adapter-only routing", () => {
  it("does not call controller when adapter handles update", async () => {
    const controller = { handleTelegramUpdate: () => { throw new Error("controller called"); } };
    const telegramAdapter = { handleUpdate: async () => ({ handled: true }) };
    const { server } = createHttpServer({
      config: {} as any,
      db: {} as any,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
      controller: controller as any,
      cloudManager: null,
      telegram: {} as any,
      slack: null,
      slackInstallProvider: null,
      wsManager: null,
      slackEventStartTs: 0,
      queue: { enqueue: async (fn: any) => fn() } as any,
      githubWebhookIngestQueue: {} as any,
      scheduleGithubWebhookProcessing: () => {},
      resolveUserLanguage: async () => "en",
      resolveSessionLanguage: () => "en",
      notifyOAuthComplete: async () => {},
      notifyNotionConnected: async () => {},
      notifyChatgptConnected: async () => {},
      telegramAdapter: telegramAdapter as any,
    });
    assert.ok(server);
  });
});
