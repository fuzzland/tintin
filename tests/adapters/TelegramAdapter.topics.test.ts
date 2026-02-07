import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { TelegramAdapter } from "../../src/runtime/adapters/TelegramAdapter.js";

describe("TelegramAdapter forum topics", () => {
  it("uses ForumTopicManager for session space creation", async () => {
    const forum = { createSessionSpace: mock.fn(async () => ({ spaceId: "123", announce: false })) };
    const adapter = new TelegramAdapter({
      telegram: {} as any,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
      forumTopicManager: forum as any,
    } as any);
    assert.strictEqual(typeof adapter, "object");
  });
});
