import { describe, it } from "node:test";
import assert from "node:assert";
import { RequestRouter } from "../../src/runtime/adapters/RequestRouter.js";

describe("RequestRouter @bot parsing", () => {
  it("treats /sessions@bot as /sessions", async () => {
    const router = new RequestRouter({ logger: { debug() {}, info() {}, warn() {}, error() {} } as any });
    const intent = await router.detectIntent("/sessions@bot", {
      platform: "telegram",
      chatId: "1",
      spaceId: "1",
      userId: "u1",
      hasActiveWizard: false,
      activeSession: null,
      cloudEnabled: false,
    });
    assert.strictEqual(intent.type, "command");
  });
});
